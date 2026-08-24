'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function acquireLaunchSlot(root, options = {}) {
  const slots = Math.max(1, Number(options.slots || 2));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000));
  const staleMs = Math.max(timeoutMs, Number(options.staleMs || timeoutMs * 2));
  const pollMs = Math.max(50, Math.min(1000, Number(options.pollMs || 250)));
  fs.mkdirSync(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = 0; index < slots; index++) {
      const slot = path.join(root, `slot-${index}`);
      let created = false;
      try {
        fs.mkdirSync(slot);
        created = true;
        fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date().toISOString(),
        }));
        return {
          slot: index,
          release() { fs.rmSync(slot, { recursive: true, force: true }); },
        };
      } catch (error) {
        if (created) fs.rmSync(slot, { recursive: true, force: true });
        if (error.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(slot);
          const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8'));
          const localOwner = owner.hostname === os.hostname();
          if (Date.now() - stat.mtimeMs > staleMs && localOwner && !processAlive(Number(owner.pid))) {
            fs.rmSync(slot, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    }
    await sleep(pollMs + Math.floor(Math.random() * Math.min(100, pollMs)));
  }
  throw new Error(`browser launch gate timed out after ${timeoutMs}ms`);
}

module.exports = { acquireLaunchSlot, processAlive };
