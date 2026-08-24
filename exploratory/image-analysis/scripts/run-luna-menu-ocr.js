#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PROMPT_VERSION = 'menu-ocr-luna-v1';
const SYSTEM_PROMPT = `You are a literal menu-image transcription system.
Extract only text that is visibly supported by the image. Never invent, translate, repair, or infer a dish, price, ingredient, currency, restaurant name, or section.
Preserve the displayed spelling, capitalization, language, and price text. Pair a price with a dish only when the visual layout supports that pairing. Put size or option prices in variants. If a dish has no visible price, use null.
Descriptions must also be literal visible text; do not infer ingredients from a dish name. Currency is null unless a currency symbol/code is visible. Record banners, notices, and other unassigned visible text in other_visible_text.
If this is not a food/drink menu, set is_menu=false, return no sections, and briefly describe the visible content in non_menu_reason.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    is_menu: { type: 'boolean' },
    menu_language_codes: { type: 'array', items: { type: 'string' } },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section_name: { type: ['string', 'null'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                dish_raw: { type: 'string' },
                description_raw: { type: ['string', 'null'] },
                price_text: { type: ['string', 'null'] },
                price_value: { type: ['number', 'null'] },
                currency: { type: ['string', 'null'] },
                variants: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      variant_raw: { type: 'string' },
                      price_text: { type: ['string', 'null'] },
                      price_value: { type: ['number', 'null'] },
                    },
                    required: ['variant_raw', 'price_text', 'price_value'],
                  },
                },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
              },
              required: [
                'dish_raw', 'description_raw', 'price_text', 'price_value',
                'currency', 'variants', 'confidence',
              ],
            },
          },
        },
        required: ['section_name', 'items'],
      },
    },
    other_visible_text: { type: 'array', items: { type: 'string' } },
    non_menu_reason: { type: ['string', 'null'] },
    transcription_notes: { type: ['string', 'null'] },
  },
  required: [
    'is_menu', 'menu_language_codes', 'sections', 'other_visible_text',
    'non_menu_reason', 'transcription_notes',
  ],
};

function parseArgs(argv) {
  const args = {
    runId: 'luna_smoke_v1',
    model: 'gpt-5.6-luna',
    detail: 'original',
    limit: 8,
    maxRetries: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sample-db') args.sampleDb = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--run-id') args.runId = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--detail') args.detail = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--max-retries') args.maxRetries = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.sampleDb || !args.out) throw new Error('--sample-db and --out are required');
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  if (!Number.isInteger(args.maxRetries) || args.maxRetries < 0) throw new Error('--max-retries must be a non-negative integer');
  if (!['low', 'high', 'original', 'auto'].includes(args.detail)) throw new Error('Unsupported --detail value');
  return args;
}

function mimeType(filePath, bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  throw new Error(`Unsupported image format: ${filePath}`);
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  throw new Error('Response contained no output_text');
}

function selectSmoke(rows, limit) {
  const selected = [];
  const used = new Set();
  const targets = [
    ['multi_poi', 'portrait', '12MP+'],
    ['multi_poi', 'landscape', '4-12MP'],
    ['single_stratified', 'portrait', '12MP+'],
    ['single_stratified', 'landscape', '12MP+'],
    ['single_stratified', 'squareish', null],
    ['single_stratified', 'portrait', '1-4MP'],
    ['single_stratified', 'landscape', '4-12MP'],
    ['multi_poi', null, '1-4MP'],
  ];
  for (const [cohort, orientation, resolution] of targets) {
    const row = rows.find((candidate) => !used.has(candidate.sample_id)
      && candidate.cohort === cohort
      && (!orientation || candidate.orientation === orientation)
      && (!resolution || candidate.resolution_bin === resolution));
    if (row) {
      selected.push(row);
      used.add(row.sample_id);
    }
    if (selected.length >= limit) return selected;
  }
  for (const row of rows) {
    if (!used.has(row.sample_id)) selected.push(row);
    if (selected.length >= limit) break;
  }
  return selected;
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source_sample_db TEXT NOT NULL,
      model TEXT NOT NULL,
      image_detail TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      requested_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS results (
      run_id TEXT NOT NULL,
      sample_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      latency_ms INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      response_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      parsed_json TEXT,
      raw_response_json TEXT,
      error TEXT,
      PRIMARY KEY(run_id, sample_id)
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      run_id TEXT NOT NULL,
      sample_id TEXT NOT NULL,
      section_index INTEGER NOT NULL,
      item_index INTEGER NOT NULL,
      section_name TEXT,
      dish_raw TEXT NOT NULL,
      description_raw TEXT,
      price_text TEXT,
      price_value REAL,
      currency TEXT,
      variants_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      PRIMARY KEY(run_id, sample_id, section_index, item_index)
    );
  `);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOcr(args, row) {
  const bytes = fs.readFileSync(row.local_path);
  const mime = mimeType(row.local_path, bytes);
  const body = {
    model: args.model,
    reasoning: { effort: 'none' },
    max_output_tokens: 12000,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: SYSTEM_PROMPT },
        { type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}`, detail: args.detail },
      ],
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'menu_image_transcription',
        strict: true,
        schema: OUTPUT_SCHEMA,
      },
    },
  };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json();
  if (!response.ok) {
    const error = new Error(`OpenAI HTTP ${response.status}: ${responseBody.error?.message || 'unknown error'}`);
    error.status = response.status;
    error.responseBody = responseBody;
    throw error;
  }
  const outputText = extractOutputText(responseBody);
  return { responseBody, parsed: JSON.parse(outputText) };
}

function persistItems(db, args, sampleId, parsed) {
  db.prepare('DELETE FROM menu_items WHERE run_id = ? AND sample_id = ?').run(args.runId, sampleId);
  const insert = db.prepare(`
    INSERT INTO menu_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transaction = db.transaction(() => {
    for (let sectionIndex = 0; sectionIndex < parsed.sections.length; sectionIndex++) {
      const section = parsed.sections[sectionIndex];
      for (let itemIndex = 0; itemIndex < section.items.length; itemIndex++) {
        const item = section.items[itemIndex];
        insert.run(
          args.runId, sampleId, sectionIndex, itemIndex, section.section_name,
          item.dish_raw, item.description_raw, item.price_text, item.price_value,
          item.currency, JSON.stringify(item.variants), item.confidence,
        );
      }
    }
  });
  transaction();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const samplePath = path.resolve(args.sampleDb);
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const source = new Database(samplePath, { readonly: true, fileMustExist: true });
  const out = new Database(outPath);
  createSchema(out);
  const rows = source.prepare('SELECT * FROM samples ORDER BY sample_id').all();
  const selected = selectSmoke(rows, args.limit);
  out.prepare('INSERT OR IGNORE INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    args.runId, new Date().toISOString(), samplePath, args.model, args.detail,
    PROMPT_VERSION, selected.length,
  );
  console.log(JSON.stringify({ event: 'run_started', run_id: args.runId, count: selected.length, model: args.model }));
  for (let index = 0; index < selected.length; index++) {
    const row = selected[index];
    const existing = out.prepare('SELECT status FROM results WHERE run_id = ? AND sample_id = ?').get(args.runId, row.sample_id);
    if (existing?.status === 'completed') continue;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    out.prepare(`
      INSERT INTO results(run_id, sample_id, status, started_at, attempts)
      VALUES (?, ?, 'running', ?, 0)
      ON CONFLICT(run_id, sample_id) DO UPDATE SET status='running', started_at=excluded.started_at, error=NULL
    `).run(args.runId, row.sample_id, startedAt);
    console.log(JSON.stringify({ event: 'image_started', index: index + 1, sample_id: row.sample_id, orientation: row.orientation, resolution: row.resolution_bin }));
    let lastError;
    for (let attempt = 1; attempt <= args.maxRetries + 1; attempt++) {
      try {
        out.prepare('UPDATE results SET attempts = ? WHERE run_id = ? AND sample_id = ?').run(attempt, args.runId, row.sample_id);
        const { responseBody, parsed } = await requestOcr(args, row);
        const latency = Date.now() - startedMs;
        const usage = responseBody.usage || {};
        out.prepare(`
          UPDATE results SET status='completed', completed_at=?, latency_ms=?, response_id=?,
            input_tokens=?, output_tokens=?, total_tokens=?, parsed_json=?, raw_response_json=?, error=NULL
          WHERE run_id=? AND sample_id=?
        `).run(
          new Date().toISOString(), latency, responseBody.id || null,
          usage.input_tokens ?? null, usage.output_tokens ?? null, usage.total_tokens ?? null,
          JSON.stringify(parsed), JSON.stringify(responseBody), args.runId, row.sample_id,
        );
        persistItems(out, args, row.sample_id, parsed);
        console.log(JSON.stringify({ event: 'image_completed', index: index + 1, sample_id: row.sample_id, latency_ms: latency, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const retryable = !error.status || error.status === 429 || error.status >= 500;
        if (!retryable || attempt > args.maxRetries) break;
        await sleep(Math.min(8000, 1000 * (2 ** (attempt - 1))));
      }
    }
    if (lastError) {
      out.prepare(`
        UPDATE results SET status='failed', completed_at=?, latency_ms=?, error=?
        WHERE run_id=? AND sample_id=?
      `).run(new Date().toISOString(), Date.now() - startedMs, String(lastError.message || lastError), args.runId, row.sample_id);
      console.error(JSON.stringify({ event: 'image_failed', sample_id: row.sample_id, error: String(lastError.message || lastError) }));
    }
  }
  const summary = out.prepare(`
    SELECT status, COUNT(*) AS count, SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens, AVG(latency_ms) AS avg_latency_ms
    FROM results WHERE run_id = ? GROUP BY status ORDER BY status
  `).all(args.runId);
  console.log(JSON.stringify({ event: 'run_completed', run_id: args.runId, summary }));
  source.close();
  out.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}

module.exports = { OUTPUT_SCHEMA, extractOutputText, mimeType, parseArgs, selectSmoke };
