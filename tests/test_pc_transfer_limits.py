import ast
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = dict(ffmpegMaxFileMb=64, ffmpegMaxTotalMb=96, sceneMaxFileMb=400, siglipMaxImageMb=20)
MIB = 1024 * 1024


def module():
    file = ROOT / 'fflow' / 'pc_transfer_limits.py'
    if not file.is_file():
        return None
    spec = importlib.util.spec_from_file_location('fixture_transfer_limits', file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def functions(file, names, namespace):
    namespace.setdefault('mod_enabled', lambda key: True)
    tree = ast.parse(file.read_text(encoding='utf-8'))
    tree.body = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    exec(compile(tree, str(file), 'exec'), namespace)
    return namespace


class TransferLimitsTests(unittest.TestCase):
    def setUp(self):
        self.api = module()

    def test_helper_exists(self):
        self.assertIsNotNone(self.api, 'Configurable per-file admission helper is missing')

    def test_numeric_bounds_unknown_keys_and_defaults(self):
        self.assertIsNotNone(self.api)
        self.assertEqual(self.api.validate_limits({}), DEFAULTS)
        for key, maximum in dict(ffmpegMaxFileMb=4096, ffmpegMaxTotalMb=4096, sceneMaxFileMb=4096, siglipMaxImageMb=128).items():
            self.assertEqual(self.api.validate_limits({key: maximum})[key], maximum)
            for value in (0, -1, maximum + 1, True, '64', 1.5):
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    self.api.validate_limits({key: value})
        with self.assertRaises(ValueError):
            self.api.validate_limits({'token': 'never'})

    def test_missing_file_defaults_but_invalid_file_fails_closed(self):
        self.assertIsNotNone(self.api)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'limits.json'
            self.assertEqual(self.api.read_limits(file, max_age=0), DEFAULTS)
            file.write_text('{broken', encoding='utf-8')
            with self.assertRaises(ValueError):
                self.api.read_limits(file, max_age=0)
            file.write_text(json.dumps({**DEFAULTS, 'sceneMaxFileMb': '400'}), encoding='utf-8')
            with self.assertRaises(ValueError):
                self.api.read_limits(file, max_age=0)

    def test_valid_runtime_envelope_and_explicit_scene_cap(self):
        self.assertIsNotNone(self.api)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'limits.json'
            file.write_text(json.dumps({**DEFAULTS, 'sceneMaxFileMb': 512, 'revision': '12345678-1234-1234-1234-123456789abc'}), encoding='utf-8')
            self.assertEqual(self.api.read_limits(file, max_age=0)['sceneMaxFileMb'], 512)
            self.assertEqual(self.api.scene_limit_bytes(400*MIB, 300, file=file, max_age=0), 512*MIB)
            file.unlink()
            self.assertEqual(self.api.scene_limit_bytes(400*MIB, 300, file=file, max_age=0), 300*MIB)

    def test_ffmpeg_individual_and_aggregate_bytes_exact_boundaries(self):
        self.assertIsNotNone(self.api)
        self.api.check_render_sizes([64*MIB, 32*MIB], DEFAULTS)
        for sizes in ([64*MIB+1], [64*MIB, 32*MIB+1], [0], [-1], [True], ['1']):
            with self.assertRaises(ValueError):
                self.api.check_render_sizes(sizes, DEFAULTS)
        self.api.check_render_sizes([128*MIB], {**DEFAULTS, 'ffmpegMaxFileMb': 128, 'ffmpegMaxTotalMb': 128})

    def test_existing_prepare_request_uses_configured_file_and_total_gates(self):
        self.assertIsNotNone(self.api)
        import hashlib
        namespace = functions(ROOT / 'fflow' / 'pc_ffmpeg_hook.py', ['contained', 'prepare_request'], {
            'Path': Path, 'hashlib': hashlib, 'MAX_INPUT': 64*MIB, 'MAX_TOTAL': 96*MIB,
            'read_transfer_limits': lambda: {**DEFAULTS, 'ffmpegMaxFileMb': 1, 'ffmpegMaxTotalMb': 2},
            'check_render_sizes': self.api.check_render_sizes, 'validate_argv': lambda *args: None,
        })
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.mp4'
            source.write_bytes(b'x' * (MIB + 1))
            with self.assertRaises(ValueError):
                namespace['prepare_request'](['ffmpeg', '-i', str(source), '-c:v', 'libx264', str(root/'out.mp4')], [root])
            source.write_bytes(b'x' * MIB)
            payload, _, _ = namespace['prepare_request'](['ffmpeg', '-i', str(source), '-c:v', 'libx264', str(root/'out.mp4')], [root])
            self.assertEqual(payload['files']['@0.mp4']['size'], MIB)
            self.assertFalse(payload['gpuEligible'])
            with self.assertRaises(ValueError):
                namespace['prepare_request'](['ffmpeg', '-i', str(source), '-i', str(source), '-i', str(source), '-c:v', 'libx264', str(root/'out.mp4')], [root])

    def test_remote_caps_must_be_known_before_transferring_above_old_physical_limits(self):
        self.assertIsNotNone(self.api)
        self.assertFalse(self.api.worker_allows_render([80*MIB], None))
        self.assertTrue(self.api.worker_allows_render([80*MIB], {**DEFAULTS, 'ffmpegMaxFileMb': 128, 'ffmpegMaxTotalMb': 128}))
        self.assertFalse(self.api.worker_allows_render([1], {**DEFAULTS, 'unknown': 1}))

    def test_siglip_image_size_is_separate_from_video_size_and_preserves_pixel_guards(self):
        self.assertIsNotNone(self.api)
        self.api.check_image_size(20*MIB, DEFAULTS)
        with self.assertRaises(ValueError):
            self.api.check_image_size(20*MIB+1, DEFAULTS)
        self.api.check_image_size(128*MIB, {**DEFAULTS, 'siglipMaxImageMb': 128})
        with self.assertRaises(ValueError):
            self.api.check_image_size(128*MIB+1, {**DEFAULTS, 'siglipMaxImageMb': 128})

    def test_scene_gate_returns_native_before_upload_for_oversize_and_invalid_config(self):
        self.assertIsNotNone(self.api)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory)/'source.mp4'
            file.write_bytes(b'x' * (MIB+1))
            namespace = functions(ROOT/'fflow'/'pc_scene_hook.py', ['try_scene_offload'], {
                'asyncio': asyncio, 'Path': Path, 'time': __import__('time'), 'PC_SCENE_BUDGET': 230,
                '_offline_until': 0, '_control': lambda: {},
                'SCENE_MAX_BYTES': 400*MIB, 'scene_limit_bytes': lambda *args: MIB,
                'os': os, 'urllib': __import__('urllib'),
            })
            self.assertIsNone(asyncio.run(namespace['try_scene_offload'](str(file), 27, settings={'enabled': True})))
            namespace['scene_limit_bytes'] = lambda *args: (_ for _ in ()).throw(ValueError('fixture invalid config'))
            namespace['ffhook'] = mock.Mock(NoBigSlot=ValueError)
            namespace['logger'] = mock.Mock()
            self.assertIsNone(asyncio.run(namespace['try_scene_offload'](str(file), 27, settings={'enabled': True})))

    def test_scene_gate_can_admit_above_original_400_only_with_confirmed_worker_limits(self):
        self.assertIsNotNone(self.api)
        sources, submitted = [], []
        file = mock.Mock()
        file.stat.return_value.st_size = 500*MIB
        limits = {**DEFAULTS, 'sceneMaxFileMb': 512}
        health = dict(sceneReady=True, sceneBusy=0, sceneCapacity=1, transferLimits=limits)
        async def health_probe(*args):
            return health
        def request(url, token, method, route, data=None, timeout=None):
            if method == 'POST':
                submitted.append(data)
                return {'id': 'fixture-scene'}
            return {'state': 'done', 'result': {'scenes': [], 'fps': 24, 'duration_sec': 12}}
        ffhook = mock.Mock(NoBigSlot=type('NoBigSlot', (Exception,), {}), http_request=request)
        namespace = functions(ROOT/'fflow'/'pc_scene_hook.py', ['try_scene_offload'], {
            'asyncio': asyncio, 'Path': lambda value: file, 'time': __import__('time'), 'PC_SCENE_BUDGET': 230,
            '_offline_until': 0, '_control': lambda: {}, 'PC_SCENE_SLOT_WAIT': 45,
            'SCENE_MAX_BYTES': 400*MIB, 'scene_limit_bytes': lambda *args: 512*MIB,
            'worker_allows_scene': self.api.worker_allows_scene, '_health': health_probe,
            '_sha256': lambda path: 'a'*64, '_upload': lambda *args: sources.append(args[2]),
            'ffhook': ffhook, '_validated': lambda result: result, 'logger': mock.Mock(),
            'os': os, 'urllib': __import__('urllib'),
        })
        value = asyncio.run(namespace['try_scene_offload']('source.mp4', 27, url='http://fixture', token='fixture', settings={'enabled': True}))
        self.assertEqual(value['duration_sec'], 12)
        self.assertEqual(sources[0]['source.mp4']['size'], 500*MIB)
        self.assertEqual(submitted[0]['source']['size'], 500*MIB)
        health.pop('transferLimits')
        sources.clear()
        self.assertIsNone(asyncio.run(namespace['try_scene_offload']('source.mp4', 27, url='http://fixture', token='fixture', settings={'enabled': True})))
        self.assertEqual(sources, [])

    def test_legacy_scene_disabled_switch_still_returns_native_before_new_control_read(self):
        namespace = functions(ROOT/'fflow'/'pc_scene_hook.py', ['try_scene_offload'], {
            'asyncio': asyncio, 'time': __import__('time'), 'PC_SCENE_BUDGET': 230,
            '_offline_until': 0, '_control': lambda: {'enabled': False, 'maxMb': 400},
        })
        self.assertIsNone(asyncio.run(namespace['try_scene_offload']('does-not-need-to-exist.mp4', 27, settings={'enabled': True})))


if __name__ == '__main__':
    unittest.main()
