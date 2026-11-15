const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let api;
try { api = require('../node/openai-images.cjs'); } catch { api = {}; }
const fixture = () => fs.readFile(path.join(__dirname, 'fixtures/openai-reference.png'));
const factory = () => { assert.equal(typeof api.createOpenAIImagesRenderer, 'function', 'direct image adapter is missing'); return api.createOpenAIImagesRenderer; };
const route = { id: 'openaiImages', provider: 'openaiImages', model: 'gpt-image-2', credential: { apiKey: 'test-secret-not-real' } };

async function harness(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-openai-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const requests = [], usage = [], events = [], bytes = await fixture();
  const render = factory()({
    request: async (url, options) => { requests.push({ url, options }); return { data: [{ b64_json: bytes.toString('base64') }], usage: { input_tokens: 5, input_tokens_details: { text_tokens: 5, image_tokens: 0 }, output_tokens: 10 } }; },
    download: async () => { throw Error('unexpected download'); },
    recordUsage: row => usage.push(row), emit: row => events.push(row), ...extra,
  });
  const args = { route, prompt: 'A test mug', aspectRatio: '16:9', destPath: path.join(dir, 'result.png'), jobId: 'test-job', usageMeta: { category: 'image_generation' } };
  return { dir, render, requests, usage, events, bytes, args };
}

test('normal generation uses the official endpoint and exact requested model', async t => {
  const h = await harness(t); await h.render(h.args);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(h.requests[0].options.json.model, 'gpt-image-2');
  assert.equal(h.requests[0].options.json.n, 1);
  assert.deepEqual(await fs.readFile(h.args.destPath), h.bytes);
});

test('reference editing carries every local reference in multipart without input_fidelity', async t => {
  const h = await harness(t), ref = path.join(h.dir, 'ref.png'); await fs.writeFile(ref, h.bytes);
  await h.render({ ...h.args, referenceImagePaths: [ref, ref] });
  const r = h.requests[0];
  assert.equal(r.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(r.options.form.getAll('image[]').length, 2);
  assert.equal(r.options.form.get('model'), 'gpt-image-2');
  assert.equal(r.options.form.has('input_fidelity'), false);
});

test('remote references use the existing bounded downloader before edit submission', async t => {
  const calls = [], bytes = await fixture();
  const h = await harness(t, { download: async (url, dest, options) => { calls.push({ url, options }); await fs.writeFile(dest, bytes); } });
  await h.render({ ...h.args, referenceImageUrls: ['https://example.org/reference.png'] });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.maxBytes, 20 * 1024 * 1024);
  assert.equal(h.requests[0].options.form.getAll('image[]').length, 1);
});

test('Studio avatar URL in the paths array is downloaded and never dropped', async t => {
  const bytes = await fixture(), downloaded=[];
  const h = await harness(t, { download: async (url,dest)=>{downloaded.push(url);await fs.writeFile(dest,bytes);} });
  await h.render({...h.args,referenceImagePaths:['https://example.org/avatar.png']});
  assert.deepEqual(downloaded,['https://example.org/avatar.png']);
  assert.equal(h.requests[0].options.form.getAll('image[]').length,1);
});

test('unapproved model cannot create any provider request', async t => {
  const h = await harness(t);
  await assert.rejects(h.render({ ...h.args, route: { ...route, model: 'gpt-image-1' } }), /gpt-image-2/);
  assert.equal(h.requests.length, 0);
});

test('missing credential cannot create a provider request', async t => {
  const h = await harness(t);
  await assert.rejects(h.render({ ...h.args, route: { ...route, credential: {} } }));
  assert.equal(h.requests.length, 0);
});

test('too many references are refused before provider submission', async t => {
  const h = await harness(t);
  await assert.rejects(h.render({ ...h.args, referenceImagePaths: Array(17).fill(h.args.destPath) }));
  assert.equal(h.requests.length, 0);
});

test('missing local reference is not silently turned into generation', async t => {
  const h = await harness(t);
  await assert.rejects(h.render({ ...h.args, referenceImagePaths: [path.join(h.dir, 'missing.png')] }));
  assert.equal(h.requests.length, 0);
});

test('cancellation before submission performs no paid operation', async t => {
  const h = await harness(t), controller = new AbortController(); controller.abort();
  await assert.rejects(h.render({ ...h.args, signal: controller.signal }));
  assert.equal(h.requests.length, 0);
});

test('native ambiguous failure is preserved with no adapter retry', async t => {
  let attempts = 0; const error = Object.assign(Error('ambiguous'), { noFallback: true, noRetry: true });
  const h = await harness(t, { request: async () => { attempts++; throw error; } });
  await assert.rejects(h.render(h.args), value => value === error);
  assert.equal(attempts, 1); assert.equal(h.usage.length, 0);
});

test('invalid output is terminal and does not replace the original target', async t => {
  const h = await harness(t, { request: async () => ({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }) });
  await fs.writeFile(h.args.destPath, 'original');
  await assert.rejects(h.render(h.args), e => e.noFallback === true);
  assert.equal(await fs.readFile(h.args.destPath, 'utf8'), 'original');
});

test('successful usage and event metadata identify real OpenAI without secrets', async t => {
  const h = await harness(t); await h.render(h.args);
  assert.equal(h.usage.length, 1); assert.equal(h.usage[0].provider, 'openaiImages');
  assert.equal(h.usage[0].model, 'gpt-image-2'); assert.equal(h.usage[0].quantity, 1);
  assert.equal(h.events.length, 1);
  assert.equal(JSON.stringify({ usage: h.usage, events: h.events }).includes(route.credential.apiKey), false);
});

test('image route builder obeys saved order, availability and separate reference lane', () => {
  assert.equal(typeof api.wrapImageRoutes, 'function', 'image routing extension is missing');
  let enabled = true, lane, saved = ['fal', 'cliProxy', 'openaiImages'];
  const original = () => [{ id: 'cliProxy', provider: 'cli-proxy' }, { id: 'fal', provider: 'fal' }];
  const wrapped = api.wrapImageRoutes(original, {
    enabled: () => enabled, getCredential: (_id, pipeline) => { lane = pipeline; return route.credential; },
    order: (pipeline, rows) => rows.sort((a, b) => saved.indexOf(a.id) - saved.indexOf(b.id)),
  });
  assert.deepEqual(wrapped('x').map(x => x.id), saved); assert.equal(lane, 'images');
  wrapped('x', { referenceImageUrls: ['https://example.org/x.png'] }); assert.equal(lane, 'refedits');
  enabled = false; assert.deepEqual(wrapped('x').map(x => x.id), ['cliProxy', 'fal']);
});

test('thumbnail routes include OpenAI and migrate optional OpenLux into the saved list', () => {
  assert.equal(typeof api.wrapThumbnailRoutes, 'function', 'thumbnail routing extension is missing');
  const saved = ['openlux', 'cliProxy', 'openaiImages'];
  const wrapped = api.wrapThumbnailRoutes(() => [{ id: 'cliProxy', provider: 'cli-proxy' }], {
    enabled: () => true, openluxEnabled: () => true, getCredential: () => route.credential,
    order: (_lane, rows) => rows.sort((a, b) => saved.indexOf(a.id) - saved.indexOf(b.id)),
    readModel: () => null,
  });
  assert.deepEqual(wrapped({ refImageLocalPath: 'reference.png' }).map(x => x.id), saved);
});
