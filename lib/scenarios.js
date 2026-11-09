'use strict';
// Synthetic safety-scenario registry (demo only, nothing here is training
// material until a human supervisor reviews it).
//
// machine-cleaning is the long-approved scenario: its instruction, labels,
// and follow-ups are exactly the original wording. The ladder-safety and
// spill-response scenarios are generic fictional additions for practice.
//
// Every Hindi line is a demo placeholder flagged needs-human-review.
// Each required point carries its own match groups so lib/evaluate.js stays
// data-driven: one group means "any of these phrases", two groups means
// "a word from each group" (same pairing rule the lock-power point always
// used). Patterns are plain RegExp literals (never /g/: test() must stay
// stateless across sentences).

const SCENARIOS = [
  {
    id: 'machine-cleaning',
    title: 'Machine cleaning',
    kicker: 'Machine cleaning training',
    instructionEN: 'Before cleaning, switch off the machine and lock the power supply.',
    instructionHI: {
      text: 'Safai se pehle machine band karein aur power supply lock karein.',
      status: 'needs-human-review',
    },
    requiredPoints: [
      {
        id: 'switch-off',
        label: 'Switch off the machine before cleaning',
        followUp:
          'Can you tell me in your own words what needs to happen with the machine before cleaning starts?',
        match: {
          groups: [
            [
              /switch\s*off/i,
              /turn\s*off/i,
              /shut\s*(off|down)/i,
              /power\s*off/i,
              /\bband\b/i,
              /बंद|बन्द/,
              /स्विच\s*ऑफ/,
              /ऑफ\s*कर/,
            ],
          ],
        },
      },
      {
        id: 'lock-power',
        label: 'Lock the power supply',
        followUp:
          'Can you tell me in your own words what needs to happen with the power supply before cleaning?',
        match: {
          groups: [
            [/lock/i, /\btaala\b/i, /\btala\b/i, /ताला/, /लॉक/],
            [
              /power\s*supply/i,
              /\bpower\b/i,
              /\bsupply\b/i,
              /\bbijli\b/i,
              /बिजली/,
              /पावर/,
              /सप्लाई/,
            ],
          ],
        },
      },
    ],
  },
  {
    id: 'ladder-safety',
    title: 'Ladder safety',
    kicker: 'Ladder safety training',
    instructionEN: 'Before climbing, set the ladder on firm level ground and lock the spreader bars.',
    instructionHI: {
      text: 'Chadhne se pehle seedhi ko samtal zameen par rakhein aur spreader lock karein.',
      status: 'needs-human-review',
    },
    requiredPoints: [
      {
        id: 'level-ground',
        label: 'Set the ladder on firm level ground',
        followUp:
          'Can you tell me in your own words where the ladder should be placed before climbing?',
        match: {
          groups: [
            [
              /level\s*ground/i,
              /firm\s*ground/i,
              /flat\s*ground/i,
              /even\s*ground/i,
              /\bsamtal\b/i,
              /समतल/,
            ],
          ],
        },
      },
      {
        id: 'lock-spreader',
        label: 'Lock the spreader bars',
        followUp:
          'Can you tell me in your own words what needs to be locked on the ladder before climbing?',
        match: {
          groups: [
            [/lock/i, /\btaala\b/i, /\btala\b/i, /ताला/, /लॉक/],
            [/spreader/i, /सप्रेडर/],
          ],
        },
      },
    ],
  },
  {
    id: 'spill-response',
    title: 'Spill response',
    kicker: 'Spill response training',
    instructionEN: 'If cleaning liquid spills, step back from the spill and tell the supervisor.',
    instructionHI: {
      text: 'Agar safai wala liquid gir jaye to peeche hatein aur supervisor ko batayein.',
      status: 'needs-human-review',
    },
    requiredPoints: [
      {
        id: 'step-back',
        label: 'Step back from the spill',
        followUp:
          'Can you tell me in your own words what you should do first if cleaning liquid spills?',
        match: {
          groups: [
            [
              /step\s*back/i,
              /move\s*(back|away)/i,
              /stand\s*back/i,
              /peeche\s*hat/i,
              /पीछे\s*हट/,
              /door\s*hat/i,
              /दूर\s*हट/,
            ],
          ],
        },
      },
      {
        id: 'tell-supervisor',
        label: 'Tell the supervisor about the spill',
        followUp: 'Can you tell me in your own words who should be told about the spill?',
        match: {
          groups: [
            [/tell/i, /inform/i, /report/i, /bata/i, /बता/],
            [/supervisor/i, /in-?charge/i, /सुपरवाइजर/],
          ],
        },
      },
    ],
  },
];

const DEFAULT_SCENARIO_ID = 'machine-cleaning';
const SCENARIO_IDS = SCENARIOS.map((s) => s.id);
const ALL_POINT_IDS = SCENARIOS.flatMap((s) => s.requiredPoints.map((p) => p.id));

function getScenario(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}

function pointIdsFor(id) {
  const s = getScenario(id);
  return s ? s.requiredPoints.map((p) => p.id) : null;
}

function pointById(pointId) {
  for (const s of SCENARIOS) {
    const found = s.requiredPoints.find((p) => p.id === pointId);
    if (found) return found;
  }
  return null;
}

module.exports = {
  ALL_POINT_IDS,
  DEFAULT_SCENARIO_ID,
  SCENARIOS,
  SCENARIO_IDS,
  getScenario,
  pointById,
  pointIdsFor,
};
