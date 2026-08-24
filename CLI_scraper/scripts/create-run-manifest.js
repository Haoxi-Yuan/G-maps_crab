#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function command(name, args) {
  const result = spawnSync(name, args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function parseArgs(argv) {
  const options = { inputs: [], allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--allow-dirty') { options.allowDirty = true; continue; }
    if (key === '--input') { options.inputs.push(argv[++index]); continue; }
    if (key === '--output') { options.output = argv[++index]; continue; }
    if (key === '--help') { options.help = true; continue; }
    throw new Error(`unknown option: ${key}`);
  }
  return options;
}

function usage() {
  console.log(`
Usage:
  node scripts/create-run-manifest.js --output <manifest.json> [--input <file>]...

The command refuses a dirty Git worktree unless --allow-dirty is supplied.
`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.output) throw new Error('--output is required');

  const status = command('git', ['status', '--porcelain']) || '';
  if (status && !options.allowDirty) throw new Error('Git worktree is dirty; commit or use --allow-dirty');

  const tracked = ['package.json', 'package-lock.json', 'requirements.txt', 'config/categories.json'];
  const files = [...tracked, ...options.inputs].map((value) => path.resolve(root, value));
  const hashes = {};
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`manifest input not found: ${file}`);
    hashes[path.relative(root, file)] = sha256(file);
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    git: {
      commit: command('git', ['rev-parse', 'HEAD']),
      branch: command('git', ['branch', '--show-current']),
      dirty: Boolean(status),
    },
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      hostname: os.hostname(),
      node: process.version,
      npm: command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']),
      python: command(process.platform === 'win32' ? 'python' : 'python3', ['--version']),
    },
    sha256: hashes,
  };

  const output = path.resolve(root, options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporary, output);
  console.log(output);
}

try {
  main();
} catch (error) {
  console.error(`Manifest error: ${error.message}`);
  process.exitCode = 1;
}
