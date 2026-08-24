/**
 * proxy-rotator.js
 *
 * Enhanced proxy management with error detection and context isolation.
 * Ported from Scrapling (scrapling/engines/toolbelt/proxy_rotation.py).
 *
 * Key improvements over the original ProxyManager:
 * - Error fingerprint detection (distinguish proxy errors from target blocks)
 * - Cyclic rotation with pluggable strategy
 * - Geo-filtering support preserved from original
 */

'use strict';

// Proxy error indicators (from Scrapling _PROXY_ERROR_INDICATORS)
const PROXY_ERROR_INDICATORS = [
  'net::err_proxy',
  'net::err_tunnel',
  'connection refused',
  'connection reset',
  'connection timed out',
  'failed to connect',
  'could not resolve proxy',
  'proxy connection failed',
  'err_proxy_connection_failed',
];

/**
 * Check if an error is proxy-related (vs. target-site block).
 * Helps decide whether to rotate proxy or back off.
 *
 * @param {Error|string} error
 * @returns {boolean}
 */
function isProxyError(error) {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return PROXY_ERROR_INDICATORS.some(indicator => msg.includes(indicator));
}

/**
 * Generate a unique key for a proxy.
 * @param {Object|string} proxy
 * @returns {string}
 */
function getProxyKey(proxy) {
  if (typeof proxy === 'string') return proxy;
  return `${proxy.server || ''}|${proxy.username || ''}`;
}

/**
 * Default cyclic rotation — sequential with wraparound.
 * Matches Scrapling's cyclic_rotation().
 */
function cyclicRotation(proxies, currentIndex) {
  const idx = currentIndex % proxies.length;
  return { proxy: proxies[idx], nextIndex: (idx + 1) % proxies.length };
}

class ProxyRotator {
  /**
   * @param {Array} proxies - Array of proxy objects {server, username?, password?, country?}
   * @param {Object} opts
   * @param {string} [opts.geoTarget] - Filter proxies by country code
   * @param {Function} [opts.strategy] - Custom rotation strategy(proxies, index) => {proxy, nextIndex}
   */
  constructor(proxies, opts = {}) {
    const { geoTarget = null, strategy = cyclicRotation } = opts;

    let filtered = proxies || [];
    if (geoTarget && filtered.length > 0) {
      const geo = geoTarget.toUpperCase();
      filtered = filtered.filter(p => !p.country || p.country.toUpperCase() === geo);
    }

    if (filtered.length === 0 && proxies && proxies.length > 0) {
      // Geo filter removed all proxies — fall back to unfiltered
      filtered = proxies;
    }

    this._proxies = filtered;
    this._strategy = strategy;
    this._currentIndex = 0;
    this._failedKeys = new Set();

    // O(1) lookup by key (from Scrapling _proxy_to_index)
    this._proxyKeyIndex = new Map();
    this._proxies.forEach((p, i) => this._proxyKeyIndex.set(getProxyKey(p), i));
  }

  get length() { return this._proxies.length; }

  hasProxies() { return this._proxies.length > 0; }

  /**
   * Get the current proxy without advancing.
   * @returns {Object|null}
   */
  getCurrentProxy() {
    if (!this.hasProxies()) return null;
    return this._proxies[this._currentIndex % this._proxies.length];
  }

  /**
   * Advance to the next proxy, skipping failed ones.
   * @returns {Object|null}
   */
  rotateProxy() {
    if (!this.hasProxies()) return null;

    let attempts = 0;
    while (attempts < this._proxies.length) {
      const { proxy, nextIndex } = this._strategy(this._proxies, this._currentIndex);
      this._currentIndex = nextIndex;

      if (!this._failedKeys.has(getProxyKey(proxy))) {
        return proxy;
      }
      attempts++;
    }

    // All proxies failed — reset failures and try again
    this._failedKeys.clear();
    const { proxy, nextIndex } = this._strategy(this._proxies, this._currentIndex);
    this._currentIndex = nextIndex;
    return proxy;
  }

  /**
   * Mark a proxy as failed.
   * @param {Object} proxy
   */
  markFailed(proxy) {
    this._failedKeys.add(getProxyKey(proxy));
  }

  /**
   * Get Playwright-compatible proxy config for the given proxy.
   * @param {Object} proxy
   * @returns {Object} {server, username?, password?}
   */
  static toPlaywrightProxy(proxy) {
    if (!proxy) return undefined;
    const result = { server: proxy.server };
    if (proxy.username) result.username = proxy.username;
    if (proxy.password) result.password = proxy.password;
    return result;
  }
}

module.exports = {
  ProxyRotator,
  isProxyError,
  getProxyKey,
  cyclicRotation,
  PROXY_ERROR_INDICATORS,
};
