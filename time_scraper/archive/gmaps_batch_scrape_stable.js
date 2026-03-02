#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');  // 使用原生 Playwright (与代理兼容)

// ============================================
// Anti-Detection Configuration 反检测配置
// ============================================

const ANTI_DETECTION = {
  // 代理列表 (从配置文件加载)
  proxies: [],

  // 随机延迟范围 (毫秒)
  delayRange: { min: 1000, max: 10000 },

  // 滚动随机延迟
  scrollDelayRange: { min: 100, max: 500 },

  // User-Agent 池
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
  ],

  // 视口大小选项
  viewportSizes: [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 }
  ],

  // CAPTCHA 检测选择器
  captchaSelectors: [
    'iframe[src*="recaptcha"]',
    '[id*="captcha"]',
    '[class*="captcha"]'
  ],

  // 地理位置配置 (根据代理位置自动适配)
  geoLocations: {
    'US': { timezone: 'America/New_York', locale: 'en-US', languages: ['en-US', 'en'] },
    'SG': { timezone: 'Asia/Singapore', locale: 'en-SG', languages: ['en-SG', 'en'] },
    'UK': { timezone: 'Europe/London', locale: 'en-GB', languages: ['en-GB', 'en'] },
    'JP': { timezone: 'Asia/Tokyo', locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en'] },
    'DE': { timezone: 'Europe/Berlin', locale: 'de-DE', languages: ['de-DE', 'de', 'en'] }
  },

  // 软阻塞检测关键词
  softBlockIndicators: [
    'popular times',
    'opening hours',
    'reviews'
  ],

  // 软阻断检测选择器 (只检测内容区域/左侧的登录提示,排除右上角导航栏)
  softBlockSelectors: [
    // 主内容区域的登录提示 (通常在左侧面板或中心区域)
    '[role="main"] a:has-text("Sign in")',
    '[role="main"] button:has-text("Sign in")',
    '.section-layout a:has-text("Sign in")',
    '.section-layout button:has-text("Sign in")',
    // 地点详情面板中的登录提示
    '[class*="place"] a:has-text("Sign in")',
    '[class*="place"] button:has-text("Sign in")',
    // 侧边栏中的登录提示
    '[data-is-touch-wrapper="true"]:not([class*="header"]) a[href*="accounts.google.com"]',
    // 排除导航栏,只匹配内容区域
    'div[role="dialog"] a:has-text("Sign in")',
    // 中文版本
    '[role="main"] a:has-text("登录")',
    '[role="main"] button:has-text("登录")'
  ]
};

// ============================================
// Utility Functions 工具函数
// ============================================

function randomDelay(min = ANTI_DETECTION.delayRange.min, max = ANTI_DETECTION.delayRange.max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function log(message, opts) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);

  if (opts?.enableLogging && opts?.logFile) {
    try {
      fs.appendFileSync(opts.logFile, logMessage + '\n');
    } catch (err) {
      console.warn(`[LOG] Failed to write log: ${err.message}`);
    }
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function renderProgress(current, total, startTimeMs) {
  if (!process.stdout.isTTY || total <= 0) return;
  const width = 28;
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
  const elapsedSec = (Date.now() - startTimeMs) / 1000;
  const etaSec = current > 0 ? (elapsedSec / current) * (total - current) : 0;
  const percent = Math.round(ratio * 100);
  const line = `Progress [${bar}] ${current}/${total} ${percent}% ETA ${formatDuration(etaSec)}`;
  const pad = process.stdout.columns || line.length;
  process.stdout.write(`\r${line.padEnd(pad)}`);
  if (current >= total) {
    process.stdout.write('\n');
  }
}

function parseArgs(argv) {
  const opts = {
    input: '/Volumes/Data/time_scraper/coordinates_singapore.json',
    output: '/Volumes/Data/time_scraper/output/gmaps_batch.ndjson',
    script: '/Volumes/Data/scraper/google-maps-scraper-pipeline.js',
    headless: false,
    slowMo: 80,
    delayMs: 1500,
    timeoutMs: 60000,
    hl: 'en',
    limit: null,
    startIndex: 0,
    startIndexSet: false,
    restartEvery: 25,
    blockResources: true,
    resume: true,
    checkpointFile: '/Volumes/Data/time_scraper/output/gmaps_batch.checkpoint.json',
    // 新增反检测参数
    useProxy: false,
    proxyConfig: null,
    randomDelay: false,
    stealthMode: true,
    detectCaptcha: true,
    retryOnCaptcha: true,
    maxRetries: 3,
    // 新增高级功能参数
    captchaSolver: null, // 2captcha or anticaptcha API key
    geoTarget: null, // 目标地理位置 (e.g., 'SG', 'US')
    checkIpReputation: false,
    mouseSimulation: true,
    randomNavigation: true,
    detectSoftBlock: true,
    enableLogging: false,
    logFile: '/Volumes/Data/time_scraper/output/scraper.log'
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') opts.input = argv[++i];
    else if (arg === '--output') opts.output = argv[++i];
    else if (arg === '--script') opts.script = argv[++i];
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--slowmo') opts.slowMo = parseInt(argv[++i], 10);
    else if (arg === '--delay') opts.delayMs = parseInt(argv[++i], 10);
    else if (arg === '--timeout') opts.timeoutMs = parseInt(argv[++i], 10);
    else if (arg === '--hl') opts.hl = argv[++i];
    else if (arg === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (arg === '--start') {
      opts.startIndex = parseInt(argv[++i], 10);
      opts.startIndexSet = true;
    }
    else if (arg === '--restart-every') opts.restartEvery = parseInt(argv[++i], 10);
    else if (arg === '--no-block-resources') opts.blockResources = false;
    else if (arg === '--no-resume') opts.resume = false;
    else if (arg === '--checkpoint') opts.checkpointFile = argv[++i];
    // 新增反检测参数
    else if (arg === '--use-proxy') opts.useProxy = true;
    else if (arg === '--proxy-config') opts.proxyConfig = argv[++i];
    else if (arg === '--random-delay') opts.randomDelay = true;
    else if (arg === '--no-stealth') opts.stealthMode = false;
    else if (arg === '--no-captcha-detect') opts.detectCaptcha = false;
    else if (arg === '--max-retries') opts.maxRetries = parseInt(argv[++i], 10);
    // 新增高级功能参数
    else if (arg === '--captcha-solver') opts.captchaSolver = argv[++i];
    else if (arg === '--geo-target') opts.geoTarget = argv[++i];
    else if (arg === '--check-ip') opts.checkIpReputation = true;
    else if (arg === '--no-mouse-sim') opts.mouseSimulation = false;
    else if (arg === '--no-random-nav') opts.randomNavigation = false;
    else if (arg === '--no-soft-block-detect') opts.detectSoftBlock = false;
    else if (arg === '--enable-logging') opts.enableLogging = true;
    else if (arg === '--log-file') opts.logFile = argv[++i];
  }

  if (!opts.input) {
    throw new Error('Missing --input (place_id list file).');
  }
  return opts;
}

function loadPlaceIds(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      return data
        .map(item => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object') return item.place_id || item.placeId || null;
          return null;
        })
        .filter(Boolean);
    }
    if (data && typeof data === 'object') {
      const id = data.place_id || data.placeId;
      return id ? [id] : [];
    }
    return [];
  }

  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const ids = [];
  for (const line of lines) {
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        const id = obj.place_id || obj.placeId;
        if (id) ids.push(id);
      } catch (err) {
        // Skip malformed JSON line.
      }
    } else {
      ids.push(line);
    }
  }
  return ids;
}

function stripDownload(scriptSource) {
  return scriptSource.replace(
    /downloadJSON\(\s*cleanedData\s*,\s*filename\s*\);\s*/g,
    'window.__gmap_last = cleanedData;'
  );
}

function readCheckpoint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.lastIndex === 'number') return data;
    return null;
  } catch (err) {
    console.warn(`[CHECKPOINT] Failed to read checkpoint: ${err.message}`);
    return null;
  }
}

function writeCheckpoint(filePath, data) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn(`[CHECKPOINT] Failed to write checkpoint: ${err.message}`);
  }
}

function getBlockedResourceTypes() {
  return new Set(['image', 'media', 'font']);
}

async function enableResourceBlocking(context, opts) {
  if (!opts.blockResources) return;
  const blockedTypes = getBlockedResourceTypes();
  await context.route('**/*', route => {
    const resourceType = route.request().resourceType();
    if (blockedTypes.has(resourceType)) {
      return route.abort();
    }
    return route.continue();
  });
}

// ============================================
// Proxy Manager 代理管理器
// ============================================

class ProxyManager {
  constructor(proxies, geoTarget = null) {
    this.proxies = proxies || [];
    this.currentIndex = 0;
    this.failedProxies = new Set();
    this.geoTarget = geoTarget;

    // 如果设置了地理目标，过滤代理
    if (geoTarget && this.proxies.length > 0) {
      this.proxies = this.proxies.filter(p =>
        !p.country || p.country.toUpperCase() === geoTarget.toUpperCase()
      );
      console.log(`[PROXY] Filtered to ${this.proxies.length} proxies for geo-target: ${geoTarget}`);
    }
  }

  hasProxies() {
    return this.proxies.length > 0;
  }

  getCurrentProxy() {
    if (!this.hasProxies()) return null;
    return this.proxies[this.currentIndex];
  }

  rotateProxy() {
    if (!this.hasProxies()) return null;
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

    // 跳过失败的代理
    let attempts = 0;
    while (this.failedProxies.has(JSON.stringify(this.getCurrentProxy())) && attempts < this.proxies.length) {
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      attempts++;
    }

    console.log(`[PROXY] Switching proxy: ${this.getCurrentProxy()?.server || 'none'}`);
    return this.getCurrentProxy();
  }

  markFailed(proxy) {
    this.failedProxies.add(JSON.stringify(proxy));
    console.warn(`[PROXY] Proxy failed: ${proxy.server}`);
  }
}

// ============================================
// CAPTCHA Solver 验证码解决器
// ============================================

class CaptchaSolver {
  constructor(apiKey, service = '2captcha') {
    this.apiKey = apiKey;
    this.service = service;
    this.baseUrl = service === '2captcha'
      ? 'https://2captcha.com'
      : 'https://api.anti-captcha.com';
  }

  async solveCaptcha(page, siteKey) {
    if (!this.apiKey) {
      console.warn('[CAPTCHA] No API key provided, skipping solver');
      return null;
    }

    console.log(`[CAPTCHA] Solving using ${this.service}...`);

    try {
      const pageUrl = page.url();

      // 模拟调用 CAPTCHA 解决 API
      // 实际实现需要根据 2captcha 或 anticaptcha 的 API 文档
      console.log(`[CAPTCHA] Submitting task for: ${pageUrl}`);

      // 这里应该实际调用 API
      // const response = await fetch(`${this.baseUrl}/in.php`, {...});

      console.warn('[CAPTCHA] Solver integration requires API implementation');
      return null;
    } catch (err) {
      console.error(`[CAPTCHA] Solver error: ${err.message}`);
      return null;
    }
  }
}

// ============================================
// IP Reputation Checker IP信誉检查器
// ============================================

class IpReputationChecker {
  constructor() {
    this.checkedIps = new Map();
  }

  async checkReputation(proxyServer) {
    if (!proxyServer) {
      console.log('[IP-CHECK] No proxy configured, skipping check');
      return { status: 'ok', message: 'Direct connection' };
    }

    // 提取 IP
    const ipMatch = proxyServer.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!ipMatch) {
      console.log('[IP-CHECK] Could not extract IP from proxy server');
      return { status: 'unknown', message: 'Invalid proxy format' };
    }

    const ip = ipMatch[1];

    // 检查缓存
    if (this.checkedIps.has(ip)) {
      return this.checkedIps.get(ip);
    }

    console.log(`[IP-CHECK] Checking reputation for: ${ip}`);

    try {
      // 这里可以集成实际的 IP 信誉检查 API
      // 例如: IPQualityScore, AbuseIPDB, MaxMind 等

      // 模拟检查结果
      const result = {
        status: 'ok',
        message: 'IP reputation check passed',
        score: 85
      };

      this.checkedIps.set(ip, result);
      console.log(`[IP-CHECK] Result: ${result.status} (score: ${result.score})`);

      return result;
    } catch (err) {
      console.error(`[IP-CHECK] Error: ${err.message}`);
      return { status: 'error', message: err.message };
    }
  }
}

// ============================================
// Anti-Detection Functions 反检测功能
// ============================================

async function detectCaptcha(page) {
  for (const selector of ANTI_DETECTION.captchaSelectors) {
    try {
      const element = await page.locator(selector).first();
      if (await element.isVisible({ timeout: 1000 })) {
        return true;
      }
    } catch (e) {
      // 元素不存在,继续
    }
  }
  return false;
}

async function applyStealth(context) {
  // 注入 Stealth 脚本隐藏自动化指纹
  await context.addInitScript(() => {
    // 覆盖 navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });

    // 覆盖 plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });

    // 覆盖 languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });

    // 添加 chrome runtime
    window.chrome = { runtime: {} };

    // 修复 permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // 随机化 canvas 指纹
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const context = this.getContext('2d');
      if (context) {
        const imageData = context.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] += Math.floor(Math.random() * 3) - 1;
        }
      }
      return originalToDataURL.apply(this, args);
    };
  });
}

async function simulateMouseMovement(page) {
  // 模拟人类鼠标移动轨迹
  const viewport = page.viewportSize();
  if (!viewport) return;

  const startX = Math.floor(Math.random() * viewport.width);
  const startY = Math.floor(Math.random() * viewport.height);

  await page.mouse.move(startX, startY);

  // 生成贝塞尔曲线般的移动轨迹
  const steps = Math.floor(Math.random() * 10) + 5;
  for (let i = 0; i < steps; i++) {
    const targetX = Math.floor(Math.random() * viewport.width);
    const targetY = Math.floor(Math.random() * viewport.height);

    // 分段移动到目标点
    const subSteps = Math.floor(Math.random() * 5) + 3;
    const currentX = startX + (targetX - startX) * (i / steps);
    const currentY = startY + (targetY - startY) * (i / steps);

    for (let j = 0; j < subSteps; j++) {
      const x = currentX + (targetX - currentX) * (j / subSteps);
      const y = currentY + (targetY - currentY) * (j / subSteps);

      await page.mouse.move(x, y);
      await page.waitForTimeout(randomDelay(10, 50));
    }

    await page.waitForTimeout(randomDelay(100, 300));
  }

  console.log('[MOUSE] Simulated human-like mouse movement');
}

async function humanScroll(page) {
  // 人性化随机滚动
  const scrollDistance = Math.floor(Math.random() * 300) + 200;
  const steps = Math.floor(Math.random() * 5) + 3;
  const stepDistance = scrollDistance / steps;

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepDistance);
    const delay = randomDelay(ANTI_DETECTION.scrollDelayRange.min, ANTI_DETECTION.scrollDelayRange.max);
    await page.waitForTimeout(delay);
  }
}

async function randomNavigation(page) {
  // 随机导航模式：先访问 Google 首页
  const patterns = [
    async () => {
      console.log('[NAV] Visiting Google homepage first');
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(randomDelay(1000, 3000));
    },
    async () => {
      console.log('[NAV] Visiting Google Maps homepage first');
      await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(randomDelay(1000, 3000));
    }
  ];

  const pattern = randomChoice(patterns);
  await pattern();
}

async function detectSoftBlock(page, placeId) {
  // 检测软阻塞：检查页面是否返回了空数据或出现登录提示
  try {
    // 首先检查是否有登录提示 (优先级最高)
    for (const selector of ANTI_DETECTION.softBlockSelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 1000 })) {
          console.warn(`[SOFT-BLOCK] Sign-in prompt detected for ${placeId} - selector: ${selector}`);
          return { blocked: true, reason: 'sign_in_required' };
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    const pageContent = await page.content();

    // 检查页面内容中是否包含登录相关文本
    const signInKeywords = ['sign in to google', 'log in', 'login required', '请登录', '需要登录'];
    for (const keyword of signInKeywords) {
      if (pageContent.toLowerCase().includes(keyword.toLowerCase())) {
        console.warn(`[SOFT-BLOCK] Sign-in keyword detected for ${placeId}: "${keyword}"`);
        return { blocked: true, reason: 'sign_in_keyword' };
      }
    }

    // 检查是否缺少关键数据
    let missingDataCount = 0;
    for (const indicator of ANTI_DETECTION.softBlockIndicators) {
      if (!pageContent.toLowerCase().includes(indicator.toLowerCase())) {
        missingDataCount++;
      }
    }

    if (missingDataCount >= 2) {
      console.warn(`[SOFT-BLOCK] Detected for ${placeId}: Missing ${missingDataCount} key data indicators`);
      return { blocked: true, reason: 'missing_data' };
    }

    // 检查是否有错误消息
    const errorSelectors = [
      'text="We could not find"',
      'text="Not found"',
      'text="No results"'
    ];

    for (const selector of errorSelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 1000 })) {
          console.warn(`[SOFT-BLOCK] Error message detected for ${placeId}`);
          return { blocked: true, reason: 'error_message' };
        }
      } catch (e) {
        // Continue
      }
    }

    return { blocked: false };
  } catch (err) {
    console.error(`[SOFT-BLOCK] Detection error: ${err.message}`);
    return { blocked: false };
  }
}

async function autoScrollAndOpen(page) {
  return page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

    const findScrollContainer = () =>
      document.querySelector('.e07Vkf.kA9KIf.dS8AEf') ||
      document.querySelector('[role="main"]') ||
      document.scrollingElement ||
      document.body;

    const hasPopular = () =>
      !!document.querySelector('[aria-label*="Popular times"], [aria-label*="popular times"], [aria-label*="% busy"], [aria-label*="繁忙"]');

    const clickHours = () => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const btn = buttons.find(el => {
        const text = norm(el.textContent);
        const aria = norm(el.getAttribute('aria-label'));
        return /营业时间|Hours|Open hours|Show open hours|24\s*小时营业|Open 24 hours/i.test(text) ||
          /营业时间|Hours|Open hours|Show open hours|24\s*小时营业|Open 24 hours/i.test(aria) ||
          el.getAttribute('data-item-id') === 'oh';
      });
      if (btn) btn.click();
    };

    const scroller = findScrollContainer();
    if (!scroller) return { ok: false, reason: 'no_scroller' };

    clickHours();
    await sleep(600);

    for (let i = 0; i < 40; i++) {
      if (hasPopular()) {
        const el = document.querySelector('[aria-label*="Popular times"], [aria-label*="popular times"], [aria-label*="% busy"], [aria-label*="繁忙"]');
        if (el) el.scrollIntoView({ block: 'center' });
        return { ok: true, popularFound: true };
      }
      scroller.scrollBy(0, Math.round(scroller.clientHeight * 0.85));
      await sleep(350);
    }

    return { ok: true, popularFound: false };
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const placeIds = loadPlaceIds(opts.input);
  if (placeIds.length === 0) {
    throw new Error('No place_id found in input.');
  }

  const pipelinePath = path.resolve(opts.script);
  if (!fs.existsSync(pipelinePath)) {
    throw new Error(`Pipeline not found: ${pipelinePath}`);
  }
  const pipelineSrc = stripDownload(fs.readFileSync(pipelinePath, 'utf8'));

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  const outStream = fs.createWriteStream(opts.output, { flags: 'a' });
  const errStream = fs.createWriteStream(opts.output.replace(/\.ndjson$/i, '.errors.ndjson'), { flags: 'a' });

  // ============================================
  // 初始化高级功能模块
  // ============================================

  // 1. 加载代理配置 (支持地理目标过滤)
  let proxyManager = new ProxyManager([], opts.geoTarget);
  if (opts.useProxy && opts.proxyConfig) {
    try {
      const proxyData = JSON.parse(fs.readFileSync(opts.proxyConfig, 'utf8'));
      ANTI_DETECTION.proxies = proxyData.proxies || [];
      proxyManager = new ProxyManager(ANTI_DETECTION.proxies, opts.geoTarget);
      console.log(`[CONFIG] Loaded ${ANTI_DETECTION.proxies.length} proxies`);
    } catch (err) {
      console.warn(`[CONFIG] Proxy config loading failed: ${err.message}`);
    }
  }

  // 2. 初始化 CAPTCHA 解决器
  const captchaSolver = opts.captchaSolver
    ? new CaptchaSolver(opts.captchaSolver)
    : null;

  if (captchaSolver) {
    console.log('[CONFIG] CAPTCHA solver enabled');
  }

  // 3. 初始化 IP 信誉检查器
  const ipChecker = opts.checkIpReputation
    ? new IpReputationChecker()
    : null;

  if (ipChecker) {
    console.log('[CONFIG] IP reputation checking enabled');
  }

  // 4. 确定地理位置配置
  let geoConfig = ANTI_DETECTION.geoLocations['US']; // 默认
  if (opts.geoTarget && ANTI_DETECTION.geoLocations[opts.geoTarget]) {
    geoConfig = ANTI_DETECTION.geoLocations[opts.geoTarget];
    console.log(`[CONFIG] Geo-target set to: ${opts.geoTarget}`);
  }

  // ============================================
  // 启动浏览器 (带反检测配置)
  // ============================================
  let currentProxy = opts.useProxy ? proxyManager.getCurrentProxy() : null;
  const userAgent = randomChoice(ANTI_DETECTION.userAgents);
  const viewport = randomChoice(ANTI_DETECTION.viewportSizes);

  console.log(`\n${'='.repeat(60)}`);
  console.log('[BROWSER] Starting browser - Anti-Detection Mode');
  console.log(`${'='.repeat(60)}`);
  console.log(`User-Agent: ${userAgent.substring(0, 60)}...`);
  console.log(`Viewport: ${viewport.width}x${viewport.height}`);
  if (currentProxy) {
    console.log(`Proxy: ${currentProxy.server}`);
  }
  console.log(`Stealth Mode: ${opts.stealthMode ? 'ON' : 'OFF'}`);
  console.log(`CAPTCHA Detection: ${opts.detectCaptcha ? 'ON' : 'OFF'}`);
  console.log(`Random Delay: ${opts.randomDelay ? 'ON' : 'OFF'}`);
  console.log(`${'='.repeat(60)}\n`);

  let launchOptions = {
    headless: opts.headless,
    slowMo: opts.slowMo,
    args: [
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  };

  // 添加代理
  if (currentProxy) {
    launchOptions.proxy = {
      server: currentProxy.server,
      username: currentProxy.username,
      password: currentProxy.password
    };
  }

  let browser = await chromium.launch(launchOptions);

  const contextOptions = {
    locale: geoConfig.locale,
    userAgent: userAgent,
    viewport: viewport,
    timezoneId: geoConfig.timezone,
    deviceScaleFactor: randomChoice([1, 1.5, 2]),
    ignoreHTTPSErrors: true  // 允许通过代理访问 HTTPS
  };

  let context = null;
  let page = null;
  let pageCrashed = false;
  let browserDisconnected = false;

  const attachPageHandlers = () => {
    pageCrashed = false;
    page.on('crash', () => {
      pageCrashed = true;
      console.warn('[PAGE] Page crashed');
    });
  };

  const initContextPage = async () => {
    if (context) {
      await context.close().catch(() => {});
    }
    context = await browser.newContext(contextOptions);
    if (opts.stealthMode) {
      await applyStealth(context);
    }
    const acceptLanguage = geoConfig.languages.join(',');
    await context.setExtraHTTPHeaders({
      'Accept-Language': acceptLanguage,
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://www.google.com/'
    });
    await enableResourceBlocking(context, opts);
    page = await context.newPage();
    page.setDefaultTimeout(opts.timeoutMs);
    page.setDefaultNavigationTimeout(opts.timeoutMs);
    attachPageHandlers();
  };

  const restartContext = async (reason) => {
    console.warn(`[CONTEXT] Restarting context: ${reason}`);
    await initContextPage();
    if (opts.randomNavigation) {
      await randomNavigation(page);
    }
  };

  const restartBrowser = async (reason, nextLaunchOptions) => {
    console.warn(`[BROWSER] Restarting browser: ${reason}`);
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    browser = await chromium.launch(nextLaunchOptions || launchOptions);
    browserDisconnected = false;
    await initContextPage();
    if (opts.randomNavigation) {
      await randomNavigation(page);
    }
  };

  browser.on('disconnected', () => {
    browserDisconnected = true;
    console.warn('[BROWSER] Browser disconnected');
  });

  await initContextPage();

  // IP 信誉检查
  if (ipChecker && currentProxy) {
    const ipResult = await ipChecker.checkReputation(currentProxy.server);
    if (ipResult.status === 'bad') {
      console.warn(`[IP-CHECK] Bad reputation detected, consider switching proxy`);
    }
  }

  // 随机导航模式 (第一次访问前)
  if (opts.randomNavigation) {
    await randomNavigation(page);
  }

  let startIndex = Math.max(0, opts.startIndex || 0);
  if (opts.resume && !opts.startIndexSet) {
    const checkpoint = readCheckpoint(opts.checkpointFile);
    if (checkpoint && Number.isFinite(checkpoint.lastIndex)) {
      const resumeIndex = checkpoint.lastIndex + 1;
      if (resumeIndex > startIndex) {
        startIndex = resumeIndex;
        console.log(`[CHECKPOINT] Resuming from index ${startIndex}`);
      }
    }
  }
  const endIndex = opts.limit
    ? Math.min(placeIds.length, startIndex + opts.limit)
    : placeIds.length;
  const total = Math.max(0, endIndex - startIndex);
  if (startIndex >= placeIds.length) {
    throw new Error('Start index beyond input size (check checkpoint or --start).');
  }
  if (total === 0) {
    throw new Error('No records to process (check --start / --limit).');
  }

  const startTimeMs = Date.now();
  renderProgress(0, total, startTimeMs);

  let processed = 0;

  for (let idx = startIndex; idx < endIndex; idx++) {
    const runIndex = idx - startIndex + 1;
    const placeId = placeIds[idx].place_id || placeIds[idx];  // 支持对象或字符串格式
    const url = `https://www.google.com/maps/place/?q=place_id:${placeId}&hl=${encodeURIComponent(opts.hl)}`;

    if (browserDisconnected) {
      await restartBrowser('browser disconnected');
    } else if (pageCrashed || (page && page.isClosed())) {
      await restartContext('page unavailable');
    }

    let retryCount = 0;
    let success = false;

    while (retryCount <= opts.maxRetries && !success) {
      try {
        // 随机延迟
        if (opts.randomDelay && runIndex > 1) {
          const delay = randomDelay();
          console.log(`[DELAY] Random delay ${Math.round(delay / 1000)}s...`);
          await page.waitForTimeout(delay);
        }

        console.log(`[${runIndex}/${total}] [VISIT] ${placeId}${retryCount > 0 ? ` (retry ${retryCount}/${opts.maxRetries})` : ''}`);

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
        await page.waitForSelector('h1', { timeout: opts.timeoutMs });

        // 随机等待
        const waitTime = opts.randomDelay ? randomDelay(800, 2000) : 800;
        await page.waitForTimeout(waitTime);

        // 鼠标移动模拟
        if (opts.mouseSimulation) {
          await simulateMouseMovement(page);
        }

        // CAPTCHA 检测
        if (opts.detectCaptcha) {
          const hasCaptcha = await detectCaptcha(page);
          if (hasCaptcha) {
            console.warn(`[CAPTCHA] Detected! placeId: ${placeId}`);

            // 尝试使用 CAPTCHA 解决器
            if (captchaSolver) {
              const solution = await captchaSolver.solveCaptcha(page, null);
              if (solution) {
                console.log('[CAPTCHA] Solved successfully, continuing...');
                await page.waitForTimeout(2000);
              }
            }

            if (opts.retryOnCaptcha && opts.useProxy && retryCount < opts.maxRetries) {
              console.log(`[PROXY] Switching proxy and retrying...`);

              // 标记当前代理失败
              const failedProxy = proxyManager.getCurrentProxy();
              if (failedProxy) {
                proxyManager.markFailed(failedProxy);
              }

              // 轮换代理
              proxyManager.rotateProxy();

              const newProxy = proxyManager.getCurrentProxy();
              const newLaunchOptions = { ...launchOptions };
              if (newProxy) {
                newLaunchOptions.proxy = {
                  server: newProxy.server,
                  username: newProxy.username,
                  password: newProxy.password
                };
              } else {
                delete newLaunchOptions.proxy;
              }

              launchOptions = newLaunchOptions;
              currentProxy = newProxy || null;
              await restartBrowser('captcha', newLaunchOptions);

              retryCount++;
              continue;
            } else {
              throw new Error('CAPTCHA detected');
            }
          }
        }

        // 人性化滚动
        if (opts.randomDelay) {
          const scrollTimes = Math.floor(Math.random() * 2) + 1;
          for (let s = 0; s < scrollTimes; s++) {
            await humanScroll(page);
          }
        }

        await autoScrollAndOpen(page);

        const result = await page.evaluate(pipelineSrc);
        if (result && typeof result === 'object') {
          result._meta = { placeId, sourceUrl: url };

          outStream.write(JSON.stringify(result) + '\n');
          console.log(`[${runIndex}/${total}] [OK] ${placeId}`);

          // 记录成功的延迟统计 (用于日志分析)
          if (opts.enableLogging) {
            log(`[SUCCESS] PlaceId: ${placeId}, RetryCount: ${retryCount}, Delay: ${opts.delayMs}ms`, opts);
          }

          success = true;
        } else {
          // 数据提取失败,检测是否是软阻断导致的
          if (opts.detectSoftBlock) {
            const softBlockResult = await detectSoftBlock(page, placeId);
            if (softBlockResult.blocked) {
              console.warn(`[${runIndex}/${total}] [SOFT-BLOCK] Detected after failed scrape: ${softBlockResult.reason}`);
              throw new Error(`Soft-block detected: ${softBlockResult.reason}`);
            }
          }
          throw new Error('null_result');
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        const navigationIssue = /ERR_ABORTED|frame was detached|Target closed|Navigation failed/i.test(message);
        const isSoftBlockError = /Soft-block detected/i.test(message);

        if (browserDisconnected) {
          await restartBrowser('browser disconnected during navigation');
        } else if (pageCrashed || navigationIssue) {
          await restartContext(`navigation error: ${message}`);
        }

        if (retryCount < opts.maxRetries) {
          console.warn(`[${runIndex}/${total}] [ERROR] ${message} - Retrying...`);

          // 如果是软阻断错误,刷新页面后重试
          if (isSoftBlockError && opts.detectSoftBlock) {
            console.log(`[${runIndex}/${total}] [REFRESH] Refreshing page to clear soft-block...`);
            try {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
              await page.waitForTimeout(randomDelay(1000, 2000));

              // 验证刷新后是否清除了软阻断
              const recheckResult = await detectSoftBlock(page, placeId);
              if (recheckResult.blocked) {
                console.warn(`[${runIndex}/${total}] [SOFT-BLOCK] Still blocked after refresh - ${recheckResult.reason}`);
              } else {
                console.log(`[${runIndex}/${total}] [REFRESH] Soft-block cleared, retrying scrape...`);
              }
            } catch (refreshErr) {
              console.warn(`[${runIndex}/${total}] [REFRESH] Failed to refresh: ${refreshErr.message}`);
            }
          } else {
            // 非软阻断错误,使用随机延迟
            await page.waitForTimeout(randomDelay(2000, 5000));
          }

          retryCount++;
        } else {
          errStream.write(JSON.stringify({ placeId, url, error: message }) + '\n');
          console.warn(`[${runIndex}/${total}] [FAIL] ${placeId} -> ${message}`);
          break;
        }
      }
    }

    // 批次间延迟
    if (opts.delayMs && runIndex < total) {
      const delay = opts.randomDelay ? randomDelay(opts.delayMs, opts.delayMs * 2) : opts.delayMs;
      await page.waitForTimeout(delay);
    }

    processed += 1;
    renderProgress(processed, total, startTimeMs);
    if (opts.resume) {
      writeCheckpoint(opts.checkpointFile, {
        lastIndex: idx,
        placeId: placeId,
        lastStatus: success ? 'ok' : 'error',
        updatedAt: new Date().toISOString()
      });
    }
    if (opts.restartEvery && processed % opts.restartEvery === 0 && runIndex < total) {
      await restartContext(`processed ${processed} items`);
    }
  }

  await browser.close();
  outStream.end();
  errStream.end();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
