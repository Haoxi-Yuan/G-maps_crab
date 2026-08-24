#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { chromium } = require('playwright');  // 使用原生 Playwright

async function main() {
  console.log('Starting Google Maps Scraper with Proxy (Native Playwright)...\n');

  // 读取代理配置
  const proxyData = JSON.parse(fs.readFileSync('proxy-config-iproyal.json', 'utf8'));
  const proxy = proxyData.proxies.find(p => p.country === 'SG');

  console.log('Proxy:', proxy.server);

  // 启动浏览器
  const browser = await chromium.launch({
    headless: false,
    proxy: {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password
    }
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore'
  });

  const page = await context.newPage();

  // 读取 pipeline 脚本
  const pipelinePath = '/Volumes/Data/scraper/google-maps-scraper-pipeline.js';
  const pipelineSrc = fs.readFileSync(pipelinePath, 'utf8')
    .replace(/downloadJSON\(\s*cleanedData\s*,\s*filename\s*\);\s*/g, 'window.__gmap_last = cleanedData;');

  // 读取 place IDs
  const placeIds = JSON.parse(fs.readFileSync('coordinates_singapore.json', 'utf8'));

  console.log(`Total places: ${placeIds.length}`);
  console.log('Processing first 3 places...\n');

  const limit = 3;
  const results = [];

  for (let i = 0; i < Math.min(limit, placeIds.length); i++) {
    const placeId = placeIds[i].place_id;
    const url = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en`;

    try {
      console.log(`[${i + 1}/${limit}] Visiting: ${placeId}`);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 90000
      });

      // 等待页面加载
      await page.waitForSelector('h1', { timeout: 30000 });
      await page.waitForTimeout(1500);

      // 执行 pipeline 脚本
      console.log(`[${i + 1}/${limit}] Extracting data...`);
      const result = await page.evaluate(pipelineSrc);

      if (result && typeof result === 'object') {
        result._meta = { placeId, sourceUrl: url };
        results.push(result);
        console.log(`[${i + 1}/${limit}] Success: ${result.title || 'No title'}`);
      } else {
        console.warn(`[${i + 1}/${limit}] Warning: No data extracted`);
      }

      // 延迟
      await page.waitForTimeout(2000);

    } catch (err) {
      console.error(`[${i + 1}/${limit}] Error: ${err.message}`);
    }
  }

  await browser.close();

  // 保存结果
  const outFile = 'output/gmaps_proxy_test.ndjson';
  fs.mkdirSync('output', { recursive: true });
  const outStream = fs.createWriteStream(outFile, { flags: 'w' });

  results.forEach(r => {
    outStream.write(JSON.stringify(r) + '\n');
  });

  outStream.end();

  console.log(`\nDone! Saved ${results.length} results to ${outFile}`);
}

main().catch(console.error);
