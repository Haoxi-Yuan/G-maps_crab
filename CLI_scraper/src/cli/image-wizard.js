#!/usr/bin/env node
/**
 * Stage 5 — Image download wizard.
 *
 * Persistent interactive menu: any time you launch it, you see live status of
 * every task (running/paused/done/killed) and can spawn new ones, pause them,
 * resume, kill, inspect failures, or run cleanup.
 *
 *   gmaps-crab → [5] → image-wizard.js
 *   OR
 *   node src/cli/image-wizard.js
 *
 * All state lives in one SQLite manifest per city: output/<city>/images/manifest.sqlite
 * Workers are tmux sessions named gmaps-img-<taskId>; killing the wizard does
 * NOT affect running tasks, and the wizard reads task state purely from the
 * manifest, so multiple wizard instances can coexist.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, spawn } = require('child_process');
const {
  openManifest, sha256, stripSizeSuffix, appendSizeSuffix,
} = require('../image-fetcher');
const { testProxy } = require('../proxy-fetch');

const ROOT = path.resolve(__dirname, '..', '..');
const FETCHER = path.join(ROOT, 'src', 'image-fetcher.js');

const COLOR = process.stdout.isTTY ? {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
} : { reset: '', dim: '', bold: '', red: '', green: '', yellow: '', blue: '', cyan: '', gray: '' };

const c = COLOR;

// ─────────────────────────────────────────────────────────────────────────────
//  readline helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, q, def) {
  return new Promise((resolve) => {
    const suf = (def !== undefined && def !== '') ? c.dim + ` [${def}]` + c.reset : '';
    rl.question(`${q}${suf} > `, (a) => {
      a = (a || '').trim();
      resolve(a === '' ? (def !== undefined ? String(def) : '') : a);
    });
  });
}

async function askYN(rl, q, def = 'n') {
  const a = await ask(rl, `${q} (y/n)`, def);
  return /^y/i.test(a);
}

async function askInt(rl, q, def) {
  const a = await ask(rl, q, def === undefined ? '' : String(def));
  const n = parseInt(a, 10);
  return Number.isFinite(n) ? n : null;
}

async function pickOne(rl, q, options) {
  while (true) {
    console.log();
    console.log(c.cyan + q + c.reset);
    options.forEach((o, i) => console.log(`  ${c.bold}${i + 1}${c.reset}) ${o}`));
    const a = await ask(rl, 'pick #', '1');
    const n = parseInt(a, 10);
    if (Number.isFinite(n) && n >= 1 && n <= options.length) return n - 1;
    console.log(c.red + '  invalid choice' + c.reset);
  }
}

async function pickMany(rl, q, options, defaults) {
  // defaults = array of indices that start selected
  const selected = new Set(defaults || []);
  while (true) {
    console.log();
    console.log(c.cyan + q + c.reset);
    options.forEach((o, i) => {
      const mark = selected.has(i) ? c.green + '[x]' + c.reset : '[ ]';
      console.log(`  ${mark} ${c.bold}${i + 1}${c.reset}) ${o}`);
    });
    const a = await ask(rl, 'toggle # or [enter] to confirm', '');
    if (a === '') return [...selected].sort((x, y) => x - y);
    const n = parseInt(a, 10);
    if (Number.isFinite(n) && n >= 1 && n <= options.length) {
      if (selected.has(n - 1)) selected.delete(n - 1); else selected.add(n - 1);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  City discovery
// ─────────────────────────────────────────────────────────────────────────────

function listCities() {
  const outDir = path.join(ROOT, 'output');
  if (!fs.existsSync(outDir)) return [];
  const cities = [];
  for (const d of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const reviews = path.join(outDir, d.name, 'reviews.ndjson');
    if (!fs.existsSync(reviews)) continue;
    const size = fs.statSync(reviews).size;
    const lines = countLines(reviews);
    cities.push({ name: d.name, reviewsBytes: size, places: lines });
  }
  return cities;
}

function countLines(file) {
  try {
    return parseInt(execSync(`wc -l < '${file}'`, { encoding: 'utf8' }).trim(), 10) || 0;
  } catch { return 0; }
}

function imagesRoot(city) {
  return path.join(ROOT, 'output', city, 'images');
}

function manifestPath(city) {
  return path.join(imagesRoot(city), 'manifest.sqlite');
}

// Auto-detect the NUS tunnel's source IP: a utun interface carrying a 10.x
// address. The utun index changes on every reconnect, so we never hardcode it.
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

// ─────────────────────────────────────────────────────────────────────────────
//  Task spawn
// ─────────────────────────────────────────────────────────────────────────────

function launchTaskTmux(taskId, city) {
  const sess = `gmaps-img-${taskId}`;
  const manifest = manifestPath(city);
  const env = [
    `cd '${ROOT}'`,
    `export PLAYWRIGHT_BROWSERS_PATH='${path.join(ROOT, '.playwright-browsers')}'`,
  ].join(' && ');
  const cmd = `${env} && node '${FETCHER}' --task-id ${taskId} --manifest '${manifest}' 2>&1 | tee -a '${path.join(imagesRoot(city), `task-${taskId}.log`)}'; echo; echo '=== task ${taskId} exited; press Enter to close ==='; read`;
  try { execSync(`tmux kill-session -t ${sess} 2>/dev/null`); } catch {}
  execSync(`tmux new-session -d -s ${sess} "${cmd.replace(/"/g, '\\"')}"`);
  return sess;
}

function tmuxRunning(sess) {
  try {
    execSync(`tmux has-session -t ${sess} 2>/dev/null`);
    return true;
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Status / progress queries
// ─────────────────────────────────────────────────────────────────────────────

function taskProgress(db, taskId) {
  return db.prepare(`
    SELECT
      SUM(CASE WHEN b.status='done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN b.status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN b.status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN b.status='dead' THEN 1 ELSE 0 END) AS dead,
      COUNT(DISTINCT b.sha) AS total,
      SUM(CASE WHEN b.status='done' THEN b.bytes ELSE 0 END) AS bytes_done
    FROM blobs b
    JOIN refs r ON r.sha = b.sha
    WHERE r.task_id = ?
  `).get(taskId) || {};
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function stateLabel(s) {
  if (s === 'running') return c.green + 'running' + c.reset;
  if (s === 'paused') return c.yellow + 'paused' + c.reset;
  if (s === 'done') return c.dim + 'done' + c.reset;
  if (s === 'killed') return c.red + 'killed' + c.reset;
  return s;
}

function tasksSummary(city) {
  const mp = manifestPath(city);
  if (!fs.existsSync(mp)) return [];
  const db = openManifest(mp);
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY task_id DESC').all();
  const rows = tasks.map((t) => {
    const p = taskProgress(db, t.task_id);
    const sess = `gmaps-img-${t.task_id}`;
    const alive = tmuxRunning(sess);
    return { ...t, progress: p, alive, sess };
  });
  db.close();
  return rows;
}

function renderTasks(rows) {
  if (rows.length === 0) { console.log(c.dim + '  (no tasks yet)' + c.reset); return; }
  console.log();
  console.log(`  ${c.bold}#  state    mode     sources                    done/total      bytes    age  tmux${c.reset}`);
  for (const r of rows) {
    const sources = JSON.parse(r.sources).join('+');
    const pct = r.progress.total > 0
      ? (r.progress.done / r.progress.total * 100).toFixed(1) + '%'
      : '-';
    const age = r.created_at ? r.created_at.slice(5, 16).replace('T', ' ') : '-';
    const tmuxMark = r.alive ? c.green + '✓' + c.reset : c.dim + '✗' + c.reset;
    const line = `  ${String(r.task_id).padStart(2)} ` +
      `${stateLabel(r.state).padEnd(20)} ` +
      `${r.mode.padEnd(8)} ` +
      `${sources.padEnd(26)} ` +
      `${String(r.progress.done || 0).padStart(5)}/${String(r.progress.total || 0).padEnd(6)} (${pct.padStart(6)}) ` +
      `${fmtBytes(r.progress.bytes_done).padStart(8)} ` +
      `${age}  ${tmuxMark}`;
    console.log(line);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  New-task wizard
// ─────────────────────────────────────────────────────────────────────────────

async function flowNewTask(rl) {
  const cities = listCities();
  if (cities.length === 0) {
    console.log(c.red + 'No reviews.ndjson found under output/. Run stage 3 first.' + c.reset);
    return;
  }
  const cityIdx = await pickOne(rl, 'Step 1/6 — City:',
    cities.map((c) => `${c.name}  ${c.dim || ''}(${c.places} places written)`));
  const city = cities[cityIdx].name;

  const sourceOpts = ['photoCategories', 'review_images', 'business_photos'];
  const srcIdx = await pickMany(rl, 'Step 2/6 — Sources (toggle one or more, enter to confirm):',
    sourceOpts.map((s) => s), [0, 1]);
  if (srcIdx.length === 0) {
    console.log(c.red + 'No sources selected.' + c.reset);
    return;
  }
  const sources = srcIdx.map((i) => sourceOpts[i]);

  // Step 3 — filters (only ask for what's relevant)
  console.log(c.cyan + '\nStep 3/6 — Filters (blank = no limit)' + c.reset);
  const filters = {};

  if (sources.includes('photoCategories')) {
    console.log(c.dim + '  photoCategories:' + c.reset);
    const cats = await ask(rl,
      '    Category labels (comma-sep; blank=all)', '');
    const maxPerCat = await ask(rl, '    Max photos per (place,category)', '');
    filters.photoCategories = {
      category_labels: cats ? cats.split(',').map((s) => s.trim()).filter(Boolean) : null,
      max_per_category: maxPerCat ? parseInt(maxPerCat, 10) : null,
    };
  }
  if (sources.includes('review_images')) {
    console.log(c.dim + '  review_images:' + c.reset);
    const minR = await askInt(rl, '    Min rating (1-5)', 0);
    const minL = await askInt(rl, '    Min likes', 0);
    const lgOnly = await askYN(rl, '    Local Guide reviewers only?', 'n');
    const maxPerPlace = await ask(rl, '    Max images per place', '');
    filters.review_images = {
      min_rating: minR || 0,
      min_likes: minL || 0,
      local_guide_only: lgOnly,
      max_per_place: maxPerPlace ? parseInt(maxPerPlace, 10) : null,
    };
  }

  const includeVideo = await askYN(rl,
    'Include video thumbnails? (mediaType=video — only thumbnails, not mp4)', 'n');

  // Step 4 — size
  // NB: gps-cs-s (place) photo URLs return HTTP 400 unless the suffix carries
  // the -k-no modifier; grass-cs (review) URLs tolerate either. So every preset
  // ends in -k-no for cross-source correctness. (The fetcher also retries a 400
  // by appending -k-no as a safety net for custom suffixes.)
  const sizeIdx = await pickOne(rl, 'Step 4/7 — Image size:', [
    's1024-w1024-h1024-k-no  (1024² no-crop, balanced)',
    'w800-h600-k-no          (800×600)',
    'w1600-h1200-k-no        (high-res)',
    's400-k-no               (thumbnail)',
    'raw                     (Google default)',
    'custom...',
  ]);
  const sizeOptions = [
    's1024-w1024-h1024-k-no',
    'w800-h600-k-no',
    'w1600-h1200-k-no',
    's400-k-no',
    'raw',
    null,
  ];
  let sizeSuffix = sizeOptions[sizeIdx];
  if (sizeSuffix === null) {
    sizeSuffix = await ask(rl, 'Enter custom size suffix (e.g. w1200-h800)', '');
  }

  // Step 5 — mode
  const modeIdx = await pickOne(rl, 'Step 5/6 — Mode:', [
    'follow   (tail reviews.ndjson live as scraper appends)',
    'oneshot  (process current snapshot, then exit)',
  ]);
  const mode = modeIdx === 0 ? 'follow' : 'oneshot';

  // Step 6 — network egress (bind source IP so traffic exits via the NUS
  // tunnel; on an overseas server with direct access, leave blank).
  console.log(c.cyan + '\nStep 6/7 — Network egress' + c.reset);
  const autoIp = detectTunnelIP();
  if (autoIp) {
    console.log(c.dim + `  detected tunnel IP (utun/10.x): ${autoIp}` + c.reset);
  } else {
    console.log(c.dim + '  no utun/10.x tunnel detected (direct access assumed)' + c.reset);
  }
  const bindIp = await ask(rl,
    'Bind source IP (blank = direct; auto = use detected tunnel IP)',
    autoIp ? 'auto' : '');
  const resolvedBind = bindIp === 'auto' ? autoIp : (bindIp || null);
  const proxy = await ask(rl, 'Proxy URL (blank = none; e.g. socks5://127.0.0.1:1080)', '');

  // Step 7 — runtime
  console.log(c.cyan + '\nStep 7/7 — Runtime params' + c.reset);
  const concurrency = await askInt(rl, 'Concurrency per task', 8);
  const maxRetries = await askInt(rl, 'Retries before dead-letter', 3);
  const name = await ask(rl, 'Save as named task (optional)', '');

  // Preview + confirm
  const mp = manifestPath(city);
  fs.mkdirSync(path.dirname(mp), { recursive: true });
  const db = openManifest(mp);

  console.log();
  console.log(c.cyan + '═══ Preview ═══' + c.reset);
  console.log(`  city:         ${city}`);
  console.log(`  sources:      ${sources.join(', ')}`);
  console.log(`  filters:      ${JSON.stringify(filters)}`);
  console.log(`  include_video: ${includeVideo}`);
  console.log(`  size_suffix:  ${sizeSuffix || 'raw'}`);
  console.log(`  mode:         ${mode}`);
  console.log(`  concurrency:  ${concurrency}  retries: ${maxRetries}`);
  console.log(`  name:         ${name || '(unnamed)'}`);
  console.log(`  manifest:     ${mp}`);
  console.log();

  const ok = await askYN(rl, 'Create + launch this task?', 'y');
  if (!ok) { db.close(); return; }

  const ts = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO tasks (name, city, sources, filters, size_suffix, include_video,
                       mode, concurrency, max_retries, bind_ip, proxy, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `);
  const r = ins.run(
    name || null, city, JSON.stringify(sources), JSON.stringify(filters),
    sizeSuffix || 'raw', includeVideo ? 1 : 0,
    mode, concurrency, maxRetries, resolvedBind || null, proxy || null, ts, ts,
  );
  const taskId = r.lastInsertRowid;
  db.close();

  const sess = launchTaskTmux(taskId, city);
  console.log();
  console.log(c.green + `Task ${taskId} launched in tmux session ${sess}` + c.reset);
  console.log(`  re-attach:    tmux attach -t ${sess}   (Ctrl-B D to detach)`);
  console.log(`  tail log:     tail -f ${path.join(imagesRoot(city), `task-${taskId}.log`)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Manage / status flows
// ─────────────────────────────────────────────────────────────────────────────

async function flowList(rl) {
  const cities = listCities();
  if (cities.length === 0) { console.log(c.dim + 'no cities with reviews.ndjson' + c.reset); return; }
  let cityIdx = 0;
  if (cities.length > 1) {
    cityIdx = await pickOne(rl, 'Pick city:', cities.map((c) => c.name));
  }
  const city = cities[cityIdx].name;
  const rows = tasksSummary(city);
  console.log(c.bold + `\nTasks in ${city}:` + c.reset);
  renderTasks(rows);
  if (rows.length === 0) return;
  console.log();
  const cmd = await ask(rl,
    'Action: [p]ause / [r]esume / [k]ill / [a]ttach / [t]ail / [i]nspect / blank=back',
    '');
  if (!cmd) return;
  const id = await askInt(rl, 'Task ID', rows[0].task_id);
  const row = rows.find((r) => r.task_id === id);
  if (!row) { console.log(c.red + 'no such task' + c.reset); return; }
  const db = openManifest(manifestPath(city));
  const ts = new Date().toISOString();
  if (cmd === 'p') {
    db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?').run('paused', ts, id);
    console.log(c.yellow + `task ${id} → paused (worker will idle within ~3s)` + c.reset);
  } else if (cmd === 'r') {
    db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?').run('running', ts, id);
    if (!row.alive) {
      launchTaskTmux(id, city);
      console.log(c.green + `task ${id} → relaunched in tmux gmaps-img-${id}` + c.reset);
    } else {
      console.log(c.green + `task ${id} → running` + c.reset);
    }
  } else if (cmd === 'k') {
    db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?').run('killed', ts, id);
    try { execSync(`tmux kill-session -t ${row.sess} 2>/dev/null`); } catch {}
    console.log(c.red + `task ${id} → killed` + c.reset);
  } else if (cmd === 'a') {
    db.close();
    if (!row.alive) { console.log(c.red + 'task tmux session is dead' + c.reset); return; }
    console.log(`Detach with Ctrl-B D. Attaching...`);
    spawn('tmux', ['attach', '-t', row.sess], { stdio: 'inherit' }).on('exit', () => {});
    return;
  } else if (cmd === 't') {
    db.close();
    const logPath = path.join(imagesRoot(city), `task-${id}.log`);
    spawn('tail', ['-f', logPath], { stdio: 'inherit' });
    return;
  } else if (cmd === 'i') {
    await flowInspectTask(db, row);
  }
  db.close();
}

async function flowInspectTask(db, row) {
  const taskId = row.task_id;
  console.log(c.bold + `\nTask ${taskId} inspection:` + c.reset);
  console.log(`  sources:   ${row.sources}`);
  console.log(`  filters:   ${row.filters}`);
  console.log(`  size:      ${row.size_suffix}`);
  console.log(`  reviews_offset: ${row.reviews_offset}`);
  console.log(`  pid:       ${row.pid || '-'}  alive: ${row.alive}`);

  const bySource = db.prepare(`
    SELECT r.source, COUNT(DISTINCT b.sha) AS n,
           SUM(CASE WHEN b.status='done' THEN 1 ELSE 0 END) AS done
    FROM refs r JOIN blobs b ON b.sha = r.sha
    WHERE r.task_id = ?
    GROUP BY r.source
  `).all(taskId);
  console.log();
  console.log('  By source:');
  for (const s of bySource) console.log(`    ${s.source.padEnd(20)} ${s.done}/${s.n}`);

  const dead = db.prepare(`
    SELECT b.sha, b.url_full, b.last_error, b.attempts
    FROM blobs b JOIN refs r ON r.sha = b.sha
    WHERE r.task_id = ? AND b.status = 'dead'
    GROUP BY b.sha LIMIT 5
  `).all(taskId);
  if (dead.length > 0) {
    console.log();
    console.log(c.red + `  Dead-letter sample (${dead.length} of N):` + c.reset);
    for (const d of dead) {
      console.log(`    ${d.sha.slice(0, 12)}…  attempts=${d.attempts}  err=${(d.last_error || '').slice(0, 60)}`);
      console.log(`      ${d.url_full.slice(0, 120)}`);
    }
  }
}

async function flowRerunDead(rl) {
  const cities = listCities();
  const cityIdx = cities.length === 1 ? 0 : await pickOne(rl, 'Pick city:', cities.map((c) => c.name));
  const city = cities[cityIdx].name;
  const db = openManifest(manifestPath(city));
  const n = db.prepare("SELECT COUNT(*) AS n FROM blobs WHERE status = 'dead'").get();
  if (!n.n) { console.log(c.dim + 'no dead URLs' + c.reset); db.close(); return; }
  const ok = await askYN(rl, `Reset ${n.n} dead URLs back to 'pending' (attempts reset)?`);
  if (!ok) { db.close(); return; }
  db.prepare("UPDATE blobs SET status = 'pending', attempts = 0, last_error = NULL WHERE status = 'dead'").run();
  console.log(c.green + `${n.n} URLs reset to pending. Resume the relevant task to retry.` + c.reset);
  db.close();
}

async function flowQuery(rl) {
  const cities = listCities();
  const cityIdx = cities.length === 1 ? 0 : await pickOne(rl, 'Pick city:', cities.map((c) => c.name));
  const city = cities[cityIdx].name;
  const db = openManifest(manifestPath(city));
  console.log();
  const o = await pickOne(rl, 'Query:', [
    'Coverage by place (top 10 with most pending)',
    'Top failed domains',
    'Bytes done by source',
    'Recently downloaded (last 50)',
  ]);
  if (o === 0) {
    const rows = db.prepare(`
      SELECT r.place_name, r.place_id,
             COUNT(DISTINCT b.sha) AS total,
             SUM(CASE WHEN b.status='done' THEN 1 ELSE 0 END) AS done,
             SUM(CASE WHEN b.status='pending' THEN 1 ELSE 0 END) AS pending
      FROM refs r JOIN blobs b ON b.sha = r.sha
      GROUP BY r.place_id
      HAVING pending > 0
      ORDER BY pending DESC LIMIT 10
    `).all();
    for (const r of rows) console.log(`  ${r.done}/${r.total}  pending=${r.pending}  ${r.place_name || r.place_id}`);
  } else if (o === 1) {
    const rows = db.prepare(`
      SELECT
        substr(url_full, 1, instr(substr(url_full, 9), '/') + 8) AS host_prefix,
        COUNT(*) AS n
      FROM blobs WHERE status IN ('failed','dead') GROUP BY host_prefix ORDER BY n DESC LIMIT 5
    `).all();
    for (const r of rows) console.log(`  ${r.n}  ${r.host_prefix}`);
  } else if (o === 2) {
    const rows = db.prepare(`
      SELECT r.source, COUNT(DISTINCT b.sha) AS n, SUM(b.bytes) AS bytes
      FROM refs r JOIN blobs b ON b.sha = r.sha
      WHERE b.status = 'done' GROUP BY r.source
    `).all();
    for (const r of rows) console.log(`  ${r.source.padEnd(22)} ${r.n}  ${fmtBytes(r.bytes)}`);
  } else if (o === 3) {
    const rows = db.prepare(`
      SELECT sha, bytes, fetched_at FROM blobs WHERE status='done' ORDER BY fetched_at DESC LIMIT 50
    `).all();
    for (const r of rows) console.log(`  ${r.fetched_at}  ${fmtBytes(r.bytes).padStart(8)}  ${r.sha.slice(0, 12)}`);
  }
  db.close();
}

async function flowGC(rl) {
  const cities = listCities();
  const cityIdx = cities.length === 1 ? 0 : await pickOne(rl, 'Pick city:', cities.map((c) => c.name));
  const city = cities[cityIdx].name;
  const root = imagesRoot(city);
  const blobsRoot = path.join(root, '_blobs');
  if (!fs.existsSync(blobsRoot)) { console.log(c.dim + 'no _blobs/ dir yet' + c.reset); return; }
  const db = openManifest(manifestPath(city));
  // Find blob files on disk not referenced by any DB row OR with no refs.
  console.log('Scanning _blobs/ ...');
  const onDisk = new Set();
  for (const sub of fs.readdirSync(blobsRoot)) {
    const subDir = path.join(blobsRoot, sub);
    if (!fs.statSync(subDir).isDirectory()) continue;
    for (const f of fs.readdirSync(subDir)) {
      if (f.endsWith('.part')) continue;
      onDisk.add(f.replace(/\.(jpg|png|webp)$/, ''));
    }
  }
  const known = new Set(db.prepare('SELECT sha FROM blobs').all().map((r) => r.sha));
  const orphans = [...onDisk].filter((sha) => !known.has(sha));
  console.log(`  on disk: ${onDisk.size}  in DB: ${known.size}  orphans: ${orphans.length}`);
  if (orphans.length === 0) { db.close(); return; }
  const ok = await askYN(rl, `Delete ${orphans.length} orphaned blob files?`, 'n');
  if (!ok) { db.close(); return; }
  let removed = 0;
  for (const sha of orphans) {
    const guess = path.join(blobsRoot, sha.slice(0, 2), sha + '.jpg');
    try { fs.unlinkSync(guess); removed++; } catch {}
  }
  console.log(c.green + `removed ${removed} orphan files` + c.reset);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main menu
// ─────────────────────────────────────────────────────────────────────────────

function liveTaskBanner() {
  const all = [];
  for (const city of listCities()) {
    const rows = tasksSummary(city.name);
    for (const r of rows) if (r.state === 'running' || r.state === 'paused') all.push({ city: city.name, ...r });
  }
  if (all.length === 0) return;
  console.log(c.dim + '  active tasks:' + c.reset);
  for (const r of all) {
    const pct = r.progress.total > 0 ? (r.progress.done / r.progress.total * 100).toFixed(1) + '%' : '-';
    console.log(`    #${r.task_id} ${r.city}  ${stateLabel(r.state)}  ${r.progress.done || 0}/${r.progress.total || 0} (${pct})  alive=${r.alive ? 'yes' : 'no'}`);
  }
}

function banner() {
  console.log();
  console.log(c.bold + '╔═══════════════════════════════════════════════════════════════╗' + c.reset);
  console.log(c.bold + '║              Stage 5 — Image Downloader                       ║' + c.reset);
  console.log(c.bold + '╚═══════════════════════════════════════════════════════════════╝' + c.reset);
}

async function main() {
  const rl = makeRL();
  try {
    while (true) {
      banner();
      liveTaskBanner();
      console.log();
      console.log('  [1] New download task');
      console.log('  [2] List + manage tasks  (pause/resume/kill/attach/tail)');
      console.log('  [3] Query manifest        (coverage, failures, throughput)');
      console.log('  [4] Re-run dead URLs');
      console.log('  [5] Cleanup orphaned blob files');
      console.log('  [q] Quit');
      console.log();
      const choice = await ask(rl, 'Select', '1');
      if (choice === 'q' || choice === 'Q') break;
      try {
        if (choice === '1') await flowNewTask(rl);
        else if (choice === '2') await flowList(rl);
        else if (choice === '3') await flowQuery(rl);
        else if (choice === '4') await flowRerunDead(rl);
        else if (choice === '5') await flowGC(rl);
        else console.log(c.red + 'invalid choice' + c.reset);
      } catch (e) {
        console.log(c.red + 'ERROR: ' + e.message + c.reset);
      }
      console.log();
      await ask(rl, c.dim + 'press enter to continue' + c.reset, '');
    }
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}
