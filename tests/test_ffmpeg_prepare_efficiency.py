import asyncio
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

CORE = Path(__file__).resolve().parents[1] / 'fflow'


def hook_module():
    with patch.object(sys, 'path', [str(CORE), *sys.path]):
        spec = importlib.util.spec_from_file_location('prepare_efficiency_hook', CORE / 'pc_ffmpeg_hook.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class NativeImagePreparationTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_images_do_not_hash_or_upload_the_source(self):
        hook = hook_module()
        with patch.object(hook, 'mod_enabled', return_value=True), \
             patch.object(hook, 'prepare_request', return_value=({}, Path('frame.png'), {})) as prepare, \
             patch.object(hook, 'http_request') as request:
            for suffix in hook.IMAGE_SUFFIXES:
                result = await hook.try_offload(['ffmpeg', '-i', '/original/clip.mp4', '-frames:v', '1', '/output/frame'+suffix],
                                                settings={'enabled': True})
                self.assertIsNone(result)
        prepare.assert_not_called()
        request.assert_not_called()

    async def test_cancellation_precedes_native_image_fastpath(self):
        hook = hook_module()
        event = asyncio.Event()
        event.set()
        with self.assertRaises(asyncio.CancelledError):
            await hook.try_offload(['ffmpeg', '/output/frame.png'], cancellation_event=event)

    async def test_video_requests_keep_existing_preparation(self):
        hook = hook_module()
        with patch.object(hook, 'mod_enabled', return_value=True), \
             patch.object(hook, 'prepare_request', side_effect=ValueError('Original native fallback')) as prepare:
            self.assertIsNone(await hook.try_offload(['ffmpeg', '-i', '/original/clip.mp4', '/output/clip.mp4'],
                                                   settings={'enabled': True}))
        prepare.assert_called_once()


class TransferCacheFreshnessTests(unittest.TestCase):
    def test_big_transfer_rechecks_under_owned_slot_and_skips_present_inputs(self):
        hook = hook_module()
        files = {'@0.mp4': {'sha256': 'a'*64, 'size': hook.MAX_TRANSFER+1}}
        slot = Mock()
        with patch.object(hook, 'missing_blobs', side_effect=[files, {}]) as missing, \
             patch.object(hook, 'acquire_big_slot', return_value=slot), \
             patch.object(hook, 'upload_blobs') as upload:
            hook.upload_with_lane('fixture', 'fixture', files, {})
        self.assertEqual(missing.call_count, 2)
        self.assertEqual(missing.call_args.args[2], files)
        upload.assert_not_called()
        slot.close.assert_called_once()

    def test_recheck_includes_previously_cached_inputs_that_were_evicted(self):
        hook = hook_module()
        files = {'@0.mp4': {'size': hook.MAX_TRANSFER+1}, '@1.mp4': {'size': 7}}
        slot = Mock()
        with patch.object(hook, 'missing_blobs', side_effect=[{'@0.mp4': files['@0.mp4']}, {'@1.mp4': files['@1.mp4']}]) as missing, \
             patch.object(hook, 'acquire_big_slot', return_value=slot), \
             patch.object(hook, 'upload_blobs') as upload:
            hook.upload_with_lane('fixture', 'fixture', files, {})
        self.assertEqual(missing.call_args.args[2], files)
        self.assertEqual(upload.call_args.args[2], {'@1.mp4': files['@1.mp4']})
        slot.close.assert_called_once()

    def test_failed_recheck_releases_slot_and_does_not_upload(self):
        hook = hook_module()
        files = {'@0.mp4': {'size': hook.MAX_TRANSFER+1}}
        slot = Mock()
        with patch.object(hook, 'missing_blobs', side_effect=[files, OSError('Link lost')]), \
             patch.object(hook, 'acquire_big_slot', return_value=slot), \
             patch.object(hook, 'upload_blobs') as upload:
            with self.assertRaises(OSError):
                hook.upload_with_lane('fixture', 'fixture', files, {})
        slot.close.assert_called_once()
        upload.assert_not_called()

    def test_small_inputs_keep_existing_direct_transfer(self):
        hook = hook_module()
        files = {'@0.mp4': {'size': 8}}
        with patch.object(hook, 'missing_blobs', return_value=files) as missing, \
             patch.object(hook, 'acquire_big_slot') as acquire, \
             patch.object(hook, 'upload_blobs') as upload:
            hook.upload_with_lane('fixture', 'fixture', files, {})
        missing.assert_called_once()
        acquire.assert_not_called()
        upload.assert_called_once_with('fixture', 'fixture', files, {})


if __name__ == '__main__':
    unittest.main()
