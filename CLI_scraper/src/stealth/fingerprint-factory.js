/**
 * fingerprint-factory.js
 *
 * Generates consistent browser fingerprints (UA, viewport, platform, etc.)
 * Ported from Scrapling (scrapling/engines/toolbelt/fingerprints.py).
 *
 * Key principle: all fingerprint fields must be internally consistent.
 * A macOS user-agent must pair with a macOS platform string, Retina viewport, etc.
 */

'use strict';

// Chrome version ranges — keep updated with real Chrome releases
const CHROME_VERSIONS = {
  min: 120,
  max: 131,
};

// OS-specific configurations
const OS_PROFILES = {
  windows: {
    platforms: ['Win32'],
    oscpus: ['Windows NT 10.0; Win64; x64'],
    uaOS: [
      'Windows NT 10.0; Win64; x64',
      'Windows NT 10.0; WOW64',
    ],
    viewports: [
      { width: 1920, height: 1080 },
      { width: 1536, height: 864 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
      { width: 2560, height: 1440 },
    ],
    deviceScaleFactors: [1, 1.25, 1.5],
  },
  macos: {
    platforms: ['MacIntel'],
    oscpus: ['Intel Mac OS X 10_15_7', 'Intel Mac OS X 14_0'],
    uaOS: [
      'Macintosh; Intel Mac OS X 10_15_7',
      'Macintosh; Intel Mac OS X 14_0',
      'Macintosh; Intel Mac OS X 13_6_1',
    ],
    viewports: [
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 1440, height: 900 },
      { width: 1680, height: 1050 },
    ],
    deviceScaleFactors: [2],  // Retina
  },
  linux: {
    platforms: ['Linux x86_64'],
    oscpus: ['Linux x86_64'],
    uaOS: [
      'X11; Linux x86_64',
    ],
    viewports: [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 2560, height: 1440 },
      { width: 1600, height: 900 },
    ],
    deviceScaleFactors: [1, 1.5, 2],
  },
};

const OS_NAMES = Object.keys(OS_PROFILES);

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Build a Chrome user-agent string consistent with the given OS and version.
 */
function buildChromeUA(osString, chromeVersion) {
  const webkitVersion = '537.36';
  return `Mozilla/5.0 (${osString}) AppleWebKit/${webkitVersion} (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/${webkitVersion}`;
}

/**
 * Build Sec-CH-UA headers consistent with the Chrome version.
 * These Client Hints headers are checked by sophisticated anti-bot systems.
 */
function buildClientHints(chromeVersion, os) {
  const brands = [
    `"Chromium";v="${chromeVersion}"`,
    `"Google Chrome";v="${chromeVersion}"`,
    `"Not_A Brand";v="${randomChoice([8, 24, 99])}"`,
  ];
  // Shuffle brands to look more natural
  for (let i = brands.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [brands[i], brands[j]] = [brands[j], brands[i]];
  }

  const platformMap = { windows: '"Windows"', macos: '"macOS"', linux: '"Linux"' };

  return {
    'Sec-CH-UA': brands.join(', '),
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': platformMap[os] || '"Windows"',
  };
}

/**
 * Generate a complete, internally consistent browser fingerprint.
 *
 * @param {Object} opts
 * @param {string} [opts.os] - Force OS: 'windows'|'macos'|'linux'. Random if omitted.
 * @param {number} [opts.chromeVersion] - Force Chrome version. Random in range if omitted.
 * @param {string[]} [opts.languages] - Override languages array.
 * @returns {Object} Fingerprint object with all consistent fields.
 */
function generateFingerprint(opts = {}) {
  const os = opts.os || randomChoice(OS_NAMES);
  const profile = OS_PROFILES[os];
  const chromeVersion = opts.chromeVersion || randomInt(CHROME_VERSIONS.min, CHROME_VERSIONS.max);
  const uaOS = randomChoice(profile.uaOS);
  const viewport = randomChoice(profile.viewports);

  return {
    // Browser identity
    userAgent: buildChromeUA(uaOS, chromeVersion),
    chromeVersion,
    os,

    // Navigator properties (for applyStealth injection)
    platform: randomChoice(profile.platforms),
    oscpu: randomChoice(profile.oscpus),
    vendor: 'Google Inc.',
    languages: opts.languages || ['en-US', 'en'],

    // Display
    viewport: { ...viewport },
    screen: { ...viewport },
    deviceScaleFactor: randomChoice(profile.deviceScaleFactors),

    // Client Hints headers
    clientHints: buildClientHints(chromeVersion, os),
  };
}

/**
 * Build HTTP headers consistent with the fingerprint.
 *
 * @param {Object} fingerprint - From generateFingerprint()
 * @param {Object} opts
 * @param {Object} [opts.geoConfig] - Geo config with .languages array
 * @returns {Object} Headers to set via context.setExtraHTTPHeaders()
 */
function buildHeaders(fingerprint, opts = {}) {
  const languages = (opts.geoConfig && opts.geoConfig.languages) || fingerprint.languages;

  const headers = {
    'Accept-Language': languages.join(','),
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.google.com/',
    ...fingerprint.clientHints,
  };

  return headers;
}

module.exports = {
  generateFingerprint,
  buildHeaders,
  buildChromeUA,
  buildClientHints,
  OS_PROFILES,
  CHROME_VERSIONS,
};
