import asyncio
import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

CORE = Path(__file__).resolve().parents[1] / 'fflow'
FILE = CORE / 'pc_node_normalize_cli.py'
sys.path.insert(0, str(CORE))
FILTER = 'crop=1920:1000:0:40,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080'


class NormalizeCliTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.assertTrue(FILE.is_file(), 'offload-only native normalization CLI is missing')
        spec = importlib.util.spec_from_file_location('node_normalize_cli', FILE)
        self.cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cli)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.projects = self.data / 'projects'
        self.projects.mkdir()
        self.source = self.projects / 'source.mp4'
        self.source.write_bytes(b'synthetic-input-unchanged')
        self.output = self.projects / 'normalized.mp4'
        self.env = patch.dict(os.environ, {'DATA_DIR': str(self.data)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.request = {'argv': ['-y', '-i', str(self.source), '-vf', FILTER,
            '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-crf', '17',
            '-pix_fmt', 'yuv420p', '-r', '24', '-c:a', 'aac', '-b:a', '192k',
            '-t', '2.000', '-movflags', '+faststart', str(self.output)],
            'options': {'timeoutMs': 180000}}

    def encoded(self, request=None):
        return base64.b64encode(json.dumps(self.request if request is None else request).encode()).decode()

    def fake_hook(self, result=(0, 'PC boost gpu output verified'), health=None):
        calls = []
        original_selector = lambda payload, output, health: None
        module = types.SimpleNamespace(select_gpu_policy=original_selector)
        async def attempt(command, **kwargs):
            payload = {}
            module.select_gpu_policy(payload, Path(command[-1]), health or {
                'nvencReady': True, 'gpuMode': 'nvenc-high-qp14-v1'})
            calls.append((command, kwargs, payload))
            if result:
                Path(command[-1]).write_bytes(b'verified-output')
            return result
        module.try_offload = attempt
        return module, calls, original_selector

    def test_exact_native_recipe_is_qualified_without_rewriting(self):
        before = copy.deepcopy(self.request)
        value = self.cli.qualify(self.request)
        self.assertEqual(value['argv'], self.request['argv'])
        self.assertEqual(value['duration'], 2.0)
        self.assertEqual(value['root'], self.projects.resolve())
        self.assertEqual(self.request, before)

    def test_native_crf_range_and_plain_normalization_are_supported(self):
        for crf in ('0', '17', '51'):
            request = copy.deepcopy(self.request)
            request['argv'][12] = crf
            request['argv'][4] = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080'
            self.assertEqual(self.cli.qualify(request)['argv'][12], crf)

    def test_other_commands_fps_audio_and_timing_are_rejected(self):
        for index, bad in ((0,'-n'),(6,'0:v?'),(8,'0:a:0'),(10,'h264_nvenc'),
                           (12,'52'),(12,'017'),(14,'yuv444p'),(16,'30'),
                           (18,'copy'),(20,'256k'),(22,'2'),(22,'0.000'),
                           (22,'nan'),(24,'faststart')):
            request = copy.deepcopy(self.request)
            request['argv'][index] = bad
            with self.subTest(index=index, bad=bad), self.assertRaises(ValueError):
                self.cli.qualify(request)

    def test_extra_flags_inputs_and_executable_prefix_are_rejected(self):
        for extra, position in ((['-i',str(self.source)],3),(['-ss','0'],1),
                                (['-preset','fast'],13),(['ffmpeg'],0)):
            request = copy.deepcopy(self.request)
            request['argv'][position:position] = extra
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.cli.qualify(request)

    def test_only_closed_native_crop_scale_filters_are_supported(self):
        for value in ('hflip', 'scale=640:360', FILTER+',fps=30', FILTER+',zoompan=z=2',
                      'movie=/etc/passwd', 'drawtext=textfile=/etc/passwd',
                      FILTER+';null', FILTER+'\n', 'crop=0:1000:0:40,'+FILTER):
            request = copy.deepcopy(self.request)
            request['argv'][4] = value
            with self.subTest(filter=value), self.assertRaises(ValueError):
                self.cli.qualify(request)

    def test_options_are_the_exact_native_timeout_only(self):
        for options in ({}, {'timeoutMs':180001}, {'timeoutMs':True}, {'timeoutMs':1000},
                        {'timeoutMs':180000,'shell':True}):
            request = copy.deepcopy(self.request)
            request['options'] = options
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.cli.qualify(request)

    def test_paths_must_be_regular_distinct_mp4s_inside_projects(self):
        outside = self.data / 'outside.mp4'
        outside.write_bytes(b'outside')
        for index, path in ((2,str(outside)),(25,str(outside)),(2,'https://example.test/file.mp4'),
                            (2,str(self.source.with_suffix('.mov'))),(25,str(self.output.with_suffix('.mkv'))),
                            (25,str(self.source)),(2,str(self.projects/'..'/'outside.mp4'))):
            request = copy.deepcopy(self.request)
            request['argv'][index] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.cli.qualify(request)

    def test_symlink_and_hardlink_input_output_collisions_are_rejected(self):
        hardlink = self.projects / 'hardlink.mp4'
        os.link(self.source, hardlink)
        request = copy.deepcopy(self.request)
        request['argv'][-1] = str(hardlink)
        with self.assertRaises(ValueError):self.cli.qualify(request)
        link = self.projects / 'link.mp4'
        try:link.symlink_to(self.source)
        except OSError:return
        for index in (2,25):
            request = copy.deepcopy(self.request)
            request['argv'][index] = str(link)
            with self.assertRaises(ValueError):self.cli.qualify(request)

    def test_strict_base64_json_and_duplicate_keys(self):
        for raw in ('not-base64', '', base64.b64encode(b'[]').decode(),
                    base64.b64encode(b'{"argv":[],"argv":[],"options":{}}').decode(),
                    'A'*131073):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):self.cli.decode_request(raw)
        self.assertEqual(self.cli.decode_request(self.encoded()), self.request)

    async def test_valid_offload_keeps_original_fps_audio_source_and_roots(self):
        module, calls, selector = self.fake_hook()
        before = self.source.read_bytes()
        result = await self.cli.offload(self.request, hook=module)
        self.assertTrue(result['offloaded'])
        self.assertEqual(result['metadata']['lane'], 'gpu')
        self.assertEqual(calls[0][0], ['ffmpeg', *self.request['argv']])
        self.assertEqual(calls[0][1]['roots'], [self.projects.resolve()])
        self.assertEqual(calls[0][1]['timeout'], 180)
        self.assertEqual(calls[0][1]['expected_duration'], 2)
        self.assertEqual(calls[0][2]['gpuPolicy'], 'nvenc-high-qp14-v1')
        self.assertIs(module.select_gpu_policy, selector)
        self.assertEqual(self.source.read_bytes(), before)

    async def test_invalid_request_never_imports_or_calls_the_hook(self):
        request = copy.deepcopy(self.request)
        request['argv'][16] = '30'
        with patch.object(self.cli, '_load_hook', side_effect=AssertionError('must not import')):
            self.assertFalse((await self.cli.offload(request))['offloaded'])

    async def test_remote_failure_never_starts_native_fallback(self):
        module, calls, _ = self.fake_hook(result=None)
        with patch('asyncio.create_subprocess_exec', side_effect=AssertionError('native fallback forbidden')):
            result = await self.cli.offload(self.request, hook=module)
        self.assertFalse(result['offloaded'])
        self.assertEqual(len(calls), 1)
        self.assertFalse(self.output.exists())

    async def test_unverified_success_is_not_accepted(self):
        for remote in ((0,'completed'),(1,'PC boost gpu output verified')):
            module, _, _ = self.fake_hook(result=remote)
            self.assertFalse((await self.cli.offload(self.request, hook=module))['offloaded'])

    async def test_worker_health_policy_is_not_relaxed(self):
        for health in ({'nvencReady':False,'gpuMode':'nvenc-high-qp14-v1'},
                       {'nvencReady':True,'gpuMode':'lossless'}):
            module, calls, _ = self.fake_hook(health=health)
            await self.cli.offload(self.request, hook=module)
            self.assertNotIn('gpuPolicy', calls[0][2])

    async def test_cancellation_awaits_hook_cleanup_and_restores_selector(self):
        module, _, selector = self.fake_hook()
        started, cleaned = asyncio.Event(), asyncio.Event()
        async def attempt(*args, **kwargs):
            started.set()
            try:await asyncio.Future()
            finally:cleaned.set()
        module.try_offload = attempt
        task = asyncio.create_task(self.cli.offload(self.request, hook=module))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        self.assertTrue(cleaned.is_set())
        self.assertIs(module.select_gpu_policy, selector)

    async def test_actual_existing_hook_deletes_submitted_render_on_cancellation(self):
        import pc_ffmpeg_hook as real
        submitted = asyncio.Event()
        loop = asyncio.get_running_loop()
        requests = []
        original_try = real.try_offload
        async def authenticated_fixture(command, **kwargs):
            return await original_try(command, **kwargs, token='fixture-only',
                                      url='http://fixture.invalid', settings={'enabled':True})
        def request(url, token, method, path, *args):
            requests.append((method,path))
            if path == '/health':
                return {'ready':True,'config':{'enabled':True},'protocolVersion':2,
                        'nvencReady':True,'gpuMode':'nvenc-high-qp14-v1',
                        'gpuBusy':0,'gpuCapacity':1,'cpuBusy':0,'cpuCapacity':1}
            if method == 'POST' and path == '/renders':
                loop.call_soon_threadsafe(submitted.set)
                return {'id':'fixture-render'}
            if method == 'GET':return {'state':'running'}
            return {'ok':True}
        payload = {'argv':[], 'files':{'@0.mp4':{'size':24,'sha256':'0'*64}}, 'gpuEligible':False}
        with patch.object(real,'try_offload',authenticated_fixture), \
             patch.object(real,'http_request',side_effect=request), \
             patch.object(real,'prepare_request',return_value=(payload,self.output,{})), \
             patch.object(real,'upload_with_lane',return_value=None):
            task = asyncio.create_task(self.cli.offload(self.request, hook=real))
            await asyncio.wait_for(submitted.wait(),2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
        self.assertIn(('DELETE','/renders/fixture-render'), requests)

    async def test_verified_home_cpu_is_also_an_offload_not_native_fallback(self):
        module, _, _ = self.fake_hook(result=(0,'PC boost cpu output verified'))
        result = await self.cli.offload(self.request, hook=module)
        self.assertTrue(result['offloaded'])
        self.assertEqual(result['metadata']['lane'], 'cpu')

    async def test_existing_input_caps_reject_before_any_worker_request(self):
        import pc_ffmpeg_hook as real
        with self.source.open('wb') as stream:stream.truncate(2*1024*1024)
        original_try = real.try_offload
        async def fixture(command, **kwargs):
            return await original_try(command, **kwargs, token='fixture-only',
                                      url='http://fixture.invalid', settings={'enabled':True})
        limits = {'ffmpegMaxFileMb':1,'ffmpegMaxTotalMb':1,
                  'sceneMaxFileMb':400,'siglipMaxImageMb':20}
        with patch.object(real,'try_offload',fixture), \
             patch.object(real,'read_transfer_limits',return_value=limits), \
             patch.object(real,'http_request',side_effect=AssertionError('must not contact worker')):
            result = await self.cli.offload(self.request, hook=real)
        self.assertFalse(result['offloaded'])
        self.assertFalse(self.output.exists())

    def test_pure_hook_import_does_not_load_fflow_configuration_or_worker(self):
        before = set(sys.modules)
        self.cli._load_hook()
        added = set(sys.modules)-before
        self.assertFalse(added & {'src.core.config','src.queue.worker','src.core.composer'})

    async def test_cli_timeout_cancels_offload_instead_of_running_native(self):
        cleaned = asyncio.Event()
        async def wait(request):
            try:await asyncio.Future()
            finally:cleaned.set()
        result = await self.cli.run_request(self.request, attempt=wait, timeout=.01)
        self.assertFalse(result['offloaded'])
        self.assertEqual(result['metadata']['reason'], 'timeout')
        self.assertTrue(cleaned.is_set())

    async def test_cli_errors_do_not_echo_exception_secrets(self):
        async def fail(request):raise RuntimeError('Bearer private-test-secret')
        result = await self.cli.run_request(self.request, attempt=fail)
        self.assertFalse(result['offloaded'])
        self.assertNotIn('private-test-secret', json.dumps(result))

    @unittest.skipUnless(os.name == 'posix', 'POSIX signal handler qualification')
    async def test_sigterm_cancels_own_task_and_awaits_cleanup(self):
        cleaned = asyncio.Event()
        async def wait(request):
            asyncio.get_running_loop().call_later(.01, os.kill, os.getpid(), signal.SIGTERM)
            try:await asyncio.Future()
            finally:cleaned.set()
        result = await self.cli.run_request(self.request, attempt=wait)
        self.assertEqual(result['metadata']['reason'], 'cancelled')
        self.assertTrue(cleaned.is_set())

    def test_stdout_is_only_one_json_record(self):
        stdout = io.StringIO()
        with contextlib_redirect(stdout):
            code = self.cli.main(['invalid'])
        self.assertEqual(code, 0)
        record = json.loads(stdout.getvalue())
        self.assertEqual(set(record), {'offloaded','metadata'})
        self.assertFalse(record['offloaded'])


def contextlib_redirect(stream):
    from contextlib import redirect_stdout
    return redirect_stdout(stream)


if __name__ == '__main__':unittest.main()
