import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'home-graphics-worker' / 'motion-offload'
sys.path.insert(0, str(ROOT))


@unittest.skipUnless(os.name == 'nt', 'Windows job object qualification')
class ProcessTreeTests(unittest.TestCase):
    def factory(self):
        self.assertTrue((ROOT / 'process_tree.py').is_file(), 'missing process-tree ownership')
        from process_tree import TreeProcess
        return TreeProcess

    def test_real_parent_and_grandchild_are_reaped(self):
        factory = self.factory()
        command = [sys.executable, '-u', '-c',
                   'import subprocess,sys,time; p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);print(p.pid,flush=True);time.sleep(60)']
        process = factory(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(process.stdout.readline().strip().isdigit())
            self.assertFalse(process.tree_exited())
            process.terminate_tree()
            process.communicate(timeout=10)
            self.assertTrue(process.tree_exited())
            self.assertEqual(process.active_count(), 0)
        finally:
            process.terminate_tree()
            process.wait(timeout=10)
            process.dispose()

    def test_exited_root_with_live_grandchild_keeps_ownership(self):
        factory = self.factory()
        command = [sys.executable, '-u', '-c',
                   'import subprocess,sys;p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(p.pid)']
        process = factory(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            output, error = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, error)
            self.assertTrue(output.strip().isdigit())
            self.assertFalse(process.tree_exited())
            self.assertGreaterEqual(process.active_count(), 1)
            process.terminate_tree()
            self.assertTrue(process.wait_tree(timeout=10))
        finally:
            process.terminate_tree()
            process.wait_tree(timeout=10)
            process.dispose()

    def test_normal_stdio_contract(self):
        process = self.factory()([sys.executable, '-c', 'import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            output, error = process.communicate(b'unchanged-payload', timeout=15)
            self.assertEqual((output, error, process.returncode), (b'unchanged-payload', b'', 0))
            self.assertTrue(process.wait_tree(timeout=5))
        finally:
            process.dispose()


if __name__ == '__main__':
    unittest.main()
