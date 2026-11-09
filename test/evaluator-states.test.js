'use strict';
// Evaluator states, excerpts, and follow-ups: both demo utterances,
// paraphrases and code-mix, empty/unintelligible input, contradictions.
// No new deps: node:test + node:assert only.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, READY, CLARIFY } = require('../lib/evaluate');
const scenario = require('../lib/scenario');

const DEMO_1 = 'Machine band karke saaf karna hai.';
const DEMO_2 = 'Power supply lock karni hai.';

function byId(result, id) {
  return result.points.find((p) => p.id === id);
}

function assertExactExcerpt(transcript, excerpt) {
  assert.ok(typeof excerpt === 'string' && excerpt.length > 0);
  assert.ok(transcript.includes(excerpt), `excerpt ${JSON.stringify(excerpt)} is not an exact substring`);
}

describe('demo utterance 1 (switch-off only)', () => {
  it('Mentioned switch-off with exact excerpt, lock-power gap, power follow-up, Needs clarification', () => {
    const r = evaluate(DEMO_1, 1);
    const sw = byId(r, 'switch-off');
    assert.equal(sw.status, 'Mentioned');
    assertExactExcerpt(DEMO_1, sw.excerpt);
    assert.match(sw.excerpt, /band/i);
    assert.equal(byId(r, 'lock-power').status, 'Not mentioned');
    assert.equal(byId(r, 'lock-power').excerpt, null);
    assert.equal(r.followUp, scenario.requiredPoints[1].followUp);
    assert.match(r.followUp, /power supply/i);
    assert.equal(r.state, CLARIFY);
    assert.equal(r.turn, 1);
  });
});

describe('demo utterance 2 (lock-power only)', () => {
  it('Mentioned lock-power with exact excerpt, switch-off gap, machine follow-up, Needs clarification', () => {
    const r = evaluate(DEMO_2, 1);
    const lp = byId(r, 'lock-power');
    assert.equal(lp.status, 'Mentioned');
    assertExactExcerpt(DEMO_2, lp.excerpt);
    assert.match(lp.excerpt, /lock/i);
    assert.equal(byId(r, 'switch-off').status, 'Not mentioned');
    assert.equal(byId(r, 'switch-off').excerpt, null);
    assert.equal(r.followUp, scenario.requiredPoints[0].followUp);
    assert.match(r.followUp, /machine/i);
    assert.equal(r.state, CLARIFY);
  });
});

describe('combined answers', () => {
  it('both demo utterances together -> Ready, no follow-up', () => {
    const r = evaluate(`${DEMO_1} ${DEMO_2}`, 2);
    assert.equal(byId(r, 'switch-off').status, 'Mentioned');
    assert.equal(byId(r, 'lock-power').status, 'Mentioned');
    assert.equal(r.state, READY);
    assert.equal(r.followUp, null);
    assert.equal(r.turn, 2);
  });

  it('turn defaults to null when omitted', () => {
    assert.equal(evaluate(DEMO_1).turn, null);
  });
});

describe('paraphrases and code-mix', () => {
  const switchParaphrases = [
    'Please turn off the machine before cleaning.',
    'Shut down the machine first.',
    'Power off the machine, then clean.',
    'Machine बंद करो फिर सफाई करो.',
    'Pehle machine band karo, phir saaf karo.',
    'मशीन स्विच ऑफ करके साफ करना है.',
    'Machine ऑफ करके clean karo.',
  ];
  for (const t of switchParaphrases) {
    it(`switch-off Mentioned: ${JSON.stringify(t)}`, () => {
      const r = evaluate(t, 1);
      assert.equal(byId(r, 'switch-off').status, 'Mentioned');
      assertExactExcerpt(t, byId(r, 'switch-off').excerpt);
    });
  }

  const lockParaphrases = [
    'Lock the power supply before cleaning.',
    'Taala lagana hai power supply par.',
    'Power par tala lagao.',
    'बिजली का ताला लगाना है.',
    'Bijli band karke uska taala laga do.',
    'पावर सप्लाई पर लॉक लगाना है.',
    'Power supply lock karo, लॉक zaroori hai.',
  ];
  for (const t of lockParaphrases) {
    it(`lock-power Mentioned: ${JSON.stringify(t)}`, () => {
      const r = evaluate(t, 1);
      assert.equal(byId(r, 'lock-power').status, 'Mentioned');
      assertExactExcerpt(t, byId(r, 'lock-power').excerpt);
    });
  }

  it('code-mixed full answer -> Ready with no follow-up', () => {
    const t = 'Machine band karo aur bijli ke supply ka taala laga do.';
    const r = evaluate(t, 1);
    assert.equal(byId(r, 'switch-off').status, 'Mentioned');
    assert.equal(byId(r, 'lock-power').status, 'Mentioned');
    assert.equal(r.state, READY);
    assert.equal(r.followUp, null);
  });
});

describe('live misrecognition guard (बैन is not बंद)', () => {
  it('never matches a lookalike: मशीन बैन कार के -> Not mentioned + machine follow-up', () => {
    const t = 'मशीन बैन कार के साफ करना है।'; // real live-STT mishearing of "band karke"
    const r = evaluate(t, 1);
    assert.equal(byId(r, 'switch-off').status, 'Not mentioned');
    assert.equal(byId(r, 'switch-off').excerpt, null);
    assert.equal(byId(r, 'lock-power').status, 'Not mentioned');
    assert.equal(r.followUp, scenario.requiredPoints[0].followUp);
    assert.equal(r.state, CLARIFY);
  });
});

describe('empty and unintelligible input -> no evaluation', () => {
  const empties = ['', '   ', '\n\t ', 'uhh hmm', 'asdf qwerty', 'pata nahi samajh nahi aaya'];
  for (const t of empties) {
    it(`no Mentioned for ${JSON.stringify(t)}`, () => {
      const r = evaluate(t, 1);
      for (const p of r.points) assert.notEqual(p.status, 'Mentioned');
      assert.equal(r.state, CLARIFY);
      assert.ok(r.followUp, 'a teach-back follow-up is offered instead of an evaluation');
    });
  }

  it('pure gibberish yields Not mentioned with null excerpts', () => {
    const r = evaluate('asdf qwerty', 1);
    assert.deepEqual(
      r.points.map((p) => [p.id, p.status, p.excerpt]),
      [
        ['switch-off', 'Not mentioned', null],
        ['lock-power', 'Not mentioned', null],
      ],
    );
  });
});

describe('contradictions -> never Mentioned', () => {
  const cases = [
    ['Do not switch off the machine.', 'switch-off'],
    ['Never switch off the machine.', 'switch-off'],
    ['Machine band mat karo.', 'switch-off'],
    ['Machine band karne ki no need hai.', 'switch-off'],
    ['Switch off nahi karna hai.', 'switch-off'],
    ['Taala nahi lagana hai.', 'lock-power'],
    ['Do not lock the power supply.', 'lock-power'],
    ['Never lock the power, just clean.', 'lock-power'],
    ['Skip the lock, just switch off the machine.', 'lock-power'],
    // Cross-sentence contradictions: the negation wins over the earlier affirmation.
    ['Switch off the machine. Actually, do not switch off.', 'switch-off'],
    ['I will lock the power supply. Actually, no need to lock.', 'lock-power'],
    ['Machine band karo. Nahi, band mat karo.', 'switch-off'],
  ];
  for (const [t, id] of cases) {
    it(`${id} not Mentioned: ${JSON.stringify(t)}`, () => {
      const r = evaluate(t, 1);
      assert.notEqual(byId(r, id).status, 'Mentioned');
      assert.equal(byId(r, id).status, 'Unclear');
      assertExactExcerpt(t, byId(r, id).excerpt);
    });
  }

  it('a negated sentence about something else does not clear a real mention', () => {
    const r = evaluate('Switch off the machine. There is no dust on the floor.', 1);
    assert.equal(byId(r, 'switch-off').status, 'Mentioned');
  });
});

describe('evaluator states and follow-up shape', () => {
  it('follow-up is a single teach-back string, never an instruction to act', () => {
    for (const t of [DEMO_1, DEMO_2, '']) {
      const r = evaluate(t, 1);
      assert.equal(typeof r.followUp, 'string');
      assert.match(r.followUp, /tell me in your own words/i);
      assert.doesNotMatch(r.followUp, /you must|do it|go and|switch it off now/i);
    }
  });

  it('follow-up is null exactly when Ready', () => {
    assert.equal(evaluate(`${DEMO_1} ${DEMO_2}`, 2).followUp, null);
    assert.ok(evaluate(DEMO_1, 1).followUp);
  });

  it('point labels come from the scenario', () => {
    const r = evaluate(DEMO_1, 1);
    assert.deepEqual(
      r.points.map((p) => [p.id, p.label]),
      scenario.requiredPoints.map((p) => [p.id, p.label]),
    );
  });
});

// ---- Scenario picker: the two new synthetic safety scenarios ----
// The machine-cleaning cases above run with no scenario arg (the default);
// these cases pass an explicit scenarioId through to the data-driven matcher.
const { getScenario, SCENARIOS, DEFAULT_SCENARIO_ID } = require('../lib/scenarios');

describe('scenario registry', () => {
  it('holds 3 scenarios defaulting to machine-cleaning', () => {
    assert.equal(DEFAULT_SCENARIO_ID, 'machine-cleaning');
    assert.deepEqual(
      SCENARIOS.map((s) => s.id),
      ['machine-cleaning', 'ladder-safety', 'spill-response'],
    );
    for (const s of SCENARIOS) {
      assert.equal(s.requiredPoints.length, 2);
    }
  });

  it('keeps the machine-cleaning wording exactly as approved', () => {
    const def = getScenario('machine-cleaning');
    assert.equal(def.instructionEN, scenario.instructionEN);
    assert.deepEqual(def.instructionHI, scenario.instructionHI);
    assert.deepEqual(
      def.requiredPoints.map((p) => [p.id, p.label, p.followUp]),
      scenario.requiredPoints.map((p) => [p.id, p.label, p.followUp]),
    );
  });

  it('flags every Hindi line as needs-human-review', () => {
    for (const s of SCENARIOS) {
      assert.equal(s.instructionHI.status, 'needs-human-review');
      assert.ok(s.instructionHI.text.length > 0);
    }
  });

  it('gives every point a teach-back follow-up, never an instruction to act', () => {
    for (const s of SCENARIOS) {
      for (const p of s.requiredPoints) {
        assert.match(p.followUp, /tell me in your own words/i);
        assert.doesNotMatch(p.followUp, /you must|do it|go and|climb it now|step back now/i);
      }
    }
  });
});

describe('ladder-safety scenario', () => {
  const SC = 'ladder-safety';
  const ladder = getScenario(SC);

  it('level-ground Mentioned with exact excerpt, spreader gap + spreader follow-up', () => {
    const t = 'Set the ladder on firm level ground before climbing.';
    const r = evaluate(t, 1, SC);
    assert.equal(byId(r, 'level-ground').status, 'Mentioned');
    assertExactExcerpt(t, byId(r, 'level-ground').excerpt);
    assert.equal(byId(r, 'lock-spreader').status, 'Not mentioned');
    assert.equal(byId(r, 'lock-spreader').excerpt, null);
    assert.equal(r.followUp, ladder.requiredPoints[1].followUp);
    assert.match(r.followUp, /locked/i);
    assert.equal(r.state, CLARIFY);
    assert.equal(r.turn, 1);
  });

  it('level-ground Mentioned via Latin-script Hindi and Devanagari', () => {
    for (const t of ['Seedhi ko samtal zameen par rakho.', 'सीढ़ी को समतल जगह पर रखें।']) {
      const r = evaluate(t, 1, SC);
      assert.equal(byId(r, 'level-ground').status, 'Mentioned');
      assertExactExcerpt(t, byId(r, 'level-ground').excerpt);
    }
  });

  it('lock-spreader Mentioned with exact excerpt, level gap + placing follow-up', () => {
    const t = 'Lock the spreader bars before climbing.';
    const r = evaluate(t, 1, SC);
    assert.equal(byId(r, 'lock-spreader').status, 'Mentioned');
    assertExactExcerpt(t, byId(r, 'lock-spreader').excerpt);
    assert.match(byId(r, 'lock-spreader').excerpt, /spreader/i);
    assert.equal(byId(r, 'level-ground').status, 'Not mentioned');
    assert.equal(r.followUp, ladder.requiredPoints[0].followUp);
    assert.match(r.followUp, /where the ladder/i);
    assert.equal(r.state, CLARIFY);
  });

  it('half answers are Unclear: spreader-only, lock-only, and negated lock', () => {
    for (const t of [
      'Check the spreader bars.',
      'Lock the ladder before climbing.',
      'Do not lock the spreader bars.',
    ]) {
      const r = evaluate(t, 1, SC);
      assert.equal(byId(r, 'lock-spreader').status, 'Unclear');
      assertExactExcerpt(t, byId(r, 'lock-spreader').excerpt);
      assert.notEqual(byId(r, 'lock-spreader').status, 'Mentioned');
    }
  });

  it('combined ladder answer -> Ready with no follow-up', () => {
    const r = evaluate(
      'Set the ladder on firm level ground and lock the spreader bars before climbing.',
      2,
      SC,
    );
    assert.equal(byId(r, 'level-ground').status, 'Mentioned');
    assert.equal(byId(r, 'lock-spreader').status, 'Mentioned');
    assert.equal(r.state, READY);
    assert.equal(r.followUp, null);
  });

  it('point labels come from the ladder scenario', () => {
    const r = evaluate('Set the ladder on firm level ground before climbing.', 1, SC);
    assert.deepEqual(
      r.points.map((p) => [p.id, p.label]),
      ladder.requiredPoints.map((p) => [p.id, p.label]),
    );
  });
});

describe('spill-response scenario', () => {
  const SC = 'spill-response';
  const spill = getScenario(SC);

  it('step-back Mentioned with exact excerpt, supervisor gap + who-to-tell follow-up', () => {
    const t = 'Step back from the spill.';
    const r = evaluate(t, 1, SC);
    assert.equal(byId(r, 'step-back').status, 'Mentioned');
    assertExactExcerpt(t, byId(r, 'step-back').excerpt);
    assert.equal(byId(r, 'tell-supervisor').status, 'Not mentioned');
    assert.equal(byId(r, 'tell-supervisor').excerpt, null);
    assert.equal(r.followUp, spill.requiredPoints[1].followUp);
    assert.match(r.followUp, /who should be told/i);
    assert.equal(r.state, CLARIFY);
    assert.equal(r.turn, 1);
  });

  it('step-back Mentioned via Latin-script Hindi', () => {
    const t = 'Peeche hat jao, spill ho gaya hai.';
    const r = evaluate(t, 1, SC);
    assert.equal(byId(r, 'step-back').status, 'Mentioned');
    assertExactExcerpt(t, byId(r, 'step-back').excerpt);
  });

  it('tell-supervisor Mentioned with exact excerpt, step-back gap + first-action follow-up', () => {
    const t = 'Tell the supervisor about the spill.';
    const r = evaluate(t, 1, SC);
    assert.equal(byId(r, 'tell-supervisor').status, 'Mentioned');
    assertExactExcerpt(t, byId(r, 'tell-supervisor').excerpt);
    assert.match(byId(r, 'tell-supervisor').excerpt, /supervisor/i);
    assert.equal(byId(r, 'step-back').status, 'Not mentioned');
    assert.equal(r.followUp, spill.requiredPoints[0].followUp);
    assert.match(r.followUp, /what you should do first/i);
    assert.equal(r.state, CLARIFY);
  });

  it('half answers are Unclear: tell-only, supervisor-only, and negated tell', () => {
    for (const t of [
      'Tell someone quickly.',
      'The supervisor is busy.',
      'Do not tell the supervisor.',
    ]) {
      const r = evaluate(t, 1, SC);
      assert.equal(byId(r, 'tell-supervisor').status, 'Unclear');
      assertExactExcerpt(t, byId(r, 'tell-supervisor').excerpt);
      assert.notEqual(byId(r, 'tell-supervisor').status, 'Mentioned');
    }
  });

  it('combined spill answer -> Ready with no follow-up', () => {
    const r = evaluate('Step back from the spill and tell the supervisor.', 2, SC);
    assert.equal(byId(r, 'step-back').status, 'Mentioned');
    assert.equal(byId(r, 'tell-supervisor').status, 'Mentioned');
    assert.equal(r.state, READY);
    assert.equal(r.followUp, null);
  });

  it('empty transcript under a new scenario -> Needs clarification + teach-back follow-up', () => {
    const r = evaluate('', 1, SC);
    assert.equal(r.state, CLARIFY);
    assert.equal(r.followUp, spill.requiredPoints[0].followUp);
    assert.match(r.followUp, /tell me in your own words/i);
  });
});

describe('evaluate scenario selection', () => {
  it('no scenario arg behaves exactly like machine-cleaning across a mixed corpus', () => {
    const corpus = [
      DEMO_1,
      DEMO_2,
      `${DEMO_1} ${DEMO_2}`,
      '',
      'Lock the spreader bars.',
      'Tell the supervisor about the spill.',
      'Do not switch off the machine.',
    ];
    for (const t of corpus) {
      assert.deepEqual(evaluate(t, 1), evaluate(t, 1, 'machine-cleaning'));
      assert.deepEqual(evaluate(t), evaluate(t, undefined, 'machine-cleaning'));
    }
  });

  it('accepts a scenario object as well as an id', () => {
    const t = 'Lock the spreader bars before climbing.';
    assert.deepEqual(evaluate(t, 1, getScenario('ladder-safety')), evaluate(t, 1, 'ladder-safety'));
  });

  it('rejects an unknown scenario id with UNKNOWN_SCENARIO', () => {
    assert.throws(() => evaluate(DEMO_1, 1, 'no-such-scenario'), { code: 'UNKNOWN_SCENARIO' });
  });
});
