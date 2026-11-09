'use strict';
// Local deterministic evaluator: matches EN + Devanagari + Latin-script Hindi
// paraphrases, negation-aware, at most one teach-back follow-up question.
// Per-point matching comes from the scenario data (lib/scenarios.js): one
// match group means "any of these phrases", two groups means "a word from
// each group" (the pairing rule the lock-power point always used).
// evaluate(transcript, turn) with no scenario arg scores the default
// machine-cleaning scenario exactly as before.
const { DEFAULT_SCENARIO_ID, getScenario, pointById } = require('./scenarios');

const NEGATIONS = [
  /nahin|nahi\b/i,
  /नहीं|नही/,
  /no\s*need/i,
  /don't|do not/i,
  /\bnot\b/i,
  /\bnever\b/i,
  /\bno\b/i,
  /\bskip\b/i,
  /\bavoid\b/i,
  /\bmat\b/i,
];

const READY = 'Ready for supervisor review';
const CLARIFY = 'Needs clarification';

function splitSentences(text) {
  return String(text || '')
    .split(/[.!?।\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function allMatches(sentences, patterns) {
  return sentences.filter((s) => patterns.some((p) => p.test(s)));
}

function negated(sentence) {
  return NEGATIONS.some((p) => p.test(sentence));
}

// Single-group point (e.g. switch-off): a negated match anywhere wins, so
// contradictions are never Mentioned.
function matchSingle(sentences, group) {
  const all = allMatches(sentences, group);
  if (all.length === 0) return { status: 'Not mentioned', excerpt: null };
  const neg = all.find((s) => negated(s));
  if (neg) return { status: 'Unclear', excerpt: neg };
  return { status: 'Mentioned', excerpt: all[0] };
}

// Paired-group point (e.g. lock-power): needs a word from each group. Either
// half alone is Unclear, and a negated first-half match wins.
function matchPaired(sentences, first, second) {
  const firstAll = allMatches(sentences, first);
  const secondAll = allMatches(sentences, second);
  const firstNeg = firstAll.find((s) => negated(s));
  if (firstAll.length === 0 && secondAll.length === 0) {
    return { status: 'Not mentioned', excerpt: null };
  }
  if (firstAll.length === 0) {
    return { status: 'Unclear', excerpt: secondAll[0] };
  }
  if (firstNeg) {
    return { status: 'Unclear', excerpt: firstNeg };
  }
  if (firstAll.some((s) => second.some((p) => p.test(s))) || secondAll.length > 0) {
    const both = firstAll.find((s) => second.some((p) => p.test(s))) || firstAll[0];
    return { status: 'Mentioned', excerpt: both };
  }
  return { status: 'Unclear', excerpt: firstAll[0] };
}

function resolveScenario(input) {
  if (input === undefined || input === null) return getScenario(DEFAULT_SCENARIO_ID);
  if (typeof input === 'string') {
    const found = getScenario(input);
    if (!found) {
      const err = new Error(`Unknown scenario: ${JSON.stringify(input)}.`);
      err.code = 'UNKNOWN_SCENARIO';
      throw err;
    }
    return found;
  }
  return input;
}

function groupsFor(point) {
  if (point && point.match && Array.isArray(point.match.groups)) return point.match.groups;
  // Plain scenario objects without match data (e.g. lib/scenario.js) borrow
  // the registry patterns for the same point id.
  const known = point && pointById(point.id);
  if (known && known.match && Array.isArray(known.match.groups)) return known.match.groups;
  return [];
}

function evaluate(transcript, turn, scenarioInput) {
  const scenario = resolveScenario(scenarioInput);
  const sentences = splitSentences(transcript);
  const byId = {};

  for (const p of scenario.requiredPoints) {
    const groups = groupsFor(p);
    byId[p.id] =
      groups.length >= 2
        ? matchPaired(sentences, groups[0], groups[1])
        : matchSingle(sentences, groups[0] || []);
  }

  const points = scenario.requiredPoints.map((p) => ({
    id: p.id,
    label: p.label,
    status: byId[p.id].status,
    excerpt: byId[p.id].excerpt,
  }));

  const firstGap = scenario.requiredPoints.find((p) => byId[p.id].status !== 'Mentioned');
  const followUp = firstGap ? firstGap.followUp : null;
  const state = firstGap ? CLARIFY : READY;

  return { points, followUp, state, turn: turn === undefined ? null : turn };
}

module.exports = { evaluate, READY, CLARIFY };
