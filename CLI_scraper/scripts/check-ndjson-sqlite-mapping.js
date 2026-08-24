#!/usr/bin/env node
'use strict';

// This is an independent oracle: expected destinations and retention modes
// come from contracts/reviews-ndjson-keys.v1.json, never from the mapper's
// source-key sets or column lists. The production mapper is imported only as
// the system under test.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONTRACT = path.join(ROOT, 'contracts', 'reviews-ndjson-keys.v1.json');
const DEFAULT_FIXTURE = path.join(ROOT, 'TEST', 'fixtures', 'reviews-ndjson-all-keys.ndjson');
const DEFAULT_MAPPER = path.join(ROOT, 'scripts', 'review-db-schema.js');
const BASE_PLACE_ID = '__mapping_contract_place__';
const BASE_REVIEW_ID = '__mapping_contract_review__';
const MERGED_AT = '2099-01-01T00:00:00.000Z';

function usage() {
  console.log(`Usage: node scripts/check-ndjson-sqlite-mapping.js [options]

Options:
  --contract PATH   Independent retention contract
  --fixture PATH    Complete NDJSON fixture
  --mapper PATH     Mapper module exporting buildBusinessRow/buildReviewRow
  --self-test       Prove injected business/review mapper omissions are detected
  -h, --help        Show this help`);
}

function parseArgs(argv) {
  const options = {
    contractPath: DEFAULT_CONTRACT,
    fixturePath: DEFAULT_FIXTURE,
    mapperPath: DEFAULT_MAPPER,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--contract' || arg === '--fixture' || arg === '--mapper') {
      if (!argv[i + 1]) throw new Error(`${arg} requires a path`);
      const name = arg === '--contract' ? 'contractPath'
        : arg === '--fixture' ? 'fixturePath' : 'mapperPath';
      options[name] = path.resolve(argv[++i]);
    } else if (arg === '--self-test') {
      options.selfTest = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }
}

function readFixture(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read fixture ${file}: ${error.message}`);
  }
  const records = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`invalid fixture JSON at line ${index + 1}: ${error.message}`);
    }
  });
  if (!records.length) throw new Error('fixture contains no records');
  return records;
}

const clone = (value) => (
  value === undefined ? undefined : JSON.parse(JSON.stringify(value))
);

function same(actual, expected) {
  return Object.is(actual, expected);
}

function show(value) {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

function coerceBool(value) {
  return value === true ? 1 : value === false ? 0 : value == null ? null : Number(value) ? 1 : 0;
}

function scalarOrJson(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function collectSamples(contract, records) {
  const samples = Object.fromEntries(
    Object.keys(contract.groups).map((group) => [group, new Map()]),
  );

  function visit(value, groupName) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const fields = contract.groups[groupName].fields;
    for (const [key, child] of Object.entries(value)) {
      const spec = fields[key];
      if (!spec) continue; // Unknown-key rejection belongs to the streaming checker.
      if (!samples[groupName].has(key)) samples[groupName].set(key, clone(child));
      if (!spec.nested || child == null) continue;
      if (spec.nested.shape === 'array') {
        if (Array.isArray(child)) child.forEach((item) => visit(item, spec.nested.group));
      } else {
        visit(child, spec.nested.group);
      }
    }
  }

  records.forEach((record) => visit(record, 'top'));
  const missing = [];
  for (const [groupName, group] of Object.entries(contract.groups)) {
    for (const key of Object.keys(group.fields)) {
      if (!samples[groupName].has(key)) missing.push(`${groupName}.${key}`);
    }
  }
  if (missing.length) throw new Error(`fixture misses contract fields: ${missing.join(', ')}`);
  return samples;
}

function containsVendorExtension(value) {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && Object.hasOwn(value, 'vendor_extension')) return true;
  return Object.values(value).some(containsVendorExtension);
}

function validateOpenDictionaryFixtures(contract, samples) {
  const missing = [];
  for (const [groupName, group] of Object.entries(contract.groups)) {
    for (const [key, spec] of Object.entries(group.fields)) {
      if (spec.nestedPolicy === 'open'
          && !containsVendorExtension(samples[groupName].get(key))) {
        missing.push(`${groupName}.${key}`);
      }
    }
  }
  if (missing.length) {
    throw new Error(
      `open-dictionary fixture values need a vendor_extension sentinel: ${missing.join(', ')}`,
    );
  }
}

function destinationColumn(destination, expectedTable) {
  const match = /^(businesses|reviews)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(destination);
  if (!match || match[1] !== expectedTable) {
    throw new Error(`invalid ${expectedTable} destination: ${destination}`);
  }
  return match[2];
}

function contractDestinations(contract) {
  const destinations = { businesses: new Set(), reviews: new Set() };
  for (const group of Object.values(contract.groups)) {
    for (const spec of Object.values(group.fields)) {
      const declared = Array.isArray(spec.destination) ? spec.destination : [spec.destination];
      for (const destination of declared) {
        if (destination.endsWith('.*')) continue;
        const match = /^(businesses|reviews)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(destination);
        if (!match) throw new Error(`invalid contract destination: ${destination}`);
        destinations[match[1]].add(match[2]);
      }
    }
  }
  return destinations;
}

function schemaColumns(schemaSql, table) {
  const pattern = new RegExp(
    `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\s*\\(([\\s\\S]*?)\\);`,
    'i',
  );
  const match = pattern.exec(schemaSql);
  if (!match) return null;
  return new Set(match[1].split(',').map((definition) => (
    definition.trim().split(/\s+/)[0].replace(/^[`"[]|[`"\]]$/g, '')
  )).filter(Boolean));
}

function insertColumns(sql, table) {
  const pattern = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(([^)]+)\\)`, 'i');
  const match = pattern.exec(sql);
  if (!match) return null;
  return new Set(match[1].split(',').map((column) => column.trim()).filter(Boolean));
}

function validateProductionDestinations(mapper, contract) {
  const errors = [];
  const expected = contractDestinations(contract);
  const tableConfig = {
    businesses: {
      columns: mapper.BUSINESS_COLUMNS,
      valueSql: mapper.businessValueUpsertSql,
      selectSql: mapper.businessSelectUpsertSql,
    },
    reviews: {
      columns: mapper.REVIEW_COLUMNS,
      valueSql: mapper.reviewValueUpsertSql,
      selectSql: mapper.reviewSelectUpsertSql,
    },
  };

  for (const [table, config] of Object.entries(tableConfig)) {
    if (!Array.isArray(config.columns)) {
      errors.push(`${table}: production mapper does not export a column list`);
      continue;
    }
    if (typeof config.valueSql !== 'function' || typeof config.selectSql !== 'function') {
      errors.push(`${table}: production mapper does not export both UPSERT SQL builders`);
      continue;
    }
    const schema = typeof mapper.SCHEMA === 'string' ? schemaColumns(mapper.SCHEMA, table) : null;
    if (!schema) errors.push(`${table}: CREATE TABLE definition missing from exported SCHEMA`);

    const sqlVariants = [
      ['value UPSERT', config.valueSql()],
      ['select UPSERT', config.selectSql('__contract_source__')],
    ];
    const parsedVariants = sqlVariants.map(([label, sql]) => {
      if (/\bOR\s+REPLACE\b/i.test(sql) || !/\bON\s+CONFLICT\b/i.test(sql)) {
        errors.push(`${table}: ${label} is not an explicit ON CONFLICT UPSERT`);
      }
      const columns = insertColumns(sql, table);
      if (!columns) errors.push(`${table}: ${label} INSERT column list is unreadable`);
      return [label, columns];
    });

    const exported = new Set(config.columns);
    for (const column of expected[table]) {
      if (!exported.has(column)) {
        errors.push(`${table}.${column}: absent from production column list`);
      }
      if (schema && !schema.has(column)) {
        errors.push(`${table}.${column}: absent from production CREATE TABLE schema`);
      }
      for (const [label, columns] of parsedVariants) {
        if (columns && !columns.has(column)) {
          errors.push(`${table}.${column}: absent from production ${label} INSERT`);
        }
      }
    }
  }
  return errors;
}

function expectedForRetention(retention, value, probe) {
  if (retention === 'scalar') return value;
  if (retention === 'json') return JSON.stringify(value);
  if (retention === 'boolean') return coerceBool(value);
  if (retention === 'scalar-or-json') return scalarOrJson(value);
  if (retention === 'json-member') return JSON.stringify(probe.photoCategories);
  throw new Error(`retention ${retention} needs explicit assertion handling`);
}

function makeProbe(groupName, key, value) {
  const record = { business: { placeId: BASE_PLACE_ID } };
  let review = null;

  if (groupName === 'top') {
    if (key === 'business') record.business = clone(value);
    else record[key] = clone(value);
  } else if (groupName === 'business') {
    record.business[key] = clone(value);
  } else if (groupName === 'coordinates') {
    record.business.coordinates = { [key]: clone(value) };
  } else if (groupName === 'meta') {
    record._meta = { [key]: clone(value) };
    // The meta placeId fallback is independently observable only when the
    // authoritative business.placeId is absent.
    if (key === 'placeId') delete record.business.placeId;
  } else if (groupName === 'review') {
    review = { [key]: clone(value) };
    if (key !== 'review_id') review.review_id = BASE_REVIEW_ID;
  } else if (groupName === 'photoCategory') {
    record.photoCategories = [{ [key]: clone(value) }];
  } else if (groupName === 'photo') {
    record.photoCategories = [{ photos: [{ [key]: clone(value) }] }];
  } else {
    throw new Error(`unsupported probe group: ${groupName}`);
  }
  return { record, review };
}

function callBusiness(mapper, record, location, errors) {
  try {
    return mapper.buildBusinessRow(record, MERGED_AT);
  } catch (error) {
    errors.push(`${location}: buildBusinessRow threw: ${error.message}`);
    return null;
  }
}

function callReview(mapper, review, location, errors) {
  try {
    return mapper.buildReviewRow(review, BASE_PLACE_ID);
  } catch (error) {
    errors.push(`${location}: buildReviewRow threw: ${error.message}`);
    return null;
  }
}

function assertValue(errors, location, actual, expected) {
  if (!same(actual, expected)) {
    errors.push(`${location}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

function checkField(mapper, groupName, key, spec, value, errors) {
  const location = `${groupName}.${key}`;
  const probe = makeProbe(groupName, key, value);

  if (spec.retention === 'container') {
    if (groupName === 'top' && key === 'business') {
      const row = callBusiness(mapper, probe.record, location, errors);
      if (!row || row.place_id == null) errors.push(`${location} -> businesses.*: no row produced`);
    } else if (groupName === 'top' && key === 'detailedReviews') {
      const rows = value.map((review, index) => (
        callReview(mapper, review, `${location}[${index}]`, errors)
      ));
      if (rows.some((row) => !row)) errors.push(`${location} -> reviews.*: no row produced`);
    } else {
      errors.push(`${location}: unsupported container assertion`);
    }
    return;
  }

  const row = groupName === 'review'
    ? callReview(mapper, probe.review, location, errors)
    : callBusiness(mapper, probe.record, location, errors);
  if (!row) {
    errors.push(`${location}: mapper produced no row`);
    return;
  }

  if (spec.retention === 'mapped-children') {
    assertValue(errors, `${location} -> businesses.latitude`, row.latitude, value.lat);
    assertValue(errors, `${location} -> businesses.longitude`, row.longitude, value.lng);
    return;
  }

  if (spec.retention === 'json-and-scalar') {
    for (const assertion of spec.assertions || []) {
      const column = destinationColumn(assertion.destination, 'businesses');
      const expected = assertion.encoding === 'group-json'
        ? JSON.stringify(probe.record._meta) : value;
      assertValue(errors, `${location} -> ${assertion.destination}`, row[column], expected);
    }
    return;
  }

  const expectedTable = groupName === 'review' ? 'reviews' : 'businesses';
  const column = destinationColumn(spec.destination, expectedTable);
  const expected = expectedForRetention(spec.retention, value, probe.record);
  assertValue(errors, `${location} -> ${spec.destination}`, row[column], expected);
}

function checkPrecedence(mapper, contract, samples, errors) {
  for (const [key, spec] of Object.entries(contract.groups.business.fields)) {
    if (!spec.preferredOver) continue;
    const match = /^business\.coordinates\.(lat|lng)$/.exec(spec.preferredOver);
    if (!match) {
      errors.push(`business.${key}: unsupported preferredOver ${spec.preferredOver}`);
      continue;
    }
    const coordinateKey = match[1];
    const direct = samples.business.get(key);
    const fallback = samples.coordinates.get(coordinateKey);
    if (same(direct, fallback)) {
      errors.push(`business.${key}: fixture must distinguish direct and coordinate values`);
      continue;
    }
    const record = {
      business: {
        placeId: BASE_PLACE_ID,
        [key]: clone(direct),
        coordinates: { [coordinateKey]: clone(fallback) },
      },
    };
    const row = callBusiness(mapper, record, `precedence.business.${key}`, errors);
    if (!row) continue;
    const column = destinationColumn(spec.destination, 'businesses');
    assertValue(
      errors,
      `precedence.business.${key} over ${spec.preferredOver}`,
      row[column],
      direct,
    );
  }
}

function runOracle(mapper, contract, samples) {
  const errors = [];
  for (const [groupName, group] of Object.entries(contract.groups)) {
    for (const [key, spec] of Object.entries(group.fields)) {
      checkField(mapper, groupName, key, spec, samples[groupName].get(key), errors);
    }
  }
  checkPrecedence(mapper, contract, samples, errors);
  return errors;
}

function mutationSelfTest(mapper, contract, samples) {
  const rowMutant = {
    buildBusinessRow(...args) {
      const row = mapper.buildBusinessRow(...args);
      if (row) delete row.name;
      return row;
    },
    buildReviewRow(...args) {
      const row = mapper.buildReviewRow(...args);
      if (row) delete row.review_text;
      return row;
    },
  };
  const rowErrors = runOracle(rowMutant, contract, samples);
  const businessCaught = rowErrors.some((error) => error.includes('business.name'));
  const reviewCaught = rowErrors.some((error) => error.includes('review.review_text'));

  const sqlMutant = {
    ...mapper,
    BUSINESS_COLUMNS: mapper.BUSINESS_COLUMNS.filter((column) => column !== 'name'),
    REVIEW_COLUMNS: mapper.REVIEW_COLUMNS.filter((column) => column !== 'review_text'),
  };
  const sqlErrors = validateProductionDestinations(sqlMutant, contract);
  const businessSqlCaught = sqlErrors.some((error) => error.includes('businesses.name'));
  const reviewSqlCaught = sqlErrors.some((error) => error.includes('reviews.review_text'));
  if (!businessCaught || !reviewCaught || !businessSqlCaught || !reviewSqlCaught) {
    throw new Error(
      'mutation self-test failed '
      + `(row business=${businessCaught}, row review=${reviewCaught}, `
      + `SQL business=${businessSqlCaught}, SQL review=${reviewSqlCaught})`,
    );
  }
  console.log(
    'Mapper/SQL omission self-test: passed '
    + '(business + review row/column mutations rejected)',
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const contract = readJson(options.contractPath, 'contract');
  if (!contract.groups || contract.contractVersion !== 2) {
    throw new Error('mapping oracle requires a version 2 retention contract');
  }
  const records = readFixture(options.fixturePath);
  const samples = collectSamples(contract, records);
  validateOpenDictionaryFixtures(contract, samples);

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mapper = require(options.mapperPath);
  if (typeof mapper.buildBusinessRow !== 'function'
      || typeof mapper.buildReviewRow !== 'function') {
    throw new Error('mapper must export buildBusinessRow and buildReviewRow');
  }

  const errors = [
    ...validateProductionDestinations(mapper, contract),
    ...runOracle(mapper, contract, samples),
  ];
  if (errors.length) {
    console.error(`NDJSON -> SQLite mapping contract failed with ${errors.length} error(s):`);
    errors.slice(0, 100).forEach((error) => console.error(`  - ${error}`));
    if (errors.length > 100) console.error(`  ... ${errors.length - 100} more error(s)`);
    process.exitCode = 1;
    return;
  }

  if (options.selfTest) mutationSelfTest(mapper, contract, samples);
  const fieldCount = Object.values(contract.groups)
    .reduce((count, group) => count + Object.keys(group.fields).length, 0);
  console.log(
    `NDJSON -> SQLite mapping contract passed: ${fieldCount} independently declared keys; `
    + 'row output, schema, value/select UPSERTs, coordinates, and open JSON verified',
  );
}

try {
  main();
} catch (error) {
  console.error(`NDJSON -> SQLite mapping contract error: ${error.message}`);
  process.exitCode = 1;
}
