'use strict';
// Samajh backend: static demo UI + Gnani STT/TTS proxies + local evaluator.
// Synthetic demo data only. Live Gnani calls are UNVERIFIED in this session.

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { evaluate } = require('./lib/evaluate');
const { DEFAULT_SCENARIO_ID, getScenario } = require('./lib/scenarios');
const store = require('./lib/session-store');

// Minimal .env loader (no deps): KEY=VALUE lines only, never overwrites real env.
function loadDotEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      const v = t
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    // .env is optional
  }
}
loadDotEnv(path.join(__dirname, '.env'));

const GNANI_BASE = 'https://api.vachana.ai';
const PORT = Number(process.env.PORT) || 3000;
const STT_MODEL = process.env.GNANI_STT_MODEL || 'prisma-v3.0';
const STT_LANGUAGE = process.env.GNANI_STT_LANGUAGE || 'hi-IN,en-IN';
const TTS_MODEL = process.env.GNANI_TTS_MODEL || 'timbre-v2.5';
const VOICE_FOR = { 'hi-IN': 'Nalini', 'en-IN': 'Kaveri', 'hi-en': 'Poorvi' };

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ISO timestamps of the last successful live Gnani calls this session.
// Health reports VERIFIED only after a real upstream success — never on config alone.
app.locals.live = { stt: null, tts: null };

function gnaniKey() {
  return process.env.GNANI_API_KEY || '';
}

async function readUpstreamJson(upstream) {
  const text = await upstream.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Reports local config plus observed live-call evidence; never calls Gnani itself.
app.get('/api/health', (req, res) => {
  const live = app.locals.live;
  res.json({
    ok: true,
    gnani: {
      base: GNANI_BASE,
      keyConfigured: Boolean(gnaniKey()),
      sttModel: STT_MODEL,
      sttLanguage: STT_LANGUAGE,
      ttsModel: TTS_MODEL,
    },
    liveGnaniCalls: live.stt || live.tts ? 'VERIFIED' : 'UNVERIFIED',
    lastLiveStt: live.stt,
    lastLiveTts: live.tts,
  });
});

const rawAudio = express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '15mb' });

function extFor(contentType) {
  const m = /^audio\/([a-z0-9+.-]+)/i.exec(contentType || '');
  const sub = (m && m[1] ? m[1] : '').toLowerCase();
  if (sub === 'x-wav') return 'wav';
  if (sub === 'mpeg') return 'mp3';
  if (['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a'].includes(sub)) return sub;
  return 'wav';
}

// POST /api/stt: raw audio bytes (Content-Type audio/*, <=30s) -> Gnani /stt/v3.
app.post('/api/stt', rawAudio, async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        error: 'EMPTY_AUDIO',
        message: 'Send raw audio bytes (wav/mp3/ogg/flac/aac/m4a, <=30s) with Content-Type audio/*.',
      });
    }
    if (!gnaniKey()) {
      return res
        .status(503)
        .json({ error: 'STT_UNAVAILABLE', message: 'GNANI_API_KEY is not configured; cannot call Gnani STT.' });
    }
    const filename = String(
      req.query.filename || req.get('X-Filename') || `audio.${extFor(req.get('Content-Type'))}`,
    );
    const form = new FormData();
    form.append('audio_file', new Blob([req.body], { type: req.get('Content-Type') || 'audio/wav' }), filename);
    form.append('model', STT_MODEL);
    form.append('language_code', STT_LANGUAGE);
    const upstream = await fetch(`${GNANI_BASE}/stt/v3`, {
      method: 'POST',
      headers: { 'X-API-Key-ID': gnaniKey() },
      body: form,
    });
    const body = await readUpstreamJson(upstream);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'STT_UPSTREAM_ERROR', status: upstream.status, gnani: body });
    }
    if (typeof body.transcript !== 'string') body.transcript = '';
    app.locals.live.stt = new Date().toISOString();
    return res.json(body); // empty transcript "" is success, not an error
  } catch (err) {
    return res.status(502).json({ error: 'STT_PROXY_FAILED', message: String((err && err.message) || err) });
  }
});

// POST /api/tts: JSON { text, language } -> Gnani TTS binary audio.
app.post('/api/tts', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { text, language } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res
        .status(400)
        .json({ error: 'EMPTY_TEXT', message: 'Body must be JSON { text, language } with non-empty text.' });
    }
    const lang = language === 'en-IN' ? 'en-IN' : language === 'hi-en' ? 'hi-en' : 'hi-IN';
    if (!gnaniKey()) {
      return res
        .status(503)
        .json({ error: 'TTS_UNAVAILABLE', message: 'GNANI_API_KEY is not configured; cannot call Gnani TTS.' });
    }
    const upstream = await fetch(`${GNANI_BASE}/api/v1/tts/inference`, {
      method: 'POST',
      headers: { 'X-API-Key-ID': gnaniKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.trim(),
        voice: VOICE_FOR[lang],
        model: TTS_MODEL,
        language: lang,
        audio_config: { container: 'wav' },
      }),
    });
    if (!upstream.ok) {
      const g = await readUpstreamJson(upstream);
      if (upstream.status === 403 && JSON.stringify(g).includes('SCOPE_NOT_ALLOWED')) {
        return res.status(503).json({
          error: 'TTS_UNAVAILABLE',
          message: 'Gnani account does not allow TTS (SCOPE_NOT_ALLOWED).',
          gnani: g,
        });
      }
      return res.status(upstream.status).json({ error: 'TTS_UPSTREAM_ERROR', status: upstream.status, gnani: g });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    app.locals.live.tts = new Date().toISOString();
    res.set('Content-Type', upstream.headers.get('content-type') || 'audio/wav');
    return res.send(buf);
  } catch (err) {
    return res.status(502).json({ error: 'TTS_PROXY_FAILED', message: String((err && err.message) || err) });
  }
});

// POST /api/evaluate: JSON { transcript, turn, scenarioId? } -> local deterministic evaluation.
// scenarioId is optional and defaults to machine-cleaning; the response echoes
// the effective scenarioId alongside { points, followUp, state, turn }.
app.post('/api/evaluate', express.json({ limit: '64kb' }), (req, res) => {
  const { transcript, turn, scenarioId } = req.body || {};
  if (typeof transcript !== 'string') {
    return res
      .status(400)
      .json({ error: 'BAD_TRANSCRIPT', message: 'Body must be JSON { transcript, turn } with transcript as a string.' });
  }
  const effective = scenarioId === undefined || scenarioId === null ? DEFAULT_SCENARIO_ID : scenarioId;
  if (typeof effective !== 'string' || !getScenario(effective)) {
    return res.status(400).json({
      error: 'BAD_SCENARIO',
      message: 'scenarioId must be a known scenario: machine-cleaning, ladder-safety, or spill-response.',
    });
  }
  res.json({ ...evaluate(transcript, turn, effective), scenarioId: effective });
});

// ---------- File-based session persistence (synthetic demo data only) ----------
// Sessions are JSON files under <dataDir>/sessions/<id>.json. dataDir defaults
// to ./data and can be pointed elsewhere with SAMAJH_DATA_DIR (tests use a temp dir).
function dataDir() {
  return process.env.SAMAJH_DATA_DIR || path.join(__dirname, 'data');
}

function sessionError(res, err) {
  const code = (err && err.code) || '';
  const message = String((err && err.message) || err);
  if (code === 'SESSION_NOT_FOUND') return res.status(404).json({ error: code, message });
  if (code === 'SESSION_CORRUPT') return res.status(500).json({ error: code, message });
  return res.status(400).json({ error: code || 'SESSION_BAD_REQUEST', message });
}

const sessionJson = express.json({ limit: '256kb' });

// POST /api/sessions: create a session -> 201 + full session object.
// Optional query: ?scenarioId= (default machine-cleaning) and ?trainee=.
app.post('/api/sessions', (req, res) => {
  try {
    const session = store.createSession(dataDir(), {
      trainee: req.query.trainee,
      scenarioId: req.query.scenarioId,
    });
    return res.status(201).json(session);
  } catch (err) {
    return sessionError(res, err);
  }
});

// GET /api/sessions/:id: read one session (reload / resume).
app.get('/api/sessions/:id', (req, res) => {
  try {
    return res.json(store.readSession(dataDir(), req.params.id));
  } catch (err) {
    return sessionError(res, err);
  }
});

// PATCH /api/sessions/:id: append progress. Any of:
//   { turn: { turn, stt, edited }, eval: { points, followUp, state, turn }, overrides: { id: { override, note } } }
app.patch('/api/sessions/:id', sessionJson, (req, res) => {
  try {
    const { turn, eval: snapshot, overrides } = req.body || {};
    if (turn === undefined && snapshot === undefined && overrides === undefined) {
      return res.status(400).json({
        error: 'SESSION_BAD_REQUEST',
        message: 'Body must include at least one of: turn, eval, overrides.',
      });
    }
    const id = req.params.id;
    if (turn !== undefined) store.appendTurn(dataDir(), id, turn);
    if (snapshot !== undefined) store.appendEval(dataDir(), id, snapshot);
    if (overrides !== undefined) store.saveOverrides(dataDir(), id, overrides);
    return res.json(store.readSession(dataDir(), id));
  } catch (err) {
    return sessionError(res, err);
  }
});

// POST /api/sessions/:id/turns: append one turn { turn, stt, edited } (alias for PATCH { turn }).
app.post('/api/sessions/:id/turns', sessionJson, (req, res) => {
  try {
    return res.status(201).json(store.appendTurn(dataDir(), req.params.id, req.body || {}));
  } catch (err) {
    return sessionError(res, err);
  }
});

// POST /api/sessions/:id/signoff: final supervisor sign-off { decision, supervisorName, note? }.
app.post('/api/sessions/:id/signoff', sessionJson, (req, res) => {
  try {
    return res.json(store.signOff(dataDir(), req.params.id, req.body || {}));
  } catch (err) {
    return sessionError(res, err);
  }
});

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`Samajh backend listening on http://localhost:${PORT}`));
  // Graceful shutdown for containers (Render/Railway send SIGTERM on deploy/stop).
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}
module.exports = app;
