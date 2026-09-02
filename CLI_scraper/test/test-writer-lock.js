'use strict';

// Single-writer guard for reviewer shard outputs.
//
// Contract:
//   1. A live holder blocks a second writer.
//   2. A lock whose owner died on this host is reclaimed, so a crash does not
//      wedge the directory.
//   3. A lock owned by another host is never assumed stale — the output
//      directory may be shared, and guessing wrong restores the double writer
//      this guard exists to prevent.
//   4. Release only removes a lock this process still owns.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquireWriterLock, acquireWriterLocks, lockPath } = require('../src/writer-lock');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'writer-lock-')); }

function testBlocksSecondWriter() {
  const dir = tmpDir();
  const release = acquireWriterLock(dir);
  assert.ok(fs.existsSync(lockPath(dir)), 'the lock file must exist while held');
  assert.throws(
    () => acquireWriterLock(dir),
    /another writer holds/,
    'a second writer must be refused while the first is alive',
  );
  release();
  assert.ok(!fs.existsSync(lockPath(dir)), 'release must remove the lock');
  // Reacquire proves release actually freed it.
  acquireWriterLock(dir)();
  console.log('writer lock: live holder blocks a second writer, release frees it: passed');
}

function testReclaimsDeadOwner() {
  const dir = tmpDir();
  // A pid that is gone: spawn a child, let it exit, reuse its pid.
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid;
  fs.writeFileSync(lockPath(dir), JSON.stringify({
    pid: deadPid, host: os.hostname(), startedAt: '2026-09-01T00:00:00.000Z',
  }));
  const release = acquireWriterLock(dir);
  const holder = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
  assert.equal(holder.pid, process.pid, 'the reclaimed lock must name the new owner');
  release();
  console.log('writer lock: a dead owner on this host is reclaimed: passed');
}

function testRefusesForeignHost() {
  const dir = tmpDir();
  // pid 1 is alive locally too, but the point is the host: a foreign holder is
  // unverifiable, so it must never be treated as stale.
  fs.writeFileSync(lockPath(dir), JSON.stringify({
    pid: 999999, host: `${os.hostname()}-somewhere-else`, startedAt: '2026-09-01T00:00:00.000Z',
  }));
  assert.throws(
    () => acquireWriterLock(dir),
    /another writer holds/,
    'a lock from another host must not be reclaimed',
  );
  console.log('writer lock: a foreign-host holder is never assumed stale: passed');
}

function testCorruptLockIsReclaimed() {
  const dir = tmpDir();
  fs.writeFileSync(lockPath(dir), 'not json');
  const release = acquireWriterLock(dir);
  assert.equal(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid, process.pid);
  release();
  console.log('writer lock: an unreadable lock (crash mid-write) is reclaimed: passed');
}

function testReleaseDoesNotStealSuccessorLock() {
  const dir = tmpDir();
  const release = acquireWriterLock(dir);
  // Simulate a successor that reclaimed the directory after we lost it.
  fs.writeFileSync(lockPath(dir), JSON.stringify({
    pid: process.pid + 1, host: os.hostname(), startedAt: '2026-09-01T00:00:00.000Z',
  }));
  release();
  assert.ok(fs.existsSync(lockPath(dir)), 'release must not remove a lock owned by someone else');
  console.log('writer lock: release only removes our own lock: passed');
}

function testMultiDirectoryRollback() {
  const a = tmpDir();
  const b = tmpDir();
  const held = acquireWriterLock(b);            // b is already taken
  assert.throws(() => acquireWriterLocks([a, b]), /another writer holds/);
  assert.ok(!fs.existsSync(lockPath(a)), 'a partial acquisition must roll back');
  held();
  const release = acquireWriterLocks([a, b, a]); // duplicates collapse
  assert.ok(fs.existsSync(lockPath(a)) && fs.existsSync(lockPath(b)));
  release();
  assert.ok(!fs.existsSync(lockPath(a)) && !fs.existsSync(lockPath(b)));
  console.log('writer lock: multi-directory acquire rolls back and dedupes: passed');
}

// The unit cases above prove the lock's semantics; this one proves it is
// actually wired into the run. Without it the guard could be correct and still
// never consulted, which is exactly the failure mode being fixed.
async function testParallelRunRefusesLockedOutput() {
  const { scrapeReviewerProfilesParallel } = require('../src/reviewer-profile-parallel-scraper');
  const dir = tmpDir();
  const listFile = path.join(dir, 'list.ndjson');
  const outputFile = path.join(dir, 'out.ndjson');
  fs.writeFileSync(listFile, `${JSON.stringify({
    reviewer_id: '100000000000000000001',
    reviewer_link: 'https://www.google.com/maps/contrib/100000000000000000001/reviews',
    reviewer_name: 'R',
  })}\n`);

  const held = acquireWriterLock(dir); // stand in for a live first writer
  await assert.rejects(
    () => scrapeReviewerProfilesParallel(
      { shards: [{ listFile, outputFile }], totalReviewers: 1, sourceReviewsFile: listFile },
      {
        concurrency: 1,
        windowSize: 1,
        browserRestartEvery: 1,
        log: () => {},
        reapOrphans: () => {},
        onExit: () => {},
        browserFactory: () => { throw new Error('must not reach browser launch'); },
      },
    ),
    /another writer holds/,
    'the run must refuse to start while the output directory is claimed',
  );
  held();
  console.log('writer lock: a parallel run refuses a locked output directory: passed');
}

async function main() {
  testBlocksSecondWriter();
  testReclaimsDeadOwner();
  testRefusesForeignHost();
  testCorruptLockIsReclaimed();
  testReleaseDoesNotStealSuccessorLock();
  testMultiDirectoryRollback();
  await testParallelRunRefusesLockedOutput();
  console.log('Writer lock tests: passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
