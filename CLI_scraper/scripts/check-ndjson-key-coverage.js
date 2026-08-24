#!/usr/bin/env node
'use strict';

// Deliberately do not import review-db-schema.js. This streaming checker uses
// an independently maintained source-key/retention contract, so mapper drift
// cannot silently redefine what the input format is allowed to contain.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONTRACT = path.join(ROOT, 'contracts', 'reviews-ndjson-keys.v1.json');
const DEFAULT_FIXTURE = path.join(ROOT, 'TEST', 'fixtures', 'reviews-ndjson-all-keys.ndjson');
const REQUIRED_GROUPS = [
  'top', 'business', 'coordinates', 'meta', 'review', 'photoCategory', 'photo',
];
const RETENTION_MODES = new Set([
  'scalar', 'json', 'boolean', 'scalar-or-json', 'container',
  'mapped-children', 'json-member', 'json-and-scalar',
]);

function usage() {
  console.log(`Usage: node scripts/check-ndjson-key-coverage.js [options] [file ...]

Options:
  --contract PATH      Retention contract (default: contracts/reviews-ndjson-keys.v1.json)
  --require-complete   Fail if the input union does not exercise every contract key
  --self-test          Test unknown-key rejection and open-dictionary handling
  -h, --help           Show this help

With no file arguments, the complete, small CI fixture is checked.`);
}

function parseArgs(argv) {
  const options = {
    contractPath: DEFAULT_CONTRACT,
    requireComplete: false,
    selfTest: false,
    files: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--contract') {
      if (!argv[i + 1]) throw new Error('--contract requires a path');
      options.contractPath = path.resolve(argv[++i]);
    } else if (arg === '--require-complete') {
      options.requireComplete = true;
    } else if (arg === '--self-test') {
      options.selfTest = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      options.files.push(path.resolve(arg));
    }
  }

  if (options.files.length === 0) {
    options.files.push(DEFAULT_FIXTURE);
    options.requireComplete = true;
  }
  return options;
}

function destinationList(spec) {
  return Array.isArray(spec.destination) ? spec.destination : [spec.destination];
}

function loadContract(contractPath) {
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read contract ${contractPath}: ${error.message}`);
  }

  if (!contract || typeof contract !== 'object' || contract.contractVersion !== 2
      || !contract.groups || typeof contract.groups !== 'object') {
    throw new Error('contract must be version 2 and contain a groups object');
  }

  const actualGroups = Object.keys(contract.groups);
  const missingGroups = REQUIRED_GROUPS.filter((group) => !actualGroups.includes(group));
  const unexpectedGroups = actualGroups.filter((group) => !REQUIRED_GROUPS.includes(group));
  if (missingGroups.length || unexpectedGroups.length) {
    throw new Error(
      `contract groups mismatch; missing=[${missingGroups.join(', ')}], `
      + `unexpected=[${unexpectedGroups.join(', ')}]`,
    );
  }

  for (const groupName of REQUIRED_GROUPS) {
    const group = contract.groups[groupName];
    if (!group || group.unknownKeys !== 'reject' || !group.fields
        || typeof group.fields !== 'object' || Array.isArray(group.fields)) {
      throw new Error(
        `groups.${groupName} must contain fields and set unknownKeys to "reject"`,
      );
    }
    const keys = Object.keys(group.fields);
    if (!keys.length) throw new Error(`groups.${groupName}.fields must not be empty`);

    for (const [key, spec] of Object.entries(group.fields)) {
      const where = `groups.${groupName}.fields.${key}`;
      if (!key || !spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new Error(`${where} must be an object`);
      }
      const destinations = destinationList(spec);
      if (!destinations.length
          || destinations.some((item) => typeof item !== 'string' || !item)) {
        throw new Error(`${where}.destination must name at least one SQLite destination`);
      }
      if (new Set(destinations).size !== destinations.length) {
        throw new Error(`${where}.destination contains duplicates`);
      }
      if (!RETENTION_MODES.has(spec.retention)) {
        throw new Error(`${where}.retention is unsupported: ${spec.retention}`);
      }
      if (spec.nestedPolicy !== undefined && spec.nestedPolicy !== 'open') {
        throw new Error(`${where}.nestedPolicy must be "open" when present`);
      }
      if (spec.nested && spec.nestedPolicy) {
        throw new Error(`${where} cannot declare both nested and nestedPolicy`);
      }
      if (spec.nested) {
        if (!REQUIRED_GROUPS.includes(spec.nested.group)
            || !['object', 'array'].includes(spec.nested.shape)) {
          throw new Error(`${where}.nested must name a contract group and object/array shape`);
        }
      }
      if (spec.assertions) {
        if (!Array.isArray(spec.assertions) || !spec.assertions.length) {
          throw new Error(`${where}.assertions must be a non-empty array`);
        }
        for (const assertion of spec.assertions) {
          if (!assertion || !destinations.includes(assertion.destination)
              || !['scalar', 'group-json'].includes(assertion.encoding)) {
            throw new Error(`${where}.assertions contains an invalid destination/encoding`);
          }
        }
        const asserted = new Set(spec.assertions.map((item) => item.destination));
        if (asserted.size !== destinations.length) {
          throw new Error(`${where}.assertions must cover every destination`);
        }
      }
    }
  }
  return contract;
}

function createResults() {
  return {
    lines: 0,
    records: 0,
    observed: Object.fromEntries(REQUIRED_GROUPS.map((group) => [group, new Set()])),
    errorCount: 0,
    errors: [],
  };
}

function recordError(results, location, message) {
  results.errorCount += 1;
  // A new scraper key can occur on millions of rows. Diagnostics and observed
  // sets stay bounded by constants from the contract, not input cardinality.
  if (results.errors.length < 100) results.errors.push(`${location}: ${message}`);
}

function inspectGroup(value, groupName, contract, results, location) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    recordError(results, location, `expected an object for ${groupName}`);
    return;
  }

  const group = contract.groups[groupName];
  for (const [key, child] of Object.entries(value)) {
    const spec = group.fields[key];
    if (!spec) {
      // Do not add arbitrary unknown strings to observed: keeping only known
      // keys is what makes this checker constant-memory on huge inputs.
      recordError(results, `${location}.${key}`, `unknown ${groupName} key`);
      continue;
    }
    results.observed[groupName].add(key);
    if (!spec.nested) continue; // nestedPolicy=open is intentionally opaque.

    const childLocation = `${location}.${key}`;
    if (child === undefined || child === null) continue;
    if (spec.nested.shape === 'array') {
      if (!Array.isArray(child)) {
        recordError(results, childLocation, `expected an array of ${spec.nested.group} objects`);
        continue;
      }
      child.forEach((item, index) => {
        inspectGroup(item, spec.nested.group, contract, results, `${childLocation}[${index}]`);
      });
    } else {
      inspectGroup(child, spec.nested.group, contract, results, childLocation);
    }
  }
}

function inspectRecord(record, contract, results, location) {
  inspectGroup(record, 'top', contract, results, location);
}

async function inspectFile(file, contract, results) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  input.on('error', () => {});
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      results.lines += 1;
      if (!line.trim()) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        recordError(results, `${file}:${lineNumber}`, `invalid JSON: ${error.message}`);
        continue;
      }
      results.records += 1;
      inspectRecord(record, contract, results, `${file}:${lineNumber}`);
    }
  } catch (error) {
    throw new Error(`cannot read input ${file}: ${error.message}`);
  }
}

function checkCompleteness(contract, results) {
  for (const groupName of REQUIRED_GROUPS) {
    const expected = Object.keys(contract.groups[groupName].fields);
    const missing = expected.filter((key) => !results.observed[groupName].has(key));
    if (missing.length) {
      recordError(
        results,
        `coverage.${groupName}`,
        `contract keys not exercised: ${missing.join(', ')}`,
      );
    }
  }
}

function selfTestContractPolicies(contract) {
  const results = createResults();
  for (const groupName of REQUIRED_GROUPS) {
    inspectGroup(
      { [`__unknown_${groupName}__`]: true },
      groupName,
      contract,
      results,
      `self-test.${groupName}`,
    );
  }

  const rejectedGroups = REQUIRED_GROUPS.filter((groupName) => (
    results.errors.some((error) => error.includes(`__unknown_${groupName}__`))
  ));
  if (rejectedGroups.length !== REQUIRED_GROUPS.length) {
    const accepted = REQUIRED_GROUPS.filter((group) => !rejectedGroups.includes(group));
    throw new Error(`self-test failed: unknown keys accepted by ${accepted.join(', ')}`);
  }

  let openFields = 0;
  for (const groupName of REQUIRED_GROUPS) {
    for (const [key, spec] of Object.entries(contract.groups[groupName].fields)) {
      if (spec.nestedPolicy !== 'open') continue;
      openFields += 1;
      const openResults = createResults();
      inspectGroup(
        { [key]: { __open_dictionary_key__: { nested: true } } },
        groupName,
        contract,
        openResults,
        `self-test.open.${groupName}`,
      );
      if (openResults.errorCount) {
        throw new Error(`self-test failed: open dictionary rejected at ${groupName}.${key}`);
      }
    }
  }
  if (!openFields) throw new Error('self-test failed: contract has no open dictionaries');

  console.log(
    `Contract policy self-test: passed (${REQUIRED_GROUPS.length} closed groups, `
    + `${openFields} open dictionary fields; coordinates.lat/lng contracted)`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const contract = loadContract(options.contractPath);
  if (options.selfTest) selfTestContractPolicies(contract);

  const results = createResults();
  for (const file of options.files) {
    await inspectFile(file, contract, results);
  }
  if (results.records === 0) recordError(results, 'input', 'no NDJSON records found');
  if (options.requireComplete) checkCompleteness(contract, results);

  if (results.errorCount) {
    console.error(`NDJSON retention contract failed with ${results.errorCount} error(s):`);
    for (const error of results.errors) console.error(`  - ${error}`);
    if (results.errorCount > results.errors.length) {
      console.error(`  ... ${results.errorCount - results.errors.length} more error(s)`);
    }
    process.exitCode = 1;
    return;
  }

  const coverage = REQUIRED_GROUPS.map((groupName) => {
    const expected = Object.keys(contract.groups[groupName].fields).length;
    return `${groupName}=${results.observed[groupName].size}/${expected}`;
  }).join(', ');
  console.log(`NDJSON retention contract passed: ${results.records} record(s); ${coverage}`);
}

main().catch((error) => {
  console.error(`NDJSON retention contract error: ${error.message}`);
  process.exitCode = 1;
});
