'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adapter = require(process.env.OI_MODULE || '../node/openai-images.cjs');

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 1)]);
function setup() {
  const calls = [], usage = [], events = [];
  const render = adapter.createOpenAIImagesRenderer({
    request: async (url, options) => { calls.push({ url, options }); return { data: [{ b64_json: PNG.toString('base64') }], usage: { total_tokens: 1 } }; },
    download: async () => { throw Error('no download expected'); },
    recordUsage: row => usage.push(row), emit: event => events.push(event),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-'));
  const route = model => ({ id: adapter.ID, provider: adapter.ID, model, credential: { apiKey: 'test-key' } });
  return { calls, usage, events, render, dir, route };
}

test('version and models', () => {
  assert.equal(adapter.VERSION, 'openai-images-v2');
  assert.equal(adapter.MODEL, 'gpt-image-2');
  assert.equal(adapter.TRANSPARENT_MODEL, 'gpt-image-2.5-flare');
});

test('an opaque request still uses gpt-image-2 and the same request shape', async () => {
  const t = setup(), dest = path.join(t.dir, 'a.png');
  const result = await t.render({ route: t.route('gpt-image-2'), prompt: 'p', destPath: dest, variant: 'low', jobId: 'j', usageMeta: { operation: 'x' } });
  assert.deepEqual(result, { provider: 'openaiImages', model: 'gpt-image-2' });
  assert.equal(t.calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.deepEqual(t.calls[0].options.json, { model: 'gpt-image-2', prompt: 'p', n: 1, size: '1536x1024', quality: 'low', output_format: 'png' });
  assert.equal(t.usage[0].model, 'gpt-image-2');
  assert.equal(t.events[0].message, 'Image completed on OpenAI directly (gpt-image-2).');
  assert.equal(t.events[0].data.model, 'gpt-image-2');
  assert.ok(fs.readFileSync(dest).equals(PNG));
});

test('a transparent request on the gpt-image-2 route is sent with gpt-image-2.5-flare', async () => {
  const t = setup(), dest = path.join(t.dir, 'b.png');
  const result = await t.render({ route: t.route('gpt-image-2'), prompt: 'p', destPath: dest, variant: 'low', background: 'transparent', outputFormat: 'png' });
  assert.deepEqual(result, { provider: 'openaiImages', model: 'gpt-image-2.5-flare' });
  assert.deepEqual(t.calls[0].options.json, { model: 'gpt-image-2.5-flare', prompt: 'p', n: 1, size: '1536x1024', quality: 'low', output_format: 'png', background: 'transparent' });
  assert.equal(t.usage[0].model, 'gpt-image-2.5-flare');
  assert.equal(t.usage[0].variant, 'low');
  assert.equal(t.events[0].message, 'Image completed on OpenAI directly (gpt-image-2.5-flare).');
});

test('an opaque background keeps gpt-image-2; a route that already names 2.5-flare is accepted', async () => {
  const t = setup();
  await t.render({ route: t.route('gpt-image-2'), prompt: 'p', destPath: path.join(t.dir, 'c.png'), background: 'opaque' });
  assert.equal(t.calls[0].options.json.model, 'gpt-image-2');
  assert.equal(t.calls[0].options.json.background, 'opaque');
  await t.render({ route: t.route('gpt-image-2.5-flare'), prompt: 'p', destPath: path.join(t.dir, 'd.png') });
  assert.equal(t.calls[1].options.json.model, 'gpt-image-2.5-flare');
});

test('other models, other providers and transparent JPEG are refused before any request', async () => {
  const t = setup();
  await assert.rejects(t.render({ route: t.route('gpt-image-1'), prompt: 'p', destPath: path.join(t.dir, 'e.png') }), /only supports gpt-image-2 and gpt-image-2\.5-flare/);
  await assert.rejects(t.render({ route: { ...t.route('gpt-image-2'), provider: 'fal' }, prompt: 'p', destPath: path.join(t.dir, 'f.png') }), /only supports/);
  await assert.rejects(t.render({ route: t.route('gpt-image-2'), prompt: 'p', destPath: path.join(t.dir, 'g.jpg'), background: 'transparent' }), /Transparent images require PNG or WebP/);
  assert.equal(t.calls.length, 0);
});

test('a refusal from OpenAI keeps its HTTP status so the next route can take over', async () => {
  const calls = [];
  const render = adapter.createOpenAIImagesRenderer({
    request: async () => { calls.push(1); throw Object.assign(Error('HTTP 403: model not available test-key'), { code: 'http_403', detail: { status: 403 } }); },
    download: async () => {}, recordUsage: () => {},
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-'));
  await assert.rejects(render({ route: { provider: adapter.ID, model: 'gpt-image-2', credential: { apiKey: 'test-key' } }, prompt: 'p', destPath: path.join(dir, 'h.png'), background: 'transparent' }),
    error => error.noFallback !== true && error.message.includes('test-key') === false);
  assert.equal(calls.length, 1);
});
