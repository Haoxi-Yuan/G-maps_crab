/**
 * apply-stealth.js
 *
 * Enhanced navigator/canvas/webgl stealth injection.
 * Replaces the minimal applyStealth in both ipc and with_reviews versions.
 * Ported from Scrapling's Patchright-level protections, adapted for addInitScript.
 */

'use strict';

/**
 * Inject stealth overrides into a browser context.
 * Must be called BEFORE any page navigation.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {Object} fingerprint - From generateFingerprint()
 * @param {Object} [opts]
 * @param {boolean} [opts.canvasNoise=true] - Inject canvas noise
 * @param {boolean} [opts.webglSpoof=true] - Spoof WebGL renderer info
 */
async function applyStealth(context, fingerprint, opts = {}) {
  const { canvasNoise = true, webglSpoof = true } = opts;

  const config = {
    platform: fingerprint.platform,
    languages: fingerprint.languages,
    vendor: fingerprint.vendor,
    oscpu: fingerprint.oscpu,
    canvasNoise,
    webglSpoof,
  };

  await context.addInitScript((cfg) => {
    // --- 1. navigator.webdriver ---
    // Scrapling uses Patchright for native bypass; we simulate via property override
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Also delete the property entirely if possible
    try { delete navigator.__proto__.webdriver; } catch (e) {}

    // --- 2. navigator.plugins ---
    // Replace [1,2,3,4,5] with realistic plugin list
    const fakePlugins = {
      length: 5,
      0: { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      1: { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      2: { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      3: { name: 'Chromium PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      4: { name: 'Chromium PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      item: function(i) { return this[i] || null; },
      namedItem: function(name) {
        for (let i = 0; i < this.length; i++) { if (this[i].name === name) return this[i]; }
        return null;
      },
      refresh: function() {},
    };
    Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });

    // --- 3. navigator.languages ---
    Object.defineProperty(navigator, 'languages', { get: () => Object.freeze([...cfg.languages]) });

    // --- 4. navigator.platform ---
    Object.defineProperty(navigator, 'platform', { get: () => cfg.platform });

    // --- 5. navigator.vendor ---
    Object.defineProperty(navigator, 'vendor', { get: () => cfg.vendor });

    // --- 6. navigator.maxTouchPoints ---
    // Desktop Chrome should report 0
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

    // --- 7. navigator.hardwareConcurrency ---
    // Randomize to avoid fingerprint consistency across sessions
    if (!navigator.__stealthHWCSet) {
      const cores = [4, 8, 12, 16][Math.floor(Math.random() * 4)];
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => cores });
      navigator.__stealthHWCSet = true;
    }

    // --- 8. window.chrome ---
    // Must exist and have runtime for Chrome detection checks
    if (!window.chrome) {
      window.chrome = {};
    }
    window.chrome.runtime = window.chrome.runtime || {};
    window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, getDetails: () => null, getIsInstalled: () => false, runningState: () => 'cannot_run' };
    window.chrome.csi = function() { return {}; };
    window.chrome.loadTimes = function() { return {}; };

    // --- 9. Permissions query ---
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (parameters) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return origQuery(parameters);
    };

    // --- 10. Canvas fingerprint noise ---
    if (cfg.canvasNoise) {
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        try {
          const ctx = this.getContext('2d');
          if (ctx && this.width > 0 && this.height > 0) {
            const w = Math.min(this.width, 16);
            const h = Math.min(this.height, 16);
            const imageData = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < imageData.data.length; i += 4) {
              // Tiny noise: +/- 1 on RGB channels only (not alpha)
              imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + Math.round((Math.random() - 0.5) * 2)));
              imageData.data[i + 1] = Math.max(0, Math.min(255, imageData.data[i + 1] + Math.round((Math.random() - 0.5) * 2)));
              imageData.data[i + 2] = Math.max(0, Math.min(255, imageData.data[i + 2] + Math.round((Math.random() - 0.5) * 2)));
            }
            ctx.putImageData(imageData, 0, 0);
          }
        } catch (e) {
          // Canvas may be tainted or context unavailable — silently skip
        }
        return origToDataURL.apply(this, arguments);
      };

      // Also patch toBlob for completeness
      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
        try {
          const ctx = this.getContext('2d');
          if (ctx && this.width > 0 && this.height > 0) {
            const w = Math.min(this.width, 16);
            const h = Math.min(this.height, 16);
            const imageData = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < imageData.data.length; i += 4) {
              imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + Math.round((Math.random() - 0.5) * 2)));
            }
            ctx.putImageData(imageData, 0, 0);
          }
        } catch (e) {}
        return origToBlob.call(this, callback, type, quality);
      };
    }

    // --- 11. WebGL renderer spoofing ---
    if (cfg.webglSpoof) {
      const spoofWebGL = (proto) => {
        const origGetParameter = proto.getParameter;
        proto.getParameter = function(param) {
          // UNMASKED_VENDOR_WEBGL
          if (param === 37445) return 'Intel Inc.';
          // UNMASKED_RENDERER_WEBGL
          if (param === 37446) return 'Intel Iris OpenGL Engine';
          return origGetParameter.call(this, param);
        };
      };
      if (typeof WebGLRenderingContext !== 'undefined') spoofWebGL(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') spoofWebGL(WebGL2RenderingContext.prototype);
    }

    // --- 12. Iframe contentWindow check ---
    // Some detectors check if iframes have the same origin properties
    try {
      const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (origContentWindow) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          get: function() {
            const win = origContentWindow.get.call(this);
            if (win) {
              try { win.chrome = window.chrome; } catch (e) {}
            }
            return win;
          },
        });
      }
    } catch (e) {}

  }, config);
}

module.exports = { applyStealth };
