'use strict';
// Frontend contract (static inspection, no DOM deps): supervisor overrides are
// preserved alongside the machine result, empty input is never evaluated, at
// most one follow-up is shown, the scenario text mirrors the backend, the
// frontend carries no secrets, and no banned wording appears in the repo.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scenario = require('../lib/scenario');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('override preservation', () => {
  it('keeps a per-point override plus note in frontend state', () => {
    assert.match(appJs, /overrides:\s*\{/);
    assert.ok(appJs.includes("'switch-off'") && appJs.includes("'lock-power'"));
    assert.match(appJs, /override: ''.*note: ''/s);
  });

  it('shows the machine result next to the override and computes a Final line', () => {
    assert.ok(appJs.includes('machine-'));
    assert.ok(appJs.includes('Final for this point'));
    assert.match(appJs, /supervisor override; machine said/);
    assert.ok(appJs.includes('override, no machine result yet'));
  });

  it('offers "No override — keep machine result" as the default option', () => {
    assert.ok(appJs.includes('No override — keep machine result'));
  });

  it('preserves the supervisor note with the override', () => {
    assert.ok(appJs.includes('Supervisor note (preserved with the override)'));
  });

  it('index.html provides the machine-result, override, and transcript containers', () => {
    for (const id of ['sup-machine', 'sup-overrides', 'sup-state', 'sup-original-stt',
      'sup-original-edited', 'sup-followup-q', 'sup-followup-stt', 'sup-followup-edited']) {
      assert.ok(indexHtml.includes(`id="${id}"`), `missing #${id}`);
    }
  });

  it('keeps original STT and trainee corrections as separate fields', () => {
    assert.match(appJs, /stt: '', edited: ''/);
    assert.ok(appJs.includes('sup-original-edited'));
    assert.ok(appJs.includes('sup-followup-edited'));
  });
});

describe('empty input is never evaluated', () => {
  it('guards every submit path with a non-empty check', () => {
    assert.ok(appJs.includes('Nothing to review yet'));
    assert.ok(appJs.includes('Empty input is never evaluated'));
    assert.ok(count(appJs, '!text.trim()') >= 2, 'original + follow-up guards');
    assert.ok(count(appJs, '!combined') >= 1, 'supervisor re-evaluate guard');
  });

  it('treats empty STT as Empty state, not an evaluation', () => {
    assert.ok(appJs.includes('No speech was recognized'));
    assert.ok(appJs.includes("setRecState('empty')"));
  });
});

describe('single follow-up question', () => {
  it('renders at most one follow-up question element', () => {
    assert.equal(count(indexHtml, 'id="followup-question"'), 1);
    assert.match(appJs, /at most one follow-up/i);
    assert.match(appJs, /Single question element/);
  });
});

describe('scenario mirror', () => {
  it('frontend instruction and follow-ups match lib/scenario.js', () => {
    assert.ok(appJs.includes(scenario.instructionEN));
    assert.ok(appJs.includes(scenario.instructionHI.text));
    for (const p of scenario.requiredPoints) {
      assert.ok(appJs.includes(p.label), `missing label ${p.id}`);
      assert.ok(appJs.includes(p.followUp), `missing followUp ${p.id}`);
    }
  });

  it('index.html flags the Hindi line as needs-human-review placeholder', () => {
    assert.match(indexHtml, /needs human review/i);
  });
});

describe('no secrets in the frontend', () => {
  it('public/ carries no API keys or key headers', () => {
    for (const [name, text] of [['app.js', appJs], ['index.html', indexHtml]]) {
      assert.ok(!text.includes('GNANI_API_KEY'), `key name in ${name}`);
      assert.ok(!text.includes('X-API-Key-ID'), `key header in ${name}`);
    }
  });
});

describe('repo wording guardrails', () => {
  const files = [
    'package.json',
    'server.js',
    '.env.example',
    'lib/scenario.js',
    'lib/evaluate.js',
    'public/index.html',
    'public/app.js',
    'README.md',
  ];

  it('never claims certification or phone calls', () => {
    for (const f of files) {
      const p = path.join(root, f);
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      assert.ok(!/certified safe/i.test(text), `banned wording in ${f}`);
      assert.ok(!/phone.?call/i.test(text), `phone-call claim in ${f}`);
    }
  });

  it('.env.example holds placeholders only (no real key)', () => {
    const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    assert.match(env, /^GNANI_API_KEY=$/m);
  });

  it('the scenario registry also never claims certification or phone calls', () => {
    const text = fs.readFileSync(path.join(root, 'lib', 'scenarios.js'), 'utf8');
    assert.ok(!/certified safe/i.test(text), 'banned wording in lib/scenarios.js');
    assert.ok(!/phone.?call/i.test(text), 'phone-call claim in lib/scenarios.js');
  });
});

describe('scenario picker', () => {
  it('offers the same 3 scenarios in the trainee and supervisor views', () => {
    for (const id of ['scenario-select', 'sup-scenario-select']) {
      assert.ok(indexHtml.includes(`id="${id}"`), `missing #${id}`);
    }
    for (const option of ['machine-cleaning', 'ladder-safety', 'spill-response']) {
      assert.equal(count(indexHtml, `value="${option}"`), 2, `${option} in both pickers`);
    }
  });

  it('keeps both pickers in sync and confirms before a fresh turn set', () => {
    assert.match(appJs, /\$\('scenario-select'\)/);
    assert.match(appJs, /\$\('sup-scenario-select'\)/);
    assert.match(appJs, /function syncScenarioPickers/);
    assert.match(appJs, /function switchScenario/);
    assert.ok(appJs.includes('starts a fresh turn set'));
    assert.match(appJs, /window\.confirm/);
  });

  it('sends scenarioId with every evaluation and session create', () => {
    assert.match(appJs, /scenarioId: state\.scenarioId/);
    assert.match(appJs, /\/api\/sessions\?scenarioId=/);
  });

  it('mirrors every scenario instruction, label, and follow-up from the backend', () => {
    const { SCENARIOS } = require('../lib/scenarios');
    assert.equal(SCENARIOS.length, 3);
    for (const s of SCENARIOS) {
      assert.ok(appJs.includes(s.instructionEN), `missing EN for ${s.id}`);
      assert.ok(appJs.includes(s.instructionHI.text), `missing HI for ${s.id}`);
      for (const p of s.requiredPoints) {
        assert.ok(appJs.includes(p.label), `missing label ${p.id}`);
        assert.ok(appJs.includes(p.followUp), `missing followUp ${p.id}`);
      }
    }
  });

  it('every static $(...) id used in app.js exists in index.html', () => {
    const ids = [...appJs.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(ids.length > 0, 'expected static element lookups');
    for (const id of new Set(ids)) {
      assert.ok(indexHtml.includes(`id="${id}"`), `missing #${id}`);
    }
  });
});
