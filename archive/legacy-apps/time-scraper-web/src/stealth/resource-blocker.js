/**
 * resource-blocker.js
 *
 * Fine-grained resource interception + domain-level blocking.
 * Ported from Scrapling (scrapling/engines/toolbelt/navigation.py).
 *
 * Key difference from the original G-maps_crab implementation:
 * - Image blocking is OFF by default (fixes review image link loss)
 * - Tracking resources (beacon/websocket/csp_report) are always blocked
 * - Domain-level blocking for analytics/tracking services
 */

'use strict';

const { URL } = require('url');

// Tracking resources — always blocked (from Scrapling EXTRA_RESOURCES subset)
const TRACKING_RESOURCES = new Set([
  'beacon',
  'csp_report',
]);

// Heavy resources — optionally blocked for performance
const HEAVY_RESOURCES = new Set([
  'font',
  'media',
  'object',
  'imageset',
  'texttrack',
  'stylesheet',
]);

// Known tracking/analytics domains
const DEFAULT_BLOCKED_DOMAINS = new Set([
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.com',
  'facebook.net',
  'connect.facebook.net',
  'analytics.google.com',
  'adservice.google.com',
]);

/**
 * Create a Playwright route handler that blocks resources and domains.
 *
 * @param {Object} opts
 * @param {boolean} [opts.blockImages=false] - Block image resources (careful: breaks review images)
 * @param {boolean} [opts.blockHeavyResources=true] - Block fonts, media, stylesheets, etc.
 * @param {boolean} [opts.blockTracking=true] - Block beacon, csp_report, tracking domains
 * @param {Set<string>} [opts.blockedDomains] - Custom domain blocklist (merged with defaults)
 * @param {Set<string>} [opts.extraBlockedTypes] - Additional resource types to block
 * @returns {Function} Route handler for context.route(pattern, handler)
 */
function createInterceptHandler(opts = {}) {
  const {
    blockImages = false,
    blockHeavyResources = true,
    blockTracking = true,
    blockedDomains = null,
    extraBlockedTypes = null,
  } = opts;

  // Build the blocked resource types set
  const blockedTypes = new Set();

  if (blockTracking) {
    for (const t of TRACKING_RESOURCES) blockedTypes.add(t);
  }
  if (blockHeavyResources) {
    for (const t of HEAVY_RESOURCES) blockedTypes.add(t);
  }
  if (blockImages) {
    blockedTypes.add('image');
  }
  if (extraBlockedTypes) {
    for (const t of extraBlockedTypes) blockedTypes.add(t);
  }

  // Build the blocked domains set
  const domains = new Set(blockTracking ? DEFAULT_BLOCKED_DOMAINS : []);
  if (blockedDomains) {
    for (const d of blockedDomains) domains.add(d);
  }

  return async (route) => {
    const resourceType = route.request().resourceType();

    // Check resource type
    if (blockedTypes.has(resourceType)) {
      return route.abort().catch(() => {});
    }

    // Check domain (from Scrapling navigation.py pattern)
    if (domains.size > 0) {
      try {
        const hostname = new URL(route.request().url()).hostname;
        for (const d of domains) {
          if (hostname === d || hostname.endsWith('.' + d)) {
            return route.abort().catch(() => {});
          }
        }
      } catch (e) {
        // Invalid URL — let it through
      }
    }

    return route.continue().catch(() => {});
  };
}

/**
 * Apply resource blocking to a browser context.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {Object} opts - Same options as createInterceptHandler
 */
async function enableResourceBlocking(context, opts = {}) {
  const handler = createInterceptHandler(opts);
  await context.route('**/*', handler);
}

module.exports = {
  createInterceptHandler,
  enableResourceBlocking,
  TRACKING_RESOURCES,
  HEAVY_RESOURCES,
  DEFAULT_BLOCKED_DOMAINS,
};
