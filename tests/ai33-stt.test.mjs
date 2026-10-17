import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(process.env.STT_BUNDLE, 'utf8');
const start = source.lastIndexOf('async function ', source.indexOf('n.append("tag_audio_events","false")'));
const end = source.indexOf('async function ', start + 15);
const body = source.slice(start, end);
assert.match(body, /OpenSpeaker speech-to-text did not return a task_id/);
function nativeFunction(name) {
  const at = source.indexOf(`function ${name}(`);
  return source.slice(at, source.indexOf('function ', at + 10));
}
const words = [
  { text: 'Test', type: 'word', start: 0.12, end: 0.56 },
  { text: 'sentence', type: 'word', start: 0.65, end: 1.4 },
];
const transcript = { language_code: 'eng', text: 'Test sentence', words };

async function transcribe(payload, options = {}) {
  const requests = [];
  const warnings = [];
  class ProviderError extends Error {
    constructor({ message, ...fields }) { super(message); Object.assign(this, fields); }
  }
  const context = vm.createContext({
    FormData,
    E4: { openAsBlob: async () => new Blob(['test']) },
    ube: { basename: () => 'test.mp3' },
    Kt: async url => {
      requests.push(url);
      if (url.endsWith('/speech-to-text')) return { task_id: 'accepted-original-task' };
      return payload;
    },
    i1: 'https://api.openspeaker.ai',
    De: ProviderError,
    Date,
    Rdn: () => ({ firstWindowMs: 300000, hardWindowMs: 300000 }),
    Ya: async () => {},
    Idn: 5000,
    pHi: async () => {
      if (options.pollError) throw options.pollError;
      return { status: 'done', metadata: { json_url: 'https://result.invalid/transcript.json' } };
    },
    _Nt: Symbol('accepted-task'),
    Le: { warn: message => warnings.push(message) },
    k8e: () => { throw new Error('Do not fabricate timings in this regression test'); },
    SNt: () => false,
    O8e: error => error,
  });
  vm.runInContext(nativeFunction('ENt') + nativeFunction('wNt'), context);
  const call = vm.runInContext(`(${body})`, context);
  const result = await call({ audioPath: '/test.mp3', durationSec: 2, apiKey: 'fake-test-key' });
  return { result: JSON.parse(JSON.stringify(result)), requests, warnings };
}

test('AI33 singleton envelope preserves real transcript and word timings', async () => {
  const { result, requests } = await transcribe([transcript]);
  assert.equal(result.text, transcript.text);
  assert.deepEqual(result.words, words.map(w => ({ word: w.text, start: w.start, end: w.end })));
  assert.equal(result.durationSec, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => !url.includes('replicate')));
});

test('original object-shaped AI33 response still works', async () => {
  const { result } = await transcribe(transcript);
  assert.equal(result.text, transcript.text);
  assert.equal(result.words.length, 2);
});

test('response and timings are never modified in place', async () => {
  const packet = JSON.parse(JSON.stringify([transcript]));
  const before = JSON.stringify(packet);
  await transcribe(packet);
  assert.equal(JSON.stringify(packet), before);
});

for (const [name, payload] of [
  ['empty envelope', []],
  ['ambiguous multi-transcript envelope', [transcript, transcript]],
  ['singleton without transcript', [{}]],
]) {
  test(`${name} retains native empty-transcript error`, async () => {
    await assert.rejects(transcribe(payload), error => error.code === 'empty_transcript');
  });
}

test('accepted-task polling failure is not silently converted into another submission', async () => {
  const error = new Error('status unavailable');
  await assert.rejects(transcribe([transcript], { pollError: error }), failure => failure === error);
});
