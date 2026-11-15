'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const file = path.join(os.tmpdir(), 'vf-siglip-cap-test-' + process.pid + '.json');
process.env.VF_SIGLIP_CANDIDATE_CAP_FILE = file;
const headroom = require(process.env.SC_HEADROOM || '../node/siglip-recovery-headroom.cjs');

function run(capacity = 8, count = 20) {
  const scopes = new Map(); let n = 0, seq = 0;
  const waiters = Array.from({ length: count }, () => ({ resourceKey: 'siglip', homeKind: 'siglip-home-candidate', jobId: 'job', priority: 1, seq: seq++ }));
  const queue = headroom.install({ drain() {}, stats: () => ({ admitted: 0 }) }, { getState: () => ({ waiters }), getCapacity: () => capacity, scopes,
    newNonce: () => 'n' + (++n), claim: w => { waiters.splice(waiters.indexOf(w), 1); } });
  queue.drain();
  return { queue, candidates: [...scopes.values()].filter(s => s.candidate).length };
}
test.after(() => { try { fs.unlinkSync(file); } catch {} });

test('no cap file: 2 candidates as before', () => {
  try { fs.unlinkSync(file); } catch {}
  const r = run();
  assert.equal(r.candidates, 2);
  assert.equal(r.queue.stats().candidateCap, 2);
});
test('cap file 5: 5 candidates, reported in the stats; never above the Home capacity', () => {
  fs.writeFileSync(file, '{"cap":5}');
  const r = run();
  assert.equal(r.candidates, 5);
  assert.equal(r.queue.stats().candidateCap, 5);
  assert.equal(r.queue.stats().candidateActive, 5);
  fs.writeFileSync(file, '{"cap":12}');
  assert.equal(run(3).candidates, 3);
});
test('invalid cap file: 2', () => {
  for (const bad of ['{"cap":0}', '{"cap":13}', '{"cap":"4"}', 'x']) { fs.writeFileSync(file, bad); assert.equal(run().candidates, 2, bad); }
});
test('reader is cached for one second', () => {
  let text = '{"cap":3}', time = 0;
  const read = headroom.createCandidateCap({ now: () => time, read: () => text });
  assert.equal(read(), 3); text = '{"cap":6}'; time = 999; assert.equal(read(), 3); time = 1000; assert.equal(read(), 6);
});
