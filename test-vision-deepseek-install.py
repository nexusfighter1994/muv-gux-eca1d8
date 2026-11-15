import importlib.util
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('vision_install', ROOT / 'vision-deepseek-install.py')
NODE = os.environ.get('VF_TEST_NODE', 'node')
PREDICATE = r'''function $1t(e){let t=String(e||"").toLowerCase().split("/").at(-1);return/(?:tts|audio|transcrib|image|embedding|search|moderation)/.test(t)||/^o(?:1|3)-(?:mini|preview)(?:-|$)/.test(t)?!1:/^(?:gpt-(?:4o|4\.1|[56](?:\.\d+)?)(?:[.\-]|$)|o[134](?:-|$)|gemini-(?:1\.5|2|3)|claude-(?:3|sonnet|opus|haiku))/.test(t)}'''


def patch(source):
    if not SPEC.origin or not Path(SPEC.origin).exists():
        return source
    module = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(module)
    return module.patch_node(source)


class VisionCompatibility(unittest.TestCase):
    def test_exact_tested_deepseek_is_accepted(self):
        result = subprocess.check_output([NODE, '-e', patch(PREDICATE) + ';process.stdout.write(String($1t("deepseek-v4.1-flash")));'], text=True)
        self.assertEqual(result, 'true')

    def test_all_previous_acceptance_and_rejection_decisions_preserved(self):
        values = ['gpt-5.6-luna', 'gpt-6-luna', 'gemini-2.5-flash', 'claude-sonnet-5-5',
                  'o3', 'gpt-image-2', 'gpt-5-audio', 'text-embedding-3-large', '',
                  'deepseek-flash', 'deepseek-v4.1-flash-audio', 'glm-5.3-flash', 'o1-mini']
        import json
        js = PREDICATE + ';const before=$1t;' + patch(PREDICATE).replace('$1t', 'candidate')
        js += ';for(const v of ' + json.dumps(values) + '){if(before(v)!==candidate(v))throw Error(v)}'
        subprocess.run([NODE, '-e', js], check=True)

    def test_idempotent_and_fail_closed_fingerprints(self):
        once = patch(PREDICATE)
        self.assertEqual(patch(once), once)
        for source in ['', PREDICATE + PREDICATE, PREDICATE.replace('moderation', 'unknown')]:
            with self.assertRaises(RuntimeError):
                patch(source)


if __name__ == '__main__':
    unittest.main()
