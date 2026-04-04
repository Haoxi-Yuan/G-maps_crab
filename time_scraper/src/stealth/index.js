/**
 * stealth/index.js
 *
 * Unified export for all stealth modules.
 * Usage: const stealth = require('./stealth');
 */

'use strict';

const { buildLaunchArgs, STEALTH_ARGS, DEFAULT_ARGS, HARMFUL_ARGS, WEBRTC_ARGS, CANVAS_NOISE_ARGS, DISABLE_WEBGL_ARGS } = require('./stealth-args');
const { generateFingerprint, buildHeaders, buildChromeUA, buildClientHints, OS_PROFILES, CHROME_VERSIONS } = require('./fingerprint-factory');
const { applyStealth } = require('./apply-stealth');
const { createInterceptHandler, enableResourceBlocking, TRACKING_RESOURCES, HEAVY_RESOURCES, DEFAULT_BLOCKED_DOMAINS } = require('./resource-blocker');
const { ProxyRotator, isProxyError, getProxyKey, cyclicRotation, PROXY_ERROR_INDICATORS } = require('./proxy-rotator');
const { createStealthContext, buildLaunchOptions } = require('./context-factory');

module.exports = {
  // Primary API (what most callers need)
  createStealthContext,
  buildLaunchOptions,

  // Stealth args
  buildLaunchArgs,
  STEALTH_ARGS,
  DEFAULT_ARGS,
  HARMFUL_ARGS,
  WEBRTC_ARGS,
  CANVAS_NOISE_ARGS,
  DISABLE_WEBGL_ARGS,

  // Fingerprint
  generateFingerprint,
  buildHeaders,
  buildChromeUA,
  buildClientHints,
  OS_PROFILES,
  CHROME_VERSIONS,

  // Stealth injection
  applyStealth,

  // Resource blocking
  createInterceptHandler,
  enableResourceBlocking,
  TRACKING_RESOURCES,
  HEAVY_RESOURCES,
  DEFAULT_BLOCKED_DOMAINS,

  // Proxy
  ProxyRotator,
  isProxyError,
  getProxyKey,
  cyclicRotation,
  PROXY_ERROR_INDICATORS,
};
