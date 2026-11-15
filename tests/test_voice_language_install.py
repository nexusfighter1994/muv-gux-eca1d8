import pathlib,runpy,unittest,subprocess

patch=runpy.run_path(str(pathlib.Path(__file__).parents[1]/'voice-language-install.py'))['patch_node']
GATE='function iLe(e,t){let r=br(t);return r?wS[e==="genaipro"?"genAiPro":e]?.includes(r.label)===!0:!0}'
HYDRATE='function m4o(e){if(!e)return null;let t={};try{t=JSON.parse(e.schema_json)||{}}catch{}return{...t,autoDefaultVoice:lYa(t),id:e.id,name:e.name,version:e.version,createdAt:e.created_at,updatedAt:e.updated_at}}'
FIXTURE='const untouched=1;'+GATE+'const middle=2;'+HYDRATE+'const after=3;'

class VoiceLanguageInstall(unittest.TestCase):
    def test_real_tts_normalized_fish_provider(self):
        source=patch(FIXTURE)
        prelude='function br(t){return {label:t}};const wS={fishAudio:[],ai33pro:[]};'
        script=prelude+source+'''
          const assert=require('node:assert/strict');
          for(const language of ['Japanese','Korean']) {
            const selected='fishAudio';
            const nativeProvider=selected==='fishAudio'?'fishaudio':selected;
            assert.equal(iLe(nativeProvider,language),true,nativeProvider+'/'+language);
          }
          assert.equal(iLe('fishaudio','Hindi'),false);
          assert.equal(iLe('other','Japanese'),false);
        '''
        result=subprocess.run(['node','-e',script],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
    def test_exact_old_patch_is_upgraded(self):
        current=patch(FIXTURE)
        old=current.replace('e==="fishAudio"||e==="fishaudio"||','e==="fishAudio"||')
        upgraded=patch(old)
        self.assertIn('e==="fishaudio"',upgraded)
        self.assertEqual(patch(upgraded),upgraded)
    def test_current_catch_body_preserved(self):
        value = patch(FIXTURE.replace('catch{}', 'catch{t={}}'))
        self.assertIn('catch{t={}}/* vf-custom:voice-ja-ko-schema-v1 */', value)
    def test_both_native_paths_patched(self):
        value=patch(FIXTURE)
        self.assertIn('vf-custom:voice-ja-ko-gate-v1',value)
        self.assertIn('vf-custom:voice-ja-ko-schema-v1',value)
    def test_idempotent(self):self.assertEqual(patch(patch(FIXTURE)),patch(FIXTURE))
    def test_only_two_function_bodies_changed(self):
        value=patch(FIXTURE)
        self.assertTrue(value.startswith('const untouched=1;function iLe(e,t){'))
        self.assertIn('const middle=2;function m4o(e){',value)
        self.assertTrue(value.endswith('const after=3;'))
    def test_ambiguous_source_refused(self):
        with self.assertRaises(RuntimeError):patch(FIXTURE+GATE)
    def test_drift_refused(self):
        with self.assertRaises(RuntimeError):patch(FIXTURE.replace('?.includes(r.label)','?.includes(r.code)'))
    def test_partial_patch_refused(self):
        with self.assertRaises(RuntimeError):patch(FIXTURE+'/* vf-custom:voice-ja-ko-gate-v1 */')
    def test_tampered_patch_refused(self):
        with self.assertRaises(RuntimeError):patch(patch(FIXTURE).replace('includes(r?.label)', 'includes(r?.code)'))

if __name__=='__main__':unittest.main()
