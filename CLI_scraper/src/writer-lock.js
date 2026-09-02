'use strict';

// Exclusive single-writer guard for a reviewer output directory.
//
// The scraper appends to shard NDJSON files. Two concurrent writers interleave
// partial records, which corrupts lines that downstream resume and merge steps
// have to parse. A lock held by the supervisor shell does not prevent this: it
// guards against a second supervisor, not against that supervisor's own
// restarted child racing an orphaned earlier child.
//
// That is not hypothetical. On 2026-09-01 a SIGTERM aimed at a `/usr/bin/time`
// wrapper killed the wrapper but left its node child running and reparented to
// init, while the supervisor saw a non-zero exit and immediately launched a
// second node against the same shards. Both processes were writers; the
// supervisor's flock was held the whole time and could not see the collision.
//
// Holding the lock in the writing process itself makes the guarantee
// independent of the process tree, of signal-forwarding behaviour in wrapper
// programs, and of whoever supervises the run.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_NAME = '.reviewer-writer.lock';

function lockPath(directory) {
  return path.join(directory, LOCK_NAME);
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function describe(record) {
  if (!record) return 'unreadable lock file';
  return `pid ${record.pid} on ${record.host}, started ${record.startedAt}`;
}

// A lock counts as stale only when the owner is provably gone. An unreadable
// file is treated as stale (a crash between create and write leaves an empty
// one). A lock owned by another host is never assumed stale: the output
// directory may be shared, and guessing wrong reintroduces the double writer.
function ownerIsGone(record) {
  if (!record || typeof record.pid !== 'number') return true;
  if (record.host !== os.hostname()) return false;
  if (record.pid === process.pid) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return error.code === 'ESRCH';
  }
}

// Returns a release function. Release is idempotent and only ever removes a
// lock this process still owns, so a successor that took over a stale lock is
// never unlocked by the process it replaced.
//
// Crash safety does not depend on release running: a hard kill leaves the file
// behind, and the next run reclaims it through the staleness check above.
function acquireWriterLock(directory, options = {}) {
  const log = options.log || (() => {});
  const file = lockPath(directory);
  fs.mkdirSync(directory, { recursive: true });

  // Two passes: create, and one reclaim of a provably stale lock. A loser in
  // the reclaim race sees the winner's live pid on the second pass and fails.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readLock(file);
      if (!ownerIsGone(holder)) {
        throw new Error(`another writer holds ${file} (${describe(holder)}); refusing to append to the same shards`);
      }
      log(`[WRITER LOCK] reclaiming stale lock (${describe(holder)})`);
      try {
        fs.unlinkSync(file);
      } catch {
        // Someone else reclaimed it first; the next pass re-checks the owner.
      }
      continue;
    }

    try {
      fs.writeSync(handle, JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
      }));
    } finally {
      fs.closeSync(handle);
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      // Drop the exit hook too: a long-lived process that acquires and
      // releases repeatedly (the test suite does) would otherwise accumulate
      // listeners until Node warns about a leak.
      process.removeListener('exit', release);
      const current = readLock(file);
      if (current && current.pid === process.pid && current.host === os.hostname()) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Already gone.
        }
      }
    };
    process.once('exit', release);
    return release;
  }

  throw new Error(`could not acquire ${file} after reclaiming a stale lock`);
}

// Locks every distinct directory the shards write into, and rolls back the
// ones already taken if a later directory is busy.
function acquireWriterLocks(directories, options = {}) {
  const unique = [...new Set(directories)];
  const releases = [];
  try {
    for (const directory of unique) releases.push(acquireWriterLock(directory, options));
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
  return () => {
    for (const release of releases) release();
  };
}

module.exports = { acquireWriterLock, acquireWriterLocks, lockPath };
