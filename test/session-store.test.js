'use strict';
// File-based session persistence: store round-trip in a temp dir, the exact
// reload-restore shape the frontend consumes, honest corrupt-file errors, and
// the HTTP create/append/sign-off contract on an ephemeral port (never 3000).
// Synthetic demo data only. No new deps: node:test + node:assert + fetch.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/session-store');
const { evaluate } = require('../lib/evaluate');

const DEMO_1 = 'Machine band karke saaf karna hai.';
const DEMO_2 = 'Power supply lock karni hai.';

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'samajh-session-test-'));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('session store round-trip (temp dir)', () => {
  let dir;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => removeDir(dir));

  it('create -> file under data/sessions/<id>.json with blank overrides and no sign-off', () => {
    const s = store.createSession(dir);
    assert.match(s.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    assert.equal(s.finished, false);
    assert.equal(s.signoff, null);
    assert.deepEqual(s.turns, []);
    assert.deepEqual(s.evals, []);
    assert.deepEqual(s.overrides, {
      'switch-off': { override: '', note: '' },
      'lock-power': { override: '', note: '' },
    });
    const file = path.join(dir, 'sessions', `${s.id}.json`);
    assert.ok(fs.existsSync(file), 'session file exists on disk');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).id, s.id);
  });

  it('append turns (stt + edited kept separate), eval snapshots, overrides, then sign-off', () => {
    const s = store.createSession(dir);
    store.appendTurn(dir, s.id, { turn: 1, stt: 'Machine band karke saaf karna.', edited: DEMO_1 });
    const e1 = evaluate(DEMO_1, 1);
    store.appendEval(dir, s.id, e1);
    store.appendTurn(dir, s.id, { turn: 2, stt: DEMO_2, edited: DEMO_2 });
    const e2 = evaluate(`${DEMO_1} ${DEMO_2}`, 2);
    store.appendEval(dir, s.id, e2);
    store.saveOverrides(dir, s.id, {
      'switch-off': { override: '', note: '' },
      'lock-power': { override: 'Mentioned', note: 'heard clearly on replay' },
    });
    const done = store.signOff(dir, s.id, {
      decision: 'needs-practice',
      supervisorName: 'Meera',
      note: 'good first try',
    });
    assert.equal(done.finished, true);
    assert.equal(done.signoff.decision, 'needs-practice');
    assert.equal(done.signoff.supervisorName, 'Meera');
    assert.equal(done.signoff.note, 'good first try');
    assert.match(done.signoff.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(done.turns.length, 2);
    assert.equal(done.evals.length, 2);
  });

  it('reload-restore shape: a fresh read carries everything the frontend restores', () => {
    const s = store.createSession(dir);
    store.appendTurn(dir, s.id, { turn: 1, stt: 'stt-words', edited: DEMO_1 });
    const e1 = evaluate(DEMO_1, 1);
    store.appendEval(dir, s.id, e1);
    store.saveOverrides(dir, s.id, { 'lock-power': { override: 'Unclear', note: 'check again' } });
    store.signOff(dir, s.id, { decision: 'approved', supervisorName: 'Meera' });

    const reloaded = store.readSession(dir, s.id); // fresh read from disk, like a page reload
    const t1 = reloaded.turns.find((t) => t.turn === 1);
    assert.equal(t1.stt, 'stt-words');
    assert.equal(t1.edited, DEMO_1);
    assert.match(t1.at, /^\d{4}-\d{2}-\d{2}T/);
    const last = reloaded.evals[reloaded.evals.length - 1];
    assert.equal(last.points.find((p) => p.id === 'switch-off').status, 'Mentioned');
    assert.equal(typeof last.followUp, 'string');
    assert.equal(last.state, 'Needs clarification');
    assert.equal(reloaded.overrides['lock-power'].override, 'Unclear');
    assert.equal(reloaded.overrides['lock-power'].note, 'check again');
    assert.equal(reloaded.overrides['switch-off'].override, '');
    assert.deepEqual(Object.keys(reloaded.signoff).sort(), ['at', 'decision', 'note', 'supervisorName']);
    assert.equal(reloaded.signoff.decision, 'approved');
    assert.equal(reloaded.signoff.supervisorName, 'Meera');
  });

  it('honest errors: missing id, corrupt file, bad id, and invalid payloads', () => {
    const s = store.createSession(dir);
    assert.throws(() => store.readSession(dir, 'no-such-session'), { code: 'SESSION_NOT_FOUND' });
    assert.throws(() => store.readSession(dir, '../escape'), { code: 'SESSION_BAD_ID' });
    assert.throws(() => store.appendTurn(dir, s.id, { turn: 3, stt: '', edited: '' }), {
      code: 'SESSION_BAD_TURN',
    });
    assert.throws(() => store.appendEval(dir, s.id, { points: [] }), { code: 'SESSION_BAD_EVAL' });
    assert.throws(() => store.saveOverrides(dir, s.id, { 'switch-off': { override: 'Maybe', note: '' } }), {
      code: 'SESSION_BAD_OVERRIDES',
    });
    assert.throws(() => store.signOff(dir, s.id, { decision: 'approved', supervisorName: '  ' }), {
      code: 'SESSION_BAD_SIGNOFF',
    });
    assert.throws(() => store.signOff(dir, s.id, { decision: 'certified', supervisorName: 'Meera' }), {
      code: 'SESSION_BAD_SIGNOFF',
    });

    // Corrupt file: garbage bytes -> SESSION_CORRUPT naming the cause, never a throw of raw JSON text.
    fs.writeFileSync(path.join(dir, 'sessions', `${s.id}.json`), '{not valid json!!!');
    assert.throws(() => store.readSession(dir, s.id), { code: 'SESSION_CORRUPT' });
    try {
      store.readSession(dir, s.id);
      assert.fail('expected SESSION_CORRUPT');
    } catch (err) {
      assert.match(err.message, /not valid JSON/);
    }
  });
});

describe('session HTTP contract (ephemeral port, temp data dir)', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = freshDir();
    process.env.SAMAJH_DATA_DIR = dir;
    const app = require('../server');
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    assert.notEqual(port, 3000, 'test servers must not touch port 3000');
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    delete process.env.SAMAJH_DATA_DIR;
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    removeDir(dir);
  });

  async function json(method, urlPath, body) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { res, json: parsed, text };
  }

  it('POST /api/sessions creates, GET resumes, PATCH appends, POST signoff finishes', async () => {
    const created = await json('POST', '/api/sessions');
    assert.equal(created.res.status, 201);
    const id = created.json.id;
    assert.ok(id);

    const t1 = await json('POST', `/api/sessions/${id}/turns`, { turn: 1, stt: '', edited: DEMO_1 });
    assert.equal(t1.res.status, 201);
    assert.equal(t1.json.turns.length, 1);

    const e1 = evaluate(DEMO_1, 1);
    const patched = await json('PATCH', `/api/sessions/${id}`, {
      eval: e1,
      overrides: { 'switch-off': { override: '', note: 'ok' } },
    });
    assert.equal(patched.res.status, 200);
    assert.equal(patched.json.evals.length, 1);
    assert.equal(patched.json.overrides['switch-off'].note, 'ok');

    const bad = await json('POST', `/api/sessions/${id}/signoff`, { decision: 'approved' });
    assert.equal(bad.res.status, 400);
    assert.equal(bad.json.error, 'SESSION_BAD_SIGNOFF');

    const signed = await json('POST', `/api/sessions/${id}/signoff`, {
      decision: 'approved',
      supervisorName: 'Meera',
      note: 'well done',
    });
    assert.equal(signed.res.status, 200);
    assert.equal(signed.json.finished, true);
    assert.equal(signed.json.signoff.supervisorName, 'Meera');

    const resumed = await json('GET', `/api/sessions/${id}`);
    assert.equal(resumed.res.status, 200);
    assert.equal(resumed.json.turns[0].edited, DEMO_1);
    assert.equal(resumed.json.signoff.decision, 'approved');
    assert.match(resumed.json.signoff.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('GET unknown id -> honest 404 SESSION_NOT_FOUND', async () => {
    const { res, json: body } = await json('GET', '/api/sessions/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(body.error, 'SESSION_NOT_FOUND');
  });

  it('GET corrupt file -> honest 500 SESSION_CORRUPT', async () => {
    const created = await json('POST', '/api/sessions');
    const id = created.json.id;
    fs.writeFileSync(path.join(dir, 'sessions', `${id}.json`), '[[[corrupt');
    const { res, json: body } = await json('GET', `/api/sessions/${id}`);
    assert.equal(res.status, 500);
    assert.equal(body.error, 'SESSION_CORRUPT');
  });

  it('POST /api/sessions?scenarioId= stores the scenario; unknown id -> 400 SESSION_BAD_SCENARIO', async () => {
    const created = await json('POST', '/api/sessions?scenarioId=ladder-safety');
    assert.equal(created.res.status, 201);
    assert.equal(created.json.scenarioId, 'ladder-safety');
    assert.deepEqual(Object.keys(created.json.overrides).sort(), ['level-ground', 'lock-spreader']);

    const resumed = await json('GET', `/api/sessions/${created.json.id}`);
    assert.equal(resumed.res.status, 200);
    assert.equal(resumed.json.scenarioId, 'ladder-safety');

    const bad = await json('POST', '/api/sessions?scenarioId=no-such-scenario');
    assert.equal(bad.res.status, 400);
    assert.equal(bad.json.error, 'SESSION_BAD_SCENARIO');
  });
});

describe('session scenarioId (temp dir)', () => {
  let dir;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => removeDir(dir));

  it('defaults to machine-cleaning with its two blank overrides', () => {
    const s = store.createSession(dir);
    assert.equal(s.scenarioId, 'machine-cleaning');
    assert.deepEqual(s.overrides, {
      'switch-off': { override: '', note: '' },
      'lock-power': { override: '', note: '' },
    });
  });

  it('creates per-scenario blank overrides and accepts per-scenario evals + overrides', () => {
    const s = store.createSession(dir, { scenarioId: 'spill-response' });
    assert.deepEqual(s.overrides, {
      'step-back': { override: '', note: '' },
      'tell-supervisor': { override: '', note: '' },
    });
    store.appendTurn(dir, s.id, { turn: 1, stt: '', edited: 'Step back from the spill.' });
    store.appendEval(dir, s.id, evaluate('Step back from the spill.', 1, 'spill-response'));
    store.saveOverrides(dir, s.id, { 'step-back': { override: 'Mentioned', note: 'clear' } });
    const reloaded = store.readSession(dir, s.id);
    assert.equal(reloaded.scenarioId, 'spill-response');
    assert.equal(reloaded.evals.length, 1);
    assert.equal(reloaded.overrides['step-back'].note, 'clear');
  });

  it('rejects an unknown scenario with SESSION_BAD_SCENARIO', () => {
    assert.throws(() => store.createSession(dir, { scenarioId: 'no-such-scenario' }), {
      code: 'SESSION_BAD_SCENARIO',
    });
    assert.throws(() => store.blankOverrides('no-such-scenario'), { code: 'SESSION_BAD_SCENARIO' });
  });

  it('reads sessions written before scenarios existed as machine-cleaning', () => {
    const s = store.createSession(dir);
    const file = path.join(dir, 'sessions', `${s.id}.json`);
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete legacy.scenarioId; // files written before the picker have no scenarioId
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(store.readSession(dir, s.id).scenarioId, 'machine-cleaning');
  });
});
