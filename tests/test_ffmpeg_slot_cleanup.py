import asyncio
import importlib.util
import os
import unittest

from src.core.ffmpeg import FFmpegExecutor


class FakeRedis:
    def __init__(self):
        self.tokens = set()
        self.granted = asyncio.Event()
        self.reply = asyncio.Event()
        self.release_started = asyncio.Event()
        self.release_reply = asyncio.Event()
        self.reply.set()
        self.release_reply.set()
        self.release_failures = 0
        self.grant_error = False

    async def eval(self, script, count, *args):
        token = args[4]
        self.tokens.add(token)
        self.granted.set()
        await self.reply.wait()
        if self.grant_error:
            raise OSError('response lost after Redis accepted the reservation')
        return 1

    async def zrem(self, key, token):
        self.release_started.set()
        await self.release_reply.wait()
        if self.release_failures:
            self.release_failures -= 1
            raise OSError('temporary Redis connection failure')
        self.tokens.discard(token)
        return 1

    async def hget(self, key, field):
        return None


class SlotCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = dict(FFmpegExecutor.__dict__)
        self.redis = FakeRedis()
        FFmpegExecutor._get_redis = classmethod(lambda cls: self.redis)
        self.executor = object.__new__(FFmpegExecutor)
        patch = os.environ.get('VF_SLOT_PATCH_MODULE')
        if patch:
            spec = importlib.util.spec_from_file_location('slot_cleanup', patch)
            self.patch = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.patch)
            self.patch.install_slot_cleanup(FFmpegExecutor)

    async def asyncTearDown(self):
        self.redis.reply.set()
        self.redis.release_reply.set()
        await asyncio.sleep(0.02)
        for name in set(FFmpegExecutor.__dict__) - set(self.saved):
            delattr(FFmpegExecutor, name)
        for name, value in self.saved.items():
            if name not in ('__dict__', '__weakref__'):
                setattr(FFmpegExecutor, name, value)

    async def test_normal_grant_and_release_preserve_native_behavior(self):
        token = await self.executor._acquire_process_slot(['ffprobe', 'test.mp4'], kind='probe')
        self.assertIn(token, self.redis.tokens)
        await self.executor._release_process_slot(token)
        self.assertFalse(self.redis.tokens)

    async def test_cancellation_after_redis_grant_does_not_leak_slot(self):
        self.redis.reply.clear()
        task = asyncio.create_task(self.executor._acquire_process_slot(['ffprobe', 'test.mp4'], kind='probe'))
        await self.redis.granted.wait()
        task.cancel()
        self.redis.reply.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.02)
        self.assertFalse(self.redis.tokens)

    async def test_uncertain_redis_response_releases_exact_reservation(self):
        self.redis.grant_error = True
        with self.assertRaises(Exception):
            await self.executor._acquire_process_slot(['ffprobe', 'test.mp4'], kind='probe')
        await asyncio.sleep(0.02)
        self.assertFalse(self.redis.tokens)

    async def test_canceling_release_does_not_cancel_redis_cleanup(self):
        self.redis.tokens.add('original-token')
        self.redis.release_reply.clear()
        task = asyncio.create_task(self.executor._release_process_slot('original-token'))
        await self.redis.release_started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.redis.release_reply.set()
        await asyncio.sleep(0.02)
        self.assertFalse(self.redis.tokens)

    async def test_release_retries_transient_network_failure(self):
        self.redis.tokens.add('original-token')
        self.redis.release_failures = 1
        await self.executor._release_process_slot('original-token')
        self.assertFalse(self.redis.tokens)

    async def test_cleanup_never_resets_unrelated_live_reservations(self):
        self.redis.tokens.add('other-live-token')
        token = await self.executor._acquire_process_slot(['ffmpeg', 'test.mp4'])
        await self.executor._release_process_slot(token)
        self.assertEqual(self.redis.tokens, {'other-live-token'})

    async def test_second_cancellation_keeps_exact_grant_cleanup_alive(self):
        self.redis.reply.clear()
        task = asyncio.create_task(self.executor._acquire_process_slot(['ffprobe', 'test.mp4'], kind='probe'))
        await self.redis.granted.wait()
        task.cancel()
        await asyncio.sleep(0.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.redis.reply.set()
        await asyncio.sleep(0.02)
        self.assertFalse(self.redis.tokens)

    async def test_release_outage_does_not_replace_original_cancellation(self):
        self.redis.reply.clear()
        self.redis.release_failures = 3
        task = asyncio.create_task(self.executor._acquire_process_slot(['ffprobe', 'test.mp4'], kind='probe'))
        await self.redis.granted.wait()
        task.cancel()
        self.redis.reply.set()
        with self.assertRaises(asyncio.CancelledError):
            await task


if __name__ == '__main__':
    unittest.main()
