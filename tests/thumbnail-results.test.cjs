const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const bundle = fs.readFileSync(process.env.VF_THUMBNAIL_BUNDLE || '/app/server/dist/index.mjs', 'utf8');
const anchor = bundle.indexOf('p("Fetching reference thumbnail")');
assert.ok(anchor >= 0, 'verified native thumbnail function anchor');
const start = bundle.lastIndexOf('async function ', anchor);
const end = bundle.indexOf('async function ', start + 15);
const source = bundle.slice(start, end);
assert.ok(source.includes('thumbnails_json') && source.includes('persistEach:c=!0'));
const name = /^async function (\w+)/.exec(source)[1];
const plain = value => JSON.parse(JSON.stringify(value));

async function run(results, initial = [], persistEach = true) {
  let saved = plain(initial);
  const writes = [], fields = [], errors = [];
  const c = {
    Nm: { mkdirSync() {}, statSync() { return {size: 100}; } },
    e5: () => results.length,
    Qe: { refThumbnailPath: () => '/reference.jpg' },
    lCs: async () => ({title: null}), EYe: () => [], pt: () => null,
    RFn: (_db, _id, value) => { saved = plain(value); writes.push(saved); },
    lt: async options => ({value: await options.execute()}),
    _Cs: async ({variant}) => {
      const value = results[variant.variant_id - 1];
      if (value instanceof Error) throw value;
      return value;
    },
    SCs: async () => null,
  };
  const db = {prepare(sql) { return sql.includes('SELECT * FROM chunks')
    ? {all: () => []} : {get: () => ({thumbnails_json: JSON.stringify(saved)})}; }};
  const ctx = {
    jobId: 'isolated-regression', db, emit: event => errors.push(event.message),
    updateFields: value => fields.push(plain(value)), setStageDetail() {}, checkAbort() {},
    nowIso: () => '', generationSnapshot: {},
    deps: {
      thumbnailBlueprintAnalyzer: async () => ({}),
      thumbnailPromptWriter: async () => ({variants: results.map((_, i) => ({variant_id: i + 1}))}),
    },
  };
  vm.createContext(c);
  vm.runInContext(source, c);
  const returned = await c[name]({ctx, intake: {videoTitle: 'Test'}, slug: 'test',
    refThumbnailUrl: 'https://www.youtube.com/watch?v=oPKLKgQKmes', persistEach});
  return {returned: plain(returned), saved, writes, fields, errors};
}

const good = {path: '/good.jpg', variantId: 3, title: 'Original native title', valid: true};
test('failed variants cannot discard a later successful image', async () => {
  const r = await run([null, null, good]);
  assert.deepEqual(r.returned, [good]);
  assert.deepEqual(r.saved, [good]);
  assert.equal(r.writes.length, 1);
});
test('all failed variants never persist null entries', async () => {
  const r = await run([null, null]);
  assert.deepEqual(r.returned, []);
  assert.deepEqual(r.writes, []);
});
test('old null and invalid entries do not poison valid images', async () => {
  const old = {path: '/old.jpg', title: 'Old native title'};
  const r = await run([good], [null, {}, old]);
  assert.deepEqual(r.returned, [good]);
  assert.deepEqual(r.saved, [old, good]);
});
test('normal success retains exact metadata and replaces duplicate path', async () => {
  const r = await run([good], [{...good, title: 'Previous title'}]);
  assert.deepEqual(r.returned, [good]);
  assert.deepEqual(r.saved, [good]);
  assert.deepEqual(r.fields, [{thumbnail_path: good.path}]);
});
test('regeneration without per-image persistence remains read-only', async () => {
  const r = await run([null, good], [], false);
  assert.deepEqual(r.returned, [good]);
  assert.deepEqual(r.writes, []);
});
test('pause propagates unchanged', async () => {
  const paused = Object.assign(new Error('paused'), {pauseRun: true});
  await assert.rejects(run([paused]), error => error === paused);
});
test('empty or non-string image paths are not persisted', async () => {
  const r = await run([{path: ''}, {path: 123}, {path: '  '}, good]);
  assert.deepEqual(r.returned, [good]);
  assert.deepEqual(r.saved, [good]);
});
