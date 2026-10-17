import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
NATIVE = '''function Axt(e){return jp.get(e)?.priority??lxt}
function pX(e){let t=AM.get(e);return t}
function XBe(e,t,r,n=e,o=Axt(t)){let i=pX(e),a=pv.get(e);return null}
async function fbi(e){let t=pX(e);if(t.waiters.length===0){t.memoryBlocked=false;t.memoryWait=null;return}let r=KBe(e);}
async function $xa({key:e,opKey:t=null,quality:r=null,lane:n,jobId:o=null}={}){return true}
function fxt(e){ZBe=typeof e=="function"?e:pxt}
fxt($xa);
'''
LEGACY_HOOK = '''
/* vf-custom:render-memory-fairness-v1 */;try{$xa=__vfCustom.wrapRenderMemoryGate($xa,()=>{const s=pX("render");return {render:s,waitingSinceMs:Date.parse(s.memoryWait?.waitingSinceIso),hasReadyRender:s.waiters.some(w=>["frameshift","remotion"].includes(w.resourceKey)&&XBe("render",w.jobId,KBe("render"),w.resourceKey,w.priority)===null)}});fxt($xa);__vfCustom.report("renderMemoryFairness",true)}catch(e){__vfCustom.report("renderMemoryFairness",false,String(e))}
'''


class Installation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = {}
        source = ROOT / 'render-memory-install.py'
        exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), cls.module)

    def patch(self, text=NATIVE):
        return self.module['patch_node'](text)

    def run_hook(self, setup='', checks=''):
        hook = self.patch()[len(NATIVE):]
        program = '''const assert=require('node:assert/strict');
        const jp=new Map([['younger',{priority:'1',demand:{render:{exact:99}}}],
          ['oldest',{priority:'0',demand:{render:{exact:0}}}]]);
        const s={activeTotal:0,waiters:[{jobId:'oldest',priority:'0',resourceKey:'remotion'}],
          memoryWait:{reasonKey:'live_headroom',waitingSinceIso:new Date(0).toISOString()}};
        const blocked=new Set(),pX=()=>s,KBe=()=>5;
        const XBe=(lane,id)=>blocked.has(id)?'resource':null;
        const original=()=>true;let $xa=original,ZBe=original;
        function fxt(fn){ZBe=fn}
        const __vfCustom={wrapRenderMemoryGate:(fn,getState)=>Object.assign(
          (...args)=>fn(...args),{getState}),report:(name,ok,error)=>{if(!ok)throw Error(error)},
          createRenderFocusState:native=>require(''' + json.dumps(str(ROOT / 'node' / 'scheduler-hotpath.cjs')) + ''').createFocusState(native)};
        ''' + setup + hook + checks
        result = subprocess.run(['node', '-e', program], capture_output=True,
                                encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_oldest_registered_priority_includes_zero_demand(self):
        self.run_hook(checks='''const state=$xa.getState({jobId:'younger'});
          assert.deepEqual(state.focus,{jobId:'oldest',priority:'0',hasReadyRender:true});
          assert.equal(state.requestPriority,'1');assert.equal(state.hasReadyRender,true);
          assert.equal(ZBe,$xa);fxt($xa);assert.notEqual(ZBe,original);''')

    def test_inactive_oldest_does_not_promote_younger_render(self):
        self.run_hook(setup="s.waiters=[{jobId:'younger',priority:'1',resourceKey:'remotion'}];",
                      checks="assert.equal($xa.getState().focus.hasReadyRender,false);")

    def test_readiness_uses_actual_admission_not_only_waiter_membership(self):
        self.run_hook(setup="blocked.add('oldest');",
                      checks="assert.equal($xa.getState().focus.hasReadyRender,false);")

    def test_focus_is_recomputed_when_native_registration_changes(self):
        self.run_hook(checks='''jp.delete('oldest');
          s.waiters=[{jobId:'younger',priority:'1',resourceKey:'frameshift'}];
          assert.equal($xa.getState().focus.jobId,'younger');
          assert.equal($xa.getState().focus.hasReadyRender,true);
          jp.clear();assert.equal($xa.getState().focus,null);''')

    def test_generated_getstate_drives_the_real_canonical_helper(self):
        helper = json.dumps(str(ROOT / 'node' / 'render-memory-fairness.cjs'))
        self.run_hook(setup=f'''__vfCustom.wrapRenderMemoryGate=(fn,getState)=>
          require({helper}).createRenderMemoryFairness(fn,{{getState}});''', checks='''
          const younger={lane:'ffmpeg',key:'ffmpeg',jobId:'younger'};
          assert.equal($xa(younger).allowed,false);
          assert.equal($xa({...younger,jobId:'oldest'}),true);
          for(const key of ['ffmpegHomeFallback','ffmpegHomeTrimFallback','ffmpegHomeNormalizeFallback'])
            assert.equal($xa({...younger,key}),true);
          s.waiters=[{jobId:'younger',priority:'1',resourceKey:'remotion'}];
          assert.equal($xa(younger),true);
          assert.equal($xa.getStats().status,'cooldown');''')

    def test_missing_or_ambiguous_registry_fingerprint_is_fatal(self):
        for text in [NATIVE.replace('return jp.get(e)?.priority??lxt', 'return fallback(e)'),
                     NATIVE + 'function duplicate(e){return another.get(e)?.priority??lxt}']:
            with self.subTest(text=text), self.assertRaisesRegex(RuntimeError, 'memory fairness'):
                self.patch(text)

    def test_upgrade_replaces_legacy_hook_without_stacking(self):
        patched = self.patch(NATIVE + LEGACY_HOOK)
        self.assertNotIn('/* vf-custom:render-memory-fairness-v1 */', patched)
        self.assertEqual(patched.count('__vfCustom.wrapRenderMemoryGate('), 1)
        self.assertEqual(self.patch(patched), patched)

    def test_upgrade_replaces_v2_inline_hook_without_stacking(self):
        v2 = self.module['_v2_hook']('$xa', 'fxt', 'pX', 'XBe', 'KBe', 'jp')
        patched = self.patch(NATIVE + v2)
        self.assertNotIn('/* vf-custom:render-memory-fairness-v2 */', patched)
        self.assertEqual(patched.count('__vfCustom.wrapRenderMemoryGate('), 1)
        self.assertIn('__vfCustom.createRenderFocusState({pX:pX,XBe:(...a)=>XBe(...a),KBe:KBe,jp:jp})', patched)
        self.assertEqual(self.patch(patched), patched)
        with self.assertRaisesRegex(RuntimeError, 'memory fairness'):
            self.patch(NATIVE + v2.replace('hasReadyRender:', 'changed:'))

    def test_active_render_skips_waiter_scan(self):
        self.run_hook(setup="let checks=0;const real=XBe;s.activeTotal=2;",
                      checks="""assert.equal($xa.getState().focus.jobId,'oldest');""")

    def test_unknown_legacy_hook_is_fatal(self):
        with self.assertRaisesRegex(RuntimeError, 'memory fairness'):
            self.patch(NATIVE + LEGACY_HOOK.replace('hasReadyRender:', 'changed:'))

    def test_hook_syntax_and_optional_exact_stock(self):
        sources = [NATIVE]
        if os.environ.get('VF_STOCK_BUNDLE'):
            sources.append(Path(os.environ['VF_STOCK_BUNDLE']).read_text(encoding='utf-8'))
        for source in sources:
            patched = self.patch(source)
            self.assertEqual(self.patch(patched), patched)
            result = subprocess.run(['node', '--check', '--input-type=module'],
                                    input=patched, capture_output=True, encoding='utf-8', timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
