import ast
import asyncio
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch


CORE = Path(__file__).resolve().parents[1] / 'fflow'


def functions(file, names, namespace):
    tree = ast.parse((CORE / file).read_text(encoding='utf-8'))
    tree.body = [node for node in tree.body
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    exec(compile(tree, str(CORE / file), 'exec'), namespace)
    return namespace


class FflowModGateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        paths = patch.object(sys, 'path', [str(CORE), *sys.path])
        paths.start()
        self.addCleanup(paths.stop)

    def hook(self):
        with patch.object(sys, 'path', [str(CORE), *sys.path]):
            spec = importlib.util.spec_from_file_location('fixture_mod_gate_hook', CORE / 'pc_ffmpeg_hook.py')
            hook = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(hook)
        return hook

    async def test_disabled_ffmpeg_returns_native_before_preparation_or_http(self):
        hook = self.hook()
        with patch.object(hook, 'mod_enabled', return_value=False, create=True) as flag, \
             patch.object(hook, 'prepare_request', side_effect=ValueError('fixture')) as prepare, \
             patch.object(hook, 'http_request') as http:
            self.assertIsNone(await hook.try_offload(['ffmpeg'], settings={'enabled': True}))
        prepare.assert_not_called()
        http.assert_not_called()
        flag.assert_called_once_with('homeFfmpeg')

    async def test_disabled_ffmpeg_does_not_swallow_preexisting_cancellation(self):
        hook = self.hook()
        canceled = asyncio.Event()
        canceled.set()
        with patch.object(hook, 'mod_enabled', return_value=False, create=True):
            with self.assertRaises(asyncio.CancelledError):
                await hook.try_offload([], cancellation_event=canceled)

    async def test_admitted_ffmpeg_completes_publish_and_delete_without_regating(self):
        hook = self.hook()
        calls = []
        health = {'ready': True, 'config': {'enabled': True}, 'protocolVersion': 2,
                  'cpuBusy': 0, 'cpuCapacity': 1}
        def request(url, token, method, route, *args):
            calls.append((method, route))
            if route == '/health':
                return health
            if method == 'POST':
                flag.return_value = False
                return {'id': 'fixture-render'}
            return {'state': 'done', 'lane': 'cpu'}
        payload = {'files': {'@0.mp4': {'size': 10}}, 'argv': []}
        with patch.object(hook, 'mod_enabled', return_value=True, create=True) as flag, \
             patch.object(hook, 'prepare_request', return_value=(payload, Path('output.mp4'), {})), \
             patch.object(hook, 'select_gpu_policy'), \
             patch.object(hook, 'http_request', side_effect=request), \
             patch.object(hook, 'upload_with_lane'), \
             patch.object(hook, 'download_and_publish', new_callable=AsyncMock) as publish:
            result = await hook.try_offload(['ffmpeg'], settings={'enabled': True},
                                            url='http://fixture', token='fixture')
        self.assertEqual(result, (0, 'PC boost cpu output verified'))
        publish.assert_awaited_once()
        self.assertIn(('DELETE', '/renders/fixture-render'), calls)
        flag.assert_called_once_with('homeFfmpeg')

    async def test_disabled_scene_returns_native_before_any_controls_or_io(self):
        flag = Mock(return_value=False)
        settings = Mock(side_effect=AssertionError('No settings or media I/O when disabled'))
        namespace = functions('pc_scene_hook.py', ['try_scene_offload'], {
            'mod_enabled': flag, 'time': SimpleNamespace(monotonic=lambda: 0),
            'PC_SCENE_BUDGET': 230, 'ffhook': SimpleNamespace(runtime_settings=settings),
        })
        self.assertIsNone(await namespace['try_scene_offload']('unused.mp4', 27))
        settings.assert_not_called()
        flag.assert_called_once_with('homeScenes')

    async def test_disabled_home_pool_manager_does_not_open_runtime_or_redis(self):
        flag = Mock(return_value=False)
        io = Mock(side_effect=AssertionError('Disabled pool must not start'))
        namespace = functions('pc_home_pool.py', ['manage'], {'mod_enabled': flag, 'Path': io})
        await namespace['manage']()
        io.assert_not_called()
        flag.assert_called_once_with('homeQueue')

    async def test_disabled_home_consumer_never_starts_or_claims(self):
        started = AsyncMock()
        class Worker:
            async def _process_job(self):
                pass
            async def _wait_for_job(self):
                pass
            start = started
        src, queue, worker = (ModuleType(name) for name in ('src', 'src.queue', 'src.queue.worker'))
        src.queue, queue.worker, worker.Worker = queue, worker, Worker
        flag, install = Mock(return_value=False), Mock()
        namespace = functions('pc_home_pool.py', ['consume'], {
            'mod_enabled': flag, 'install_home_consumer': install})
        with patch.dict(sys.modules, {'src': src, 'src.queue': queue, 'src.queue.worker': worker}):
            await namespace['consume']()
        install.assert_not_called()
        started.assert_not_awaited()
        flag.assert_called_once_with('homeQueue')


if __name__ == '__main__':
    unittest.main()
