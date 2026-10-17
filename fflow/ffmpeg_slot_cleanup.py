"""Keep a Redis reservation cleanup alive when its caller is canceled."""

import asyncio
import logging


logger = logging.getLogger(__name__)
VERSION = 'cancellation-safe-v2'


def install_slot_cleanup(executor):
    if getattr(executor, '_slot_cleanup_version', None) == VERSION:
        return
    acquire = executor._try_acquire_global_process_slot.__func__
    release = executor._release_global_process_slot.__func__
    pending = set()

    def keep_task(coro):
        task = asyncio.create_task(coro)
        pending.add(task)

        def finished(done):
            pending.discard(done)
            if not done.cancelled() and done.exception() is not None:
                logger.warning('FFmpeg reservation background operation failed: %s', done.exception())

        task.add_done_callback(finished)
        return task

    async def release_with_retry(cls, token):
        for attempt in range(3):
            try:
                return await release(cls, token)
            except Exception:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.25 * (2 ** attempt))

    async def safe_release(cls, token):
        await asyncio.shield(keep_task(release_with_retry(cls, token)))

    async def finish_uncertain_grant(cls, token, grant):
        # Redis can grant a slot before cancellation interrupts its response.
        # Wait for that exact request, then remove only its original token.
        try:
            await grant
        except BaseException:
            pass
        await release_with_retry(cls, token)

    async def safe_acquire(cls, token):
        grant = keep_task(acquire(cls, token))
        try:
            return await asyncio.shield(grant)
        except BaseException:
            cleanup = keep_task(finish_uncertain_grant(cls, token, grant))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                # A second cancellation must not kill the background cleanup.
                pass
            except Exception:
                # The tracked cleanup reports its error; preserve the original failure.
                pass
            raise

    executor._try_acquire_global_process_slot = classmethod(safe_acquire)
    executor._release_global_process_slot = classmethod(safe_release)
    executor._slot_cleanup_tasks = pending
    executor._slot_cleanup_version = VERSION
    logger.info('Installed FFmpeg slot cleanup: %s', VERSION)
