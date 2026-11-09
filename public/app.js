'use strict';
/* Samajh demo frontend (vanilla JS, no build step, no API keys).
 * Calls only the local backend: GET /api/health, POST /api/stt (raw audio),
 * POST /api/tts { text, language }, POST /api/evaluate { transcript, turn, scenarioId? },
 * plus file-based session persistence (POST/GET/PATCH /api/sessions, sign-off).
 * Scenario text mirrors lib/scenarios.js on the backend (synthetic demo only).
 */

const SCENARIOS = [
  {
    id: 'machine-cleaning',
    title: 'Machine cleaning',
    kicker: 'Machine cleaning training',
    instructionEN: 'Before cleaning, switch off the machine and lock the power supply.',
    instructionHI: 'Safai se pehle machine band karein aur power supply lock karein.',
    requiredPoints: [
      {
        id: 'switch-off',
        label: 'Switch off the machine before cleaning',
        followUp:
          'Can you tell me in your own words what needs to happen with the machine before cleaning starts?',
      },
      {
        id: 'lock-power',
        label: 'Lock the power supply',
        followUp:
          'Can you tell me in your own words what needs to happen with the power supply before cleaning?',
      },
    ],
  },
  {
    id: 'ladder-safety',
    title: 'Ladder safety',
    kicker: 'Ladder safety training',
    instructionEN: 'Before climbing, set the ladder on firm level ground and lock the spreader bars.',
    instructionHI: 'Chadhne se pehle seedhi ko samtal zameen par rakhein aur spreader lock karein.',
    requiredPoints: [
      {
        id: 'level-ground',
        label: 'Set the ladder on firm level ground',
        followUp:
          'Can you tell me in your own words where the ladder should be placed before climbing?',
      },
      {
        id: 'lock-spreader',
        label: 'Lock the spreader bars',
        followUp:
          'Can you tell me in your own words what needs to be locked on the ladder before climbing?',
      },
    ],
  },
  {
    id: 'spill-response',
    title: 'Spill response',
    kicker: 'Spill response training',
    instructionEN: 'If cleaning liquid spills, step back from the spill and tell the supervisor.',
    instructionHI: 'Agar safai wala liquid gir jaye to peeche hatein aur supervisor ko batayein.',
    requiredPoints: [
      {
        id: 'step-back',
        label: 'Step back from the spill',
        followUp:
          'Can you tell me in your own words what you should do first if cleaning liquid spills?',
      },
      {
        id: 'tell-supervisor',
        label: 'Tell the supervisor about the spill',
        followUp: 'Can you tell me in your own words who should be told about the spill?',
      },
    ],
  },
];
const DEFAULT_SCENARIO_ID = 'machine-cleaning';

function scenarioById(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}

function currentScenario() {
  return scenarioById(state.scenarioId) || SCENARIOS[0];
}

const MAX_SECONDS = 30;
const STATES = ['idle', 'recording', 'processing', 'error', 'denied', 'empty'];
const STATE_WORD = {
  idle: 'Idle',
  recording: 'Recording',
  processing: 'Processing',
  error: 'Error',
  denied: 'Denied',
  empty: 'Empty',
};

const state = {
  lang: 'en-IN',
  recState: 'idle',
  stopped: false,
  scenarioId: DEFAULT_SCENARIO_ID,
  activeTurn: 1, // 1 = original answer, 2 = follow-up answer
  currentStep: 'listen',
  original: { stt: '', edited: '' },
  followUp: { question: null, stt: '', edited: '' },
  evaluatedCombined: false,
  evalLatest: null, // { points, followUp, state, turn }
  overrides: {
    'switch-off': { override: '', note: '' },
    'lock-power': { override: '', note: '' },
    'level-ground': { override: '', note: '' },
    'lock-spreader': { override: '', note: '' },
    'step-back': { override: '', note: '' },
    'tell-supervisor': { override: '', note: '' },
  },
  sessionId: null, // file-based persistence id (localStorage + GET /api/sessions/:id)
  signoff: null, // { decision, supervisorName, note, at } once signed off
  stream: null,
  recorder: null,
  chunks: [],
  timerId: null,
  seconds: 0,
};

const $ = (id) => document.getElementById(id);

function show(el, text) {
  el.textContent = text;
  el.hidden = false;
}

function hide(el) {
  el.hidden = true;
  el.textContent = '';
}

function setRecState(next) {
  if (!STATES.includes(next)) next = 'idle';
  state.recState = next;
  const badge = $('state-label');
  badge.textContent = STATE_WORD[next];
  badge.className = `state-badge is-${next}`;
  const btn = $('btn-record');
  btn.textContent = next === 'recording' ? 'Stop' : 'Record';
  btn.classList.toggle('is-live', next === 'recording');
}

function setTimer(seconds) {
  $('record-timer').textContent = `${seconds}s / ${MAX_SECONDS}s`;
}

function setTurnLabel() {
  $('turn-label').textContent = state.activeTurn === 2 ? '(follow-up answer)' : '(original answer)';
}

// ---------- Guided steps (one thing at a time) ----------

const STEPS = ['listen', 'speak', 'check', 'followup'];

function stepPanel(step) {
  return document.querySelector(`.step-panel[data-step="${step}"]`);
}

function gentleScroll(el, block) {
  const reduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: block || 'start' });
}

function paintDotState(dot, relation) {
  const word = dot.querySelector('.dot-state');
  if (word) word.textContent = relation === 'done' ? 'Done ✓' : relation === 'now' ? 'Now' : 'Next';
}

function gotoStep(step) {
  if (!STEPS.includes(step)) step = 'listen';
  if (step === 'followup' && !state.followUp.question) step = 'check';
  state.currentStep = step;
  for (const s of STEPS) {
    const panel = stepPanel(s);
    if (panel) {
      const showIt = s === step;
      panel.hidden = !showIt;
      if (showIt) {
        panel.classList.remove('entering');
        void panel.offsetWidth; // restart the gentle rise
        panel.classList.add('entering');
        const title = panel.querySelector('.step-title');
        if (title) title.focus({ preventScroll: true });
        gentleScroll(panel);
      }
    }
    const dot = $(`dot-${s}`);
    if (dot && !dot.hidden) {
      dot.classList.toggle('is-current', s === step);
      dot.classList.toggle('is-done', STEPS.indexOf(s) < STEPS.indexOf(step));
      paintDotState(dot, s === step ? 'now' : STEPS.indexOf(s) < STEPS.indexOf(step) ? 'done' : 'next');
      if (s === step) dot.setAttribute('aria-current', 'step');
      else dot.removeAttribute('aria-current');
    }
  }
}

function showTraineeDone() {
  $('trainee-done').hidden = false;
  for (const s of STEPS) {
    const dot = $(`dot-${s}`);
    if (dot && !dot.hidden) {
      dot.classList.remove('is-current');
      dot.classList.add('is-done');
      dot.removeAttribute('aria-current');
      paintDotState(dot, 'done');
    }
  }
  gentleScroll($('trainee-done'), 'nearest');
}

function stopTracks() {
  if (state.stream) {
    for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
  }
}

function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}

// ---------- Health ----------

function shortTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

function statusSeg(text, cls, dot) {
  const seg = document.createElement('span');
  seg.className = cls ? `status-seg ${cls}` : 'status-seg';
  if (dot) {
    const d = document.createElement('span');
    d.className = 'status-dot';
    d.setAttribute('aria-hidden', 'true');
    seg.appendChild(d);
  }
  seg.appendChild(document.createTextNode(text));
  return seg;
}

async function loadHealth() {
  const banner = $('health-banner');
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error(`health returned ${res.status}`);
    const h = await res.json();
    const key = Boolean(h.gnani && h.gnani.keyConfigured);
    const verified = h.liveGnaniCalls === 'VERIFIED';
    banner.innerHTML = '';
    banner.appendChild(
      statusSeg(
        key ? 'Speech ready' : 'Text mode — speech key missing',
        key ? 'status-main is-ready' : 'status-main is-text',
        true,
      ),
    );
    banner.appendChild(
      statusSeg(`STT ${h.gnani.sttModel} · ${String(h.gnani.sttLanguage).replace(/,/g, ', ')}`),
    );
    banner.appendChild(statusSeg(`TTS ${h.gnani.ttsModel}`));
    const stamps = [];
    const sttAt = h.lastLiveStt ? shortTime(h.lastLiveStt) : null;
    const ttsAt = h.lastLiveTts ? shortTime(h.lastLiveTts) : null;
    if (sttAt) stamps.push(`STT ${sttAt}`);
    if (ttsAt) stamps.push(`TTS ${ttsAt}`);
    banner.appendChild(
      statusSeg(
        verified ? `Verified${stamps.length ? ` · ${stamps.join(' · ')}` : ''}` : 'Not yet verified this session',
        'status-sub',
      ),
    );
  } catch {
    banner.innerHTML = '';
    banner.appendChild(
      statusSeg(
        'Service unreachable — start it with "npm start" and reload.',
        'status-main is-down',
        true,
      ),
    );
  }
}

// ---------- Session persistence (file-based, auto-save + resume) ----------

const SESSION_KEY = 'samajh.sessionId';
const SIGNOFF_WORD = {
  'needs-practice': 'Needs more practice',
  approved: 'Satisfactory — practice complete',
  'not-ready': 'Not satisfactory — repeat session',
};

async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const res = await fetch(`/api/sessions?scenarioId=${encodeURIComponent(state.scenarioId)}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`create session returned ${res.status}`);
  const session = await res.json();
  state.sessionId = session.id;
  try {
    localStorage.setItem(SESSION_KEY, session.id);
  } catch {
    /* private mode: the session still works in-page, it just will not resume */
  }
  return session.id;
}

function saveProgress(patch) {
  // Best-effort autosave: practice never blocks on persistence.
  (async () => {
    try {
      const id = await ensureSession();
      await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch {
      /* autosave is silent; the session keeps working in-page */
    }
  })();
}

let noteSaveTimer = null;
function saveProgressSoon(patch) {
  if (noteSaveTimer) clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(() => saveProgress(patch), 800);
}

function syncOverrideControls() {
  for (const p of currentScenario().requiredPoints) {
    const sel = $(`override-${p.id}`);
    if (sel) sel.value = state.overrides[p.id].override;
    const note = $(`note-${p.id}`);
    if (note) note.value = state.overrides[p.id].note;
  }
}

function sessionHasContent(session) {
  if (!session) return false;
  if ((session.turns || []).length || (session.evals || []).length || session.signoff) return true;
  const o = session.overrides || {};
  return Object.values(o).some((e) => (e && e.override) || (e && e.note));
}

async function restoreSession() {
  let id = null;
  try {
    id = localStorage.getItem(SESSION_KEY);
  } catch {
    id = null;
  }
  if (!id) return;
  let session = null;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`session returned ${res.status}`);
    session = await res.json();
  } catch {
    return; // backend unreachable or session gone: start clean on this page
  }
  state.sessionId = session.id;
  state.scenarioId = scenarioById(session.scenarioId) ? session.scenarioId : DEFAULT_SCENARIO_ID;
  const t1 = (session.turns || []).find((t) => t.turn === 1);
  const t2 = (session.turns || []).find((t) => t.turn === 2);
  if (t1) {
    state.original.stt = t1.stt || '';
    state.original.edited = t1.edited || '';
  }
  if (t2) {
    state.followUp.stt = t2.stt || '';
    state.followUp.edited = t2.edited || '';
  }
  const evals = session.evals || [];
  if (evals.length) {
    state.evalLatest = evals[evals.length - 1];
    state.evaluatedCombined = state.evalLatest.turn === 2;
    const first = evals.find((e) => e.turn === 1);
    state.followUp.question = first && typeof first.followUp === 'string' ? first.followUp : null;
  }
  if (session.overrides) {
    for (const s of SCENARIOS) {
      for (const p of s.requiredPoints) {
        const o = session.overrides[p.id];
        if (!o || !state.overrides[p.id]) continue;
        if (typeof o.override === 'string') state.overrides[p.id].override = o.override;
        if (typeof o.note === 'string') state.overrides[p.id].note = o.note;
      }
    }
  }
  state.signoff = session.signoff || null;
  syncScenarioPickers();
  renderScenarioTexts();
  buildSupervisorStatics();
  syncOverrideControls();
  renderOriginalTranscripts();
  renderFollowUpTranscripts();
  renderSupervisor();
  renderSignoff();
  if (state.followUp.question) {
    $('followup-question').textContent = state.followUp.question;
    $('dot-followup').hidden = false;
  }
  if (state.signoff) {
    applySignoffLock();
    gotoStep('check');
  } else if (state.followUp.question && !state.evaluatedCombined) {
    gotoStep('followup');
  } else if (state.original.edited || state.evalLatest) {
    if (state.evaluatedCombined || (state.evalLatest && !state.followUp.question)) showTraineeDone();
    gotoStep('check');
  }
  if (sessionHasContent(session)) {
    const when = session.updatedAt || session.createdAt || '';
    $('resume-text').textContent = `Resumed your saved session${when ? ` (last saved ${when})` : ''}.`;
    $('resume-banner').hidden = false;
  }
}

function startFresh() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  window.location.reload();
}

// ---------- Practice scenarios (picker kept in sync across views) ----------

function syncScenarioPickers() {
  const traineeSel = $('scenario-select');
  if (traineeSel) traineeSel.value = state.scenarioId;
  const supSel = $('sup-scenario-select');
  if (supSel) supSel.value = state.scenarioId;
}

function renderScenarioTexts() {
  const sc = currentScenario();
  $('instruction-en').textContent = sc.instructionEN;
  $('instruction-hi').textContent = sc.instructionHI;
  $('scenario-kicker').textContent = `${sc.kicker} · practising with Aarav (demo trainee).`;
}

function hasProgress() {
  if (
    state.original.stt ||
    state.original.edited ||
    state.followUp.stt ||
    state.followUp.edited ||
    state.followUp.question ||
    state.evalLatest ||
    state.signoff
  ) {
    return true;
  }
  return Object.values(state.overrides).some((e) => (e && e.override) || (e && e.note));
}

function resetTurnState() {
  state.original = { stt: '', edited: '' };
  state.followUp = { question: null, stt: '', edited: '' };
  state.evaluatedCombined = false;
  state.evalLatest = null;
  for (const s of SCENARIOS) {
    for (const p of s.requiredPoints) {
      state.overrides[p.id] = { override: '', note: '' };
    }
  }
  state.activeTurn = 1;
}

function switchScenario(nextId) {
  if (!scenarioById(nextId) || nextId === state.scenarioId || state.signoff || state.stopped) {
    syncScenarioPickers(); // unknown, unchanged, or locked: revert the picker just touched
    return;
  }
  if (
    hasProgress() &&
    !window.confirm('Switching scenarios starts a fresh turn set. Switch anyway? Your current answers stay saved.')
  ) {
    syncScenarioPickers();
    return;
  }
  state.scenarioId = nextId;
  resetTurnState();
  // A fresh turn set lives in a fresh session; the previous session stays saved on disk.
  state.sessionId = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  hide($('resume-banner'));
  hide($('submit-notice'));
  hide($('followup-submit-notice'));
  $('trainee-done').hidden = true;
  $('followup-question').textContent = '';
  setTurnLabel();
  setRecState('idle');
  syncScenarioPickers();
  renderScenarioTexts();
  buildSupervisorStatics();
  renderOriginalTranscripts();
  renderFollowUpTranscripts();
  renderFollowUpCard();
  renderSupervisor();
  renderSignoff();
  gotoStep('listen');
}

// ---------- TTS ----------

async function playTts(text, lang, audioEl, noticeEl) {
  hide(noticeEl);
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language: lang }),
    });
    if (res.status === 503) {
      show(
        noticeEl,
        'Spoken audio is unavailable (speech service not configured or not allowed). ' +
          'Showing the instruction as text only — please read it aloud yourself or ask a supervisor.',
      );
      return;
    }
    if (!res.ok) {
      show(
        noticeEl,
        `Spoken audio failed (server returned ${res.status}). Showing text only for now.`,
      );
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    audioEl.src = url;
    await audioEl.play();
  } catch {
    show(
      noticeEl,
      'Spoken audio could not be loaded (network or backend error). Showing text only for now.',
    );
  }
}

function instructionTextForLang() {
  // The demo Hindi line is Latin-script, so it is spoken with the hi-en
  // Hinglish voice; Devanagari input would use hi-IN instead.
  const sc = currentScenario();
  return state.lang === 'en-IN' ? sc.instructionEN : sc.instructionHI;
}

// ---------- Recording + STT ----------

function pickMime() {
  // Prefer containers Gnani STT accepts, so the raw fallback still has a chance.
  const candidates = ['audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm'];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return '';
}

async function startRecording() {
  if (state.stopped) {
    show($('record-error'), 'This session was stopped. A supervisor has been asked to help.');
    return;
  }
  if (state.recState === 'recording' || state.recState === 'processing') return;
  hide($('record-error'));
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) {
    setRecState('error');
    show(
      $('record-error'),
      'Recording is not supported in this browser. Type your answer in the box below instead, then submit.',
    );
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setRecState('denied');
    show(
      $('record-error'),
      'Microphone access was denied. Allow microphone access and try again, or type your answer below and submit.',
    );
    return;
  }
  state.stream = stream;
  state.chunks = [];
  const mime = pickMime();
  try {
    state.recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch {
    stopTracks();
    setRecState('error');
    show($('record-error'), 'Could not start the recorder in this browser. Type your answer below instead.');
    return;
  }
  state.recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) state.chunks.push(ev.data);
  };
  state.recorder.onstop = onRecorderStopped;
  state.recorder.start();
  state.seconds = 0;
  setTimer(0);
  setRecState('recording');
  hide($('record-error'));
  state.timerId = setInterval(() => {
    state.seconds += 1;
    setTimer(state.seconds);
    if (state.seconds >= MAX_SECONDS) stopRecording(); // <=30s guard
  }, 1000);
}

function stopRecording() {
  stopTimer();
  if (state.recorder && state.recorder.state !== 'inactive') {
    setRecState('processing');
    state.recorder.stop();
  } else {
    stopTracks();
    if (state.recState === 'recording') setRecState('idle');
  }
}

async function onRecorderStopped() {
  stopTimer();
  stopTracks();
  const type = (state.recorder && state.recorder.mimeType) || 'audio/webm';
  const blob = new Blob(state.chunks, { type });
  state.recorder = null;
  if (!blob.size) {
    setRecState('empty');
    show(
      $('record-error'),
      'No audio was captured. Press Record and try again, or press Stop / Ask for supervisor.',
    );
    return;
  }
  const wav = await transcodeToWav(blob);
  uploadStt(wav || blob);
}

// Gnani STT accepts wav/mp3/ogg/flac/aac/m4a — browsers usually record webm,
// so transcode to 16kHz mono WAV before upload. Returns null when the browser
// cannot decode, in which case the raw blob is uploaded as a fallback.
async function transcodeToWav(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  let actx = null;
  try {
    const raw = await blob.arrayBuffer();
    actx = new Ctx();
    const decoded = await actx.decodeAudioData(raw);
    if (!decoded || !decoded.numberOfChannels || !decoded.length) return null;
    const TARGET = 16000;
    const ratio = decoded.sampleRate / TARGET;
    const outLen = Math.min(Math.floor(decoded.length / ratio), TARGET * MAX_SECONDS);
    if (outLen <= 0) return null;
    const chans = [];
    for (let c = 0; c < decoded.numberOfChannels; c += 1) chans.push(decoded.getChannelData(c));
    const mono = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, decoded.length - 1);
      const frac = src - i0;
      let sum = 0;
      for (const ch of chans) sum += ch[i0] * (1 - frac) + ch[i1] * frac;
      mono[i] = sum / chans.length;
    }
    return new Blob([encodeWavPcm16(mono, TARGET)], { type: 'audio/wav' });
  } catch {
    return null;
  } finally {
    if (actx) {
      try {
        await actx.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function encodeWavPcm16(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ascii = (off, s) => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

async function uploadStt(blob) {
  setRecState('processing');
  hide($('record-error'));
  const contentType = blob.type || 'audio/webm';
  const filename = contentType.includes('wav')
    ? 'answer.wav'
    : contentType.includes('mp4')
      ? 'answer.m4a'
      : contentType.includes('ogg') || contentType.includes('oga')
        ? 'answer.ogg'
        : 'answer.webm';
  try {
    const res = await fetch(`/api/stt?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: blob,
    });
    if (res.status === 503) {
      setRecState('error');
      const target = state.activeTurn === 2 ? 'follow-up' : 'original';
      show(
        $('record-error'),
        'Automatic transcription is unavailable (speech service not configured). ' +
          `No automatic ${target} transcript was produced — type the answer in the box below and submit, or ask a supervisor.`,
      );
      if (state.activeTurn === 2) {
        state.followUp.stt = '';
        renderFollowUpTranscripts();
      } else {
        state.original.stt = '';
        renderOriginalTranscripts();
      }
      return;
    }
    if (!res.ok) {
      setRecState('error');
      show(
        $('record-error'),
        `Transcription failed (server returned ${res.status}). Try recording again, or type your answer below.`,
      );
      return;
    }
    const body = await res.json();
    const transcript = typeof body.transcript === 'string' ? body.transcript : '';
    if (!transcript.trim()) {
      // Never evaluate empty/unintelligible audio.
      setRecState('empty');
      if (state.activeTurn === 2) {
        state.followUp.stt = '';
        renderFollowUpTranscripts();
        show(
          $('followup-submit-notice'),
          'No speech was recognized in that recording. Press “Record follow-up answer” and try again, or press Stop / Ask for supervisor.',
        );
      } else {
        state.original.stt = '';
        renderOriginalTranscripts();
        show(
          $('submit-notice'),
          'No speech was recognized in that recording. Press Record and try again, or press Stop / Ask for supervisor.',
        );
      }
      show($('record-error'), '');
      hide($('record-error'));
      return;
    }
    if (state.activeTurn === 2) {
      state.followUp.stt = transcript;
      state.followUp.edited = transcript;
      $('followup-edited').value = transcript;
      renderFollowUpTranscripts();
      hide($('followup-submit-notice'));
      saveProgress({ turn: { turn: 2, stt: transcript, edited: transcript } });
    } else {
      state.original.stt = transcript;
      state.original.edited = transcript;
      $('edited-transcript').value = transcript;
      renderOriginalTranscripts();
      hide($('submit-notice'));
      saveProgress({ turn: { turn: 1, stt: transcript, edited: transcript } });
    }
    setRecState('idle');
    gotoStep(state.activeTurn === 2 ? 'followup' : 'check');
  } catch {
    setRecState('error');
    show(
      $('record-error'),
      'Transcription could not be reached (network or backend error). Try again, or type your answer below.',
    );
  }
}

// ---------- Transcripts + evaluation ----------

function renderOriginalTranscripts() {
  $('original-transcript').textContent = state.original.stt || '';
  if (document.activeElement !== $('edited-transcript')) {
    $('edited-transcript').value = state.original.edited;
  }
  renderSupervisor();
}

function renderFollowUpTranscripts() {
  $('followup-original').textContent = state.followUp.stt || '';
  if (document.activeElement !== $('followup-edited')) {
    $('followup-edited').value = state.followUp.edited;
  }
  renderSupervisor();
}

async function postEvaluate(transcript, turn) {
  const res = await fetch('/api/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, turn, scenarioId: state.scenarioId }),
  });
  if (!res.ok) throw new Error(`evaluate returned ${res.status}`);
  return res.json();
}

async function submitOriginal() {
  if (state.stopped) {
    show($('submit-notice'), 'This session was stopped. A supervisor has been asked to help.');
    return;
  }
  const text = $('edited-transcript').value;
  state.original.edited = text;
  hide($('submit-notice'));
  if (!text.trim()) {
    // Never evaluate empty input.
    setRecState('empty');
    show(
      $('submit-notice'),
      'Nothing to review yet — record an answer or type it above, then submit. Or press Stop / Ask for supervisor.',
    );
    renderSupervisor();
    return;
  }
  setRecState('processing');
  try {
    const result = await postEvaluate(text, 1);
    state.evalLatest = result;
    state.evaluatedCombined = false;
    // At most one follow-up question at a time: the backend returns a single string or null.
    state.followUp.question = typeof result.followUp === 'string' ? result.followUp : null;
    saveProgress({ turn: { turn: 1, stt: state.original.stt, edited: text }, eval: result });
    setRecState('idle');
    renderFollowUpCard();
    renderSupervisor();
    if (!state.followUp.question) showTraineeDone();
  } catch {
    setRecState('error');
    show($('submit-notice'), 'Review failed (network or backend error). Try submitting again.');
  }
}

async function submitFollowUp() {
  if (state.stopped) {
    show($('followup-submit-notice'), 'This session was stopped. A supervisor has been asked to help.');
    return;
  }
  const text = $('followup-edited').value;
  state.followUp.edited = text;
  hide($('followup-submit-notice'));
  if (!text.trim()) {
    setRecState('empty');
    show(
      $('followup-submit-notice'),
      'Nothing to review yet — record the follow-up answer or type it above, then submit. Or press Stop / Ask for supervisor.',
    );
    renderSupervisor();
    return;
  }
  setRecState('processing');
  try {
    // Combined overall result: original corrected answer + follow-up corrected answer.
    const combined = `${state.original.edited}\n${text}`.trim();
    const result = await postEvaluate(combined, 2);
    state.evalLatest = result;
    state.evaluatedCombined = true;
    saveProgress({ turn: { turn: 2, stt: state.followUp.stt, edited: text }, eval: result });
    setRecState('idle');
    renderFollowUpCard();
    renderSupervisor();
    showTraineeDone();
  } catch {
    setRecState('error');
    show($('followup-submit-notice'), 'Review failed (network or backend error). Try submitting again.');
  }
}

function renderFollowUpCard() {
  const card = $('followup-card');
  if (!state.followUp.question) {
    card.hidden = true;
    $('dot-followup').hidden = true;
    return;
  }
  // Single question element: at most one follow-up is ever shown.
  $('followup-question').textContent = state.followUp.question;
  $('dot-followup').hidden = false;
  gotoStep('followup');
}

// ---------- Supervisor view ----------

function statusWord(s) {
  return s === 'Mentioned' || s === 'Not mentioned' || s === 'Unclear' ? s : 'Unclear';
}

function paintStamp(text) {
  const stamp = $('sup-state');
  stamp.textContent = text;
  stamp.classList.remove('is-waiting', 'is-clarify', 'is-ready');
  if (text === 'Ready for supervisor review') stamp.classList.add('is-ready');
  else if (text === 'Needs clarification') stamp.classList.add('is-clarify');
  else stamp.classList.add('is-waiting');
}

function buildSupervisorStatics() {
  const sc = currentScenario();
  $('sup-instruction-en').textContent = sc.instructionEN;
  $('sup-instruction-hi').textContent = sc.instructionHI;
  const ul = $('sup-points');
  ul.innerHTML = '';
  for (const p of sc.requiredPoints) {
    const li = document.createElement('li');
    li.textContent = p.label;
    ul.appendChild(li);
  }
  const wrap = $('sup-overrides');
  wrap.innerHTML = '';
  for (const p of sc.requiredPoints) {
    const box = document.createElement('div');
    box.className = 'sup-point';
    const h = document.createElement('h4');
    h.textContent = p.label;
    box.appendChild(h);

    const machineLine = document.createElement('p');
    machineLine.innerHTML = '';
    const mLabel = document.createElement('strong');
    mLabel.textContent = 'Machine result: ';
    const mVal = document.createElement('span');
    mVal.id = `machine-${p.id}`;
    mVal.textContent = 'Not evaluated yet';
    machineLine.appendChild(mLabel);
    machineLine.appendChild(mVal);
    box.appendChild(machineLine);

    const selField = document.createElement('div');
    selField.className = 'field';
    const selLabel = document.createElement('label');
    selLabel.setAttribute('for', `override-${p.id}`);
    selLabel.textContent = 'Supervisor override (kept alongside the machine result)';
    const sel = document.createElement('select');
    sel.id = `override-${p.id}`;
    for (const [value, label] of [
      ['', 'No override — keep machine result'],
      ['Mentioned', 'Mentioned'],
      ['Not mentioned', 'Not mentioned'],
      ['Unclear', 'Unclear'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = state.overrides[p.id].override;
    sel.addEventListener('change', () => {
      state.overrides[p.id].override = sel.value;
      renderSupervisor();
      saveProgress({ overrides: state.overrides });
    });
    selField.appendChild(selLabel);
    selField.appendChild(sel);
    box.appendChild(selField);

    const noteField = document.createElement('div');
    noteField.className = 'field';
    const noteLabel = document.createElement('label');
    noteLabel.setAttribute('for', `note-${p.id}`);
    noteLabel.textContent = 'Supervisor note (preserved with the override)';
    const note = document.createElement('input');
    note.type = 'text';
    note.id = `note-${p.id}`;
    note.placeholder = 'Optional note, kept with this point';
    note.value = state.overrides[p.id].note;
    note.addEventListener('input', () => {
      state.overrides[p.id].note = note.value;
      saveProgressSoon({ overrides: state.overrides });
    });
    noteField.appendChild(noteLabel);
    noteField.appendChild(note);
    box.appendChild(noteField);

    const finalLine = document.createElement('p');
    const fLabel = document.createElement('strong');
    fLabel.textContent = 'Final for this point: ';
    const fVal = document.createElement('span');
    fVal.id = `final-${p.id}`;
    fVal.textContent = 'Not evaluated yet';
    finalLine.appendChild(fLabel);
    finalLine.appendChild(fVal);
    box.appendChild(finalLine);

    wrap.appendChild(box);
  }
}

function renderSupervisor() {
  $('sup-original-stt').textContent = state.original.stt || '';
  $('sup-original-edited').textContent = state.original.edited || '';
  $('sup-followup-q').textContent = state.followUp.question || '';
  $('sup-followup-stt').textContent = state.followUp.stt || '';
  $('sup-followup-edited').textContent = state.followUp.edited || '';

  if (state.stopped) {
    show($('sup-stop-notice'), 'The trainee pressed Stop / Ask for supervisor. Please review and assist.');
  } else {
    hide($('sup-stop-notice'));
  }

  const machine = $('sup-machine');
  machine.innerHTML = '';
  const result = state.evalLatest;
  if (!result) {
    $('sup-eval-note').hidden = false;
    paintStamp('Not evaluated yet');
  } else {
    $('sup-eval-note').hidden = true;
    const scope = document.createElement('p');
    scope.className = 'review-note';
    scope.textContent =
      state.evaluatedCombined && result.turn === 2
        ? 'Overall result from the original corrected answer plus the follow-up corrected answer.'
        : 'Result from the original corrected answer.';
    machine.appendChild(scope);
    for (const pt of result.points || []) {
      const box = document.createElement('div');
      box.className = 'sup-point';
      const h = document.createElement('h4');
      h.textContent = pt.label || pt.id;
      box.appendChild(h);
      const dl = document.createElement('dl');
      const dt1 = document.createElement('dt');
      dt1.textContent = 'Result';
      const dd1 = document.createElement('dd');
      const chip = document.createElement('span');
      const word = statusWord(pt.status);
      chip.className = `chip ${word === 'Mentioned' ? 'is-mentioned' : word === 'Not mentioned' ? 'is-not' : 'is-unclear'}`;
      chip.textContent = word;
      dd1.appendChild(chip);
      const dt2 = document.createElement('dt');
      dt2.textContent = 'Supporting excerpt';
      const dd2 = document.createElement('dd');
      if (pt.excerpt) {
        dd2.textContent = `“${pt.excerpt}”`;
        dd2.className = 'excerpt';
      } else {
        dd2.textContent = 'no supporting excerpt';
        dd2.className = 'no-excerpt';
      }
      dl.appendChild(dt1);
      dl.appendChild(dd1);
      dl.appendChild(dt2);
      dl.appendChild(dd2);
      box.appendChild(dl);
      machine.appendChild(box);
    }
    // Neutral overall state only: show the backend state string as-is.
    paintStamp(result.state || 'Not evaluated yet');
  }

  // Override panel: machine result + override + final, without touching select/note values.
  for (const p of currentScenario().requiredPoints) {
    const found = result && (result.points || []).find((x) => x.id === p.id);
    const machineStatus = found ? statusWord(found.status) : 'Not evaluated yet';
    const mEl = $(`machine-${p.id}`);
    if (mEl) mEl.textContent = machineStatus;
    const ov = state.overrides[p.id].override;
    const fEl = $(`final-${p.id}`);
    if (fEl) {
      if (!found) {
        fEl.textContent = ov ? `${ov} (override, no machine result yet)` : 'Not evaluated yet';
      } else {
        fEl.textContent = ov ? `${ov} (supervisor override; machine said ${machineStatus})` : machineStatus;
      }
    }
  }
}

async function supervisorReEvaluate() {
  hide($('sup-eval-notice'));
  const combined = `${state.original.edited}\n${state.followUp.edited}`.trim();
  if (!combined) {
    show(
      $('sup-eval-notice'),
      'Nothing to evaluate — there are no trainee answers yet. Empty input is never evaluated.',
    );
    return;
  }
  try {
    const result = await postEvaluate(combined, state.followUp.edited.trim() ? 2 : 1);
    state.evalLatest = result;
    state.evaluatedCombined = Boolean(state.followUp.edited.trim());
    saveProgress({ eval: result });
    renderSupervisor();
  } catch {
    show($('sup-eval-notice'), 'Evaluation failed (network or backend error). Try again.');
  }
}

// ---------- Supervisor sign-off (persisted, shown on reload) ----------

function signoffLine(s) {
  const word = SIGNOFF_WORD[s.decision] || s.decision;
  const stamp = s.at || '';
  const note = s.note ? ` Note: ${s.note}` : '';
  return `Signed off by ${s.supervisorName} on ${stamp}: ${word}.${note}`;
}

function renderSignoff() {
  const status = $('sup-sign-status');
  if (state.signoff) {
    $('sup-sign-name').value = state.signoff.supervisorName || '';
    $('sup-sign-decision').value = state.signoff.decision;
    $('sup-sign-note').value = state.signoff.note || '';
    $('btn-signoff').disabled = true;
    show(status, signoffLine(state.signoff));
  } else {
    $('btn-signoff').disabled = false;
    hide(status);
  }
}

async function submitSignoff() {
  const name = $('sup-sign-name').value;
  const decision = $('sup-sign-decision').value;
  const note = $('sup-sign-note').value;
  if (!name.trim()) {
    show($('sup-sign-status'), 'Add your name before signing off — the name is saved with the session.');
    return;
  }
  try {
    const id = await ensureSession();
    // Persist the latest overrides alongside the sign-off, then sign off.
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: state.overrides }),
      });
    } catch {
      /* the sign-off below is the authoritative write */
    }
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/signoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, supervisorName: name, note }),
    });
    if (!res.ok) throw new Error(`signoff returned ${res.status}`);
    const session = await res.json();
    state.signoff = session.signoff;
    renderSignoff();
    applySignoffLock();
    renderSupervisor();
  } catch {
    show($('sup-sign-status'), 'Sign-off could not be saved (network or backend error). Try again.');
  }
}

function applySignoffLock() {
  if (!state.signoff) return;
  const word = SIGNOFF_WORD[state.signoff.decision] || state.signoff.decision;
  show(
    $('signoff-banner'),
    `This session was signed off by ${state.signoff.supervisorName} (${word}) — answers are locked for review.`,
  );
  for (const id of ['btn-record', 'btn-submit-original', 'btn-record-followup', 'btn-submit-followup']) {
    $(id).disabled = true;
  }
  $('edited-transcript').disabled = true;
  $('followup-edited').disabled = true;
  $('scenario-select').disabled = true;
  $('sup-scenario-select').disabled = true;
  showTraineeDone();
}

// ---------- Stop / views ----------

function stopSession() {
  if (state.recorder && state.recorder.state !== 'inactive') {
    try {
      state.recorder.stop();
    } catch {
      /* ignore */
    }
  }
  stopTimer();
  stopTracks();
  for (const id of ['instruction-audio', 'followup-audio']) {
    try {
      $(id).pause();
    } catch {
      /* ignore */
    }
  }
  state.stopped = true;
  setRecState('idle');
  $('btn-record').disabled = true;
  $('btn-submit-original').disabled = true;
  $('btn-record-followup').disabled = true;
  $('btn-submit-followup').disabled = true;
  for (const id of ['btn-to-speak', 'btn-to-check', 'btn-back-listen', 'btn-back-speak', 'btn-back-check',
    'btn-play-instruction', 'btn-listen-again', 'btn-play-followup', 'scenario-select', 'sup-scenario-select']) {
    $(id).disabled = true;
  }
  show(
    $('stop-notice'),
    'Session stopped. A supervisor has been asked to help — please wait for them.',
  );
  renderSupervisor();
}

function showView(which) {
  const trainee = which === 'trainee';
  $('trainee-view').hidden = !trainee;
  $('supervisor-view').hidden = trainee;
  $('btn-trainee').setAttribute('aria-pressed', String(trainee));
  $('btn-supervisor').setAttribute('aria-pressed', String(!trainee));
  $('viewing-label').textContent = trainee ? 'Viewing: Trainee' : 'Viewing: Supervisor';
  if (!trainee) renderSupervisor();
}

// ---------- Init ----------

document.addEventListener('DOMContentLoaded', () => {
  renderScenarioTexts();
  syncScenarioPickers();
  setTurnLabel();
  buildSupervisorStatics();
  renderSupervisor();
  renderSignoff();
  loadHealth();
  restoreSession();

  $('language-select').addEventListener('change', (ev) => {
    state.lang = ev.target.value === 'hi-en' ? 'hi-en' : 'en-IN';
  });

  $('btn-play-instruction').addEventListener('click', () => {
    playTts(instructionTextForLang(), state.lang, $('instruction-audio'), $('tts-notice'));
  });
  $('btn-listen-again').addEventListener('click', () => {
    playTts(instructionTextForLang(), state.lang, $('instruction-audio'), $('tts-notice'));
  });
  $('btn-play-followup').addEventListener('click', () => {
    if (state.followUp.question) {
      // Follow-up text is English, so use the English voice.
      playTts(state.followUp.question, 'en-IN', $('followup-audio'), $('followup-tts-notice'));
    }
  });

  $('btn-record').addEventListener('click', () => {
    if (state.recState === 'recording') stopRecording();
    else startRecording();
  });
  $('btn-record-followup').addEventListener('click', () => {
    state.activeTurn = 2;
    setTurnLabel();
    gotoStep('speak'); // one shared recording booth for both turns
  });

  $('edited-transcript').addEventListener('input', (ev) => {
    state.original.edited = ev.target.value;
    renderSupervisor();
  });
  $('followup-edited').addEventListener('input', (ev) => {
    state.followUp.edited = ev.target.value;
    renderSupervisor();
  });

  $('btn-submit-original').addEventListener('click', submitOriginal);
  $('btn-submit-followup').addEventListener('click', submitFollowUp);
  $('btn-sup-evaluate').addEventListener('click', supervisorReEvaluate);
  $('btn-stop').addEventListener('click', stopSession);
  $('btn-signoff').addEventListener('click', submitSignoff);
  $('btn-fresh-session').addEventListener('click', startFresh);

  $('btn-trainee').addEventListener('click', () => showView('trainee'));
  $('btn-supervisor').addEventListener('click', () => showView('supervisor'));

  $('scenario-select').addEventListener('change', (ev) => switchScenario(ev.target.value));
  $('sup-scenario-select').addEventListener('change', (ev) => switchScenario(ev.target.value));

  $('btn-to-speak').addEventListener('click', () => gotoStep('speak'));
  $('btn-to-check').addEventListener('click', () => gotoStep('check'));
  $('btn-back-listen').addEventListener('click', () => gotoStep('listen'));
  $('btn-back-speak').addEventListener('click', () => gotoStep('speak'));
  $('btn-back-check').addEventListener('click', () => gotoStep('check'));
});
