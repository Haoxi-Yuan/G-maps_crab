#!/usr/bin/env node
'use strict';

/**
 * Enumerate the guided-question taxonomy that Google attaches to reviews.
 *
 * Google ships only the *selected* option with each answered question — the
 * candidate list is never sent — so the universe below is an observed lower
 * bound, not Google's catalogue. The saturation curve is what tells you how
 * close the sample is to exhausting it: if the last decile of reviews still
 * turns up new question ids, keep collecting.
 */

const fs = require('fs');
const path = require('path');
const { iterateNdjsonRecords } = require('../src/ndjson-reader');
const { REVIEW_DETAIL_KEYS } = require('../src/reviewer-profile-parser');

const root = path.resolve(__dirname, '..');
const SATURATION_BUCKETS = 20;
const TOP_CATEGORIES_PER_QUESTION = 8;

function usage() {
  console.log(`
Enumerate structured review-question ids, options and coverage

Usage:
  node scripts/analyze-structured-responses.js --input <reviewers.ndjson> [options]
  node scripts/analyze-structured-responses.js --self-test

Options:
  --input <file>    Reviewer-profile NDJSON produced by the reviewers command
  --output <file>   Write the full taxonomy JSON
  --top-options <n> Options listed per question in the JSON (default: all)
  --self-test       Run the built-in fixture check
  --help            Show this help
`);
}

function parseArgs(argv) {
  const options = {};
  const values = new Set(['--input', '--output', '--top-options']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    if (key === '--self-test') { options.selfTest = true; continue; }
    if (!values.has(key)) throw new Error(`unknown option: ${key}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value`);
    options[{ '--input': 'input', '--output': 'output', '--top-options': 'topOptions' }[key]] = argv[++index];
  }
  if (options.topOptions != null) {
    options.topOptions = Number(options.topOptions);
    if (!Number.isInteger(options.topOptions) || options.topOptions < 1) throw new Error('--top-options must be a positive integer');
  }
  return options;
}

// GUIDED_DINING_MODE -> DINING, HOTELS_ASPECT_LOCATION -> HOTELS.
function familyOf(questionId) {
  const parts = String(questionId).split('_');
  return parts[0] === 'GUIDED' && parts.length > 1 ? parts[1] : parts[0];
}

// "E:VND_100000_TO_200000" priced in dong and "E:SGD_10_TO_20" are the same
// question with a currency-parameterised option space; flag that rather than
// pretending the option universe is a closed set.
function currencyScope(optionId) {
  const match = /^E:([A-Z]{3})_/.exec(String(optionId || ''));
  return match ? match[1] : null;
}

function newQuestion(id) {
  return {
    question_id: id,
    family: familyOf(id),
    mapped_to_review_detail: REVIEW_DETAIL_KEYS[id] || null,
    reviews_answered: 0,
    display_labels: new Map(),
    question_texts: new Map(),
    answer_kinds: new Map(),
    scores: new Map(),
    options: new Map(),
    currencies: new Set(),
    place_categories: new Map(),
  };
}

function bump(map, key) {
  if (key == null || key === '') return;
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedEntries(map, limit) {
  const entries = [...map.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])));
  return limit ? entries.slice(0, limit) : entries;
}

function toCountObject(map, limit) {
  return Object.fromEntries(sortedEntries(map, limit));
}

function aggregate(records, options = {}) {
  const questions = new Map();
  const seenQuestionIds = new Set();
  const seenOptionIds = new Set();
  const families = new Map();
  const saturation = [];
  let reviewsScanned = 0;
  let reviewsWithAnyAnswer = 0;
  let answersSeen = 0;
  let profilesScanned = 0;

  const reviewTotal = records.reduce((sum, record) => sum + (record.public_content?.reviews?.length || 0), 0);
  const bucketSize = Math.max(1, Math.ceil(reviewTotal / SATURATION_BUCKETS));

  for (const record of records) {
    profilesScanned += 1;
    for (const review of record.public_content?.reviews || []) {
      reviewsScanned += 1;
      const responses = Array.isArray(review.structured_responses) ? review.structured_responses : [];
      if (responses.length) reviewsWithAnyAnswer += 1;
      const mainCategory = review.business?.main_category || null;

      for (const response of responses) {
        const id = response?.id;
        if (!id) continue;
        answersSeen += 1;
        seenQuestionIds.add(id);
        if (!questions.has(id)) questions.set(id, newQuestion(id));
        const question = questions.get(id);
        question.reviews_answered += 1;
        bump(question.display_labels, response.label);
        bump(question.question_texts, response.question);
        bump(question.place_categories, mainCategory);
        bump(families, familyOf(id));

        const hasScore = Number.isFinite(response.score);
        const selected = Array.isArray(response.selected_options) ? response.selected_options : [];
        if (hasScore) {
          bump(question.answer_kinds, 'score');
          bump(question.scores, response.score);
        }
        if (selected.length) bump(question.answer_kinds, selected.length > 1 ? 'multi_choice' : 'single_choice');
        if (!hasScore && !selected.length) bump(question.answer_kinds, 'empty');

        for (const option of selected) {
          const optionId = option?.id;
          if (!optionId) continue;
          seenOptionIds.add(`${id}::${optionId}`);
          if (!question.options.has(optionId)) question.options.set(optionId, { option_id: optionId, count: 0, labels: new Map() });
          const entry = question.options.get(optionId);
          entry.count += 1;
          bump(entry.labels, option.display_label || option.label);
          const currency = currencyScope(optionId);
          if (currency) question.currencies.add(currency);
        }
      }

      if (reviewsScanned % bucketSize === 0 || reviewsScanned === reviewTotal) {
        saturation.push({
          reviews_scanned: reviewsScanned,
          distinct_question_ids: seenQuestionIds.size,
          distinct_option_ids: seenOptionIds.size,
        });
      }
    }
  }

  const questionList = [...questions.values()]
    .sort((left, right) => right.reviews_answered - left.reviews_answered)
    .map((question) => ({
      question_id: question.question_id,
      family: question.family,
      mapped_to_review_detail: question.mapped_to_review_detail,
      reviews_answered: question.reviews_answered,
      answer_kinds: toCountObject(question.answer_kinds),
      display_labels: toCountObject(question.display_labels),
      question_texts: toCountObject(question.question_texts, 3),
      score_distribution: question.scores.size ? toCountObject(question.scores) : null,
      distinct_options: question.options.size,
      currency_scoped: question.currencies.size > 0,
      currencies: [...question.currencies].sort(),
      options: sortedEntries(question.options, options.topOptions).map(([, entry]) => ({
        option_id: entry.option_id,
        count: entry.count,
        labels: toCountObject(entry.labels, 3),
      })),
      top_place_categories: toCountObject(question.place_categories, TOP_CATEGORIES_PER_QUESTION),
    }));

  const unmapped = questionList.filter((question) => !question.mapped_to_review_detail).map((question) => question.question_id);
  // Convergence over the final quarter of the scan, not the final bucket: one
  // quiet bucket proves nothing, and a small sample goes quiet trivially.
  const quarterMark = saturation.find((point) => point.reviews_scanned >= reviewsScanned * 0.75) || null;
  const last = saturation[saturation.length - 1] || null;
  const newQuestionsInTail = last && quarterMark ? last.distinct_question_ids - quarterMark.distinct_question_ids : null;
  const newOptionsInTail = last && quarterMark ? last.distinct_option_ids - quarterMark.distinct_option_ids : null;

  return {
    generated_at: new Date().toISOString(),
    summary: {
      profiles_scanned: profilesScanned,
      reviews_scanned: reviewsScanned,
      reviews_with_any_structured_answer: reviewsWithAnyAnswer,
      structured_answer_rate: reviewsScanned ? Number((reviewsWithAnyAnswer / reviewsScanned).toFixed(4)) : null,
      answers_seen: answersSeen,
      distinct_question_ids: seenQuestionIds.size,
      distinct_question_option_pairs: seenOptionIds.size,
      question_families: toCountObject(families),
      question_ids_without_review_detail_mapping: unmapped,
      new_question_ids_in_last_quarter: newQuestionsInTail,
      new_option_pairs_in_last_quarter: newOptionsInTail,
      converged: newQuestionsInTail === 0 && newOptionsInTail === 0,
    },
    saturation,
    questions: questionList,
    notes: [
      'Google sends only the selected option, never the candidate list, so distinct_option_ids is an observed lower bound.',
      'converged compares the last quarter of the scan against the rest; on a small sample it goes true trivially, so read it together with reviews_scanned.',
      'Price questions are currency-scoped: their option space grows with every new currency in the sample.',
    ],
  };
}

async function readRecords(inputFile) {
  const records = [];
  const latest = new Map();
  for await (const logical of iterateNdjsonRecords(inputFile)) {
    const record = logical.value || {};
    if (!record.reviewer_id) continue;
    latest.set(record.reviewer_id, record);
  }
  for (const record of latest.values()) records.push(record);
  return records;
}

function selfTest() {
  const assert = require('assert');
  const review = (questions, category) => ({
    business: { main_category: category },
    structured_responses: questions,
  });
  const records = [{
    reviewer_id: 'r1',
    public_content: {
      reviews: [
        review([
          { id: 'GUIDED_DINING_MODE', question: 'Did you dine in?', label: 'Order type', score: null, selected_options: [{ id: 'E:DINE_IN', label: 'Dine in', display_label: 'Dine in' }] },
          { id: 'GUIDED_DINING_FOOD_ASPECT', question: 'Food', label: 'Food', score: 5, selected_options: [] },
          { id: 'GUIDED_DINING_PRICE_RANGE', question: 'How much?', label: 'Price per person', score: null, selected_options: [{ id: 'E:SGD_10_TO_20', label: '$10–20', display_label: '$10 to $20' }] },
        ], 'Restaurant'),
        review([
          { id: 'HOTELS_VIBE', question: 'Describe the hotel', label: 'Hotel highlights', score: null, selected_options: [{ id: 'E:HOTEL_VIBES_GREAT_VIEW', label: 'Great view', display_label: 'Great view' }] },
        ], 'Hotel'),
        review([], 'Park'),
      ],
    },
  }];
  const report = aggregate(records);
  assert.equal(report.summary.reviews_scanned, 3);
  assert.equal(report.summary.reviews_with_any_structured_answer, 2);
  assert.equal(report.summary.distinct_question_ids, 4);
  assert.equal(report.summary.distinct_question_option_pairs, 3);
  assert.deepEqual(report.summary.question_families, { DINING: 3, HOTELS: 1 });
  assert.deepEqual(report.summary.question_ids_without_review_detail_mapping, ['HOTELS_VIBE']);

  const price = report.questions.find((question) => question.question_id === 'GUIDED_DINING_PRICE_RANGE');
  assert.equal(price.currency_scoped, true);
  assert.deepEqual(price.currencies, ['SGD']);
  assert.equal(price.mapped_to_review_detail, 'price_per_person');

  const food = report.questions.find((question) => question.question_id === 'GUIDED_DINING_FOOD_ASPECT');
  assert.deepEqual(food.answer_kinds, { score: 1 });
  assert.deepEqual(food.score_distribution, { 5: 1 });

  const hotel = report.questions.find((question) => question.question_id === 'HOTELS_VIBE');
  assert.equal(hotel.family, 'HOTELS');
  assert.deepEqual(hotel.top_place_categories, { Hotel: 1 });

  assert.equal(report.saturation[report.saturation.length - 1].reviews_scanned, 3);
  console.log('Structured-response taxonomy self-test: passed '
    + `(${report.summary.distinct_question_ids} question ids, ${report.summary.distinct_question_option_pairs} option pairs)`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (options.selfTest) { selfTest(); return; }
  if (!options.input) throw new Error('--input is required');

  const inputFile = path.resolve(root, options.input);
  const records = await readRecords(inputFile);
  const report = aggregate(records, { topOptions: options.topOptions });
  report.input_file = inputFile;

  if (options.output) {
    const outputFile = path.resolve(root, options.output);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  }

  const { summary } = report;
  console.log(`profiles: ${summary.profiles_scanned}  reviews: ${summary.reviews_scanned}  with answers: ${summary.reviews_with_any_structured_answer} (${summary.structured_answer_rate})`);
  console.log(`distinct question ids: ${summary.distinct_question_ids}  question/option pairs: ${summary.distinct_question_option_pairs}`);
  console.log(`families: ${JSON.stringify(summary.question_families)}`);
  console.log(`new in last quarter: ${summary.new_question_ids_in_last_quarter} question ids, ${summary.new_option_pairs_in_last_quarter} option pairs (converged: ${summary.converged})`);
  if (summary.question_ids_without_review_detail_mapping.length) {
    console.log(`no review_details mapping: ${summary.question_ids_without_review_detail_mapping.join(', ')}`);
  }
  for (const question of report.questions) {
    console.log(`  ${question.question_id.padEnd(34)} n=${String(question.reviews_answered).padStart(6)}  options=${String(question.distinct_options).padStart(4)}  ${Object.keys(question.display_labels)[0] || ''}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[STRUCTURED ANALYSIS] ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { aggregate, familyOf, currencyScope };
