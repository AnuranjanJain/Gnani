'use strict';
// Verifies the WAV encoder embedded in public/app.js produces valid 16-bit
// mono WAV bytes. Extracts encodeWavPcm16 by balanced-brace scan and runs it
// in isolation (pure ArrayBuffer/DataView code, no DOM needed).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} present in app.js`);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

const encodeWavPcm16 = new Function(
  `${extractFunction(appJs, 'encodeWavPcm16')}; return encodeWavPcm16;`,
)();

describe('encodeWavPcm16 (from public/app.js)', () => {
  it('writes a valid 44-byte RIFF header for 16kHz mono PCM16', () => {
    const buf = Buffer.from(encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000));
    assert.equal(buf.length, 44 + 5 * 2);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.readUInt32LE(4), 36 + 10);
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
    assert.equal(buf.readUInt32LE(16), 16);
    assert.equal(buf.readUInt16LE(20), 1); // PCM
    assert.equal(buf.readUInt16LE(22), 1); // mono
    assert.equal(buf.readUInt32LE(24), 16000);
    assert.equal(buf.readUInt32LE(28), 16000 * 2);
    assert.equal(buf.toString('ascii', 36, 40), 'data');
    assert.equal(buf.readUInt32LE(40), 10);
  });

  it('scales and clamps float samples to int16', () => {
    const buf = Buffer.from(
      encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]), 16000),
    );
    const s = [0, 1, 2, 3, 4, 5, 6].map((i) => buf.readInt16LE(44 + i * 2));
    assert.deepEqual(s, [0, 0x3fff, -0x4000, 0x7fff, -0x8000, 0x7fff, -0x8000]);
  });
});

describe('wav upload path (static)', () => {
  it('transcodes recordings and names wav uploads answer.wav', () => {
    assert.ok(appJs.includes('transcodeToWav'));
    assert.ok(appJs.includes('decodeAudioData'));
    assert.ok(appJs.includes('answer.wav'));
  });
});
