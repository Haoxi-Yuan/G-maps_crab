#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const isWindows = process.platform === 'win32';
const nodeBin = path.dirname(process.execPath);
const adjacentNpm = path.join(nodeBin, isWindows ? 'npm.cmd' : 'npm');
const adjacentNpx = path.join(nodeBin, isWindows ? 'npx.cmd' : 'npx');
const npmCommand = fs.existsSync(adjacentNpm) ? adjacentNpm : (isWindows ? 'npm.cmd' : 'npm');
const npxCommand = fs.existsSync(adjacentNpx) ? adjacentNpx : (isWindows ? 'npx.cmd' : 'npx');
const npmCliCandidates = [
  path.join(nodeBin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.resolve(nodeBin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
];
const npxCliCandidates = [
  path.join(nodeBin, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  path.resolve(nodeBin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
];
const runtimeEnv = {
  ...process.env,
  PATH: `${nodeBin}${path.delimiter}${process.env.PATH || ''}`,
};

function log(message) {
  console.log(`[bootstrap] ${message}`);
}

function fail(message) {
  console.error(`[bootstrap] ERROR: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    env: options.env || runtimeEnv,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with status ${result.status}`);
}

function runPackageCommand(candidates, fallback, commandArgs, options = {}) {
  const cli = candidates.find((candidate) => fs.existsSync(candidate));
  if (cli) run(process.execPath, [cli, ...commandArgs], options);
  else run(fallback, commandArgs, options);
}

function findPython() {
  const candidates = isWindows
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '-c', 'import sys; print(sys.executable)'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status === 0) return { command, prefix };
  }
  return null;
}

function venvPython() {
  return isWindows
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python3');
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) fail(`Node.js 20 or newer is required; found ${process.version}`);

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
fs.mkdirSync(path.join(root, '.playwright-browsers'), { recursive: true });

log(`platform=${os.platform()} ${os.arch()} node=${process.version}`);
log('installing locked Node.js dependencies');
runPackageCommand(npmCliCandidates, npmCommand, ['ci', '--no-audit', '--no-fund']);

if (!args.has('--skip-browser')) {
  log('installing Playwright Chromium');
  runPackageCommand(npxCliCandidates, npxCommand, ['playwright', 'install', 'chromium'], {
    env: {
      ...runtimeEnv,
      PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.playwright-browsers'),
    },
  });
}

if (!args.has('--skip-python')) {
  const python = findPython();
  if (!python) fail('Python 3.10 or newer was not found on PATH');

  if (!fs.existsSync(venvPython())) {
    log('creating .venv');
    run(python.command, [...python.prefix, '-m', 'venv', '.venv']);
  }

  const version = spawnSync(venvPython(), ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (version.status !== 0) fail('the project Python virtual environment is not usable');
  const [pythonMajor, pythonMinor] = version.stdout.trim().split('.').map(Number);
  if (pythonMajor < 3 || (pythonMajor === 3 && pythonMinor < 10)) {
    fail(`Python 3.10 or newer is required; found ${version.stdout.trim()}`);
  }

  log('installing pinned Python dependencies');
  run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(venvPython(), ['-m', 'pip', 'install', '-r', 'requirements.txt']);
}

log('environment is ready');
log(isWindows ? 'launch with: .\\bin\\gmaps-crab.ps1' : 'launch with: ./bin/gmaps-crab');
