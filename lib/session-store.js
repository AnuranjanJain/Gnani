'use strict';
// File-based session store (synthetic demo data only).
// Sessions live as JSON files under <dataDir>/sessions/<id>.json.
// The directory is created at runtime; data/ is git-ignored and never committed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ALL_POINT_IDS, DEFAULT_SCENARIO_ID, pointIdsFor } = require('./scenarios');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DECISIONS = ['approved', 'needs-practice', 'not-ready'];
const POINT_IDS = ['switch-off', 'lock-power'];
const STATUSES = ['Mentioned', 'Not mentioned', 'Unclear'];

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function sessionsDir(dataDir) {
  return path.join(dataDir, 'sessions');
}

function ensureSessionsDir(dataDir) {
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
}

function fileFor(dataDir, id) {
  if (!ID_RE.test(String(id || ''))) {
    fail('SESSION_BAD_ID', `Invalid session id: ${JSON.stringify(id)}.`);
  }
  return path.join(sessionsDir(dataDir), `${String(id)}.json`);
}

function blankOverrides(scenarioId) {
  const target = scenarioId === undefined || scenarioId === null ? DEFAULT_SCENARIO_ID : scenarioId;
  const ids = pointIdsFor(target);
  if (!ids) fail('SESSION_BAD_SCENARIO', `Unknown scenario: ${JSON.stringify(target)}.`);
  const out = {};
  for (const id of ids) out[id] = { override: '', note: '' };
  return out;
}

function newSessionId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function createSession(dataDir, opts = {}) {
  ensureSessionsDir(dataDir);
  const scenarioId =
    opts.scenarioId === undefined || opts.scenarioId === null ? DEFAULT_SCENARIO_ID : opts.scenarioId;
  if (!pointIdsFor(scenarioId)) {
    fail('SESSION_BAD_SCENARIO', `Unknown scenario: ${JSON.stringify(scenarioId)}.`);
  }
  const at = nowIso();
  const session = {
    id: newSessionId(),
    createdAt: at,
    updatedAt: at,
    finished: false,
    trainee: typeof opts.trainee === 'string' && opts.trainee ? opts.trainee : 'Aarav (demo trainee)',
    scenarioId,
    turns: [],
    evals: [],
    overrides: blankOverrides(scenarioId),
    signoff: null,
  };
  writeSession(dataDir, session);
  return session;
}

function readSession(dataDir, id) {
  const file = fileFor(dataDir, id);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') fail('SESSION_NOT_FOUND', `No session with id ${JSON.stringify(id)}.`);
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || parsed.id !== String(id)) {
      fail('SESSION_CORRUPT', `Session file for ${JSON.stringify(id)} does not hold a matching session object.`);
    }
    // Sessions written before scenarios existed carry no scenarioId: they are
    // machine-cleaning sessions. Normalize on read; the file is untouched.
    if (typeof parsed.scenarioId !== 'string' || !parsed.scenarioId) {
      parsed.scenarioId = DEFAULT_SCENARIO_ID;
    }
    return parsed;
  } catch (err) {
    if (err && typeof err.code === 'string' && err.code.startsWith('SESSION_')) throw err;
    const corrupt = new Error(
      `Session file for ${JSON.stringify(id)} is not valid JSON: ${err && err.message ? err.message : err}`,
    );
    corrupt.code = 'SESSION_CORRUPT';
    throw corrupt;
  }
}

function writeSession(dataDir, session) {
  ensureSessionsDir(dataDir);
  const file = fileFor(dataDir, session.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return session;
}

function checkTurn(t) {
  if (!t || typeof t !== 'object') fail('SESSION_BAD_TURN', 'Turn must be an object { turn, stt, edited }.');
  if (t.turn !== 1 && t.turn !== 2) fail('SESSION_BAD_TURN', 'Turn number must be 1 or 2.');
  if (typeof t.stt !== 'string' || typeof t.edited !== 'string') {
    fail('SESSION_BAD_TURN', 'Turn stt and edited must both be strings (stt may be empty).');
  }
}

function checkEvalSnapshot(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.points)) {
    fail('SESSION_BAD_EVAL', 'Eval snapshot must be an object { points, followUp, state, turn }.');
  }
  for (const p of e.points) {
    if (!p || typeof p !== 'object' || !ALL_POINT_IDS.includes(p.id) || !STATUSES.includes(p.status)) {
      fail('SESSION_BAD_EVAL', 'Each eval point needs a known id and a Mentioned / Not mentioned / Unclear status.');
    }
    if (p.excerpt !== null && typeof p.excerpt !== 'string') {
      fail('SESSION_BAD_EVAL', 'Eval point excerpt must be a string or null.');
    }
  }
  if (e.followUp !== null && typeof e.followUp !== 'string') {
    fail('SESSION_BAD_EVAL', 'Eval followUp must be a string or null.');
  }
  if (typeof e.state !== 'string') fail('SESSION_BAD_EVAL', 'Eval state must be a string.');
}

function checkOverrides(o) {
  if (!o || typeof o !== 'object') fail('SESSION_BAD_OVERRIDES', 'Overrides must be an object keyed by point id.');
  for (const id of ALL_POINT_IDS) {
    const entry = o[id];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== 'object' || typeof entry.override !== 'string' || typeof entry.note !== 'string') {
      fail('SESSION_BAD_OVERRIDES', `Override for ${id} must be { override, note } strings.`);
    }
    if (entry.override !== '' && !STATUSES.includes(entry.override)) {
      fail('SESSION_BAD_OVERRIDES', `Override for ${id} must be empty or a known status.`);
    }
  }
}

function checkSignoff(s) {
  if (!s || typeof s !== 'object') fail('SESSION_BAD_SIGNOFF', 'Sign-off must be { decision, supervisorName, note? }.');
  if (!DECISIONS.includes(s.decision)) {
    fail('SESSION_BAD_SIGNOFF', `Decision must be one of: ${DECISIONS.join(', ')}.`);
  }
  if (typeof s.supervisorName !== 'string' || !s.supervisorName.trim()) {
    fail('SESSION_BAD_SIGNOFF', 'supervisorName must be a non-empty string.');
  }
  if (s.note !== undefined && typeof s.note !== 'string') {
    fail('SESSION_BAD_SIGNOFF', 'Sign-off note must be a string when present.');
  }
}

function appendTurn(dataDir, id, turn) {
  checkTurn(turn);
  const session = readSession(dataDir, id);
  session.turns.push({ turn: turn.turn, stt: turn.stt, edited: turn.edited, at: nowIso() });
  session.updatedAt = nowIso();
  return writeSession(dataDir, session);
}

function appendEval(dataDir, id, snapshot) {
  checkEvalSnapshot(snapshot);
  const session = readSession(dataDir, id);
  session.evals.push({ ...snapshot, at: nowIso() });
  session.updatedAt = nowIso();
  return writeSession(dataDir, session);
}

function saveOverrides(dataDir, id, overrides) {
  checkOverrides(overrides);
  const session = readSession(dataDir, id);
  if (!session.overrides || typeof session.overrides !== 'object') session.overrides = {};
  for (const pid of ALL_POINT_IDS) {
    if (overrides[pid] !== undefined) {
      session.overrides[pid] = { override: overrides[pid].override, note: overrides[pid].note };
    }
  }
  session.updatedAt = nowIso();
  return writeSession(dataDir, session);
}

function signOff(dataDir, id, input) {
  checkSignoff(input);
  const session = readSession(dataDir, id);
  session.signoff = {
    decision: input.decision,
    supervisorName: input.supervisorName.trim(),
    note: typeof input.note === 'string' ? input.note : '',
    at: nowIso(),
  };
  session.finished = true;
  session.updatedAt = session.signoff.at;
  return writeSession(dataDir, session);
}

module.exports = {
  ALL_POINT_IDS,
  DECISIONS,
  DEFAULT_SCENARIO_ID,
  POINT_IDS,
  appendEval,
  appendTurn,
  blankOverrides,
  createSession,
  fileFor,
  newSessionId,
  readSession,
  saveOverrides,
  sessionsDir,
  signOff,
  writeSession,
};
