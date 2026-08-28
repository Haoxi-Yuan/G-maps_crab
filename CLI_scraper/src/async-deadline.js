'use strict';

// Race a promise against a deadline. On timeout the returned promise rejects
// with error.code = 'OPERATION_TIMEOUT' and the optional onTimeout hook runs
// (e.g. to flag a browser for a forced restart). The underlying promise is NOT
// cancelled — Playwright gives no cancellation — so callers must discard/close
// whatever the timed-out operation was driving (page, context, browser).
async function withDeadline(promise, timeoutMs, label, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (onTimeout) onTimeout();
          const error = new Error(`${label} timed out after ${timeoutMs}ms`);
          error.code = 'OPERATION_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withDeadline };
