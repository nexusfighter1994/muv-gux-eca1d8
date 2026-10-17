'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { wrapPrepare, withVersion } = require('../node/segment-wordsync.cjs');

// Exact native SQL (stock 2026.10.13.7 chunk renderer).
const NATIVE_SQL = `UPDATE segments
       SET status = @status, output_path = @output_path, error = @error,
           attempt_count = @attempt_count, fallback_count = @fallback_count,
           provider_outputs_json = @provider_outputs_json,
           completed_at = @completed_at, updated_at = @updated_at
     WHERE id = @id`;

function fakeDb() {
  const writes = [];
  return { writes, prepare(sql) { return { sql, run: p => { writes.push(p); return { changes: 1 }; }, get: () => this.tag, all: () => [] }; }, tag: 'db' };
}

test('fresh-render segment write gains wordSyncVersion; other statements untouched', () => {
  const db = fakeDb();
  wrapPrepare(db, { version: 3 });
  db.prepare(NATIVE_SQL).run({ id: 's', status: 'succeeded', provider_outputs_json: JSON.stringify({ plannedType: 'custom_animation', smartOverlay: { a: 1 } }) });
  assert.deepEqual(JSON.parse(db.writes[0].provider_outputs_json), { wordSyncVersion: 3, plannedType: 'custom_animation', smartOverlay: { a: 1 } });
  db.prepare('UPDATE segments SET status = ? WHERE id = ?').run({ provider_outputs_json: '{}' });
  assert.equal(db.writes[1].provider_outputs_json, '{}');
  assert.equal(db.prepare(NATIVE_SQL).get(), 'db', 'other statement methods keep their binding');
});

test('existing version, failed JSON and missing outputs are left as they are', () => {
  assert.equal(JSON.parse(withVersion({ provider_outputs_json: '{"wordSyncVersion":2}' }, 3).provider_outputs_json).wordSyncVersion, 2);
  assert.equal(withVersion({ provider_outputs_json: 'not json' }, 3).provider_outputs_json, 'not json');
  assert.deepEqual(withVersion({ id: 1 }, 3), { id: 1 });
});

test('wrapping is idempotent', () => {
  const db = fakeDb();
  const a = wrapPrepare(db), b = wrapPrepare(db);
  assert.equal(a, b);
});

test('persisted installer: real writer gains the field; drift is fatal', () => {
  const py = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
src='let B=E(M,O)&&(!["text_overlay"].includes(M.type)||O.wordSyncVersion===NAe),D=O.smartOverlay||null;S.run({provider_outputs_json:JSON.stringify({plannedType:O.plannedType||M.type,finalType:O.finalType})})'
out=m.patch_node(src);assert m.patch_node(out)==out
assert 'JSON.stringify({/* vf-custom:segment-wordsync-v1 */wordSyncVersion:O.wordSyncVersion??NAe,plannedType:O.plannedType||M.type,' in out
try:
    m.patch_node(src.replace('O.wordSyncVersion===NAe','O.other===NAe'));raise SystemExit('drift accepted')
except RuntimeError: pass
print('ok')`;
  const out = execFileSync('python', ['-c', py, path.join(__dirname, '..', 'segment-wordsync-install.py')], { encoding: 'utf8' });
  assert.match(out, /ok/);
});
