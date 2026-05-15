#!/usr/bin/env node
'use strict';

/**
 * Discovery script for Google Maps photo categories.
 *
 * Goal: figure out (a) which `preview/place` field carries the per-category
 * photo manifest shown on the overview ("Menu", "Food & drink", "Soup",
 * "Latest", "Videos", ...) and (b) which RPC endpoint serves the full photo
 * list when a category card is clicked.
 *
 * Strategy: open each test place, capture every photo-related response,
 * scan the DOM for category cards, then click each card one at a time and
 * record the network requests it triggers. Output is dumped to ./discovery
 * for offline analysis — this script does NOT try to parse the responses,
 * just makes them available.
 *
 * Run:
 *   node scripts/discover-photo-categories.js          # headless
 *   node scripts/discover-photo-categories.js --headed # watch the run
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const stealth = require('../src/stealth');

const URLS = [
  {
    name: 'hua_kee_chicken_rice',
    url: 'https://www.google.com/maps/place/Hua+Kee+Cantonese+Chicken+Rice+-+Toh+Yi+Drive/@1.3414047,103.7721628,17.06z/data=!4m6!3m5!1s0x31da11007b1f6c8b:0xac9b77502deefcd5!8m2!3d1.3399916!4d103.7730156!16s%2Fg%2F11ykbfch8w?hl=en',
  },
  {
    name: 'bukit_timah_wet_market',
    url: 'https://www.google.com/maps/place/Bukit+Timah+Wet+Market+%26+Food+Centre+(Interim)/@1.3414047,103.7721628,17.06z/data=!3m1!5s0x31da10aa2612e7e3:0xf2683b57ccbb720c!4m6!3m5!1s0x31da108a1e060fc1:0x69d17c2ce13247e5!8m2!3d1.3407156!4d103.775054!16s%2Fg%2F1tfqhx60?hl=en',
  },
];

const OUT_ROOT = path.join(__dirname, '..', 'discovery');

// URL patterns we suspect carry photo data. Bodies are dumped for these.
// Includes preview/lp — a ~30 KB response at page load that looks like a
// pre-fetched photo manifest (discovered via maps_api_index.ndjson).
const PHOTO_URL_RE = /\/maps\/(preview\/(place|photo|lp)|rpc\/(listentityphotos|listugcposts|getplaceattachment)|photometa)/i;
// Index-everything filter: any /maps/ call NOT for tiles/static assets.
// We record URL + status + length for these too, so we can spot the photo-
// list endpoint even if its name doesn't match PHOTO_URL_RE above.
const MAPS_API_RE = /\/maps\/(rpc|preview|photometa|vt|api)\//i;
const SKIP_RE = /\/(vt|jsapi|jsapi-staging|api\/js|images\/)/i;

function safeName(s) {
  return (s || 'unknown').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x';
}

async function discoverOne(browser, { name, url }) {
  const outDir = path.join(OUT_ROOT, name);
  const clicksDir = path.join(outDir, 'clicks');
  fs.mkdirSync(clicksDir, { recursive: true });

  console.log(`\n=== ${name} ===`);
  console.log(`URL: ${url}`);

  const { context, page } = await stealth.createStealthContext(browser, {});

  // -------------------------------------------------------------------
  // Capture every photo-relevant response. Keep raw body in memory so we
  // can slice it per-click; the index also gets streamed to disk.
  // -------------------------------------------------------------------
  const allResponses = []; // { url, status, body, seq, ts } — only for PHOTO_URL_RE
  const reqLog = fs.createWriteStream(path.join(outDir, 'requests.ndjson'));
  // Index ALL maps API calls (URL+status+length, no body) so we can spot
  // unknown endpoints we never guessed.
  const allApiLog = fs.createWriteStream(path.join(outDir, 'maps_api_index.ndjson'));
  let seq = 0;

  page.on('response', async (resp) => {
    const u = resp.url();
    const isMapsApi = MAPS_API_RE.test(u) && !SKIP_RE.test(u);
    const isPhoto = PHOTO_URL_RE.test(u);

    // Body-less index for any maps API call
    if (isMapsApi || isPhoto) {
      let length = 0;
      try { const buf = await resp.body(); length = buf.length; } catch (e) {}
      allApiLog.write(JSON.stringify({
        seq, ts: Date.now(), url: u, status: resp.status(), length,
      }) + '\n');
    }
    if (!isPhoto) return;
    let body = null;
    try { body = await resp.text(); } catch (e) {}
    const entry = { url: u, status: resp.status(), body, seq: seq++, ts: Date.now() };
    allResponses.push(entry);
    reqLog.write(JSON.stringify({
      seq: entry.seq,
      ts: entry.ts,
      url: u,
      status: entry.status,
      bodyLength: body ? body.length : 0,
      bodyPreview: body ? body.slice(0, 800) : null,
    }) + '\n');
  });

  // -------------------------------------------------------------------
  // Navigate — same two-step dance as src/review-scraper.js, otherwise
  // Google sometimes serves a degraded panel layout (no photo grid).
  // -------------------------------------------------------------------
  // Extract ftid from URL if present (e.g. !1s0x31da...:0xac9b...)
  const ftidMatch = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  const ftid = ftidMatch ? ftidMatch[1] : null;

  await page.goto('https://www.google.com/maps?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('h1', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  if (ftid) {
    await page.goto(`https://www.google.com/maps/place/?ftid=${ftid}&hl=en`, {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await page.waitForSelector('h1', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3500);
  }

  // Scroll the place panel to surface lazy-loaded sections. The panel is
  // the scrollable region containing the h1, find it dynamically.
  await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    if (!h1) return;
    let el = h1.parentElement;
    while (el) {
      const ov = getComputedStyle(el).overflowY;
      if (ov === 'auto' || ov === 'scroll') { el.scrollTop = 0; break; }
      el = el.parentElement;
    }
  });
  await page.waitForTimeout(1500);
  // Scroll progressively to trigger lazy loads
  for (const top of [200, 400, 700, 1000, 1500]) {
    await page.evaluate((t) => {
      const h1 = document.querySelector('h1');
      if (!h1) return;
      let el = h1.parentElement;
      while (el) {
        const ov = getComputedStyle(el).overflowY;
        if (ov === 'auto' || ov === 'scroll') { el.scrollTop = t; break; }
        el = el.parentElement;
      }
    }, top);
    await page.waitForTimeout(800);
  }

  // Dump full HTML so we can grep offline for the photo card markup
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(outDir, 'page.html'), html);
  } catch (e) {}

  // -------------------------------------------------------------------
  // Save the preview/place response if we caught one
  // -------------------------------------------------------------------
  const previewResp = allResponses.find(r => r.url.includes('/maps/preview/place'));
  if (previewResp && previewResp.body) {
    fs.writeFileSync(path.join(outDir, 'preview_place.raw.txt'), previewResp.body);
    try {
      const parsed = JSON.parse(previewResp.body.replace(/^\)\]\}'\n/, ''));
      fs.writeFileSync(path.join(outDir, 'preview_place.json'), JSON.stringify(parsed, null, 2));
      console.log(`  preview/place saved (${(previewResp.body.length / 1024).toFixed(1)} KB)`);
    } catch (e) {
      console.log(`  preview/place parse failed: ${e.message}`);
    }
  } else {
    console.log('  WARN: no preview/place response captured');
  }

  // -------------------------------------------------------------------
  // DOM scan: find every button that's a photo-category card.
  //
  // The category LABELS (Menu, Food & drink, Soup, Hainanese chicken rice,
  // Original Chendol from Nonya Chendol, Pork Satay, Latest, Videos, All, …)
  // vary per place — Google makes them up from the photo content. So we
  // must NOT filter by label keywords. The structural anchor we trust is
  // the section header above the cards: "Menu", "Menu & highlights",
  // "Photos & videos", "Photos", "Highlights" (English) and likely
  // localised equivalents (we still match on these for now because the
  // scraper forces hl=en).
  //
  // Within those sections we accept *any* button of a card-like size —
  // label comes from aria-label / inner text, whatever Google chose.
  // -------------------------------------------------------------------
  const SECTION_HEADER_RE_SRC = '^(menu|menu\\s*&\\s*highlights|photos|photos\\s*&\\s*videos|highlights)$';
  // Cast a wider net: <button>, <a>, [role="button"], [role="link"], and
  // any clickable div with a jsaction. Photo cards on current Maps are
  // often <button jsaction="..."> but the markup churns; cover all bases.
  const categories = await page.evaluate((headerReSrc) => {
    const headerRe = new RegExp(headerReSrc, 'i');
    function nearestHeaderText(el) {
      let cur = el;
      for (let depth = 0; depth < 14 && cur; depth++, cur = cur.parentElement) {
        let prev = cur.previousElementSibling;
        while (prev) {
          const h = prev.querySelector?.('h2, h3') || (prev.matches?.('h2,h3') ? prev : null);
          if (h && h.textContent) return h.textContent.trim();
          prev = prev.previousElementSibling;
        }
      }
      return null;
    }
    const all = Array.from(document.querySelectorAll(
      'button, a, [role="button"], [role="link"], [jsaction]'
    ));
    // Deduplicate (an element might match multiple selectors)
    const seen = new Set();
    const unique = all.filter(el => { if (seen.has(el)) return false; seen.add(el); return true; });

    const out = [];
    unique.forEach((el, idx) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) return;
      const header = nearestHeaderText(el);
      const underMediaHeader = !!(header && headerRe.test(header.trim()));
      // Compute a stable selector path so we can re-find on click
      let selectorPath = el.tagName.toLowerCase();
      if (el.id) selectorPath += '#' + el.id;
      const out_entry = {
        globalIndex: idx, // index into the deduped clickable-element array
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        ariaLabel: el.getAttribute('aria-label') || '',
        text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        hasImg: !!el.querySelector('img'),
        hasBgImage: /url\(/.test(getComputedStyle(el).backgroundImage || ''),
        jsaction: el.getAttribute('jsaction') || null,
        href: el.getAttribute('href') || null,
        nearestHeader: header,
        underMediaHeader,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
      out.push(out_entry);
    });
    return out;
  }, SECTION_HEADER_RE_SRC);

  const photoCards = categories.filter(c => c.underMediaHeader);
  fs.writeFileSync(path.join(outDir, 'dom_categories.json'), JSON.stringify({
    allHeuristicMatches: categories,
    underMediaHeaders: photoCards,
  }, null, 2));
  console.log(`  DOM scan: ${categories.length} candidate buttons, ${photoCards.length} under media headers`);

  // -------------------------------------------------------------------
  // Click each photo card in turn; record what fired
  // -------------------------------------------------------------------
  for (let i = 0; i < photoCards.length; i++) {
    const card = photoCards[i];
    const label = card.ariaLabel || card.text || `card${i}`;
    const slug = `${String(i).padStart(2, '0')}_${safeName(label)}`;
    console.log(`  [${i + 1}/${photoCards.length}] click "${label}" (header=${card.nearestHeader})`);

    const before = allResponses.length;
    try {
      await page.evaluate((gi) => {
        const all = Array.from(document.querySelectorAll(
          'button, a, [role="button"], [role="link"], [jsaction]'
        ));
        const seen = new Set();
        const unique = all.filter(el => { if (seen.has(el)) return false; seen.add(el); return true; });
        const el = unique[gi];
        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
      }, card.globalIndex);
      await page.waitForTimeout(2500);
      // Some categories load more lazily — gentle scroll inside the opened panel
      await page.evaluate(() => {
        const panels = document.querySelectorAll('[role="dialog"], [role="region"], [aria-label*="hotos" i], [aria-label*="enu" i]');
        for (const p of panels) p.scrollTop = Math.min(p.scrollHeight, 2000);
      }).catch(() => {});
      await page.waitForTimeout(1500);
    } catch (e) {
      console.log(`     click error: ${e.message}`);
    }

    const fired = allResponses.slice(before);
    fs.writeFileSync(path.join(clicksDir, `${slug}.json`), JSON.stringify({
      card,
      firedCount: fired.length,
      fired: fired.map(r => ({
        seq: r.seq,
        url: r.url,
        status: r.status,
        bodyLength: r.body ? r.body.length : 0,
        bodyPreview: r.body ? r.body.slice(0, 1500) : null,
      })),
    }, null, 2));
    // Dump full bodies for the bigger responses (likely the photo list)
    fired.forEach((r, j) => {
      if (!r.body) return;
      const fname = `${slug}__resp${String(j).padStart(2, '0')}__seq${r.seq}.raw.txt`;
      fs.writeFileSync(path.join(clicksDir, fname), r.body);
    });

    // Close any opened overlay/photo viewer before next click
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    // Ensure we're back at the overview by clicking the place name if needed
    await page.evaluate(() => {
      const back = document.querySelector('button[aria-label*="Back" i]');
      if (back) back.click();
    }).catch(() => {});
    await page.waitForTimeout(800);
  }

  // -------------------------------------------------------------------
  // Final probe: actually OPEN the photo viewer. JS .click() doesn't
  // trigger Maps' jsaction handlers (they listen to mousedown/mouseup),
  // so use Playwright's real mouse via locator + click(). Record page.url()
  // before/after — Maps is an SPA and the data fragment encodes view state.
  // -------------------------------------------------------------------
  {
    const before = allResponses.length;
    const beforeAllSeq = seq;
    const urlBefore = page.url();
    let urlAfter = urlBefore;
    try {
      // Find the bounding rect of the first carousel image and use page.mouse
      // to click in the middle — this fires real mousedown/mouseup events.
      const target = await page.evaluate(() => {
        const region = document.querySelector('[role="region"][aria-label*="hotos of" i]');
        if (!region) return null;
        const imgs = Array.from(region.querySelectorAll('img'));
        for (const img of imgs) {
          const r = img.getBoundingClientRect();
          if (r.width > 100 && r.height > 100) {
            img.scrollIntoView({ block: 'center' });
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
          }
        }
        return null;
      });
      if (!target) {
        console.log('  [PROBE] no carousel image found');
      } else {
        console.log(`  [PROBE] clicking at (${target.x.toFixed(0)},${target.y.toFixed(0)})`);
        // Re-locate rect after scroll just in case
        await page.waitForTimeout(500);
        const target2 = await page.evaluate(() => {
          const region = document.querySelector('[role="region"][aria-label*="hotos of" i]');
          if (!region) return null;
          const imgs = Array.from(region.querySelectorAll('img'));
          for (const img of imgs) {
            const r = img.getBoundingClientRect();
            if (r.width > 100 && r.height > 100) {
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
          return null;
        });
        const pt = target2 || target;
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(6000);
        urlAfter = page.url();
        console.log(`  [PROBE] URL ${urlBefore === urlAfter ? 'UNCHANGED' : 'CHANGED'}`);
        if (urlBefore !== urlAfter) {
          fs.writeFileSync(path.join(outDir, 'photo_viewer_url_after_click.txt'),
            'BEFORE:\n' + urlBefore + '\n\nAFTER:\n' + urlAfter + '\n');
        }
        // Try arrow keys to advance the viewer
        for (let k = 0; k < 5; k++) {
          await page.keyboard.press('ArrowRight').catch(() => {});
          await page.waitForTimeout(1500);
        }
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('[role="dialog"], [role="grid"]')) {
            el.scrollTop = Math.min(el.scrollHeight, 4000);
          }
        }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      console.log(`  [PROBE] error: ${e.message}`);
    }
    const fired = allResponses.slice(before);
    fs.writeFileSync(path.join(outDir, 'photo_viewer_probe.json'), JSON.stringify({
      urlBefore, urlAfter, urlChanged: urlBefore !== urlAfter,
      photoResponsesFired: fired.map(r => ({
        seq: r.seq, url: r.url, status: r.status, bodyLength: r.body ? r.body.length : 0,
        bodyPreview: r.body ? r.body.slice(0, 1500) : null,
      })),
      note: 'For full unknown-endpoint list, see maps_api_index.ndjson entries with seq >= ' + beforeAllSeq,
    }, null, 2));
    fired.forEach((r, j) => {
      if (!r.body) return;
      fs.writeFileSync(path.join(outDir, `photo_viewer_resp${String(j).padStart(2, '0')}__seq${r.seq}.raw.txt`), r.body);
    });
    await page.keyboard.press('Escape').catch(() => {});
  }

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  const endpointCounts = {};
  for (const r of allResponses) {
    const m = r.url.match(/\/maps\/(preview\/place|preview\/photo|rpc\/listentityphotos|rpc\/listugcposts|rpc\/getplaceattachment|photometa)/);
    const key = m ? m[1] : 'other';
    endpointCounts[key] = (endpointCounts[key] || 0) + 1;
  }
  const summary = [
    `# Discovery: ${name}`,
    ``,
    `URL: ${url}`,
    `Captured responses: ${allResponses.length}`,
    `Categories under media headers: ${photoCards.length}`,
    ``,
    `## Endpoint counts`,
    ...Object.entries(endpointCounts).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Categories clicked`,
    ...photoCards.map((c, i) => `- [${i}] ${c.ariaLabel || c.text} (header=${c.nearestHeader})`),
    ``,
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), summary);

  reqLog.end();
  allApiLog.end();
  await context.close();
}

(async () => {
  const headed = process.argv.includes('--headed');
  const browser = await chromium.launch({
    headless: !headed,
    args: stealth.buildLaunchArgs(),
  });
  try {
    for (const item of URLS) {
      try { await discoverOne(browser, item); }
      catch (e) { console.error(`[${item.name}] failed: ${e.stack || e.message}`); }
    }
  } finally {
    await browser.close();
  }
  console.log(`\nDone. Output: ${OUT_ROOT}`);
})();
