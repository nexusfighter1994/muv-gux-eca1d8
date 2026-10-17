"""Offline build contract: pinned Node bundle, reviewed FFlow method fixtures, no app import."""
import ast
import contextlib
import hashlib
import io
import json
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest
from unittest.mock import patch

from test_fx_dir_retention_installer import native_source
from test_fx_worker_sentinel import RUNNER

CONTEXT = Path(__file__).resolve().parents[1]
STOCK = CONTEXT.parents[1] / 'vf-update-20261015' / 'stock-new.mjs'


def populate(root):
    core = root / 'engines/fflow/src/core'
    core.mkdir(parents=True)
    storage = core.parent / 'storage'
    storage.mkdir()
    for backend in ('local', 'minio'):
        (storage / (backend + '.py')).write_text(native_source(backend), encoding='utf-8')
    (core / 'fxtransitions').mkdir()
    (core / 'fxtransitions/runner.py').write_text(RUNNER, encoding='utf-8')
    (core / 'ffmpeg.py').write_text('''class FFmpegExecutor:
    async def execute(self, command, timeout, expected_duration, progress_callback, cancellation_event, slot_kind='ffmpeg'):
        cmd = command
        logger.info(f"Executing FFmpeg: {' '.join(cmd[:10])}...")
    async def _try_acquire_global_process_slot(self):
        pass
    async def _release_global_process_slot(self):
        pass
''', encoding='utf-8')
    queue = core.parent / 'queue'
    queue.mkdir()
    (queue / 'worker.py').write_text('''class Worker:
    async def _process_job(self):
        pass
if __name__ == "__main__":
    pass
''', encoding='utf-8')
    (queue / 'jobs.py').write_text('''class JobQueue:
    async def dequeue_and_start(self):
        # Lua script for atomic dequeue-and-start
        script = """
        if active_limit and active_limit > 0 and redis.call('scard', active_set_key) >= active_limit then
            return {'__capacity_full__'}
        end

        -- Pop job from queue (LPOP for FIFO order)
        local job_id = redis.call('lpop', queue_key)
        """
        return await redis.eval(script,
            worker_id,
            lease_id,
        )
''', encoding='utf-8')
    routes = core.parent / 'api/routes.py'
    routes.parent.mkdir()
    routes.write_text('''async def detect():
    metadata, shots = await asyncio.to_thread(
        detect_video_scenes,
        local_video_path,
        request.detection_threshold,
    )
''', encoding='utf-8')
    dist = root / 'server/dist'
    public = root / 'server/public'
    dist.mkdir(parents=True)
    (public / 'assets').mkdir(parents=True)
    shutil.copy2(STOCK, dist / 'index.mjs')
    (public / 'index.html').write_text('<html><head></head></html>', encoding='utf-8')
    geomap = root / 'render/geomap'
    geomap.mkdir(parents=True)
    shutil.copy2(CONTEXT.parent / 'stock-map-index.js', geomap / 'index.js')
    return dict(DIST=dist, PUBLIC=public, CORE=core, ROUTES=routes)


class BackendInstallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='vf-backend-')
        cls.root = Path(cls.temp.name)
        cls.namespace = runpy.run_path(str(CONTEXT / 'apply.py'))
        cls.namespace['fflow'].__globals__.update(populate(cls.root))
        with patch.dict('os.environ', {'VF_GEOMAP': str(cls.root / 'render/geomap')}), contextlib.redirect_stdout(io.StringIO()):
            for name in ('graphics', 'geomap_isolation', 'fflow', 'node', 'ui'):
                cls.namespace[name]()
        report_file = cls.root / 'server/dist/vf-custom/hooks-build.json'
        payload = json.loads(report_file.read_text(encoding='utf-8'))
        payload['report'] = cls.namespace['note'].__globals__['report']
        report_file.write_text(json.dumps(payload), encoding='utf-8')
        cls.output = (cls.root / 'server/dist/index.mjs').read_text(encoding='utf-8')
        if artifact := __import__('os').environ.get('VF_BACKEND_ARTIFACT'):
            artifact = Path(artifact)
            artifact.mkdir(parents=True, exist_ok=True)
            shutil.copytree(cls.root, artifact, dirs_exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_every_required_hook_is_installed_without_consulting_desired_flags(self):
        gate = self.namespace['HOOK_GATE']
        report = self.namespace['note'].__globals__['report']
        gate['validate_hook_report']({'report': report})
        self.assertEqual(set(report) - set(gate['OPTIONAL_HOOKS']), set(gate['REQUIRED_HOOKS']))
        self.assertTrue('modEnabled("fishFree")' in self.output, 'Fish policy has no flag boundary')
        self.assertTrue('modEnabled("ai33Stt")' in self.output, 'AI33 parser has no flag boundary')

    def test_active_helpers_are_copied_and_real_slot_cleanup_install_is_gated(self):
        core = self.root / 'engines/fflow/src/core'
        self.assertTrue((core / 'mod_flags.py').is_file())
        source = (core / 'ffmpeg.py').read_text(encoding='utf-8')
        self.assertIn("_vf_mod_enabled('slotCleanup')", source)
        tree = ast.parse(source)
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.If) and "slotCleanup" in ast.unparse(n.test)]
        self.assertEqual(len(calls), 1)
        self.assertIn('_vf_install_slot_cleanup(FFmpegExecutor)', ast.unparse(calls[0]))

    def test_map_isolation_and_home_installer_have_actual_disabled_branches(self):
        map_source = (self.root / 'render/geomap/index.js').read_text(encoding='utf-8')
        self.assertIn("!modEnabled('mapIsolation')", map_source)
        self.assertTrue("modEnabled('homeQueue')" in self.output)
        self.assertTrue("modEnabled('homeSiglip')" in self.output)
        jobs = (self.root / 'engines/fflow/src/queue/jobs.py').read_text(encoding='utf-8')
        self.assertIn("mod_enabled('homeQueue')", jobs)
        self.assertIn("ARGV[7]", jobs)

    def test_all_34_hooks_remain_required_on_reapply(self):
        before = hashlib.sha256(self.output.encode()).hexdigest()
        with contextlib.redirect_stdout(io.StringIO()):
            self.namespace['node']()
        after = (self.root / 'server/dist/index.mjs').read_bytes()
        self.assertEqual(hashlib.sha256(after).hexdigest(), before)
        self.namespace['HOOK_GATE']['validate_hook_report'](json.loads(
            (self.root / 'server/dist/vf-custom/hooks-build.json').read_text(encoding='utf-8')))


if __name__ == '__main__':
    unittest.main()
