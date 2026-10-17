import runpy,unittest
from pathlib import Path
install=runpy.run_path(str(Path(__file__).resolve().parents[1]/'long-assembly-install.py'))
SOURCE='async function Dgn(e){let t=AHe.createHash("sha256");return await new Promise((r,n)=>{let o=ic.createReadStream(e);o.on("data",i=>t.update(i)),o.once("error",n),o.once("end",r)}),t.digest("hex")}'
class HashInstall(unittest.TestCase):
 def test_reviewed_hash_hook_and_idempotence(self):
  self.assertIn('patch_final_hash',install)
  patched=install['patch_final_hash'](SOURCE)
  self.assertIn('Dgn=__vfCustom.createFinalHasher(Dgn)',patched)
  self.assertEqual(install['patch_final_hash'](patched),patched)
 def test_drift_fails_closed(self):
  self.assertIn('patch_final_hash',install)
  for text in ['',SOURCE+SOURCE,SOURCE.replace('sha256','md5')]:
   with self.assertRaises(RuntimeError):install['patch_final_hash'](text)
 def test_native_other_hashers_are_not_rebound(self):
  text=SOURCE+SOURCE.replace('Dgn','other')+';({sha256:u?c.sha256:await Dgn(n)})'
  patched=install['patch_final_hash'](text)
  self.assertIn('Dgn=__vfCustom.createFinalHasher(Dgn)',patched)
  self.assertNotIn('other=__vfCustom.createFinalHasher(other)',patched)
 def test_final_artifact_hash_is_scoped_and_idempotent(self):
  self.assertIn('patch_final_artifact_hash',install)
  text=SOURCE.replace('Dgn','vUi')+';({sha256:await vUi(t),durationSec:null})'
  patched=install['patch_final_artifact_hash'](text)
  self.assertIn('vUi=__vfCustom.createFinalHasher(vUi)',patched)
  self.assertEqual(install['patch_final_artifact_hash'](patched),patched)
  with self.assertRaises(RuntimeError):install['patch_final_artifact_hash'](SOURCE)
  with self.assertRaises(RuntimeError):install['patch_final_artifact_hash'](text.replace('sha256"','md5"'))
  legacy=text+'\n/* vf-custom:final-artifact-hash-v1 */;vUi=__vfCustom.createFinalHasher(vUi,{onlyFinalFiles:true});\n'
  self.assertEqual(install['patch_final_artifact_hash'](legacy),patched)
if __name__=='__main__':unittest.main()
