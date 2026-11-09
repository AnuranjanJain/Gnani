'use strict';
// Server contract: health shape, static page, /api/evaluate oracle checks,
// and Gnani error-shape mapping. Never calls live Gnani: the key is unset
// except in tests that replace global fetch with a canned upstream.
// No new deps: node:test + node:assert + global fetch only.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');
const scenario = require('../lib/scenario');

const DEMO_1 = 'Machine band karke saaf karna hai.';
const DEMO_2 = 'Power supply lock karni hai.';

let server;
let base;
const realFetch = globalThis.fetch;

function mockUpstream({ status = 200, json = undefined, buffer = undefined, contentType = 'audio/wav' } = {}) {
  // Intercept only Gnani upstream calls; the test client still reaches the local server.
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.vachana.ai')) return realFetch(url, opts);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => (json === undefined ? '' : JSON.stringify(json)),
      arrayBuffer: async () => {
        const b = buffer !== undefined ? buffer : Buffer.from('fake-audio');
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    };
  };
}

before(async () => {
  delete process.env.GNANI_API_KEY; // live Gnani stays UNVERIFIED by design
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.GNANI_API_KEY;
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GNANI_API_KEY;
  app.locals.live = { stt: null, tts: null };
});

async function postJson(path, body, contentType = 'application/json') {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
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

describe('GET /api/health (config only, never calls Gnani)', () => {
  it('reports models, keyConfigured=false, and UNVERIFIED live calls', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const h = await res.json();
    assert.equal(h.ok, true);
    assert.equal(h.gnani.base, 'https://api.vachana.ai');
    assert.equal(h.gnani.keyConfigured, false);
    assert.equal(h.gnani.sttModel, 'prisma-v3.0');
    assert.equal(h.gnani.sttLanguage, 'hi-IN,en-IN');
    assert.equal(h.gnani.ttsModel, 'timbre-v2.5');
    assert.equal(h.liveGnaniCalls, 'UNVERIFIED');
    assert.equal(h.lastLiveStt, null);
    assert.equal(h.lastLiveTts, null);
    assert.ok(!JSON.stringify(h).includes('GNANI_API_KEY'));
  });

  it('reports VERIFIED only after a successful upstream call (mocked)', async () => {
    process.env.GNANI_API_KEY = 'test-dummy-key';
    mockUpstream({ status: 200, buffer: Buffer.from('RIFFfake'), contentType: 'audio/wav' });
    const tts = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', language: 'hi-en' }),
    });
    assert.equal(tts.status, 200);
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.liveGnaniCalls, 'VERIFIED');
    assert.match(h.lastLiveTts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(h.lastLiveStt, null);
  });

  it('stays UNVERIFIED when upstream calls fail (mocked)', async () => {
    process.env.GNANI_API_KEY = 'test-dummy-key';
    mockUpstream({ status: 500, json: { message: 'boom' } });
    const { res } = await postJson('/api/tts', { text: 'hello', language: 'hi-IN' });
    assert.equal(res.status, 500);
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.liveGnaniCalls, 'UNVERIFIED');
  });
});

describe('static page', () => {
  it('GET / serves the Samajh page', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Samajh/);
    assert.match(html, /app\.js/);
  });

  it('serves app.js and styles.css', async () => {
    for (const p of ['/app.js', '/styles.css']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200);
    }
  });
});

describe('POST /api/evaluate oracle checks', () => {
  it('demo utterance 1 via HTTP', async () => {
    const { res, json } = await postJson('/api/evaluate', { transcript: DEMO_1, turn: 1 });
    assert.equal(res.status, 200);
    assert.equal(json.points.find((p) => p.id === 'switch-off').status, 'Mentioned');
    assert.equal(json.points.find((p) => p.id === 'lock-power').status, 'Not mentioned');
    assert.equal(json.followUp, scenario.requiredPoints[1].followUp);
    assert.equal(json.state, 'Needs clarification');
    assert.equal(json.turn, 1);
  });

  it('demo utterance 2 via HTTP', async () => {
    const { res, json } = await postJson('/api/evaluate', { transcript: DEMO_2, turn: 1 });
    assert.equal(res.status, 200);
    assert.equal(json.points.find((p) => p.id === 'lock-power').status, 'Mentioned');
    assert.equal(json.points.find((p) => p.id === 'switch-off').status, 'Not mentioned');
    assert.equal(json.followUp, scenario.requiredPoints[0].followUp);
    assert.equal(json.state, 'Needs clarification');
  });

  it('rejects a non-string transcript with BAD_TRANSCRIPT', async () => {
    for (const body of [{}, { transcript: 42 }, { transcript: null }]) {
      const { res, json } = await postJson('/api/evaluate', body);
      assert.equal(res.status, 400);
      assert.equal(json.error, 'BAD_TRANSCRIPT');
    }
  });
});

describe('POST /api/stt error shapes', () => {
  it('EMPTY_AUDIO 400 when no audio bytes are sent', async () => {
    const { res, json } = await postJson('/api/stt', {}, 'application/json');
    assert.equal(res.status, 400);
    assert.equal(json.error, 'EMPTY_AUDIO');
  });

  it('STT_UNAVAILABLE 503 without a key (no Gnani call attempted)', async () => {
    const res = await fetch(`${base}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: Buffer.from('fake-audio-bytes'),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'STT_UNAVAILABLE');
  });

  it('maps an upstream failure to STT_UPSTREAM_ERROR with the Gnani body', async () => {
    process.env.GNANI_API_KEY = 'test-dummy-key';
    mockUpstream({ status: 500, json: { message: 'boom' } });
    const res = await fetch(`${base}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: Buffer.from('fake-audio-bytes'),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'STT_UPSTREAM_ERROR');
    assert.equal(body.status, 500);
    assert.deepEqual(body.gnani, { message: 'boom' });
  });

  it('an empty transcript from upstream is success, not an error', async () => {
    process.env.GNANI_API_KEY = 'test-dummy-key';
    mockUpstream({ status: 200, json: { transcript: '' } });
    const res = await fetch(`${base}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: Buffer.from('fake-audio-bytes'),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.transcript, '');
  });
});

describe('POST /api/tts error shapes', () => {
  it('EMPTY_TEXT 400 for missing/blank text', async () => {
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }]) {
      const { res, json } = await postJson('/api/tts', body);
      assert.equal(res.status, 400);
      assert.equal(json.error, 'EMPTY_TEXT');
    }
  });

  it('TTS_UNAVAILABLE 503 without a key (no Gnani call attempted)', async () => {
    const { res, json } = await postJson('/api/tts', { text: 'hello', language: 'hi-IN' });
    assert.equal(res.status, 503);
    assert.equal(json.error, 'TTS_UNAVAILABLE');
  });

  it('maps Gnani SCOPE_NOT_ALLOWED to honest TTS_UNAVAILABLE 503', async () => {
    process.env.GNANI_API_KEY = 'test-dummy-key';
    mockUpstream({ status: 403, json: { error: 'SCOPE_NOT_ALLOWED for this key' } });
    const { res, json } = await postJson('/api/tts', { text: 'hello', language: 'en-IN' });
    assert.equal(res.status, 503);
    assert.equal(json.error, 'TTS_UNAVAILABLE');
    assert.match(json.message, /SCOPE_NOT_ALLOWED/);
    assert.deepEqual(json.gnani, { error: 'SCOPE_NOT_ALLOWED for this key' });
  });

  it('maps other upstream failures to TTS_UPSTREAM_ERROR with the Gnani body', async () => {
    process.env.GNANI_API_KEY = 'test-dummy-key';
    mockUpstream({ status: 500, json: { message: 'tts boom' } });
    const { res, json } = await postJson('/api/tts', { text: 'hello', language: 'en-IN' });
    assert.equal(res.status, 500);
    assert.equal(json.error, 'TTS_UPSTREAM_ERROR');
    assert.equal(json.status, 500);
    assert.deepEqual(json.gnani, { message: 'tts boom' });
  });

  it('passes audio bytes through on upstream success', async () => {
    process.env.GNANI_API_KEY = 'test-dummy-key';
    const wav = Buffer.from('RIFFfake-wav-bytes');
    mockUpstream({ status: 200, buffer: wav, contentType: 'audio/wav' });
    const res = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', language: 'hi-IN' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /audio\/wav/);
    const out = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(out, wav);
  });
});

describe('POST /api/evaluate with scenarioId', () => {
  it('scores a new scenario and echoes its scenarioId', async () => {
    const { res, json } = await postJson('/api/evaluate', {
      transcript: 'Set the ladder on firm level ground and lock the spreader bars before climbing.',
      turn: 2,
      scenarioId: 'ladder-safety',
    });
    assert.equal(res.status, 200);
    assert.equal(json.scenarioId, 'ladder-safety');
    assert.equal(json.points.find((p) => p.id === 'level-ground').status, 'Mentioned');
    assert.equal(json.points.find((p) => p.id === 'lock-spreader').status, 'Mentioned');
    assert.equal(json.state, 'Ready for supervisor review');
    assert.equal(json.followUp, null);
    assert.equal(json.turn, 2);
  });

  it('defaults to machine-cleaning and echoes it when scenarioId is omitted', async () => {
    const { res, json } = await postJson('/api/evaluate', { transcript: DEMO_1, turn: 1 });
    assert.equal(res.status, 200);
    assert.equal(json.scenarioId, 'machine-cleaning');
    assert.equal(json.points.find((p) => p.id === 'switch-off').status, 'Mentioned');
  });

  it('rejects an unknown or non-string scenarioId with BAD_SCENARIO', async () => {
    for (const body of [
      { transcript: DEMO_1, turn: 1, scenarioId: 'no-such-scenario' },
      { transcript: DEMO_1, turn: 1, scenarioId: 42 },
    ]) {
      const { res, json } = await postJson('/api/evaluate', body);
      assert.equal(res.status, 400);
      assert.equal(json.error, 'BAD_SCENARIO');
    }
  });
});
