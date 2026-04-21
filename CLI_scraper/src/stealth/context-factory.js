/**
 * context-factory.js
 *
 * Integrates all stealth modules into a single context creation function.
 * This is the primary API for business-layer code to create stealth browser contexts.
 *
 * Combines: stealth-args + fingerprint-factory + apply-stealth + resource-blocker
 * Ported context options from Scrapling StealthySessionMixin.__validate__()
 */

'use strict';

const { buildLaunchArgs } = require('./stealth-args');
const { generateFingerprint, buildHeaders } = require('./fingerprint-factory');
const { applyStealth } = require('./apply-stealth');
const { enableResourceBlocking } = require('./resource-blocker');
const { ProxyRotator } = require('./proxy-rotator');

/**
 * Build Playwright launch options with stealth args.
 *
 * @param {Object} opts
 * @param {boolean} [opts.headless=false]
 * @param {number} [opts.slowMo=80]
 * @param {Object} [opts.proxy] - Playwright proxy {server, username?, password?}
 * @param {boolean} [opts.blockWebRTC=true]
 * @param {boolean} [opts.canvasNoise=true]
 * @param {boolean} [opts.allowWebGL=true]
 * @param {boolean} [opts.noSandbox=false]
 * @returns {Object} Playwright launch options
 */
function buildLaunchOptions(opts = {}) {
  const launchOptions = {
    headless: opts.headless !== undefined ? opts.headless : false,
    slowMo: opts.slowMo !== undefined ? opts.slowMo : 80,
    args: buildLaunchArgs({
      blockWebRTC: opts.blockWebRTC !== undefined ? opts.blockWebRTC : true,
      canvasNoise: opts.canvasNoise !== undefined ? opts.canvasNoise : true,
      allowWebGL: opts.allowWebGL !== undefined ? opts.allowWebGL : true,
      noSandbox: opts.noSandbox !== undefined ? opts.noSandbox : false,
    }),
  };

  if (opts.proxy) {
    launchOptions.proxy = ProxyRotator.toPlaywrightProxy(opts.proxy);
  }

  return launchOptions;
}

/**
 * Create a stealth-enhanced browser context with all protections applied.
 *
 * This replaces the inline initContextPage() in both IPC and with_reviews scrapers.
 * Applies in order:
 *   1. Generate consistent fingerprint
 *   2. Create context with Scrapling-style options (colorScheme, permissions, etc.)
 *   3. Inject stealth scripts (navigator, canvas, WebGL, etc.)
 *   4. Set extra HTTP headers with client hints
 *   5. Enable resource blocking
 *
 * @param {import('playwright').Browser} browser
 * @param {Object} opts
 * @param {Object} [opts.geoConfig] - {timezone, locale, languages}
 * @param {Object} [opts.proxy] - Playwright proxy config
 * @param {Object} [opts.fingerprint] - Pre-generated fingerprint (auto-generated if omitted)
 * @param {boolean} [opts.stealthMode=true] - Apply stealth injection
 * @param {boolean} [opts.blockImages=false] - Block image resources
 * @param {boolean} [opts.blockHeavyResources=true] - Block fonts/media/stylesheets
 * @param {boolean} [opts.blockTracking=true] - Block tracking beacons/domains
 * @param {boolean} [opts.canvasNoise=true] - Canvas fingerprint noise
 * @param {boolean} [opts.webglSpoof=true] - WebGL renderer spoofing
 * @returns {Promise<{context, page, fingerprint}>}
 */
async function createStealthContext(browser, opts = {}) {
  const {
    geoConfig = { timezone: 'America/New_York', locale: 'en-US', languages: ['en-US', 'en'] },
    proxy = null,
    stealthMode = true,
    blockImages = false,
    blockHeavyResources = true,
    blockTracking = true,
    canvasNoise = true,
    webglSpoof = true,
  } = opts;

  // 1. Generate fingerprint (or use pre-generated)
  const fingerprint = opts.fingerprint || generateFingerprint({
    languages: geoConfig.languages,
  });

  // 2. Build context options (Scrapling-style)
  const contextOptions = {
    locale: geoConfig.locale,
    userAgent: fingerprint.userAgent,
    viewport: fingerprint.viewport,
    screen: fingerprint.screen,
    timezoneId: geoConfig.timezone,
    deviceScaleFactor: fingerprint.deviceScaleFactor,
    colorScheme: 'dark',            // Scrapling: bypass creepjs prefersLightColor check
    isMobile: false,
    hasTouch: false,
    ignoreHTTPSErrors: true,
    serviceWorkers: 'allow',
    permissions: ['geolocation', 'notifications'],
  };

  if (proxy) {
    contextOptions.proxy = ProxyRotator.toPlaywrightProxy(proxy);
  }

  // 3. Create context
  const context = await browser.newContext(contextOptions);

  // 4. Apply stealth injection
  if (stealthMode) {
    await applyStealth(context, fingerprint, { canvasNoise, webglSpoof });
  }

  // 5. Set extra HTTP headers
  const headers = buildHeaders(fingerprint, { geoConfig });
  await context.setExtraHTTPHeaders(headers);

  // 6. Enable resource blocking
  await enableResourceBlocking(context, {
    blockImages,
    blockHeavyResources,
    blockTracking,
  });

  // 7. Create page
  const page = await context.newPage();

  return { context, page, fingerprint };
}

module.exports = {
  createStealthContext,
  buildLaunchOptions,
};
