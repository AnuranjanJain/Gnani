# Samajh — Safety-Instruction Training Demo

Samajh is a small demo that helps a trainee practise repeating back a safety
instruction in their own words. It offers three synthetic practice scenarios
(pick one in either view; both stay in sync):

1. **Machine cleaning** — `Before cleaning, switch off the machine and lock
   the power supply.` (the original approved scenario)
2. **Ladder safety** — `Before climbing, set the ladder on firm level ground
   and lock the spreader bars.`
3. **Spill response** — `If cleaning liquid spills, step back from the spill
   and tell the supervisor.`

The trainee listens to the instruction, records an answer, and gets a neutral,
machine-generated check of two required points plus at most one teach-back
follow-up question. A supervisor view shows the transcripts, the machine
result with supporting excerpts, and supervisor overrides kept alongside the
machine result.

Synthetic demo data only. Nothing here is training material until a human
supervisor reviews it.

## Setup

Requirements: Node.js 18+ (tested on Node 24), no other dependencies.

```powershell
npm install
npm test     # 126 tests, must all pass
npm start    # serves http://localhost:3000 (PORT=3001 npm start if 3000 is taken)
```

Copy `.env.example` to `.env` to configure speech services (optional):

```powershell
Copy-Item .env.example .env
```

## Environment variables

| Variable           | Default        | Meaning                                              |
| ------------------ | -------------- | ---------------------------------------------------- |
| `GNANI_API_KEY`    | _(empty)_      | Gnani API key. Empty = speech unavailable, honest 503s and text fallback. |
| `GNANI_STT_MODEL`  | `prisma-v3.0`  | STT model sent to Gnani.                             |
| `GNANI_STT_LANGUAGE` | `hi-IN,en-IN` | STT language codes sent to Gnani.                   |
| `GNANI_TTS_MODEL`  | `timbre-v2.5`  | TTS model sent to Gnani.                             |
| `PORT`             | `3000`         | Local server port.                                   |

Keys are read from the environment (or `.env`, which is git-ignored) only.
Never put keys in code, logs, or this README.

## Gnani usage (as implemented in `server.js`)

Base URL: `https://api.vachana.ai`. Auth header: `X-API-Key-ID`.

- Speech-to-text: `POST /stt/v3`, multipart form with `audio_file` (raw
  `audio/*` bytes, <=30s), `model` (`GNANI_STT_MODEL`), `language_code`
  (`GNANI_STT_LANGUAGE`).
- Text-to-speech: `POST /api/v1/tts/inference`, JSON
  `{ text, voice, model, language, audio_config: { container: "wav" } }`.
  Voices: `Nalini` for `hi-IN`, `Kaveri` for `en-IN`, `Poorvi` for `hi-en`
  (Hinglish — used for the Latin-script demo Hindi line).

Live Gnani STT/TTS calls are **VERIFIED** with a configured key (2026-11-08:
TTS `timbre-v2.5`/`Nalini` synthesis → STT `prisma-v3.0` round-trip returned
`सफाई से पहले machine band करें और power supply lock करें।`,
`detected_language_code=hi-IN`, both points Mentioned). Without
`GNANI_API_KEY` the server returns honest `STT_UNAVAILABLE` /
`TTS_UNAVAILABLE` (503) errors and the page falls back to text. A Gnani
`SCOPE_NOT_ALLOWED` (403) response is likewise mapped to `TTS_UNAVAILABLE`.

## Capability-verification steps

1. `npm test` — 126/126 green. Covers the evaluator (states, exact excerpts,
   teach-back follow-ups, demo utterances, paraphrases and code-mix,
   Devanagari transliterations, the बैंड-lookalike guard, empty/unintelligible
   input, contradictions) for all three scenarios plus the registry
   (wording, Hindi-review flags, default compatibility), the server contracts
   and Gnani error-shape mapping (mocked upstream only — no live calls),
   live-status tracking (VERIFIED only after a real upstream success), the
   frontend contract (override preservation, empty-never-evaluated, single
   follow-up, scenario mirror, picker sync, no secrets), the WAV encoder
   bytes, and file-based session persistence (store round-trip,
   reload-restore shape, per-scenario sessions, corrupt-file errors, HTTP
   create/append/sign-off on an ephemeral port).
2. `npm start`, then check the service status (config only, never calls Gnani):

   ```powershell
   Invoke-RestMethod http://127.0.0.1:3000/api/health
   # ok=true, keyConfigured=false without a key, liveGnaniCalls=UNVERIFIED
   ```

3. Open `http://localhost:3000/` — the Samajh page loads with a service-status
   banner and Trainee / Supervisor tabs.
4. Evaluate the two demo utterances:

   ```powershell
   $demo1 = @{ transcript = "Machine band karke saaf karna hai."; turn = 1 } | ConvertTo-Json
   Invoke-RestMethod http://127.0.0.1:3000/api/evaluate -Method POST -ContentType "application/json" -Body $demo1
   # switch-off=Mentioned, lock-power=Not mentioned, power-supply follow-up, Needs clarification

   $demo2 = @{ transcript = "Power supply lock karni hai."; turn = 1 } | ConvertTo-Json
   Invoke-RestMethod http://127.0.0.1:3000/api/evaluate -Method POST -ContentType "application/json" -Body $demo2
   # lock-power=Mentioned, switch-off=Not mentioned, machine follow-up, Needs clarification
   ```

5. Without a key, confirm the honest speech fallbacks: `POST /api/tts` and
   `POST /api/stt` return 503 `TTS_UNAVAILABLE` / `STT_UNAVAILABLE`.

## Reproducible demo script

1. `npm install; npm start`, open `http://localhost:3000/`.
2. Trainee view: pick a language and press **Play instruction**. (Without a
   key you get a text-only notice — read the instruction aloud instead.)
3. Answer one: press **Record**, say **"Machine band karke saaf karna hai."**
   (or type it in the corrections box), then **Submit answer for review**.
   Expected: switch-off Mentioned with that sentence as the excerpt,
   lock-power Not mentioned, one follow-up asking in your own words what needs
   to happen with the power supply.
4. Follow-up answer: press **Record follow-up answer**, say
   **"Power supply lock karni hai."**, then **Submit follow-up answer**.
   Expected: combined result Mentioned/Mentioned,
   state `Ready for supervisor review`, no further follow-up.
5. Supervisor view: check the approved instruction, both transcripts (automatic
   vs corrected, kept separate), per-point results with exact excerpts or
   `no supporting excerpt`, and the neutral overall state. Try a per-point
   override + note: the machine result stays visible and the Final line reads
   e.g. `Mentioned (supervisor override; machine said Unclear)`.
6. Optional: submit an empty answer or a contradiction such as
   `Switch off the machine. Actually, do not switch off.` — empty input is
   never evaluated, and contradictions are never Mentioned.

## API reference (local server)

- `GET /api/health` → `{ ok, gnani: {...}, liveGnaniCalls, lastLiveStt, lastLiveTts }`.
  `liveGnaniCalls` is `VERIFIED` only after a real upstream success this
  session (never on config alone); timestamps show the last live STT/TTS.
- `POST /api/stt` — raw `audio/*` bytes (query `?filename=` optional) → Gnani
  transcript JSON; `{ transcript: "" }` is success, not an error.
- `POST /api/tts` — `{ text, language }` (`hi-IN` default, `en-IN` also
  accepted) → WAV audio bytes, or 503 `TTS_UNAVAILABLE`.
- `POST /api/evaluate` — `{ transcript, turn, scenarioId? }` →
  `{ points: [{ id, label, status, excerpt }], followUp, state, turn, scenarioId }`.
  `scenarioId` is optional (default `machine-cleaning`); unknown ids get
  `400 BAD_SCENARIO`. Statuses: `Mentioned` / `Not mentioned` / `Unclear`.
  States: `Ready for supervisor review` / `Needs clarification`.
- `POST /api/sessions` creates a session (`201` + full session object).
  Optional query `?scenarioId=` picks the practice scenario (default
  `machine-cleaning`); unknown ids get `400 SESSION_BAD_SCENARIO`.
- `GET /api/sessions/:id` resumes one session (unknown id: `404
  SESSION_NOT_FOUND`; unreadable file: `500 SESSION_CORRUPT`).
- `PATCH /api/sessions/:id` with `{ turn?, eval?, overrides? }` appends a
  turn (`{ turn, stt, edited }`), an eval snapshot, and/or per-point overrides.
- `POST /api/sessions/:id/turns` appends one turn (alias for `PATCH`).
- `POST /api/sessions/:id/signoff` with `{ decision, supervisorName, note? }`
  records the final sign-off (`decision`: `approved` / `needs-practice` /
  `not-ready`) and marks the session finished.

## Practice scenarios

Three synthetic scenarios live in `lib/scenarios.js` (each: an approved EN
instruction, a demo Hindi line flagged `needs-human-review`, and two required
points with teach-back follow-ups). `lib/evaluate.js` scores any of them from
the per-point match patterns in the registry; `evaluate(transcript, turn)`
with no scenario arg still scores machine-cleaning exactly as before, and
`lib/scenario.js` keeps exporting that default scenario unchanged.

The page has one picker in the trainee view and one in the supervisor ledger;
both stay in sync. Switching scenarios starts a fresh turn set (with a
confirm step when answers already exist) in a fresh session — the previous
session stays saved on disk. The picker locks once the session is signed off.

## Session persistence

Progress auto-saves to file-based sessions: each session is one JSON file at
`data/sessions/<id>.json` (created at runtime; `data/` is git-ignored and
holds synthetic demo data only — never commit it, never put real trainee
records there). A session file holds its `scenarioId`, turns (`stt` + trainee
`edited` kept separate), eval snapshots, per-point overrides with notes, and
the final sign-off (`{ decision, supervisorName, note, at }`). Sessions saved
before scenarios existed resume as machine-cleaning.

The page stores its session id in `localStorage` and restores on reload with
a resume banner ("Resumed your saved session…", plus **Start fresh** to begin
a new one). The supervisor view has a final sign-off panel (name + decision +
optional note); once signed off, the sign-off line with its timestamp persists
across reloads and the trainee view locks its answers read-only for review.

Set `SAMAJH_DATA_DIR` to point the store at another directory (tests use a
temp dir).

## Deploy

The app is a single Node process (`npm start` → `node server.js`) that reads
`PORT` from the environment and answers `GET /api/health` for health checks.
Use Node 24 (see `.nvmrc`; `package.json` engines require Node 18+).

### Required environment variables

| Variable             | Required?       | Meaning                                                        |
| -------------------- | --------------- | -------------------------------------------------------------- |
| `GNANI_API_KEY`      | Yes, for speech | Gnani API key. Empty = honest 503s + text fallback. Set as a secret in the host dashboard. |
| `GNANI_STT_MODEL`    | No              | STT model override (default `prisma-v3.0`).                    |
| `GNANI_STT_LANGUAGE` | No              | STT language override (default `hi-IN,en-IN`).                 |
| `GNANI_TTS_MODEL`    | No              | TTS model override (default `timbre-v2.5`).                    |
| `PORT`               | Set by the host | Render/Railway inject this; default `3000` locally.            |
| `SAMAJH_DATA_DIR`    | No              | Session store dir (default `./data`).                          |

Never commit real keys: `.env` is git-ignored and stays local; production
keys live only in the host's secret settings.

### Ephemeral-disk warning (read before deploying)

Sessions are plain JSON files under `data/sessions/` (see "Session
persistence" above). Host filesystems are **ephemeral by default**: every
redeploy or restart wipes all saved sessions unless persistent storage is
attached. Render: the disk in `render.yaml` (mounted at `/app/data`) handles
this. Railway: attach a volume at `/app/data` (or set `SAMAJH_DATA_DIR` to
your mount path). Docker: pass `-v <volume>:/app/data` as below.

### Render

1. Push this repo, then Dashboard → New → Blueprint → select the repo.
   `render.yaml` defines the `samajh` web service (Docker runtime,
   `healthCheckPath: /api/health`, 1 GB disk at `/app/data`).
2. When prompted, set `GNANI_API_KEY` as a secret value (`sync: false` vars
   are never stored in the repo). Optional: the three model overrides.
3. Deploy and open the service URL. Free tier: the service sleeps after
   ~15 minutes without traffic; the first request after sleep takes ~30–60s
   to wake it, then behaves normally.

### Railway

No config file needed — configure in the dashboard:

1. New → Deploy from Repo → select this repo.
2. Settings → Start Command: `npm start`. Healthcheck Path: `/api/health`.
3. Variables: add `GNANI_API_KEY` (plus optional model overrides).
   Railway injects `PORT` automatically.
4. Storage → Add Volume, mount path `/app/data`, so sessions survive
   restarts (or set `SAMAJH_DATA_DIR` to your mount path instead).
5. Trial/free usage sleeps or stops when idle or over quota; expect a slow
   first request after a cold start.

### Docker

```powershell
docker build -t samajh .
docker run -p 3000:3000 -e GNANI_API_KEY=$env:GNANI_API_KEY -v samajh-data:/app/data samajh
```

Omit `-v …` only for a throwaway run — sessions are lost when the container
is removed. Nothing here deploys on its own: this repo ships the Dockerfile
and `render.yaml`, but publishing to a host is always a manual step.

## Known limitations

- Browser microphone only (MediaRecorder, auto-stop at 30s, 15MB cap).
  No telephony: this demo cannot place or receive calls.
- Local file sessions only: transcripts, results, overrides, and the
  sign-off persist as JSON under `data/` (git-ignored, synthetic demo data
  only) and resume on reload. No accounts, no multi-device sync.
- The Hindi instruction lines (one per scenario, e.g.
  `Safai se pehle machine band karein aur power supply lock karein.`)
  are demo placeholders flagged `needs-human-review`; do not use them for
  real training until a fluent reviewer approves each one.
- Live Gnani integration requires an API key; without one, speech paths are
  covered by contract tests with a mocked upstream, not by real calls.
  Recognition is imperfect — e.g. one live round-trip heard "band karke" as
  "बैन कार के", correctly scored Not mentioned with a follow-up rather than
  a guessed match. Trainee corrections exist for exactly this reason.
  Related: Latin-script "band" is ambiguous for TTS and has rendered as
  "बैंड" (a strip/group — not "off"), via both `hi-IN`/`Nalini` and
  `hi-en`/`Poorvi`; the reviewed Devanagari text (बंद) round-trips
  correctly. The matcher deliberately does not treat बैंड as बंद.
- The evaluator is a local keyword/paraphrase heuristic (English +
  Devanagari + Latin-script Hindi, negation-aware). It can misread unusual
  phrasings — the supervisor's judgement is the actual decision.
