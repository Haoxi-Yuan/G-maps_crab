#!/usr/bin/env node
/**
 * Image fetcher worker — Stage 5.
 *
 * Usage:
 *   node src/image-fetcher.js --task-id <N> --manifest <path-to-manifest.sqlite>
 *
 * One invocation = one task. The wizard launches each task in its own tmux
 * session. The fetcher polls the manifest for pending blobs, downloads them
 * with bounded concurrency, hard-links them into the per-place layout, and
 * honors paused/killed task state set by the wizard.
 *
 * Independence from review-scraper: this process only reads reviews.ndjson
 * (with a file-position checkpoint for --mode follow) and writes its own
 * sidecar files. The scraper can restart, OOM, anything — fetcher carries on.
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const Database = require('better-sqlite3');
const { makeProxyAgent } = require('./proxy-fetch');

// ─────────────────────────────────────────────────────────────────────────────
//  Manifest schema + helpers (shared between this worker and the wizard)
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT,
  city           TEXT NOT NULL,
  sources        TEXT NOT NULL,        -- JSON array
  filters        TEXT NOT NULL,        -- JSON object
  size_suffix    TEXT NOT NULL,
  include_video  INTEGER NOT NULL DEFAULT 0,
  mode           TEXT NOT NULL,        -- 'oneshot' | 'follow'
  concurrency    INTEGER NOT NULL DEFAULT 8,
  max_retries    INTEGER NOT NULL DEFAULT 3,
  state          TEXT NOT NULL DEFAULT 'running',  -- running|paused|done|killed
  reviews_offset INTEGER NOT NULL DEFAULT 0,
  pid            INTEGER,
  proxy          TEXT,
  bind_ip        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  sha          TEXT PRIMARY KEY,
  url_no_size  TEXT NOT NULL,
  url_full     TEXT NOT NULL,        -- url with active size suffix at fetch time
  local_path   TEXT,                 -- relative to images/ root
  bytes        INTEGER,
  mime         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|done|failed|dead
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  fetched_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blobs_status ON blobs(status);

CREATE TABLE IF NOT EXISTS refs (
  ref_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sha             TEXT NOT NULL REFERENCES blobs(sha),
  task_id         INTEGER NOT NULL REFERENCES tasks(task_id),
  place_id        TEXT NOT NULL,
  place_name      TEXT,
  source          TEXT NOT NULL,     -- photoCategories|business_photos|review_images
  category        TEXT,
  media_type      TEXT,              -- photo|video
  reviewer_name   TEXT,
  reviewer_id     TEXT,
  is_local_guide  INTEGER,
  review_id       TEXT,
  review_rating   INTEGER,
  review_likes    INTEGER,
  link_path       TEXT,              -- relative path under by-place/
  link_created    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE (task_id, sha, place_id, source, category, review_id)
);
CREATE INDEX IF NOT EXISTS idx_refs_task ON refs(task_id);
CREATE INDEX IF NOT EXISTS idx_refs_link ON refs(link_created, sha);
`;

function openManifest(manifestPath) {
  const db = new Database(manifestPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Initialize meta defaults
  const insertMeta = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
  insertMeta.run('global_concurrency', '12');
  insertMeta.run('schema_version', '1');
  // Migration: add columns to manifests created before these features.
  try { db.exec('ALTER TABLE tasks ADD COLUMN proxy TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN bind_ip TEXT'); } catch (e) { /* already exists */ }
  return db;
}

function nowISO() { return new Date().toISOString(); }

// ─────────────────────────────────────────────────────────────────────────────
//  URL helpers
// ─────────────────────────────────────────────────────────────────────────────

// Strip the size suffix (e.g. `=w203-h304-k-no`, `=s0`, `=k-no`) so equal-
// content URLs hash to the same sha regardless of requested resolution, and so
// a new suffix can be appended without producing a malformed double `=...`.
//
// googleusercontent URLs carry the size spec as `=<tokens>` after the final
// path segment, with no query string and no other `=`. So: take everything
// after the last `=`, and if it's a dash-joined run of alphanumeric tokens
// (w203, h304, k, no, s0, c, ...), treat it as the suffix. This is more robust
// than an explicit letter class (the old one omitted `o`, so `-k-no` never
// matched and the suffix got concatenated → HTTP 400).
function stripSizeSuffix(url) {
  const eq = url.lastIndexOf('=');
  if (eq > url.lastIndexOf('/')) {
    const suffix = url.slice(eq + 1);
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(suffix)) {
      return { base: url.slice(0, eq), hadSize: true };
    }
  }
  return { base: url, hadSize: false };
}

function appendSizeSuffix(url, suffix) {
  if (!suffix || suffix === 'raw') return url;
  const { base } = stripSizeSuffix(url);
  return base + '=' + suffix.replace(/^=/, '');
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function safePathSegment(s, maxLen = 80) {
  // ASCII whitelist — anything outside [A-Za-z0-9_.-] collapses to underscore.
  return String(s || '')
    .replace(/[^A-Za-z0-9_.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, maxLen);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Extract / plan: read a single reviews.ndjson record, emit refs per filter
// ─────────────────────────────────────────────────────────────────────────────

function extractRefs(record, task) {
  // Returns array of {url_no_size, url_meta:{...}}; the URL we actually fetch
  // has size suffix appended later.
  const filters = JSON.parse(task.filters);
  const sources = JSON.parse(task.sources);
  const includeVideo = !!task.include_video;
  const out = [];
  const biz = record.business || {};
  const place_id = biz.placeId || record._meta?.placeId;
  if (!place_id) return out;
  const place_name = biz.name || null;

  // --- photoCategories ---
  if (sources.includes('photoCategories')) {
    const cats = record.photoCategories || [];
    const allowLabels = filters.photoCategories?.category_labels || null;  // null = all
    const maxPerCat = filters.photoCategories?.max_per_category || null;
    for (const cat of cats) {
      const label = cat.label || cat.key || '?';
      if (allowLabels && !allowLabels.includes(label)) continue;
      const photos = cat.photos || [];
      let taken = 0;
      for (const p of photos) {
        if (!includeVideo && p.mediaType === 'video') continue;
        if (!p.url) continue;
        if (maxPerCat && taken >= maxPerCat) break;
        out.push({
          url: p.url,
          place_id, place_name,
          source: 'photoCategories',
          category: label,
          media_type: p.mediaType || 'photo',
        });
        taken++;
      }
    }
  }

  // --- business.photos ---
  if (sources.includes('business_photos')) {
    const bp = biz.photos || [];
    for (const p of bp) {
      const url = typeof p === 'string' ? p : p?.url;
      if (!url) continue;
      out.push({
        url, place_id, place_name,
        source: 'business_photos',
        category: null,
        media_type: 'photo',
      });
    }
  }

  // --- review_images ---
  if (sources.includes('review_images')) {
    const f = filters.review_images || {};
    const minRating = f.min_rating || 0;
    const minLikes = f.min_likes || 0;
    const localGuideOnly = !!f.local_guide_only;
    const maxPerPlace = f.max_per_place || null;
    let taken = 0;
    for (const rev of (record.detailedReviews || [])) {
      if (maxPerPlace && taken >= maxPerPlace) break;
      const imgs = rev.review_images || [];
      if (imgs.length === 0) continue;
      if ((rev.rating || 0) < minRating) continue;
      if ((rev.review_likes_count || 0) < minLikes) continue;
      if (localGuideOnly && !rev.is_local_guide) continue;
      for (const url of imgs) {
        if (maxPerPlace && taken >= maxPerPlace) break;
        out.push({
          url, place_id, place_name,
          source: 'review_images',
          category: null,
          media_type: 'photo',
          reviewer_name: rev.reviewer_name,
          reviewer_id: rev.reviewer_link
            ? (rev.reviewer_link.match(/contrib\/(\d+)/) || [])[1] || null
            : null,
          is_local_guide: rev.is_local_guide ? 1 : 0,
          review_id: rev.review_id,
          review_rating: rev.rating || null,
          review_likes: rev.review_likes_count || 0,
        });
        taken++;
      }
    }
  }

  return out;
}

// Insert refs (and parent blobs) into manifest. Returns counts.
function planRefs(db, task, refs, imagesRoot) {
  const ts = nowISO();
  const insertBlob = db.prepare(`
    INSERT OR IGNORE INTO blobs (sha, url_no_size, url_full, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  const insertRef = db.prepare(`
    INSERT OR IGNORE INTO refs (
      sha, task_id, place_id, place_name, source, category, media_type,
      reviewer_name, reviewer_id, is_local_guide,
      review_id, review_rating, review_likes,
      link_path, link_created, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);

  let newBlobs = 0, newRefs = 0;
  const tx = db.transaction((items) => {
    for (const ref of items) {
      const { base } = stripSizeSuffix(ref.url);
      const sha = sha256(base);
      const urlFull = appendSizeSuffix(ref.url, task.size_suffix);
      const r = insertBlob.run(sha, base, urlFull, ts);
      if (r.changes > 0) newBlobs++;
      const linkPath = computeLinkPath(task.city, ref, sha);
      const ri = insertRef.run(
        sha, task.task_id,
        ref.place_id, ref.place_name,
        ref.source, ref.category, ref.media_type,
        ref.reviewer_name || null, ref.reviewer_id || null, ref.is_local_guide || 0,
        ref.review_id || null, ref.review_rating || null, ref.review_likes || 0,
        linkPath, ts,
      );
      if (ri.changes > 0) newRefs++;
    }
  });
  tx(refs);
  return { newBlobs, newRefs };
}

function computeLinkPath(city, ref, sha) {
  // by-place/<place_id>-<name>/<source>/<category-or-reviewer>/<sha-prefix>.<ext>
  const pidSlug = safePathSegment(ref.place_id);
  const nameSlug = safePathSegment(ref.place_name, 40);
  const placeDir = nameSlug ? `${pidSlug}-${nameSlug}` : pidSlug;
  let leaf;
  if (ref.source === 'photoCategories') {
    const catSlug = safePathSegment(ref.category, 50);
    leaf = path.join('photoCategories', catSlug);
  } else if (ref.source === 'business_photos') {
    leaf = 'business_photos';
  } else if (ref.source === 'review_images') {
    const rIdHead = String(ref.review_id || sha).slice(0, 12);
    const rname = safePathSegment(ref.reviewer_name || 'anon', 30);
    const lg = ref.is_local_guide ? '__lg' : '';
    leaf = path.join('review_images', `${rIdHead}__${rname}${lg}`);
  } else {
    leaf = ref.source;
  }
  const ext = ref.media_type === 'video' ? 'mp4.thumb.jpg' : 'jpg';
  const filename = `${sha.slice(0, 16)}.${ext}`;
  return path.join('by-place', placeDir, leaf, filename);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Download core (https, retry, hard-link)
// ─────────────────────────────────────────────────────────────────────────────

// Source-IP binding: when set, all downloads bind to this local address so
// traffic egresses via the NUS tunnel interface (utun) instead of the default
// (GFW-blocked) route. Set once in main() from --bind / IMAGE_BIND_IP.
let BIND_ADDRESS = null;

// Auto-detect the tunnel egress IP: the IPv4 on a utun* interface in the
// 10.x range (the NUS/Cisco tunnel). The utun index and the exact address
// both change on every VPN reconnect, so this is always recomputed at startup
// rather than trusting a value persisted in the manifest.
function detectTunnelIP() {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!/^utun\d+/.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && a.address.startsWith('10.')) return a.address;
    }
  }
  return null;
}

// Resolve the source IP to actually bind. A bind to an address not currently
// assigned to any interface fails every request with EADDRNOTAVAIL, so:
//   - if the requested IP is live, use it;
//   - else if it looks like a stale tunnel IP (10.x), substitute the current
//     tunnel IP and warn;
//   - else use it as-is (let the OS error surface meaningfully).
function resolveBindAddress(requested) {
  if (!requested) return null;
  const os = require('os');
  const live = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4') live.add(a.address);
  }
  if (live.has(requested)) return requested;
  if (requested.startsWith('10.')) {
    const cur = detectTunnelIP();
    if (cur && cur !== requested) {
      console.warn(`[bind] requested ${requested} not live; using current tunnel IP ${cur}`);
      return cur;
    }
  }
  console.warn(`[bind] requested ${requested} not assigned to any interface; binding may fail`);
  return requested;
}

function fetchBuffer(url, timeoutMs = 20000, redirects = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      host: u.host,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
    };
    if (BIND_ADDRESS) opts.localAddress = BIND_ADDRESS;
    const req = https.get(opts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirects <= 0) return reject(new Error('too many redirects'));
        res.resume();
        const loc = res.headers.location;
        if (!loc) return reject(new Error('redirect with no Location'));
        return resolve(fetchBuffer(loc, timeoutMs, redirects - 1));
      }
      if (res.statusCode === 429 || res.statusCode === 503) {
        res.resume();
        const ra = parseInt(res.headers['retry-after'] || '0', 10) || 0;
        return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), {
          retryable: true, retryAfter: ra,
        }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), {
          retryable: res.statusCode >= 500,
        }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const mime = res.headers['content-type'] || null;
        resolve({ buf, mime });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function writeBlobAtomically(blobsRoot, sha, buf) {
  const dir = path.join(blobsRoot, sha.slice(0, 2));
  await fsp.mkdir(dir, { recursive: true });
  const final = path.join(dir, sha + '.jpg');
  if (fs.existsSync(final)) return final; // already on disk (idempotent)
  const tmp = final + '.part.' + process.pid;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, final);
  return final;
}

// Materialize the per-place view entry. Prefer a hard link (cheapest, true
// dedup), but many filesystems (exFAT, some network/FUSE volumes — e.g. the
// external /Volumes disk this often runs on) reject cross-name links with
// ENOTSUP/EPERM. Fall back to a relative symlink, then to a full copy, so the
// by-place tree is always populated regardless of the underlying FS.
async function createHardLinkSafe(blobAbs, linkAbs) {
  await fsp.mkdir(path.dirname(linkAbs), { recursive: true });
  // 1) hard link
  try {
    await fsp.link(blobAbs, linkAbs);
    return;
  } catch (e) {
    if (e.code === 'EEXIST') return; // already materialized
    if (!['ENOTSUP', 'EPERM', 'EXDEV', 'EMLINK', 'EOPNOTSUPP'].includes(e.code)) throw e;
  }
  // 2) relative symlink (relative target survives moving the whole images dir)
  try {
    const rel = path.relative(path.dirname(linkAbs), blobAbs);
    await fsp.symlink(rel, linkAbs);
    return;
  } catch (e) {
    if (e.code === 'EEXIST') return;
    if (!['ENOTSUP', 'EPERM', 'EOPNOTSUPP'].includes(e.code)) throw e;
  }
  // 3) copy
  try {
    await fsp.copyFile(blobAbs, linkAbs);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Worker loop
// ─────────────────────────────────────────────────────────────────────────────

class Semaphore {
  constructor(n) { this.n = n; this.queue = []; }
  acquire() {
    if (this.n > 0) { this.n--; return Promise.resolve(); }
    return new Promise((r) => this.queue.push(r));
  }
  release() {
    this.n++;
    const r = this.queue.shift();
    if (r) { this.n--; r(); }
  }
}

async function processBlob(db, task, blob, imagesRoot, blobsRoot) {
  const updateBlob = db.prepare(`
    UPDATE blobs SET status = ?, bytes = ?, mime = ?, fetched_at = ?, local_path = ?,
                     attempts = attempts + 1, last_error = ?
    WHERE sha = ?
  `);
  const bumpAttempt = db.prepare(`
    UPDATE blobs SET attempts = attempts + 1, last_error = ?, status = ?
    WHERE sha = ?
  `);
  try {
    const { buf, mime } = await fetchBuffer(blob.url_full);
    if (!buf || buf.length < 1024) {
      throw new Error(`payload too small (${buf?.length || 0} bytes)`);
    }
    const finalAbs = await writeBlobAtomically(blobsRoot, blob.sha, buf);
    const rel = path.relative(imagesRoot, finalAbs);
    updateBlob.run('done', buf.length, mime, nowISO(), rel, null, blob.sha);

    // Create hard links for all refs of this blob that aren't yet linked.
    const refs = db.prepare(`
      SELECT ref_id, link_path FROM refs WHERE sha = ? AND link_created = 0
    `).all(blob.sha);
    const markLinked = db.prepare('UPDATE refs SET link_created = 1 WHERE ref_id = ?');
    for (const r of refs) {
      try {
        const linkAbs = path.join(imagesRoot, r.link_path);
        await createHardLinkSafe(finalAbs, linkAbs);
        markLinked.run(r.ref_id);
      } catch (e) {
        // Linking failure is non-fatal; log via last_error keeps blob done
        // but a future GC step can re-link orphans. Leave link_created = 0.
      }
    }
  } catch (e) {
    const attempts = (blob.attempts || 0) + 1;
    const dead = attempts >= task.max_retries;
    bumpAttempt.run(String(e.message || e).slice(0, 200), dead ? 'dead' : 'failed', blob.sha);
    if (e.retryAfter) {
      // crude: surface retry-after to the caller via thrown error
      throw Object.assign(new Error('rate-limited'), { retryAfter: e.retryAfter });
    }
  }
}

// Materialize by-place entries for every already-downloaded blob whose refs
// aren't yet linked. Self-healing: covers blobs that were downloaded before
// link support existed, links that failed on a now-changed filesystem, or a
// manual `link_created` reset. Safe to call repeatedly.
async function materializeLinks(db, task, imagesRoot) {
  const rows = db.prepare(`
    SELECT r.ref_id, r.link_path, b.local_path
    FROM refs r JOIN blobs b ON b.sha = r.sha
    WHERE r.task_id = ? AND r.link_created = 0 AND b.status = 'done' AND b.local_path IS NOT NULL
  `).all(task.task_id);
  if (rows.length === 0) return 0;
  const mark = db.prepare('UPDATE refs SET link_created = 1 WHERE ref_id = ?');
  let n = 0;
  for (const r of rows) {
    try {
      const finalAbs = path.join(imagesRoot, r.local_path);
      const linkAbs = path.join(imagesRoot, r.link_path);
      await createHardLinkSafe(finalAbs, linkAbs);
      mark.run(r.ref_id);
      n++;
    } catch (e) {
      // leave link_created = 0; a later pass retries
    }
  }
  return n;
}

async function workerLoop(db, task, imagesRoot) {
  const blobsRoot = path.join(imagesRoot, '_blobs');
  await fsp.mkdir(blobsRoot, { recursive: true });
  const sem = new Semaphore(task.concurrency);

  // Heal any pre-existing done-but-unlinked refs before downloading more.
  const healed = await materializeLinks(db, task, imagesRoot);
  if (healed > 0) console.log(`[task ${task.task_id}] materialized ${healed} pre-existing links`);

  const getTaskState = db.prepare('SELECT state FROM tasks WHERE task_id = ?');
  const updateTask = db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?');
  const pickPending = db.prepare(`
    SELECT b.sha, b.url_full, b.attempts FROM blobs b
    JOIN refs r ON r.sha = b.sha
    WHERE b.status IN ('pending', 'failed')
      AND r.task_id = ?
      AND b.attempts < ?
    GROUP BY b.sha
    LIMIT ?
  `);

  let rateLimitedUntil = 0;

  while (true) {
    // 1) Check task state — pause / kill respect.
    const cur = getTaskState.get(task.task_id);
    if (!cur) break;
    if (cur.state === 'killed') break;
    if (cur.state === 'paused') {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    // 2) Respect rate-limit cooldown.
    if (Date.now() < rateLimitedUntil) {
      await new Promise((r) => setTimeout(r, rateLimitedUntil - Date.now()));
    }
    // 3) Pull a batch of pending blobs FOR THIS TASK.
    const batch = pickPending.all(task.task_id, task.max_retries, task.concurrency * 4);
    if (batch.length === 0) {
      consecutiveEmpty++;
      if (task.mode === 'oneshot' && consecutiveEmpty >= 2) break;
      // follow mode: idle a bit and let the tail loop add more
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    consecutiveEmpty = 0;

    // 4) Download with bounded concurrency.
    const promises = batch.map(async (blob) => {
      await sem.acquire();
      try { await processBlob(db, task, blob, imagesRoot, blobsRoot); }
      catch (e) {
        if (e.retryAfter) {
          rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + e.retryAfter * 1000);
        }
      }
      finally { sem.release(); }
    });
    await Promise.all(promises);
    updateTask.run('running', nowISO(), task.task_id);
  }

  // Mark task done if no failures left.
  const remaining = db.prepare(
    `SELECT COUNT(*) AS n FROM blobs b
     JOIN refs r ON r.sha = b.sha
     WHERE r.task_id = ? AND b.status IN ('pending','failed')`
  ).get(task.task_id);
  const finalState = (db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(task.task_id) || {}).state;
  if (finalState !== 'killed' && remaining.n === 0 && task.mode === 'oneshot') {
    updateTask.run('done', nowISO(), task.task_id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reviews.ndjson reader: oneshot (read once) + follow (tail + checkpoint)
// ─────────────────────────────────────────────────────────────────────────────

async function* tailNDJSON(filePath, startOffset, opts) {
  // Generator yielding {record, byteEnd}. In follow mode, sleeps for new bytes;
  // in oneshot mode, ends at EOF.
  const { follow = false, pollMs = 2000, abort = () => false } = opts || {};
  let offset = startOffset || 0;
  let buffer = '';
  while (true) {
    if (abort()) return;
    let st;
    try { st = fs.statSync(filePath); }
    catch (e) {
      if (!follow) return;
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    if (st.size < offset) { offset = 0; buffer = ''; } // file truncated
    if (st.size === offset) {
      if (!follow) return;
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = st.size - offset;
      const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      offset += n;
      buffer += buf.slice(0, n).toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          yield { record: rec, byteEnd: offset - buffer.length };
        } catch (e) {
          // skip malformed line
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

async function ingestLoop(db, task, reviewsPath, imagesRoot) {
  const updateOffset = db.prepare('UPDATE tasks SET reviews_offset = ?, updated_at = ? WHERE task_id = ?');
  const getState = db.prepare('SELECT state, reviews_offset FROM tasks WHERE task_id = ?');

  const abort = () => {
    const r = getState.get(task.task_id);
    return !r || r.state === 'killed';
  };
  let lastCommit = Date.now();

  for await (const { record, byteEnd } of tailNDJSON(reviewsPath, task.reviews_offset, {
    follow: task.mode === 'follow', pollMs: 2000, abort,
  })) {
    const refs = extractRefs(record, task);
    if (refs.length > 0) planRefs(db, task, refs, imagesRoot);
    // Commit offset every ~3s
    if (Date.now() - lastCommit > 3000) {
      updateOffset.run(byteEnd, nowISO(), task.task_id);
      lastCommit = Date.now();
    }
  }
  updateOffset.run(fs.statSync(reviewsPath).size, nowISO(), task.task_id);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args['task-id'] || !args.manifest) {
    console.error('usage: image-fetcher.js --task-id N --manifest path/manifest.sqlite');
    process.exit(2);
  }
  const taskId = parseInt(args['task-id'], 10);
  const manifestPath = path.resolve(args.manifest);
  const imagesRoot = path.dirname(manifestPath);

  const db = openManifest(manifestPath);
  db.prepare('UPDATE tasks SET pid = ?, updated_at = ? WHERE task_id = ?')
    .run(process.pid, nowISO(), taskId);

  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  if (!task) {
    console.error(`task ${taskId} not found in ${manifestPath}`);
    process.exit(2);
  }

  // Source-IP binding: egress via a specific local interface (the NUS tunnel)
  // so downloads dodge the GFW-blocked default route. Precedence:
  //   --bind flag > IMAGE_BIND_IP env > task.bind_ip (from DB).
  const requestedBind = args.bind || process.env.IMAGE_BIND_IP || task.bind_ip || null;
  BIND_ADDRESS = resolveBindAddress(requestedBind);
  if (BIND_ADDRESS) console.log(`[task ${taskId}] bind source IP: ${BIND_ADDRESS}`);

  // Alternatively route ALL https downloads through a proxy if configured.
  // fetchBuffer uses https.get without an explicit agent, so overriding
  // globalAgent is enough. --proxy > HTTPS_PROXY/ALL_PROXY > task.proxy.
  const proxyUrl = args.proxy || process.env.HTTPS_PROXY || process.env.ALL_PROXY || task.proxy || null;
  if (proxyUrl) {
    try { https.globalAgent = makeProxyAgent(proxyUrl); console.log(`[task ${taskId}] proxy: ${proxyUrl}`); }
    catch (e) { console.error(`[task ${taskId}] bad proxy "${proxyUrl}": ${e.message}`); process.exit(2); }
  }

  // Locate reviews.ndjson under output/<city>/
  const reviewsPath = path.resolve(imagesRoot, '..', 'reviews.ndjson');
  if (!fs.existsSync(reviewsPath)) {
    console.error(`reviews.ndjson not found at ${reviewsPath}`);
    process.exit(2);
  }

  console.log(`[task ${taskId}] city=${task.city} mode=${task.mode} sources=${task.sources}`);
  console.log(`[task ${taskId}] reviews: ${reviewsPath}`);
  console.log(`[task ${taskId}] images:  ${imagesRoot}`);

  // Kick off ingest (extract+plan) and worker (download) in parallel.
  const ingestP = ingestLoop(db, task, reviewsPath, imagesRoot);
  const workerP = workerLoop(db, task, imagesRoot);

  // Periodic progress log
  const progT = setInterval(() => {
    const s = db.prepare(`
      SELECT
        SUM(CASE WHEN b.status='done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN b.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN b.status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN b.status='dead' THEN 1 ELSE 0 END) AS dead,
        COUNT(*) AS total
      FROM blobs b
      WHERE EXISTS (SELECT 1 FROM refs r WHERE r.sha = b.sha AND r.task_id = ?)
    `).get(taskId);
    console.log(`[task ${taskId}] done=${s.done || 0} pending=${s.pending || 0} failed=${s.failed || 0} dead=${s.dead || 0} total=${s.total || 0}`);
  }, 10000);

  try {
    await Promise.all([ingestP, workerP]);
  } finally {
    clearInterval(progT);
    db.close();
  }
  console.log(`[task ${taskId}] exit`);
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = {
  openManifest, extractRefs, planRefs, stripSizeSuffix, appendSizeSuffix,
  sha256, safePathSegment, computeLinkPath, SCHEMA,
};
