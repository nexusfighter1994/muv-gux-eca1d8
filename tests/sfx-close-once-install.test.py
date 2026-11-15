import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
# Exact native shape from the live bundle (dist/index.mjs, 2026-11-05 build), function V_o.
NATIVE = ('async function V_o({placements:e,totalSec:t,outputPath:r,signal:n,timeoutMs:o=600*1e3,run:i=Ke,pack:s,dir:a}){'
          'let c=await LBa(e,{...s?{pack:s}:{},...a?{dir:a}:{},signal:n});kU.mkdirSync(q_o.dirname(r),{recursive:!0});'
          'let l=q_o.join(OBa.tmpdir(),`vf-sfx-stem-${G_o.randomUUID()}.s16`),u=`${r}.${G_o.randomUUID()}.m4a`,d=kU.openSync(l,"w");'
          'try{let p=BBa({placements:e,sounds:c,totalSec:t,write:f=>kU.writeSync(d,Buffer.from(f.buffer,f.byteOffset,f.byteLength))});'
          'return kU.closeSync(d),await i(["-f","s16le","-ar",String(JTe),"-ac","2","-i",l,"-c:a","aac","-b:a","192k","-ar",String(JTe),'
          '"-ac","2","-movflags","+faststart",u],{signal:n,timeoutMs:o}),kU.renameSync(u,r),{outputPath:r,placed:p.spans,frames:p.frames}}'
          'finally{try{kU.closeSync(d)}catch{}kU.rmSync(l,{force:!0}),kU.rmSync(u,{force:!0})}}')

HARNESS = r'''
const assert=require("node:assert/strict");
const log=[];let nextFd=40;const open=new Set();
const kU={mkdirSync(){},openSync(p){const fd=nextFd++;open.add(fd);log.push(["open",fd]);return fd},
  writeSync(fd){assert.ok(open.has(fd),"write on closed fd")},
  closeSync(fd){log.push(["close",fd]);if(!open.delete(fd)){const e=new Error("EBADF");e.code="EBADF";throw e}},
  renameSync(){log.push(["rename"])},rmSync(){}};
const q_o={dirname:()=>"/x",join:(...a)=>a.join("/")},OBa={tmpdir:()=>"/tmp"},G_o={randomUUID:()=>"u"};
const JTe=48000,Ke=null;let mixThrows=false;
async function LBa(){return new Map()}
function BBa({write}){if(mixThrows)throw new Error("mix failed");write(new Int16Array(4));return {spans:1,frames:4}}
SOURCE
(async()=>{
  // success: the stem fd is closed exactly once, and a socket that reuses the number during ffmpeg survives
  let socket;
  const out=await V_o({placements:[],totalSec:1,outputPath:"/x/o.m4a",run:async()=>{socket=nextFd-1;open.add(socket);log.push(["socket-reuses",socket])}});
  assert.equal(out.placed,1);
  assert.equal(log.filter(x=>x[0]==="close").length,EXPECT_SUCCESS_CLOSES);
  assert.equal(open.has(socket),EXPECT_SOCKET_ALIVE);
  // mix failure before the first close: still closed exactly once
  log.length=0;mixThrows=true;
  await assert.rejects(V_o({placements:[],totalSec:1,outputPath:"/x/o.m4a",run:async()=>{}}),/mix failed/);
  assert.equal(log.filter(x=>x[0]==="close").length,1);
  assert.equal([...open].filter(fd=>fd!==socket).length,0);
  console.log("ok");
})().catch(e=>{console.error(e);process.exit(1)});
'''


class Installation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = {}
        source = ROOT / 'sfx-close-once-install.py'
        exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), cls.module)

    def run_js(self, source, closes, alive):
        program = HARNESS.replace('SOURCE', source).replace('EXPECT_SUCCESS_CLOSES', str(closes)).replace(
            'EXPECT_SOCKET_ALIVE', json.dumps(alive))
        return subprocess.run(['node', '-e', program], capture_output=True, text=True)

    def test_native_shape_reproduces_the_stale_close(self):
        result = self.run_js(NATIVE, 2, False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_patched_closes_once_and_spares_the_reused_fd(self):
        patched = self.module['patch_node'](NATIVE)
        self.assertIn(self.module['MARKER'], patched)
        result = self.run_js(patched, 1, True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_idempotent(self):
        once = self.module['patch_node'](NATIVE)
        self.assertEqual(self.module['patch_node'](once), once)

    def test_missing_or_ambiguous_site_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'missing or ambiguous'):
            self.module['patch_node']('function x(){}')
        with self.assertRaisesRegex(RuntimeError, 'missing or ambiguous'):
            self.module['patch_node'](NATIVE + NATIVE.replace('V_o', 'V_p'))

    def test_only_the_two_close_sites_change(self):
        patched = self.module['patch_node'](NATIVE)
        marker = self.module['MARKER']
        expected = NATIVE.replace('return kU.closeSync(d),await i(',
                                  'return ' + marker + '(()=>{const vfFd=d;d=-1;kU.closeSync(vfFd)})(),await i(').replace(
            'finally{try{kU.closeSync(d)}catch{}', 'finally{try{d>=0&&kU.closeSync(d)}catch{}')
        self.assertEqual(patched, expected)


if __name__ == '__main__':
    unittest.main()
