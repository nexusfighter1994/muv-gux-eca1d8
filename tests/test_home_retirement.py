import asyncio
import importlib.util
from pathlib import Path
import signal
import unittest
import sys
from unittest.mock import patch

FILE=Path(__file__).resolve().parents[1]/'fflow'/'pc_home_queue.py'


class HomeRetirementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        spec=importlib.util.spec_from_file_location('fixture_home_retirement',FILE)
        self.home=importlib.util.module_from_spec(spec)
        with patch.object(sys,'path',[str(FILE.parent),*sys.path]):
            spec.loader.exec_module(self.home)
        self.handlers={};self.claims=[];self.processed=[];self.heartbeats=[]
        self.register_hook=None;self.claim_hook=None;self.process_hook=None
        self.jobs=[('first',{'lease_id':'original','payload':object()}),('second',{})]
        fixture=self

        class Queue:
            async def register_worker(self,*args,**kwargs):
                if fixture.register_hook:await fixture.register_hook()

            async def dequeue_and_start(self,**kwargs):
                fixture.claims.append(kwargs)
                if fixture.claim_hook:await fixture.claim_hook()
                return fixture.jobs.pop(0) if fixture.jobs else None

        class Worker:
            def __init__(self):
                self._shutdown_event=asyncio.Event()
                self._active_job_id=None
                self._worker_id='home-fixture'
                self.job_queue=Queue()

            def _setup_signal_handlers(self):
                for sig in (signal.SIGTERM,signal.SIGINT):
                    signal.signal(sig,lambda *_:self._shutdown_event.set())

            async def _process_job(self,job_id,data):
                self._active_job_id=job_id
                try:
                    if fixture.process_hook:await fixture.process_hook(self)
                    # Matches native heartbeat's shutdown-event condition.
                    if not self._shutdown_event.is_set():fixture.heartbeats.append(job_id)
                    fixture.processed.append((job_id,data))
                finally:self._active_job_id=None

            async def start(self):
                self._setup_signal_handlers()
                while not self._shutdown_event.is_set():
                    result=await self._wait_for_job()
                    if result:await self._process_job(*result)

        self.Worker=Worker
        self.home.install_home_consumer(Worker)
        self.signal_patch=patch.object(signal,'signal',side_effect=lambda sig,fn:self.handlers.__setitem__(sig,fn))
        self.signal_patch.start()
        self.addCleanup(self.signal_patch.stop)

    def retire(self,sig=signal.SIGTERM):
        self.handlers[sig](sig,None)

    async def test_idle_retirement_does_not_claim_or_start_work(self):
        worker=self.Worker();worker._setup_signal_handlers();self.retire()
        self.assertIsNone(await worker._wait_for_job())
        self.assertEqual(self.claims,[])
        self.assertTrue(worker._shutdown_event.is_set())

    async def test_retirement_during_registration_does_not_dequeue(self):
        async def register():self.retire()
        self.register_hook=register
        await asyncio.wait_for(self.Worker().start(),1)
        self.assertEqual(self.claims,[])
        self.assertEqual(self.processed,[])

    async def test_retirement_during_atomic_claim_finishes_exact_claim_with_heartbeat(self):
        original=self.jobs[0]
        async def claim():
            self.retire()
            await asyncio.sleep(0)
        self.claim_hook=claim
        worker=self.Worker()
        await asyncio.wait_for(worker.start(),1)
        self.assertEqual(self.processed,[original])
        self.assertIs(self.processed[0][1],original[1])
        self.assertEqual(self.heartbeats,['first'])
        self.assertEqual(self.claims,[{'active_limit':-1,'worker_id':'home-fixture'}])
        self.assertEqual([job[0] for job in self.jobs],['second'])

    async def test_active_job_retirement_keeps_native_lease_heartbeat_until_finished(self):
        async def process(worker):
            self.retire();self.retire(signal.SIGINT)
            for _ in range(3):
                await asyncio.sleep(0)
                self.assertFalse(worker._shutdown_event.is_set())
        self.process_hook=process
        await asyncio.wait_for(self.Worker().start(),1)
        self.assertEqual(self.heartbeats,['first'])
        self.assertEqual(len(self.claims),1)

    async def test_retirement_with_empty_inflight_claim_exits_without_another_claim(self):
        self.jobs=[]
        async def claim():self.retire()
        self.claim_hook=claim
        await asyncio.wait_for(self.Worker().start(),1)
        self.assertEqual(len(self.claims),1)
        self.assertEqual(self.processed,[])

    async def test_normal_claims_keep_original_order_and_payloads(self):
        expected=list(self.jobs)
        async def process(worker):
            if worker._active_job_id=='second':self.retire()
        self.process_hook=process
        await asyncio.wait_for(self.Worker().start(),1)
        self.assertEqual(self.processed,expected)
        self.assertEqual(self.heartbeats,['first','second'])

    async def test_hook_does_not_modify_process_or_native_worker_base_class(self):
        class Native:
            def _setup_signal_handlers(self):return 'native'
            async def _wait_for_job(self):return 'native'
        class Home(Native):pass
        original=Native._setup_signal_handlers
        self.home.install_home_consumer(Home)
        self.assertIs(Native._setup_signal_handlers,original)
        self.assertEqual(Native()._setup_signal_handlers(),'native')
        self.assertEqual(await Native()._wait_for_job(),'native')


if __name__=='__main__':unittest.main()
