#!/usr/bin/env node
'use strict';

/**
 * POI Searcher Module
 * 从采样点搜索周边POI，提取place_id
 *
 * 工作流程:
 * 1. 读取采样点(lat/lng)和POI类别
 * 2. 为每个采样点x类别组合生成搜索链接
 * 3. 访问搜索页，滚动加载结果
 * 4. 提取place链接并解析place_id
 * 5. 去重后返回place_id列表
 */

const fs = require('fs');

// ============================================
// 配置常量
// ============================================

const SEARCH_CONFIG = {
  // 默认搜索半径
  defaultZoom: '1000m',

  // 每个搜索最大滚动次数
  maxScrolls: 15,

  // 滚动延迟 (毫秒)
  scrollDelay: 800,

  // 搜索间延迟 (毫秒)
  searchDelay: 2000,

  // 选择器
  selectors: {
    feedContainer: '[role="feed"]',
    endOfList: 'p.fontBodyMedium > span > span',
    placeLinks: 'a[href*="/maps/place/"]',
    businessCards: 'div[jsaction*="mouseover:pane"]'
  }
};

// ============================================
// URL生成函数
// ============================================

/**
 * 移除字符串中的空格
 */
function removeSpaces(str) {
  return String(str).replace(/\s+/g, '');
}

/**
 * 生成Google Maps搜索链接
 * @param {string} query - POI类别 (e.g., "Restaurant")
 * @param {number} lat - 纬度
 * @param {number} lng - 经度
 * @param {string} zoom - 缩放级别 (e.g., "1000m" 或 "14z")
 * @param {string} lang - 语言代码
 * @returns {string} 搜索URL
 */
function createSearchLink(query, lat, lng, zoom = SEARCH_CONFIG.defaultZoom, lang = 'en') {
  const endpoint = encodeURIComponent(query);

  // 构建基础参数
  const params = new URLSearchParams({
    authuser: '0',
    hl: lang,
    entry: 'ttu'
  });

  // 构建坐标字符串: @lat,lng,zoom (无空格)
  // Ensure zoom has a unit suffix (e.g. "1000m" or "14z"); bare numbers default to meters
  const zoomStr = /^\d+$/.test(String(zoom)) ? `${zoom}m` : String(zoom);
  const geoStr = `/@${removeSpaces(`${lat},${lng}`)},${zoomStr}`;

  // 完整URL
  const url = `https://www.google.com/maps/search/${endpoint}${geoStr}?${params.toString()}`;

  return url;
}

// ============================================
// Place ID提取函数
// ============================================

/**
 * 从HTML中提取可能的place链接
 * 处理单结果直接跳转的情况
 */
function extractPossibleMapLink(html) {
  try {
    const parts = html.split(';window.APP_INITIALIZATION_STATE=');
    if (parts.length < 2) return null;

    const initState = parts[1].split(';window.APP_FLAGS')[0];
    const data = parseInitializationState(initState);

    // 尝试多个可能的路径
    const link = safeGet(data, 6, 27) || safeGet(data, 0, 1, 0, 14, 27);

    if (link && link.includes('/maps/place')) {
      return link;
    }
  } catch (err) {
    // Ignore parsing errors
  }
  return null;
}

/**
 * 解析APP_INITIALIZATION_STATE
 */
function parseInitializationState(data) {
  const loaded = JSON.parse(data);
  const inputString = safeGet(loaded, 3, -1);

  if (!inputString) return null;

  const substring = ")]}'";
  let modified = inputString;

  if (inputString.startsWith(substring)) {
    modified = inputString.substring(substring.length);
  }

  return JSON.parse(modified);
}

/**
 * 从解析后的数据中提取place_id
 */
function getPlaceId(data) {
  return safeGet(data, 6, 78);
}

/**
 * 从URL中提取place_id (优先方法)
 * Google Maps URL格式: /maps/place/...data=!...!1s{place_id}!...
 */
function extractPlaceIdFromUrl(url) {
  try {
    // 方法1: 优先提取ChIJ格式 (从!19s参数，可直接用于place_id:查询)
    const chijMatch = url.match(/!19s(ChIJ[^!?&]+)/);
    if (chijMatch && chijMatch[1]) {
      return decodeURIComponent(chijMatch[1]);
    }

    // 方法2: 从data参数中提取 (格式: !1s{place_id})
    const dataMatch = url.match(/!1s([A-Za-z0-9_-]+)/);
    if (dataMatch && dataMatch[1]) {
      return dataMatch[1];
    }

    // 方法3: 从ftid参数提取
    const ftidMatch = url.match(/ftid=([A-Za-z0-9_:-]+)/);
    if (ftidMatch && ftidMatch[1]) {
      return ftidMatch[1];
    }

    return null;
  } catch (err) {
    return null;
  }
}

/**
 * 从页面HTML提取place_id
 */
function extractPlaceIdFromHtml(html) {
  try {
    const parts = html.split(';window.APP_INITIALIZATION_STATE=');
    if (parts.length < 2) return null;

    const initState = parts[1].split(';window.APP_FLAGS')[0];
    const data = parseInitializationState(initState);

    return getPlaceId(data);
  } catch (err) {
    console.error(`[PLACE-ID] Extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * 安全获取嵌套对象属性
 */
function safeGet(obj, ...keys) {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      return null;
    }
    current = current[key];
  }
  return current;
}

// ============================================
// 搜索结果滚动和收集
// ============================================

/**
 * 滚动搜索结果页面并收集所有place链接
 * @param {Page} page - Playwright page对象
 * @param {Object} options - 配置选项
 * @returns {Promise<string[]>} place链接数组
 */
async function scrollAndCollectLinks(page, options = {}) {
  const maxScrolls = options.maxScrolls || SEARCH_CONFIG.maxScrolls;
  const scrollDelay = options.scrollDelay || SEARCH_CONFIG.scrollDelay;

  const links = [];

  try {
    // 1. 检查是否有feed容器
    const feedExists = await page.locator(SEARCH_CONFIG.selectors.feedContainer).count() > 0;

    if (!feedExists) {
      // 情况A: 没有feed - 可能单个结果直接跳转
      const currentUrl = page.url();

      if (currentUrl.includes('/maps/place/')) {
        // 直接跳转到place页
        return [currentUrl];
      } else if (currentUrl.includes('/maps/search/')) {
        // 搜索页但没有feed - 尝试从HTML提取
        const html = await page.content();
        const link = extractPossibleMapLink(html);
        return link ? [link] : [];
      }

      return [];
    }

    // 2. 正常情况: 滚动加载结果
    console.log(`[SCROLL] Starting to scroll feed (max ${maxScrolls} times)`);

    for (let i = 0; i < maxScrolls; i++) {
      // 滚动feed容器
      await page.evaluate((selector) => {
        const feed = document.querySelector(selector);
        if (feed) {
          feed.scrollBy(0, Math.round(feed.clientHeight * 0.85));
        }
      }, SEARCH_CONFIG.selectors.feedContainer);

      // 等待内容加载
      await page.waitForTimeout(scrollDelay);

      // 检查是否到达列表底部
      const endReached = await page.locator(SEARCH_CONFIG.selectors.endOfList).count() > 0;
      if (endReached) {
        console.log(`[SCROLL] Reached end of list at scroll ${i + 1}`);
        break;
      }

      // 检查是否无法继续滚动
      const canScroll = await page.evaluate((selector) => {
        const feed = document.querySelector(selector);
        if (!feed) return false;
        return feed.scrollHeight > feed.scrollTop + feed.clientHeight;
      }, SEARCH_CONFIG.selectors.feedContainer);

      if (!canScroll && i > 3) {
        console.log(`[SCROLL] Cannot scroll further at scroll ${i + 1}`);
        break;
      }
    }

    // 3. 收集所有place链接
    const linkElements = await page.locator(SEARCH_CONFIG.selectors.placeLinks).all();

    for (const el of linkElements) {
      try {
        const href = await el.getAttribute('href');
        if (href && href.includes('/maps/place/')) {
          // 清理URL (移除&opi等参数)
          const cleanUrl = href.split('&opi')[0];
          links.push(cleanUrl);
        }
      } catch (err) {
        // 忽略单个链接提取失败
      }
    }

    console.log(`[SCROLL] Collected ${links.length} place links`);

  } catch (err) {
    console.error(`[SCROLL] Error during scrolling: ${err.message}`);
  }

  // 去重
  return [...new Set(links)];
}

// ============================================
// 主搜索函数
// ============================================

/**
 * 为单个采样点搜索指定类别的POI
 * @param {Object} page - Playwright page对象
 * @param {Object} point - 采样点 {lat, lng}
 * @param {string} category - POI类别
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 搜索结果 {placeIds, links, searchUrl}
 */
async function searchPOIsForPoint(page, point, category, options = {}) {
  const { lat, lng } = point;
  const zoom = options.zoom || SEARCH_CONFIG.defaultZoom;
  const lang = options.lang || 'en';

  // 1. 生成搜索URL
  const searchUrl = createSearchLink(category, lat, lng, zoom, lang);
  console.log(`[SEARCH] ${category} @ (${lat}, ${lng})`);
  console.log(`[SEARCH] URL: ${searchUrl}`);

  try {
    // 2. 访问搜索页
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // 等待页面稳定
    await page.waitForTimeout(2000);

    // 3. 滚动并收集链接
    const placeLinks = await scrollAndCollectLinks(page, options);

    if (placeLinks.length === 0) {
      console.log(`[SEARCH] No results found`);
      return {
        searchUrl,
        placeLinks: [],
        placeIds: [],
        count: 0
      };
    }

    // 4. 提取place_id
    const placeIds = [];
    const linkWithIds = [];

    for (const link of placeLinks) {
      try {
        // 方法1: 从URL直接提取 (快速、可靠)
        let placeId = extractPlaceIdFromUrl(link);

        // 方法2: 如果URL提取失败，访问页面提取
        if (!placeId && options.extractPlaceIdFromPage !== false) {
          await page.goto(link, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await page.waitForTimeout(1000);

          const html = await page.content();
          placeId = extractPlaceIdFromHtml(html);
        }

        if (placeId) {
          placeIds.push(placeId);
          linkWithIds.push({ link, placeId });
        }
      } catch (err) {
        console.warn(`[PLACE-ID] Failed to extract from ${link}: ${err.message}`);
      }
    }

    console.log(`[SEARCH] Found ${placeIds.length} place_ids`);

    return {
      searchUrl,
      placeLinks,
      placeIds,
      linkWithIds,
      count: placeIds.length
    };

  } catch (err) {
    console.error(`[SEARCH] Error: ${err.message}`);
    return {
      searchUrl,
      placeLinks: [],
      placeIds: [],
      error: err.message,
      count: 0
    };
  }
}

/**
 * 批量搜索: 多个采样点 x 多个类别
 * @param {Object} browser - Playwright browser对象
 * @param {Array} points - 采样点数组 [{lat, lng}, ...]
 * @param {Array} categories - 类别数组 ["Restaurant", ...]
 * @param {Object} options - 配置选项
 * @param {Function} progressCallback - 进度回调函数 (current, total, currentPlace)
 * @returns {Promise<Object>} 汇总结果
 */
async function batchSearchPOIs(browser, points, categories, options = {}, progressCallback = null) {
  const results = [];
  const allPlaceIds = new Set();
  const allLinks = [];

  // Resume support: load existing search results if available
  const incrementalSaveFile = options.incrementalSaveFile;
  const saveInterval = options.saveInterval || 50;
  const completedSearches = new Set(); // Track "pointIndex:category" combos already done
  let resumedCount = 0;

  if (incrementalSaveFile && fs.existsSync(incrementalSaveFile)) {
    try {
      const existingData = JSON.parse(fs.readFileSync(incrementalSaveFile, 'utf8'));
      const existingProgress = existingData.progress || {};
      const existingResults = existingData.results || [];
      const existingPlaceIds = existingData.uniquePlaceIds || [];

      if (existingResults.length > 0) {
        // Restore previous results
        for (const r of existingResults) {
          results.push(r);
          const key = `${r.pointIndex}:${r.category}`;
          completedSearches.add(key);
          if (r.placeIds) r.placeIds.forEach(id => allPlaceIds.add(id));
          if (r.placeLinks) allLinks.push(...r.placeLinks);
        }
        // Also restore any place_ids that were in the unique list but maybe not in results
        for (const id of existingPlaceIds) {
          allPlaceIds.add(id);
        }
        resumedCount = completedSearches.size;
        console.log(`[BATCH] Resuming from checkpoint: ${resumedCount} searches already done, ${allPlaceIds.size} place_ids loaded`);
      }
    } catch (err) {
      console.warn(`[BATCH] Could not load existing search results for resume: ${err.message}`);
    }
  }

  const context = await browser.newContext({
    userAgent: options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: options.lang || 'en-US'
  });

  const page = await context.newPage();

  try {
    let searchCount = resumedCount;
    const totalSearches = points.length * categories.length;

    for (let i = 0; i < points.length; i++) {
      const point = points[i];

      for (let j = 0; j < categories.length; j++) {
        const category = categories[j];
        const searchKey = `${i}:${category}`;

        // Skip already completed searches (resume support)
        if (completedSearches.has(searchKey)) {
          continue;
        }

        searchCount++;

        console.log(`\n[BATCH] Progress: ${searchCount}/${totalSearches} - Point ${i + 1}/${points.length}, Category: ${category}`);

        // Call progress callback if provided
        if (progressCallback && typeof progressCallback === 'function') {
          progressCallback(searchCount, totalSearches, `Searching: ${category} at point ${i + 1}/${points.length}`);
        }

        const result = await searchPOIsForPoint(page, point, category, options);

        results.push({
          pointIndex: i,
          point,
          category,
          ...result
        });

        // 收集所有place_id
        result.placeIds.forEach(id => allPlaceIds.add(id));
        allLinks.push(...result.placeLinks);

        // Incremental save (with atomic write to prevent data loss)
        if (incrementalSaveFile && searchCount % saveInterval === 0) {
          const partialResults = {
            timestamp: new Date().toISOString(),
            progress: {
              searchCount,
              totalSearches,
              percentage: Math.round((searchCount / totalSearches) * 100)
            },
            totalPlaceIds: allPlaceIds.size,
            uniquePlaceIds: Array.from(allPlaceIds),
            results
          };

          try {
            // Atomic write: write to temp file first, then rename
            const tmpFile = incrementalSaveFile + '.tmp';
            fs.writeFileSync(tmpFile, JSON.stringify(partialResults, null, 2), 'utf8');
            fs.renameSync(tmpFile, incrementalSaveFile);
            console.log(`[BATCH] Incremental save: ${allPlaceIds.size} unique place_ids (${searchCount}/${totalSearches} searches)`);
          } catch (err) {
            console.error(`[BATCH] Failed to save incremental results: ${err.message}`);
          }
        }

        // 搜索间延迟
        if (searchCount < totalSearches) {
          const delay = options.searchDelay || SEARCH_CONFIG.searchDelay;
          console.log(`[BATCH] Waiting ${delay}ms before next search...`);
          await page.waitForTimeout(delay);
        }
      }
    }

  } finally {
    await page.close();
    await context.close();
  }

  return {
    totalSearches: results.length,
    uniquePlaceIds: Array.from(allPlaceIds),
    totalPlaceIds: allPlaceIds.size,
    results
  };
}

// ============================================
// 文件读取辅助函数
// ============================================

/**
 * 从CSV读取采样点
 * 支持列名: lat/lng 或 latitude/longitude
 */
function loadPointsFromCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.trim().split(/\r?\n/);

  if (lines.length < 2) {
    throw new Error('CSV file must have header and at least one data row');
  }

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());

  // 尝试多种列名格式
  let latIdx = header.findIndex(h => h === 'lat' || h === 'latitude');
  let lngIdx = header.findIndex(h => h === 'lng' || h === 'longitude' || h === 'lon');

  if (latIdx === -1 || lngIdx === -1) {
    throw new Error('CSV must contain lat/latitude and lng/longitude columns. Found columns: ' + header.join(', '));
  }

  const points = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    const lat = parseFloat(row[latIdx]);
    const lng = parseFloat(row[lngIdx]);

    if (!isNaN(lat) && !isNaN(lng)) {
      points.push({ lat, lng });
    }
  }

  return points;
}

/**
 * 从JSON读取采样点
 */
function loadPointsFromJSON(jsonPath) {
  const content = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(content);

  if (Array.isArray(data)) {
    return data.filter(p => p.lat != null && p.lng != null);
  }

  throw new Error('JSON must be an array of {lat, lng} objects');
}

/**
 * 加载POI类别配置
 */
function loadCategories(configPath) {
  const content = fs.readFileSync(configPath, 'utf8');
  const data = JSON.parse(content);

  if (data.categories && Array.isArray(data.categories)) {
    return data.categories;
  }

  if (Array.isArray(data)) {
    return data;
  }

  throw new Error('Invalid categories config format');
}

// ============================================
// 导出
// ============================================

module.exports = {
  createSearchLink,
  scrollAndCollectLinks,
  extractPlaceIdFromHtml,
  searchPOIsForPoint,
  batchSearchPOIs,
  loadPointsFromCSV,
  loadPointsFromJSON,
  loadCategories,
  SEARCH_CONFIG
};
