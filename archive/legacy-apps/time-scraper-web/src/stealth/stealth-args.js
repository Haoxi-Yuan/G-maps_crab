/**
 * stealth-args.js
 *
 * Browser launch arguments ported from Scrapling (scrapling/engines/constants.py).
 * Provides 85+ stealth arguments for Chromium to minimize automation detection.
 */

'use strict';

// Arguments that MUST be excluded — they trigger automation detection
const HARMFUL_ARGS = new Set([
  '--enable-automation',
  '--disable-popup-blocking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
]);

// Performance optimization defaults (from Scrapling DEFAULT_ARGS)
const DEFAULT_ARGS = [
  '--no-pings',
  '--no-first-run',
  '--disable-infobars',
  '--disable-breakpad',
  '--no-service-autorun',
  '--homepage=about:blank',
  '--password-store=basic',
  '--disable-hang-monitor',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--disable-search-engine-choice-screen',
];

// Stealth arguments (from Scrapling STEALTH_ARGS)
// Reference: https://peter.sh/experiments/chromium-command-line-switches/
const STEALTH_ARGS = [
  '--test-type',
  '--lang=en-US',
  '--mute-audio',
  '--disable-sync',
  '--hide-scrollbars',
  '--disable-logging',
  '--start-maximized',
  '--enable-async-dns',
  '--accept-lang=en-US',
  '--use-mock-keychain',
  '--disable-translate',
  '--disable-voice-input',
  '--window-position=0,0',
  '--disable-wake-on-wifi',
  '--ignore-gpu-blocklist',
  '--enable-tcp-fast-open',
  '--enable-web-bluetooth',
  '--disable-cloud-import',
  '--disable-print-preview',
  '--disable-dev-shm-usage',
  '--metrics-recording-only',
  '--disable-crash-reporter',
  '--disable-partial-raster',
  '--disable-gesture-typing',
  '--disable-checker-imaging',
  '--disable-prompt-on-repost',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--aggressive-cache-discard',
  '--disable-cookie-encryption',
  '--disable-domain-reliability',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--enable-simple-cache-backend',
  '--disable-background-networking',
  '--enable-surface-synchronization',
  '--disable-image-animation-resync',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--prerender-from-omnibox=disabled',
  '--safebrowsing-disable-auto-update',
  '--disable-offer-upload-credit-cards',
  '--disable-background-timer-throttling',
  '--disable-new-content-rendering-timeout',
  '--run-all-compositor-stages-before-draw',
  '--disable-client-side-phishing-detection',
  '--disable-backgrounding-occluded-windows',
  '--disable-layer-tree-host-memory-pressure',
  '--autoplay-policy=user-gesture-required',
  '--disable-offer-store-unmasked-wallet-cards',
  '--disable-blink-features=AutomationControlled',
  '--disable-component-extensions-with-background-pages',
  '--enable-features=NetworkService,NetworkServiceInProcess,TrustTokens,TrustTokensAlwaysAllowIssuance',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
  '--disable-features=AudioServiceOutOfProcess,TranslateUI,BlinkGenPropertyTrees',
];

// Optional: WebRTC leak prevention
const WEBRTC_ARGS = [
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--force-webrtc-ip-handling-policy',
];

// Optional: Canvas fingerprint noise (Chromium flag)
const CANVAS_NOISE_ARGS = [
  '--fingerprinting-canvas-image-data-noise',
];

// Optional: Disable WebGL entirely
const DISABLE_WEBGL_ARGS = [
  '--disable-webgl',
  '--disable-webgl-image-chromium',
  '--disable-webgl2',
];

/**
 * Build the full launch args array based on options.
 * Merges DEFAULT + STEALTH + optional feature args.
 * Filters out any HARMFUL_ARGS that may have been passed externally.
 *
 * @param {Object} opts
 * @param {boolean} [opts.blockWebRTC=true] - Prevent WebRTC IP leaks
 * @param {boolean} [opts.canvasNoise=true] - Add canvas fingerprint noise
 * @param {boolean} [opts.allowWebGL=true] - Keep WebGL enabled (recommended)
 * @param {boolean} [opts.noSandbox=false] - Add --no-sandbox (Linux containers)
 * @param {string[]} [opts.extraArgs=[]] - Additional custom args
 * @returns {string[]}
 */
function buildLaunchArgs(opts = {}) {
  const {
    blockWebRTC = true,
    canvasNoise = true,
    allowWebGL = true,
    noSandbox = false,
    extraArgs = [],
  } = opts;

  const args = [...DEFAULT_ARGS, ...STEALTH_ARGS];

  if (blockWebRTC) args.push(...WEBRTC_ARGS);
  if (canvasNoise) args.push(...CANVAS_NOISE_ARGS);
  if (!allowWebGL) args.push(...DISABLE_WEBGL_ARGS);

  if (noSandbox) {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  for (const arg of extraArgs) {
    if (!HARMFUL_ARGS.has(arg)) {
      args.push(arg);
    }
  }

  // Deduplicate while preserving order
  return [...new Set(args)];
}

module.exports = {
  HARMFUL_ARGS,
  DEFAULT_ARGS,
  STEALTH_ARGS,
  WEBRTC_ARGS,
  CANVAS_NOISE_ARGS,
  DISABLE_WEBGL_ARGS,
  buildLaunchArgs,
};
