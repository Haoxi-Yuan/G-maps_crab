/**
 * Turf.js Loader — CJS / ESM singleton with cache
 *
 * require('@turf/turf') works in v6 and in v7 when every transitive
 * dependency ships CJS.  v7.3+ pulled in kdbush which is ESM-only,
 * so require() throws ERR_REQUIRE_ESM.  In that case we fall back to
 * a dynamic import().
 */

let _turf = null;
let _loading = null;

async function getTurf() {
  if (_turf) return _turf;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      _turf = require('@turf/turf');
    } catch (err) {
      if (err.code === 'ERR_REQUIRE_ESM') {
        const mod = await import('@turf/turf');
        _turf = mod.default || mod;
      } else {
        throw err;
      }
    }
    return _turf;
  })();

  return _loading;
}

module.exports = { getTurf };
