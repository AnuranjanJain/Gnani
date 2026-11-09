'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../lib/evaluate');
const scenario = require('../lib/scenario');

function statusOf(result, id) {
  return result.points.find((p) => p.id === id);
}

describe('scenario', () => {
  it('uses the approved EN instruction and 2 required points', () => {
    assert.equal(scenario.instructionEN, 'Before cleaning, switch off the machine and lock the power supply.');
    assert.deepEqual(
      scenario.requiredPoints.map((p) => p.id),
      ['switch-off', 'lock-power'],
    );
  });

  it('flags the Hindi translation as needs-human-review', () => {
    assert.equal(scenario.instructionHI.status, 'needs-human-review');
  });
});

describe('evaluate demo oracle', () => {
  it('"Machine band karke saaf karna hai." -> switch-off Mentioned, lock-power gap + power follow-up', () => {
    const r = evaluate('Machine band karke saaf karna hai.', 1);
    const sw = statusOf(r, 'switch-off');
    assert.equal(sw.status, 'Mentioned');
    assert.match(sw.excerpt, /band/i);
    assert.ok(['Not mentioned', 'Unclear'].includes(statusOf(r, 'lock-power').status));
    assert.match(r.followUp, /power supply/i);
    assert.equal(r.state, 'Needs clarification');
  });

  it('"Power supply lock karni hai." -> lock-power Mentioned', () => {
    const r = evaluate('Power supply lock karni hai.', 1);
    assert.equal(statusOf(r, 'lock-power').status, 'Mentioned');
    assert.match(statusOf(r, 'lock-power').excerpt, /lock/i);
  });
});

describe('evaluate matching', () => {
  it('matches Devanagari paraphrases', () => {
    const r = evaluate('Machine बंद करके साफ करना है और बिजली का ताला लगाना है.', 1);
    assert.equal(statusOf(r, 'switch-off').status, 'Mentioned');
    assert.equal(statusOf(r, 'lock-power').status, 'Mentioned');
    assert.equal(r.state, 'Ready for supervisor review');
    assert.equal(r.followUp, null);
  });

  it('matches EN paraphrases and reports Ready when both points covered', () => {
    const r = evaluate('Switch off the machine and lock the power supply before cleaning.', 2);
    assert.equal(statusOf(r, 'switch-off').status, 'Mentioned');
    assert.equal(statusOf(r, 'lock-power').status, 'Mentioned');
    assert.equal(r.state, 'Ready for supervisor review');
    assert.equal(r.followUp, null);
    assert.equal(r.turn, 2);
  });

  it('is negation-aware: never Mentioned under nahi / no need / skip', () => {
    const r1 = evaluate('Machine band karne ki no need hai.', 1);
    assert.notEqual(statusOf(r1, 'switch-off').status, 'Mentioned');
    const r2 = evaluate('Taala nahi lagana hai.', 1);
    assert.notEqual(statusOf(r2, 'lock-power').status, 'Mentioned');
    const r3 = evaluate('Skip the lock, just switch off the machine.', 1);
    assert.notEqual(statusOf(r3, 'lock-power').status, 'Mentioned');
  });

  it('handles empty transcript as Needs clarification (not an error)', () => {
    const r = evaluate('', 1);
    assert.equal(r.state, 'Needs clarification');
    assert.ok(r.followUp);
  });

  it('follow-up is a teach-back prompt, never an instruction to act', () => {
    const r = evaluate('Machine band karke saaf karna hai.', 1);
    assert.match(r.followUp, /tell me in your own words/i);
    assert.doesNotMatch(r.followUp, /you must|do it|go and|switch it off now/i);
  });
});
