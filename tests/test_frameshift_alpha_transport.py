"""Offline alpha protocol tests; no renderer, listener, or release is modified."""
import base64
import hashlib
import importlib.util
import inspect
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1] / 'home-graphics-worker'
FROZEN = Path('E:/VidForgeHomeBoost/graphics-releases/20261015-29-g1')
MIB = 1024 ** 2
ALPHA = 'frameshift-alpha-v1'
OPAQUE = 'frameshift-opaque-v1'
CONTRACT = 'offline-qualified-dispatcher-v1'
CONFIG = {'contract': CONTRACT, 'kinds': [ALPHA],
          'maxOutputBytes': 128 * MIB, 'maxResponseBytes': 176 * MIB}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


transport = load('transport', ROOT / 'motion-offload/transport.py')
adapter = load('alpha_test_adapter', ROOT / 'motion-offload/adapter.py')
bootstrap = load('alpha_test_bootstrap', ROOT / 'shared-graphics-worker/graphics_bootstrap.py')


class SizedBytes(bytes):
    """Exercise large boundaries without large allocations or real files."""
    def __new__(cls, value, size):
        instance = super().__new__(cls, value)
        instance.size = size
        return instance

    def __len__(self):
        return self.size


class Pace:
    def __init__(self):
        self.sizes = []

    def take(self, size):
        self.sizes.append(size)


class Handler:
    def __init__(self, data=None, path='/motion/render', command='POST'):
        raw = json.dumps(data).encode() if data is not None else b''
        self.path, self.command = path, command
        self.headers = {'Content-Length': str(len(raw))}
        self.rfile, self.wfile = io.BytesIO(raw), io.BytesIO()
        self.connection = SimpleNamespace(settimeout=Mock())
        self.code, self.response_headers, self.responses = None, {}, []

    def respond(self, code, value):
        self.code = code
        self.responses.append(value)

    def send_response(self, code):
        self.code = code

    def send_header(self, key, value):
        self.response_headers[key] = value

    def end_headers(self):
        pass


def worker(file_mb=256, total_mb=512):
    return SimpleNamespace(lock=threading.RLock(), stopping=threading.Event(), ready=True,
                           config={'enabled': True, 'cpuWorkers': 18, 'gpuWorkers': 6},
                           busy={'cpu': 17, 'gpu': 5},
                           transfer_limits=SimpleNamespace(get=lambda: {
                               'ffmpegMaxFileMb': file_mb, 'ffmpegMaxTotalMb': total_mb}),
                           health=lambda: {'completedGpu': 9, 'completedNvenc': 7})


def make_service(owner, config=CONFIG):
    # Baseline lacks config; exercising it still yields behavioral RED assertions.
    kwargs = {'config': config} if 'config' in inspect.signature(adapter.make_adapter).parameters else {}
    return adapter.make_adapter(owner, ['not-executed-node', 'not-executed-dispatcher'], CONTRACT, **kwargs)


def payload(**updates):
    return dict({'version': 1, 'id': 'a' * 32, 'contract': CONTRACT, 'kind': ALPHA,
                 'format': 'mov', 'workers': 1, 'sourceWorkers': 3, 'timeoutMs': 1000,
                 'assets': []}, **updates)


def receipt(request=None, **updates):
    data = request or payload()
    return dict({'version': 1, 'id': data['id'], 'contract': CONTRACT, 'kind': ALPHA,
                 'format': 'mov', 'backend': 'd3d11/nvidia',
                 'sha256': hashlib.sha256(b'x').hexdigest(), 'data': 'eA==',
                 'payloadSha256': 'b' * 64,
                 'probe': {'codec': 'prores', 'profile': '4444', 'pixFmt': 'yuva444p12le'}},
                **updates)


def process(result=None, callback=None, wire_size=None, returncode=0):
    raw = json.dumps(result or receipt()).encode()
    if wire_size is not None:
        raw = SizedBytes(raw, wire_size)
    def communicate(*args, **kwargs):
        if callback:
            callback()
        return raw, b''
    return SimpleNamespace(pid=12345, returncode=returncode, communicate=Mock(side_effect=communicate),
                           poll=Mock(return_value=0), wait=Mock())


class AlphaTransportTests(unittest.TestCase):
    def setUp(self):
        self.worker = worker()
        self.service = make_service(self.worker)

    def render(self, result=None, data=None, size=1, wire_size=None, service=None):
        decode = base64.b64decode
        def sized_decode(value, **kwargs):
            return SizedBytes(b'x', size) if value == 'eA==' else decode(value, **kwargs)
        with patch.object(transport.subprocess, 'Popen', return_value=process(result, wire_size=wire_size)), \
             patch.object(base64, 'b64decode', side_effect=sized_decode):
            return (service or self.service).render(data or payload())

    def test_protocol_caps_are_split_without_enlarging_input(self):
        for name, expected in [('MAX_BODY', 48), ('MAX_ARTIFACT', 32),
                               ('MAX_OUTPUT', 128), ('MAX_RESPONSE', 176)]:
            self.assertEqual(getattr(transport, name, None), expected * MIB)

    def test_health_explicitly_advertises_alpha_only_for_opted_in_service(self):
        for config, alpha in [(None, False), (CONFIG, True)]:
            service = make_service(self.worker, config)
            handler = Handler(path='/motion/health', command='GET')
            transport.dispatch_motion(handler, service, None)
            health = handler.responses[0]
            self.assertIsInstance(health.get('kinds'), list)
            self.assertEqual(ALPHA in health['kinds'], alpha)
            self.assertEqual(health['slots'], 1)

    def test_unqualified_old_service_rejects_alpha_before_spawning(self):
        with patch.object(transport.subprocess, 'Popen', return_value=process()) as spawn:
            with self.assertRaisesRegex(ValueError, 'kind|alpha|capability'):
                make_service(self.worker, None).render(payload())
            spawn.assert_not_called()
        self.assertEqual(self.worker.busy, {'cpu': 17, 'gpu': 5})

    def test_bad_capability_configuration_is_rejected_at_creation(self):
        configs = [dict(CONFIG, kinds=['unknown-v1']), dict(CONFIG, kinds=ALPHA),
                   dict(CONFIG, maxOutputBytes=128 * MIB + 1),
                   dict(CONFIG, maxResponseBytes=176 * MIB + 1),
                   dict(CONFIG, maxOutputBytes=True), dict(CONFIG, maxResponseBytes=0),
                   {'kinds': [ALPHA]}, dict(CONFIG, contract='wrong-contract')]
        for config in configs:
            with self.subTest(config=config), self.assertRaises(ValueError):
                make_service(self.worker, config)

    def test_alpha_32mib_plus_one_and_common_46mib_are_accepted(self):
        for size in (32 * MIB + 1, 46 * MIB, 128 * MIB):
            with self.subTest(size=size):
                self.service = make_service(self.worker)
                result = self.render(size=size, wire_size=64 * MIB)
                self.assertEqual(result['kind'], ALPHA)
                self.assertEqual(self.worker.busy, {'cpu': 17, 'gpu': 5})

    def test_alpha_hard_artifact_cap_is_enforced(self):
        with self.assertRaisesRegex(ValueError, 'artifact|output|size'):
            self.render(size=128 * MIB + 1)
        self.assertEqual(self.worker.busy, {'cpu': 17, 'gpu': 5})

    def test_stdout_at_176mib_is_allowed_but_next_byte_is_not(self):
        self.render(wire_size=176 * MIB)
        self.service = make_service(self.worker)
        with self.assertRaisesRegex((RuntimeError, ValueError), 'response|motion failed|output'):
            self.render(wire_size=176 * MIB + 1)

    def test_configured_lower_alpha_caps_are_enforced(self):
        config = dict(CONFIG, maxOutputBytes=40 * MIB, maxResponseBytes=60 * MIB)
        with self.assertRaisesRegex(ValueError, 'artifact|output|size'):
            self.render(size=46 * MIB, service=make_service(self.worker, config))
        with self.assertRaisesRegex((RuntimeError, ValueError), 'response|motion failed|output'):
            self.render(wire_size=60 * MIB + 1, service=make_service(self.worker, config))

    def test_alpha_does_not_raise_input_json_cap(self):
        handler = Handler(payload())
        handler.headers['Content-Length'] = str(48 * MIB + 1)
        self.worker.motion = self.service
        down, up = Pace(), Pace()
        adapter.paced_dispatch(handler, self.worker, down, up)
        self.assertEqual(handler.code, 413)
        self.assertEqual(down.sizes, [])

    def test_direct_service_also_rejects_overlarge_stdin(self):
        real_dumps = json.dumps
        class SizedJson(str):
            def encode(self, *args, **kwargs):
                return SizedBytes(super().encode(*args, **kwargs), 48 * MIB + 1)
        with patch.object(json, 'dumps', side_effect=lambda value: SizedJson(real_dumps(value))), \
             patch.object(transport.subprocess, 'Popen', return_value=process()) as spawn:
            with self.assertRaisesRegex(ValueError, 'body|input'):
                self.service.render(payload())
            spawn.assert_not_called()

    def test_assets_stay_at_32mib_total_and_per_file(self):
        for sizes in ([32 * MIB + 1], [17 * MIB, 16 * MIB]):
            self.service = make_service(self.worker)
            data = payload(assets=[{'data': 'eA=='} for _ in sizes])
            with self.subTest(sizes=sizes), \
                 patch.object(base64, 'b64decode', side_effect=[SizedBytes(b'x', n) for n in sizes]), \
                 patch.object(transport.subprocess, 'Popen', return_value=process()) as spawn:
                with self.assertRaisesRegex(ValueError, 'input|asset'):
                    self.service.render(data)
                spawn.assert_not_called()

    def test_request_kind_and_format_cannot_infer_or_downgrade_alpha(self):
        for data in (payload(format='mp4'), payload(kind='unknown-v1'),
                     {k: v for k, v in payload().items() if k != 'kind'}):
            self.service = make_service(self.worker)
            with self.subTest(data=data), patch.object(transport.subprocess, 'Popen', return_value=process()) as spawn:
                with self.assertRaisesRegex(ValueError, 'kind|format|alpha|protocol'):
                    self.service.render(data)
                spawn.assert_not_called()

    def test_receipt_protocol_kind_format_and_codec_mismatches_fail_closed(self):
        for updates in ({'kind': OPAQUE}, {'format': 'mp4'}, {'version': 2},
                        {'contract': 'wrong'}, {'id': 'c' * 32},
                        {'probe': {'codec': 'h264', 'profile': 'High', 'pixFmt': 'yuv420p'}},
                        {'probe': {'codec': 'prores', 'profile': '422', 'pixFmt': 'yuv422p10le'}},
                        {'probe': None}, {'backend': 'software'}, {'data': ''}, {'sha256': '0' * 64}):
            self.service = make_service(self.worker)
            with self.subTest(updates=updates), self.assertRaisesRegex(ValueError, 'receipt|protocol|alpha|output|artifact'):
                self.render(receipt(**updates))

    def test_opaque_keeps_original_caps_even_on_alpha_capable_dispatcher(self):
        data = {k: v for k, v in payload().items() if k not in ('kind', 'format')}
        result = {k: v for k, v in receipt(data).items() if k not in ('kind', 'format')}
        result['probe'] = {'codec_name': 'h264', 'profile': 'High', 'pix_fmt': 'yuv420p'}
        self.render(result, data, size=32 * MIB)
        for size, wire_size in ((32 * MIB + 1, 1000), (1, 48 * MIB + 1)):
            self.service = make_service(self.worker)
            with self.subTest(size=size), self.assertRaises((ValueError, RuntimeError)):
                self.render(result, data, size=size, wire_size=wire_size)

    def test_alpha_receipt_cannot_enlarge_an_opaque_request(self):
        data = {k: v for k, v in payload().items() if k not in ('kind', 'format')}
        with self.assertRaisesRegex(ValueError, 'kind|protocol|output|receipt'):
            self.render(receipt(), data)

    def test_custom_file_and_total_output_caps_apply_below_alpha_hardcap(self):
        for file_mb, total_mb in ((40, 512), (256, 40)):
            owner = worker(file_mb, total_mb)
            with self.subTest(file_mb=file_mb), self.assertRaisesRegex(ValueError, 'custom output cap'):
                self.render(size=46 * MIB, service=make_service(owner))

    def test_custom_input_file_and_total_caps_apply_before_start(self):
        for file_mb, total_mb, sizes in ((1, 512, [2 * MIB]), (256, 1, [MIB, MIB])):
            owner = worker(file_mb, total_mb)
            data = payload(assets=[{'data': 'eA=='} for _ in sizes])
            with self.subTest(file_mb=file_mb), \
                 patch.object(base64, 'b64decode', side_effect=[SizedBytes(b'x', n) for n in sizes]), \
                 patch.object(transport.subprocess, 'Popen', return_value=process()) as spawn:
                with self.assertRaisesRegex(ValueError, 'custom input cap'):
                    make_service(owner).render(data)
                spawn.assert_not_called()

    def test_shared_lease_charges_once_and_rejects_concurrent_alpha(self):
        def active():
            self.assertEqual(self.worker.busy, {'cpu': 18, 'gpu': 6})
            with self.assertRaisesRegex(RuntimeError, 'motion busy'):
                self.service.render(payload(id='b' * 32))
        with patch.object(transport.subprocess, 'Popen', return_value=process(callback=active)) as spawn:
            self.service.render(payload())
        self.assertEqual(spawn.call_count, 1)
        self.assertEqual(self.worker.busy, {'cpu': 17, 'gpu': 5})
        self.assertFalse(self.service.slot.locked())

    def test_cancel_of_job_that_already_exited_or_dies_slowly_does_not_quarantine(self):
        # Race: job exits between poll() and taskkill (taskkill then fails), or the tree needs >2 s.
        for name, kill_code, wait_effect in [('exited', 128, None), ('slow', 0, 'slow')]:
            with self.subTest(name):
                job = Mock()
                state = {'alive': True}
                job.poll.side_effect = lambda: None if state['alive'] else 0
                def wait(timeout=None):
                    state['alive'] = False
                    return 0
                job.wait.side_effect = wait
                def run(*a, **k):
                    if name == 'exited': state['alive'] = False
                    return SimpleNamespace(returncode=kill_code)
                self.service.jobs['c' * 32] = job
                with patch.object(transport.subprocess, 'run', side_effect=run), patch.object(transport.os, 'name', 'nt'):
                    self.assertEqual(self.service.cancel('c' * 32), {'terminated': True})
                self.assertFalse(self.service.quarantined)
                self.service.jobs.pop('c' * 32, None)

    def test_cancel_quarantines_only_while_job_proven_alive(self):
        job = Mock()
        job.poll.return_value = None
        job.wait.side_effect = transport.subprocess.TimeoutExpired('x', 15)
        self.service.jobs['d' * 32] = job
        with patch.object(transport.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), patch.object(transport.os, 'name', 'nt'):
            with self.assertRaisesRegex(RuntimeError, 'termination unconfirmed'):
                self.service.cancel('d' * 32)
        self.assertTrue(self.service.quarantined)

    def test_cpu_or_gpu_full_never_spawns(self):
        for busy in ({'cpu': 18, 'gpu': 5}, {'cpu': 17, 'gpu': 6}):
            self.worker.busy = busy.copy()
            with patch.object(transport.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, 'shared GPU unavailable'):
                    self.service.render(payload())
                spawn.assert_not_called()
            self.assertEqual(self.worker.busy, busy)

    def test_owned_delete_fences_late_post_without_any_start(self):
        handler = Handler(path='/motion/' + payload()['id'], command='DELETE')
        transport.dispatch_motion(handler, self.service, None)
        self.assertEqual(handler.responses, [{'terminated': True}])
        with patch.object(transport.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'cancelled or replay'):
                self.service.render(payload())
            spawn.assert_not_called()

    def test_delete_during_communicate_cannot_publish_a_success(self):
        proc = process(callback=lambda: self.service.cancel(payload()['id']))
        with patch.object(transport.subprocess, 'Popen', return_value=proc):
            with self.assertRaisesRegex(RuntimeError, 'cancelled'):
                self.service.render(payload())
        self.assertEqual(self.worker.busy, {'cpu': 17, 'gpu': 5})

    def test_confirmed_deadline_termination_releases_original_lease(self):
        proc = process()
        proc.poll.return_value = None
        proc.communicate.side_effect = [subprocess.TimeoutExpired('offline', 1), (b'', b'')]
        with patch.object(transport.subprocess, 'Popen', return_value=proc), \
             patch.object(transport.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
             patch.object(transport.os, 'killpg', create=True):
            with self.assertRaisesRegex(RuntimeError, 'native motion deadline'):
                self.service.render(payload())
        proc.wait.assert_called_once()
        self.assertFalse(self.service.quarantined)
        self.assertFalse(self.service.slot.locked())
        self.assertEqual(self.worker.busy, {'cpu': 17, 'gpu': 5})

    def test_unconfirmed_kill_quarantines_without_freeing_accounting_or_directory(self):
        proc = process()
        proc.poll.return_value = None
        proc.communicate.side_effect = subprocess.TimeoutExpired('offline', 1)
        directory = SimpleNamespace(name='not-created-tempdir', cleanup=Mock())
        with patch.object(transport.subprocess, 'Popen', return_value=proc), \
             patch.object(transport.tempfile, 'TemporaryDirectory', return_value=directory), \
             patch.object(transport.subprocess, 'run', side_effect=RuntimeError('offline kill failure')), \
             patch.object(transport.os, 'killpg', side_effect=RuntimeError('offline kill failure'), create=True):
            with self.assertRaisesRegex(RuntimeError, 'termination unconfirmed'):
                self.service.render(payload())
        self.assertTrue(self.service.quarantined)
        self.assertTrue(self.service.slot.locked())
        self.assertEqual(self.worker.busy, {'cpu': 18, 'gpu': 6})
        directory.cleanup.assert_not_called()
        self.assertIn(directory, vars(self.service).values())
        with self.assertRaisesRegex(RuntimeError, 'motion busy'):
            self.service.render(payload(id='b' * 32))

    def test_native_failure_and_invalid_receipt_do_not_leak_a_lease(self):
        with patch.object(transport.subprocess, 'Popen', return_value=process(returncode=1)):
            with self.assertRaisesRegex(RuntimeError, 'native motion failed'):
                self.service.render(payload())
        self.assertEqual(self.worker.busy, {'cpu': 17, 'gpu': 5})
        self.assertFalse(self.service.slot.locked())

    def test_paced_reads_and_writes_keep_256kib_chunks_and_restore_handler(self):
        data = payload(assets=[{'data': base64.b64encode(b'x' * (300 * 1024)).decode()}])
        result = receipt(data, data=base64.b64encode(b'x' * (300 * 1024)).decode(),
                         sha256=hashlib.sha256(b'x' * (300 * 1024)).hexdigest())
        self.worker.motion = self.service
        handler, down, up = Handler(data), Pace(), Pace()
        original = handler.respond
        with patch.object(transport.subprocess, 'Popen', return_value=process(result)):
            adapter.paced_dispatch(handler, self.worker, down, up)
        self.assertEqual(handler.code, 200)
        self.assertEqual(sum(down.sizes), int(handler.headers['Content-Length']))
        self.assertEqual(sum(up.sizes), len(handler.wfile.getvalue()))
        self.assertTrue(all(0 < n <= 256 * 1024 for n in down.sizes + up.sizes))
        self.assertGreater(len(up.sizes), 1)
        self.assertEqual(handler.respond, original)

    def test_cancelled_or_health_response_cannot_use_alpha_response_budget(self):
        self.worker.motion = self.service
        handler = Handler(path='/motion/health', command='GET')
        real_dumps = json.dumps
        class SizedJson(str):
            def encode(self, *args, **kwargs):
                return SizedBytes(super().encode(*args, **kwargs), 48 * MIB + 1)
        with patch.object(json, 'dumps', side_effect=lambda value: SizedJson(real_dumps(value))):
            with self.assertRaisesRegex(ValueError, 'response cap'):
                adapter.paced_dispatch(handler, self.worker, Pace(), Pace())


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for folder in ('motion-offload', 'map-offload'):
            (self.root / folder).mkdir()
        for name in ('transport.py', 'adapter.py'):
            shutil.copy2(ROOT / 'motion-offload' / name, self.root / 'motion-offload' / name)
        # Existing read-only Map facade is intentionally unchanged.
        shutil.copy2(FROZEN / 'map-offload/service.py', self.root / 'map-offload/service.py')
        self.worker = worker()
        self.write_runtime(CONFIG)

    def write_runtime(self, config):
        (self.root / 'motion-offload/runtime.json').write_text(json.dumps(dict(config, node='not-executed-node')))
        (self.root / 'map-offload/runtime.json').write_text(json.dumps({'node': 'not-executed-node', 'contract': 'map-test'}))

    def create(self):
        return bootstrap.attach_graphics(self.worker, self.root)

    def test_bootstrap_passes_runtime_capabilities_into_one_cached_motion_service(self):
        graphics = self.create()
        handler = Handler(path='/motion/health', command='GET')
        graphics.dispatch(handler, Pace(), Pace())
        self.assertIn(ALPHA, json.loads(handler.wfile.getvalue())['kinds'])
        self.assertIs(graphics.motion.slot, graphics.maps.slot)
        self.assertIs(graphics.motion.acquire_gpu, graphics.maps.acquire_gpu)
        self.assertEqual(graphics.motion.command[1], str(self.root / 'motion-offload/worker.mjs'))
        self.assertFalse(hasattr(graphics, 'alpha'))
        self.write_runtime({'contract': CONTRACT})
        # A runtime edit must not mutate a service/command already constructed.
        handler = Handler(path='/motion/health', command='GET')
        graphics.dispatch(handler, Pace(), Pace())
        self.assertIn(ALPHA, json.loads(handler.wfile.getvalue())['kinds'])

    def test_old_runtime_does_not_gain_alpha_and_map_health_never_advertises_it(self):
        self.write_runtime({'contract': CONTRACT})
        graphics = self.create()
        for path in ('/motion/health', '/map/health'):
            handler = Handler(path=path, command='GET')
            graphics.dispatch(handler, Pace(), Pace())
            self.assertNotIn(ALPHA, json.loads(handler.wfile.getvalue()).get('kinds', []))
            self.assertEqual(handler.path, path)

    def test_alpha_and_maps_use_same_shared_lease_and_health_accounting(self):
        graphics = self.create()
        release = graphics.motion.acquire_gpu()
        self.assertEqual(self.worker.busy, {'cpu': 18, 'gpu': 6})
        self.assertEqual(self.worker.health()['graphicsBusy'], 1)
        self.assertIsNone(graphics.maps.acquire_gpu())
        release()
        release()
        self.assertEqual(self.worker.busy, {'cpu': 17, 'gpu': 5})
        self.assertEqual(self.worker.health()['graphicsBusy'], 0)
        self.assertEqual(self.worker.health()['completedGpu'], 9)
        self.assertEqual(self.worker.health()['completedNvenc'], 7)

    def test_only_valid_alpha_completion_increments_its_separate_counter(self):
        graphics = self.create()
        with patch.object(transport.subprocess, 'Popen', return_value=process()):
            graphics.motion.render(payload())
        health = graphics.health()
        self.assertEqual(health.get('completedAlpha'), 1)
        self.assertEqual(health['completedMotion'], 0)
        self.assertEqual(health['completedMap'], 0)
        for identifier, updates in [('c' * 32, {'format': 'mp4'}), ('d' * 32, {'probe': {'codec': 'h264'}})]:
            data = payload(id=identifier)
            with patch.object(transport.subprocess, 'Popen', return_value=process(receipt(data, **updates))):
                with self.assertRaises(ValueError):
                    graphics.motion.render(data)
        self.assertEqual(graphics.health()['completedAlpha'], 1)

    def test_custom_cap_rejection_is_not_counted_as_completed_alpha(self):
        self.worker.transfer_limits.get = lambda: {'ffmpegMaxFileMb': 40, 'ffmpegMaxTotalMb': 512}
        graphics = self.create()
        with patch.object(transport.subprocess, 'Popen', return_value=process()), \
             patch.object(base64, 'b64decode', return_value=SizedBytes(b'x', 46 * MIB)):
            with self.assertRaisesRegex(ValueError, 'custom output cap'):
                graphics.motion.render(payload())
        self.assertEqual(graphics.health().get('completedAlpha'), 0)

    def test_map_opaque_caps_and_success_counters_are_unchanged(self):
        graphics = self.create()
        data = {'id': 'b' * 32, 'contract': 'map-test', 'timeoutMs': 1000}
        result = dict(receipt(data), contract='map-test', backend='Vulkan GPU',
                      probe={'codec_name': 'h264'}, cleanupConfirmed=True)
        result.pop('kind')
        result.pop('format')
        with patch.object(transport.subprocess, 'Popen', return_value=process(result)):
            graphics.maps.render(data)
        self.assertEqual(graphics.health()['completedMap'], 1)
        with patch.object(transport.subprocess, 'Popen', return_value=process(result)), \
             patch.object(base64, 'b64decode', return_value=SizedBytes(b'x', 32 * MIB + 1)):
            with self.assertRaises(ValueError):
                graphics.maps.render(dict(data, id='c' * 32))
        self.assertEqual(graphics.health()['completedMap'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
