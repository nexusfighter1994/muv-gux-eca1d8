'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createProcScan, readProcTable, readPss, PAGE_BYTES } = require('../node/proc-scan-cache.cjs');

// Fake /proc with the native stat layout (comm may contain spaces and parentheses).
function fakeFs(procs, { pss = {} } = {}) {
  const reads = { dir: 0, stat: 0 };
  return { reads, readdirSync(p) { assert.equal(p, '/proc'); reads.dir++; return [...Object.keys(procs), 'self', 'meminfo']; },
    readFileSync(p) {
      const m = p.match(/^\/proc\/(\d+)\/(stat|smaps_rollup)$/);
      if (!m || !procs[m[1]]) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
      if (m[2] === 'smaps_rollup') { if (pss[m[1]] == null) throw Error('EACCES'); return `Rss: 1 kB\nPss:   ${pss[m[1]]} kB\n`; }
      reads.stat++;
      const { ppid, rss, comm = 'node' } = procs[m[1]];
      // proc(5): after ') ' index 0 = state, 1 = ppid ... 20 = vsize, 21 = rss (pages).
      const fields = ['S', ppid, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, 100, 1000, rss];
      return `${m[1]} (${comm}) ${fields.join(' ')} 0 0`;
    } };
}

test('table matches the native layout: pid, ppid, rss pages x 4096; odd comm names', () => {
  const fs = fakeFs({ 10: { ppid: 1, rss: 100 }, 11: { ppid: 10, rss: 50, comm: 'chrome (renderer) x' } });
  assert.deepEqual(readProcTable(fs), [
    { pid: 10, ppid: 1, rssBytes: 100 * PAGE_BYTES }, { pid: 11, ppid: 10, rssBytes: 50 * PAGE_BYTES }]);
  assert.equal(readProcTable({ readdirSync() { throw Error('no proc'); } }), null);
});

test('one /proc scan per ttl; a later call rescans', () => {
  let t = 1000;
  const fs = fakeFs({ 10: { ppid: 1, rss: 100 }, 11: { ppid: 10, rss: 50 } });
  const scan = createProcScan({ ttlMs: 500, now: () => t, fsImpl: fs });
  const a = scan.table(); t += 100; const b = scan.table(); t += 399; scan.table();
  assert.equal(a, b);
  assert.equal(fs.reads.dir, 1);
  t += 1; scan.table();
  assert.equal(fs.reads.dir, 2);
  assert.deepEqual(scan.stats, { scans: 2, hits: 2 });
  t -= 5000; scan.table();
  assert.equal(fs.reads.dir, 3, 'clock going backwards rescans');
});

test('PSS like native: kB to bytes, unreadable -> null', () => {
  const fs = fakeFs({ 10: { ppid: 1, rss: 1 } }, { pss: { 10: 2048 } });
  assert.equal(readPss(10, fs), 2048 * 1024);
  assert.equal(readPss(99, fs), null);
});

test('installer wires both native hooks once; drift is fatal', () => {
  const py = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
src='function Xva(){if(q5t)return q5t();if(process.platform==="linux"){let e=Vva();if(e)return e}return Yva()}function Wva(e){if(SOn)return SOn(e);if(q5t||process.platform!=="linux")return null;try{let r=z5t.readFileSync(\`/proc/\${e}/smaps_rollup\`,"utf8")}catch{return null}}var MOn=P(()=>{qte=null,Hve=null,q5t=null,SOn=null;Fva.subscribe(Uva,e=>{})});'
out=m.patch_node(src);assert m.patch_node(out)==out
assert 'q5t=__vfCustom.procScanTable??null,SOn=__vfCustom.procScanPss??null;' in out, out
try:
    m.patch_node(src.replace('if(q5t||process','if(x5t||process'));raise SystemExit('drift accepted')
except RuntimeError: pass
print('ok')`;
  assert.match(execFileSync('python', ['-c', py, path.join(__dirname, '..', 'proc-scan-cache-install.py')], { encoding: 'utf8' }), /ok/);
});
