'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const reuse = require('../node/broll-reuse.cjs');

// Native checkpoint hash (GM/WCt in the stock bundle).
const W = e => (Array.isArray(e) ? e.map(W) : !e || typeof e !== 'object' ? e : Object.fromEntries(Object.keys(e).sort().map(k => [k, W(e[k])])));
const GM = e => crypto.createHash('sha256').update(JSON.stringify({ version: 1, input: W(e) })).digest('hex');
// Native R3t shape: slow-to-fit keeps the pick's range, otherwise unchanged window.
const fit = (pick, d, allowSlow) => {
  const span = pick.endSec - pick.startSec;
  return allowSlow && span < d * 0.9 && span >= d * 0.65 - 0.05
    ? { startSec: pick.startSec, endSec: pick.endSec, extended: false, slowed: true, slowFactor: Math.round(d / span * 1e4) / 1e4 }
    : { startSec: pick.startSec, endSec: pick.endSec, extended: false, slowed: false };
};
const pick = { videoUrl: 'https://v/1', startSec: 10, endSec: 14.5, score: 0.9 };
const base = { best: pick, durationSec: 4, outputPath: '/data/seg-5.mp4', creditAuthor: true };

test('real uBn inputs (verify, slow-to-fit window) are recognised; other picks/settings are not', () => {
  assert.ok(reuse.finalMatches({ hash: GM({ ...base, verify: 1 }), GM, ...base, fit }));
  const slowPick = { ...pick, endSec: 13 };
  const slowed = { ...base, best: slowPick, window: { startSec: 10, endSec: 13 }, slow: Math.round(4 / 3 * 1e4) / 1e4, verify: 1 };
  assert.ok(reuse.finalMatches({ hash: GM(slowed), GM, ...base, best: slowPick, fit }));
  // Without a fit function the window comes from the recorded final output.
  const output = { outputPath: base.outputPath, usedStartSec: 10, usedEndSec: 13 };
  assert.ok(reuse.finalMatches({ hash: GM(slowed), GM, ...base, best: slowPick, output }));
  assert.ok(!reuse.finalMatches({ hash: GM({ ...base, verify: 1 }), GM, ...base, creditAuthor: false, fit }), 'credit setting changed -> render again');
  assert.ok(!reuse.finalMatches({ hash: GM({ ...base, verify: 1 }), GM, ...base, best: { ...pick, videoUrl: 'https://v/2' }, fit }));
  assert.ok(!reuse.finalMatches({ hash: GM({ ...base, verify: 1 }), GM, ...base, outputPath: '/data/other.mp4', fit }));
  assert.ok(!reuse.finalMatches({ hash: 'x', GM, ...base, best: null }));
});

test('persisted hook parses the stored final output', () => {
  const hash = GM({ ...base, verify: 1 });
  assert.equal(reuse.brollFinalReuse({ hash, GM, ...base, outputJson: '{"outputPath":"/data/seg-5.mp4"}', fit, verify: 1 }), true);
  assert.equal(reuse.brollFinalReuse({ hash, GM, ...base, outputJson: 'not json', fit, verify: 1 }), true);
  assert.equal(reuse.brollFinalReuse({ hash: GM(base) + 'x', GM, ...base, fit }), false);
});

const NATIVE_SQL = `SELECT operation, input_hash, output_json
       FROM operation_checkpoints
       WHERE job_id = ? AND scope_type = 'segment' AND scope_id = ?
         AND namespace = ?
         AND operation IN ('selected_source', 'final_video', 'treatment')
         AND status = 'succeeded'`;

function fakeDb(rows, segment) {
  return { prepare(sql) { return { sql, all: () => rows, get: () => (sql.includes('FROM segments') ? segment : 'other'), run: () => ({ changes: 0 }) }; } };
}

test('hot wrapper: stored real variant is returned with the canonical native hash for its creditAuthor', () => {
  const finalRow = { operation: 'final_video', input_hash: GM({ ...base, verify: 1 }), output_json: JSON.stringify({ outputPath: base.outputPath }) };
  const rows = [{ operation: 'selected_source', input_hash: 'h', output_json: JSON.stringify(pick) }, finalRow];
  const segment = { duration_sec: 4, output_path: base.outputPath, provider_outputs_json: '{"finalType":"b_roll_video"}' };
  const db = fakeDb(rows, segment);
  const stats = reuse.wrapPrepare(db, { GM, fit });
  const out = db.prepare(NATIVE_SQL).all('job', 'seg', 'b_roll_video');
  assert.equal(out.find(r => r.operation === 'final_video').input_hash, GM(base), 'native E() now matches');
  assert.notEqual(out.find(r => r.operation === 'final_video').input_hash, GM({ ...base, creditAuthor: false }));
  assert.equal(finalRow.input_hash, GM({ ...base, verify: 1 }), 'stored row object untouched');
  assert.equal(stats.normalized, 1);
  assert.deepEqual(db.prepare(NATIVE_SQL).all('job', 'seg', 'b_roll_image'), rows, 'b_roll_image untouched');
  assert.equal(db.prepare('SELECT 1').get(), 'other', 'other statements untouched');
  assert.equal(reuse.wrapPrepare(db, { GM }), stats, 'idempotent');
});

test('hot wrapper: smart-overlay base path is the native outputPath; unknown hashes stay as they are', () => {
  const smart = { ...base, outputPath: '/data/seg-5.base.mp4' };
  const rows = [{ operation: 'selected_source', output_json: JSON.stringify(pick) }, { operation: 'final_video', input_hash: GM({ ...smart, verify: 1 }), output_json: '{}' }];
  const db = fakeDb(rows, { duration_sec: 4, output_path: '/data/seg-5.mp4', provider_outputs_json: JSON.stringify({ smartOverlay: { baseOutputPath: smart.outputPath } }) });
  reuse.wrapPrepare(db, { GM, fit });
  assert.equal(db.prepare(NATIVE_SQL).all('j', 's', 'b_roll_video')[1].input_hash, GM(smart));
  const other = [{ operation: 'selected_source', output_json: JSON.stringify(pick) }, { operation: 'final_video', input_hash: 'unknown', output_json: '{}' }];
  const db2 = fakeDb(other, { duration_sec: 4, output_path: base.outputPath });
  reuse.wrapPrepare(db2, { GM, fit });
  assert.equal(db2.prepare(NATIVE_SQL).all('j', 's', 'b_roll_video')[1].input_hash, 'unknown');
});

test('stable selected_source input ignores bookkeeping columns only', () => {
  const row = { id: 'c1-segment-5', type: 'b_roll_video', context: 'storm', srt_segment: 'x', duration_sec: 4, status: 'pending', output_path: null,
    error: null, attempt_count: 0, fallback_count: 0, provider_outputs_json: null, started_at: null, completed_at: null, created_at: 'a', updated_at: 'b' };
  const later = { ...row, status: 'succeeded', output_path: '/o.mp4', attempt_count: 2, provider_outputs_json: '{"x":1}', started_at: 'c', completed_at: 'd', updated_at: 'e' };
  assert.equal(GM({ segment: reuse.stableSegmentInput(row) }), GM({ segment: reuse.stableSegmentInput(later) }));
  assert.notEqual(GM({ segment: reuse.stableSegmentInput(row) }), GM({ segment: reuse.stableSegmentInput({ ...row, context: 'fire' }) }));
  assert.equal(reuse.stableSegmentInput(null), null);
  assert.equal(row.status, 'pending', 'input not mutated');
});

// Synthetic stock fragments with the exact native shapes (2026.10.13.7).
const NATIVE = `const P=(f,r)=>()=>(f&&(r=f(f=0)),r);
function GM(e){const W=e=>Array.isArray(e)?e.map(W):!e||typeof e!="object"?e:Object.fromEntries(Object.keys(e).sort().map(t=>[t,W(e[t])]));return require("node:crypto").createHash("sha256").update(JSON.stringify({version:1,input:W(e)})).digest("hex")}
function kWe(o){return o}function TWe(){return null}
function R3t(e,t,{allowSlow:r=!0}={}){let a=e.endSec-e.startSec;return r&&a<t*.9&&a>=t*.65-.05?{startSec:e.startSec,endSec:e.endSec,extended:!1,slowed:!0,slowFactor:Math.round(t/a*1e4)/1e4}:{startSec:e.startSec,endSec:e.endSec,extended:!1,slowed:!1}}
async function uBn({job:e,slug:t,chunkNumber:r,segment:n,videoBrief:o,language:i,usedBroll:a,brollClaims:s,generationSnapshot:l=null,outputPath:c=null,deps:u={}}={}){if(!t)throw new Error('brollVideo.renderSegment: "slug" is required');let{revision_no:v,selected_revision_id:x,...w}=n,R={segment:w,videoBrief:o,language:i};let ee=u.pick,F=4,q=!0,j=!1,G=!0;let J=R3t(ee,F,{allowSlow:q}),te=!j&&Array.isArray(ee?.alternates);return{R,final:{best:ee,durationSec:F,outputPath:c,creditAuthor:!0,...J.extended||J.slowed?{window:{startSec:J.startSec,endSec:J.endSec}}:{},...J.slowed?{slow:J.slowFactor}:{},...G?{verify:R1a}:{}}}}
var lBn,R1a,M3t,oxe=P(()=>{lBn=2,R1a=1;M3t={renderSegment:uBn}});
function cv(n,o,i,M,N,I){return{operation:"selected_source",operationOrder:I,input:{segment:n,videoBrief:o,language:i,...M?{footageTopic:M}:{},...N?{translationPin:N}:{}}}}
function E(L,M,G){let $="b_roll_video",F=L.find(J=>J.operation==="selected_source"),z=L.find(J=>J.operation==="final_video"),j=JSON.parse(F.output_json),Y=M.duration_sec,V=M.output_path,Z=!1,H=null,p=null,K=$==="b_roll_image"?kWe({selected:j,durationSec:Y,targetPath:V,creditAuthor:G,imageMotionSmart:Z,tempo:TWe(M),treatment:H,snapshot:p}):{best:j,durationSec:Y,outputPath:V,creditAuthor:G};if(z.input_hash===GM(K))return!0;return!1}
return{uBn,cv,E,oxe};`;

function installer(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-broll-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.js'), src);
    const py = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
src=open(sys.argv[2],encoding='utf8').read()
try:
    out=m.patch_node(src)
except RuntimeError as e:
    print('DRIFT',e);raise SystemExit(0)
assert m.patch_node(out)==out
open(sys.argv[3],'w',encoding='utf8').write(out);print('ok')`;
    const res = execFileSync('python', ['-c', py, path.join(__dirname, '..', 'broll-reuse-install.py'), path.join(dir, 'in.js'), path.join(dir, 'out.js')], { encoding: 'utf8' });
    return res.startsWith('ok') ? fs.readFileSync(path.join(dir, 'out.js'), 'utf8') : res;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const load = (src, custom) => new Function('__vfCustom', 'require', src)(custom, require);

test('persisted installer: patched native E() keeps the real b-roll final; drift is fatal', async () => {
  const patched = installer(NATIVE);
  assert.match(patched, /vf-custom:broll-reuse-v1/);
  assert.match(patched, /vf-custom:broll-stable-input-v1/);
  const stock = load(NATIVE, {}), mod = load(patched, reuse);
  mod.oxe(); // uBn only runs after the b-roll module init (dispatcher import)
  for (const best of [pick, { ...pick, endSec: 13 }]) {
    const real = (await mod.uBn({ slug: 's', segment: { id: 'x' }, outputPath: base.outputPath, deps: { pick: best } })).final;
    const rows = [{ operation: 'selected_source', output_json: JSON.stringify(best) }, { operation: 'final_video', input_hash: GM(real), output_json: '{}' }];
    const segment = { duration_sec: 4, output_path: base.outputPath };
    assert.equal(stock.E(rows, segment, true), false, 'stock check misses the real input');
    assert.equal(mod.E(rows, segment, true), true, 'patched check keeps it');
    assert.equal(mod.E(rows, segment, false), false, 'changed credit setting still renders');
  }
  const a = await mod.uBn({ slug: 's', segment: { id: 'x', context: 'c', status: 'pending', updated_at: '1', revision_no: 0 }, deps: { pick } });
  const b = await mod.uBn({ slug: 's', segment: { id: 'x', context: 'c', status: 'rendering', updated_at: '2', revision_no: 0 }, deps: { pick } });
  assert.equal(GM(a.R), GM(b.R), 'b-roll selected_source survives bookkeeping changes');
  assert.equal(GM(mod.cv({ id: 'x', status: 'a' }).input), GM(mod.cv({ id: 'x', status: 'b' }).input), 'composite_video too');
  assert.deepEqual(load(patched, {}).cv({ id: 'x', status: 'a' }).input.segment, { id: 'x', status: 'a' }, 'missing layer keeps native input');
  assert.match(installer(NATIVE.replace('if(z.input_hash===GM(K))return!0;', 'if(z.input_hash==GM(K))return!0;')), /^DRIFT/);
  assert.match(installer(NATIVE.replace('...G?{verify:R1a}:{}', '')), /^DRIFT/);
});
