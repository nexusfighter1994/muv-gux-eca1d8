import asyncio
import importlib.util
from pathlib import Path
import unittest

FILE=Path(__file__).with_name('memory_reclaim.py')
if not FILE.exists():FILE=Path(__file__).resolve().parents[1]/'python/memory_reclaim.py'

class ReclaimTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(FILE.exists(), 'Missing bounded post-task memory release')
        spec=importlib.util.spec_from_file_location('reclaim_test',FILE)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)

    def make(self, trim=None, rss=None):
        self.time=[100.0];self.calls=[]
        return self.m.Reclaimer(trim=trim or (lambda:self.calls.append('trim')),
          rss=rss or (lambda:600*1048576),clock=lambda:self.time[0])

    def test_rate_limited_success(self):
        r=self.make();r.release();r.release();self.assertEqual(self.calls,['trim'])
        self.time[0]+=60;r.release();self.assertEqual(self.calls,['trim','trim'])

    def test_low_rss_skips(self):
        r=self.make(rss=lambda:100*1048576);r.release();self.assertEqual(self.calls,[])

    def test_trim_failure_is_nonfatal_and_backed_off(self):
        calls=[]
        def fail():calls.append(1);raise OSError('unsupported')
        r=self.make(trim=fail);r.release();r.release();self.assertEqual(calls,[1])

    def test_bad_metric_is_nonfatal(self):
        def fail():raise OSError('proc absent')
        r=self.make(rss=fail);r.release();self.assertEqual(self.calls,[])

    def test_no_trim_while_lock_held(self):
        r=self.make();r.lock.acquire()
        try:r.release();self.assertEqual(self.calls,[])
        finally:r.lock.release()

    def test_clock_regression_is_not_repeated_trim(self):
        r=self.make();r.release();self.time[0]=90;r.release();self.assertEqual(self.calls,['trim'])

    def test_async_result_identity_and_order(self):
        order=[];value=object()
        async def original(a):order.append(a);return value
        wrapped=self.m.after_task(original,reclaim=lambda:order.append('released'))
        self.assertIs(asyncio.run(wrapped('task')),value)
        self.assertEqual(order,['task','released'])

    def test_async_error_preserved(self):
        error=ValueError('native');calls=[]
        async def original():raise error
        wrapped=self.m.after_task(original,reclaim=lambda:calls.append(1))
        with self.assertRaises(ValueError) as result:asyncio.run(wrapped())
        self.assertIs(result.exception,error);self.assertEqual(calls,[1])

    def test_async_cancel_preserved(self):
        calls=[]
        async def original():raise asyncio.CancelledError()
        wrapped=self.m.after_task(original,reclaim=lambda:calls.append(1))
        with self.assertRaises(asyncio.CancelledError):asyncio.run(wrapped())
        self.assertEqual(calls,[1])

    def test_reclaimer_failure_does_not_replace_native_result(self):
        def fail():raise RuntimeError('diagnostic failure')
        async def original():return 'ok'
        self.assertEqual(asyncio.run(self.m.after_task(original,reclaim=fail)()),'ok')

    def test_idempotent_wrapper(self):
        async def original():pass
        wrapped=self.m.after_task(original)
        self.assertIs(self.m.after_task(wrapped),wrapped)

if __name__=='__main__':unittest.main()
