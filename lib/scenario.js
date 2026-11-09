'use strict';
// Approved safety scenario. The Hindi line is a demo placeholder only.
// Backward-compatible view of the default registry entry: exactly
// { instructionEN, instructionHI, requiredPoints [{ id, label, followUp }] }.
const { getScenario, DEFAULT_SCENARIO_ID } = require('./scenarios');

const defaults = getScenario(DEFAULT_SCENARIO_ID);

module.exports = {
  instructionEN: defaults.instructionEN,
  instructionHI: { text: defaults.instructionHI.text, status: defaults.instructionHI.status },
  requiredPoints: defaults.requiredPoints.map((p) => ({ id: p.id, label: p.label, followUp: p.followUp })),
};
