"""Real loopback APIs and per-job guards; never loads CUDA or runs native FFmpeg."""
import base64
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

HOME = Path(__file__).resolve().parents[1].parent / 'vf-speed-20261002'
sys.path.insert(0, str(HOME / 'ffmpeg'))
sys.path.insert(0, str(HOME))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ff = load('local_transfer_ff', HOME / 'ffmpeg' / 'pc_ffmpeg_worker.py')
sig = load('local_transfer_sig', HOME / 'siglip' / 'service.py')
DEFAULTS = dict(ffmpegMaxFileMb=64, ffmpegMaxTotalMb=96, sceneMaxFileMb=400, siglipMaxImageMb=20)
MIB = 1048576
CURRENT = dict(enabled=True, cpuWorkers=12, gpuWorkers=0, siglipEnabled=True, siglipConcurrency=12, sceneWorkers=0)


class FakeRanker:
    device = 'cuda'
    torch = SimpleNamespace(cuda=SimpleNamespace(get_device_name=lambda _: 'test GPU',
        is_available=lambda: True, memory_allocated=lambda: 0, memory_reserved=lambda: 0,
        max_memory_allocated=lambda: 0, empty_cache=lambda: None))

    def rank(self, query, candidates, **kwargs):
        self.received_limits = kwargs.get('limits')
        if hasattr(self, 'during_rank'):
            self.during_rank()
        return {'status': 'completed'}


class LocalTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        executable = self.root / 'fake-ffmpeg.exe'
        executable.touch()
        with patch.object(ff, 'run'):
            self.worker = ff.Worker(executable, 'test-only-token', self.root / 'ff', probe_gpu=False)
        self.worker.update_config(CURRENT)
        self.ranker = FakeRanker()
        self.state = sig.State(self.ranker, 'test-only-token', CURRENT)
        # Explicit temporary runtime paths: isolated tests must never write real worker state.
        self.assertTrue(hasattr(self.worker, 'transfer_limits'), 'Worker needs fresh persisted transfer limits')
        self.worker.transfer_limits.path = self.root / 'ff-limits.json'
        self.assertTrue(hasattr(self.state, 'transfer_limits'), 'SigLIP needs fresh persisted transfer limits')
        self.state.transfer_limits.path = self.root / 'sig-limits.json'
        self.servers = [ff.make_server(self.worker, 0), sig.ThreadingHTTPServer(('127.0.0.1', 0), sig.Handler)]
        self.servers[1].state = self.state
        self.threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in self.servers]
        for thread in self.threads:
            thread.start()

    def tearDown(self):
        for server in getattr(self, 'servers', []):
            server.shutdown()
            server.server_close()
        for thread in getattr(self, 'threads', []):
            thread.join()
        self.worker.jobs.clear()
        self.worker.close()
        self.temp.cleanup()

    def request(self, index, method, path, data=None, authorized=True):
        conn = http.client.HTTPConnection('127.0.0.1', self.servers[index].server_port, timeout=5)
        headers = {'Content-Type': 'application/json', 'X-VF-Local': '1'}
        if authorized:
            headers['Authorization'] = 'Bearer test-only-token'
        conn.request(method, path, None if data is None else json.dumps(data), headers)
        reply = conn.getresponse()
        result = reply.status, json.loads(reply.read())
        conn.close()
        return result

    def sparse_blob(self, size):
        digest = hashlib.sha256(str(size).encode()).hexdigest()
        path = self.worker.blob_path(digest)
        path.parent.mkdir(exist_ok=True)
        with path.open('wb') as stream:
            stream.truncate(size)
        return {'sha256': digest, 'size': size}

    def render(self, blob):
        return {'argv': ['-y', '-i', '@0.mp4', '-c:v', 'libx264', '-crf', '18', 'output.mp4'],
                'files': {'@0.mp4': blob}, 'gpuEligible': False}

    def test_defaults_health_and_no_state_or_config_write(self):
        for index, state in enumerate((self.worker, self.state)):
            self.assertEqual(self.request(index, 'GET', '/transfer-limits'), (200, {'limits': DEFAULTS}))
            status, health = self.request(index, 'GET', '/health')
            self.assertEqual(status, 200)
            self.assertEqual(health['transferLimits'], DEFAULTS)
            self.assertFalse(state.transfer_limits.path.exists())

    def test_strict_atomic_api_ranges_auth_and_independent_config(self):
        maxima = dict(ffmpegMaxFileMb=4096, ffmpegMaxTotalMb=4096, sceneMaxFileMb=4096, siglipMaxImageMb=128)
        for index, state in enumerate((self.worker, self.state)):
            config = dict(state.config)
            self.assertEqual(self.request(index, 'PUT', '/transfer-limits', maxima, False)[0], 401)
            self.assertFalse(state.transfer_limits.path.exists())
            self.assertEqual(self.request(index, 'PUT', '/transfer-limits', maxima), (200, {'limits': maxima}))
            self.assertEqual(self.request(index, 'GET', '/transfer-limits'), (200, {'limits': maxima}))
            persisted = state.transfer_limits.path.read_bytes()
            invalid = [{}, {**DEFAULTS, 'unknown': 1}, {**DEFAULTS, 'siglipMaxImageMb': 129}]
            for key in DEFAULTS:
                invalid.extend({**DEFAULTS, key: value} for value in (0, True, 1.5, '25', maxima[key] + 1))
            for limits in invalid:
                self.assertEqual(self.request(index, 'PUT', '/transfer-limits', limits)[0], 400)
                self.assertEqual(state.transfer_limits.path.read_bytes(), persisted)
            self.assertEqual(state.config, config)
            state.transfer_limits.path.write_text(json.dumps(DEFAULTS))
            self.assertEqual(self.request(index, 'GET', '/transfer-limits')[1], {'limits': DEFAULTS})
            state.transfer_limits.path.write_text('{broken')
            self.assertEqual(self.request(index, 'GET', '/transfer-limits')[0], 400)

    def test_blob_reference_per_file_total_and_job_snapshot_are_dynamic(self):
        blob = self.sparse_blob(65 * MIB)
        with self.assertRaises(ValueError):
            self.worker.submit(self.render(blob))
        limits = {**DEFAULTS, 'ffmpegMaxFileMb': 66, 'ffmpegMaxTotalMb': 100}
        self.worker.transfer_limits.set(limits)
        with patch.object(threading.Thread, 'start'):
            result = self.worker.submit(self.render(blob))
        self.assertEqual(result['lane'], 'cpu')
        job = self.worker.jobs[result['id']]
        self.assertEqual(job['transferLimits'], limits)
        self.worker.transfer_limits.set({**limits, 'ffmpegMaxFileMb': 64})
        self.assertEqual(job['transferLimits'], limits)
        with self.assertRaises(ValueError):
            self.worker.submit(self.render(blob))
        self.worker.transfer_limits.set({**limits, 'ffmpegMaxFileMb': 120, 'ffmpegMaxTotalMb': 96})
        with self.assertRaises(ValueError):
            self.worker.submit(self.render(self.sparse_blob(97 * MIB)))
        self.worker.transfer_limits.set({**limits, 'ffmpegMaxFileMb': 120, 'ffmpegMaxTotalMb': 100})
        with patch.object(threading.Thread, 'start'):
            self.worker.submit(self.render(self.sparse_blob(97 * MIB)))

    def test_blob_stream_boundaries_hash_and_bounded_chunks(self):
        limits = {**DEFAULTS, 'sceneMaxFileMb': 1, 'ffmpegMaxFileMb': 1}
        self.worker.transfer_limits.set(limits)
        raw = b'a' * (MIB + 1)
        digest = hashlib.sha256(raw).hexdigest()
        with self.assertRaises(ValueError):
            self.worker.store_blob(digest, len(raw), lambda _: self.fail('Rejected before read'))
        self.worker.transfer_limits.set({**limits, 'sceneMaxFileMb': 2})
        stream = io.BytesIO(raw)
        chunks = []
        def reader(size):
            chunks.append(size)
            return stream.read(size)
        with patch.object(ff.DOWNLOAD_LIMIT, 'take'):
            self.worker.store_blob(digest, len(raw), reader)
        self.assertLessEqual(max(chunks), 256 * 1024)
        self.assertEqual(self.worker.blob_path(digest).read_bytes(), raw)
        with patch.object(ff.DOWNLOAD_LIMIT, 'take'), self.assertRaises(ValueError):
            self.worker.store_blob('0' * 64, 3, io.BytesIO(b'abc').read)
        self.assertFalse(list((self.worker.root / 'blobs').glob('.blob-*')))

    def test_scene_actual_input_guard_and_admission_snapshot(self):
        blob = self.sparse_blob(2 * MIB)
        self.worker.scenes.ready = True
        self.worker.scenes.set_workers(1)
        self.worker.transfer_limits.set({**DEFAULTS, 'sceneMaxFileMb': 1})
        payload = dict(source=blob, threshold=27)
        with self.assertRaises(ValueError):
            self.worker.scenes.submit(payload)
        self.assertEqual(self.worker.scenes.busy, 0)
        limits = {**DEFAULTS, 'sceneMaxFileMb': 3}
        self.worker.transfer_limits.set(limits)
        with patch.object(threading.Thread, 'start'):
            result = self.worker.scenes.submit(payload)
        self.assertEqual(self.worker.scenes.jobs[result['id']]['transferLimits'], limits)
        self.worker.scenes.jobs.clear()

    def test_inline_v1_limits_remain_physical_even_when_user_raises_limit(self):
        self.worker.transfer_limits.set({**DEFAULTS, 'ffmpegMaxFileMb': 4096, 'ffmpegMaxTotalMb': 4096})
        class TooBig:
            def __len__(self):
                return 65 * MIB
        with patch.object(ff.base64, 'b64decode', return_value=TooBig()), self.assertRaises(ValueError):
            self.worker.submit(self.render('YQ=='))
        self.assertEqual(ff.MAX_BODY, 140 * MIB)
        self.assertEqual(ff.MAX_OUTPUT, 512 * MIB)

    def test_siglip_body_budget_and_real_image_limits_pixel_guard_preserved(self):
        self.assertEqual(sig.body_limit(DEFAULTS), 64 * MIB)
        raised = {**DEFAULTS, 'siglipMaxImageMb': 128}
        self.assertGreater(sig.body_limit(raised), 4 * ((128 * MIB + 2) // 3))
        self.assertLess(sig.body_limit(raised), 176 * MIB)
        self.assertEqual(sig.batch_raw_limit(DEFAULTS), 45 * MIB)
        self.assertEqual(sig.batch_raw_limit(raised), 128 * MIB)
        limits = {**DEFAULTS, 'siglipMaxImageMb': 1}
        encoded = base64.b64encode(b'a' * (MIB + 1)).decode()
        with self.assertRaises(ValueError):
            sig.validate_payload(dict(query='test', candidates=[dict(id='a', image_base64=encoded)]), limits)
        image = io.BytesIO()
        sig.Image.new('RGB', (1, 1)).save(image, format='PNG')
        # Valid decoded image > old20MiB; trailing bytes are accepted by PIL like the old service.
        padded = image.getvalue() + b'\0' * (21 * MIB)
        large = base64.b64encode(padded).decode()
        with self.assertRaises(ValueError):
            sig.decode_image(large, DEFAULTS)
        with sig.decode_image(large, {**DEFAULTS, 'siglipMaxImageMb': 22}) as decoded:
            self.assertEqual(decoded.size, (1, 1))
        bomb = SimpleNamespace(width=40_000_001, height=1)
        context = unittest.mock.MagicMock()
        context.__enter__.return_value = bomb
        with patch.object(sig.Image, 'open', return_value=context), self.assertRaisesRegex(ValueError, 'pixel'):
            sig.decode_image('YQ==', limits)

    def test_rank_passes_fixed_snapshot_and_next_request_reads_current_file(self):
        limits = {**DEFAULTS, 'siglipMaxImageMb': 21}
        self.state.transfer_limits.set(limits)
        self.ranker.during_rank = lambda: self.state.transfer_limits.set(DEFAULTS)
        payload = dict(query='test', candidates=[dict(id='a', image_base64='YQ==')])
        self.assertEqual(self.request(1, 'POST', '/rank', payload)[0], 200)
        self.assertEqual(self.ranker.received_limits, limits)
        self.assertEqual(self.state.active, 0)
        self.assertEqual(self.request(1, 'POST', '/rank', payload)[0], 200)
        self.assertEqual(self.ranker.received_limits, DEFAULTS)

    def test_siglip_rejects_oversized_body_before_read_and_real_raised_http_image(self):
        for maximum in (64 * MIB, sig.body_limit({**DEFAULTS, 'siglipMaxImageMb': 128})):
            handler = sig.Handler.__new__(sig.Handler)
            handler.headers = {'Content-Length': str(maximum + 1)}
            handler.rfile = SimpleNamespace(read=lambda _: self.fail('Must reject before allocation'))
            with self.assertRaises(ValueError):
                handler.body(maximum)
        image = io.BytesIO()
        sig.Image.new('RGB', (1, 1)).save(image, format='PNG')
        encoded = base64.b64encode(image.getvalue() + b'\0' * (21 * MIB)).decode()
        payload = dict(query='test', candidates=[dict(id='a', image_base64=encoded)])
        self.assertEqual(self.request(1, 'POST', '/rank', payload)[0], 400)
        limits = {**DEFAULTS, 'siglipMaxImageMb': 22}
        self.assertEqual(self.request(1, 'PUT', '/transfer-limits', limits)[0], 200)
        self.assertEqual(self.request(1, 'POST', '/rank', payload)[0], 200)
        self.assertEqual(self.ranker.received_limits, limits)

    def test_atomic_write_failure_keeps_last_good_file_and_batch_ceiling(self):
        import pc_transfer_runtime
        self.state.transfer_limits.set(DEFAULTS)
        before = self.state.transfer_limits.path.read_bytes()
        with patch.object(pc_transfer_runtime.os, 'replace', side_effect=OSError('test failure')):
            self.assertEqual(self.request(1, 'PUT', '/transfer-limits', {**DEFAULTS, 'siglipMaxImageMb': 21})[0], 503)
        self.assertEqual(self.state.transfer_limits.path.read_bytes(), before)
        self.assertFalse(list(self.root.glob('.transfer-*.tmp')))
        payload = dict(query='test', candidates=[dict(id='a', image_base64='YQ=='), dict(id='b', image_base64='YQ==')])
        # Check total raw guard without allocating a multi-hundred-MiB test request.
        class Raw:
            def __len__(self):
                return 70 * MIB
        with patch.object(sig.base64, 'b64decode', return_value=Raw()), self.assertRaises(ValueError):
            sig.validate_payload(payload, {**DEFAULTS, 'siglipMaxImageMb': 128})
        from pc_transfer_limits import check_render_sizes
        largest = {**DEFAULTS, 'ffmpegMaxFileMb': 4096, 'ffmpegMaxTotalMb': 4096}
        check_render_sizes([4096 * MIB], largest)
        with self.assertRaises(ValueError):
            check_render_sizes([4096 * MIB + 1], largest)


if __name__ == '__main__':
    unittest.main()
