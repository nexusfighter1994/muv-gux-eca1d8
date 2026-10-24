import asyncio
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import json
import urllib.error
import sys
from types import SimpleNamespace

FILE=Path(__file__).resolve().parents[1]/'fflow'/'pc_home_queue.py'


class HomeProcessAdmissionTests(unittest.TestCase):
    def test_cancel_during_home_admission_awaits_owned_cleanup(self):
        async def run():
            cleanup=[]
            async def work():
                try:await asyncio.Event().wait()
                finally:await asyncio.sleep(.01);cleanup.append('done')
            async def read():return SimpleNamespace(cancel_requested=True)
            await asyncio.wait_for(self.home.run_cancel_aware(work,read,interval=.001),.5)
            self.assertEqual(cleanup,['done'])
            self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task()],[])
        asyncio.run(run())

    def test_monitor_read_failure_does_not_cancel_valid_render(self):
        async def run():
            async def work():await asyncio.sleep(.015);return 'output'
            async def read():raise OSError('transient')
            self.assertEqual(await self.home.run_cancel_aware(work,read,interval=.001),'output')
        asyncio.run(run())

    def test_outer_cancel_still_propagates_after_cleanup(self):
        async def run():
            cleanup=[]
            async def work():
                try:await asyncio.Event().wait()
                finally:cleanup.append('done')
            async def read():return SimpleNamespace(cancel_requested=False)
            task=asyncio.create_task(self.home.run_cancel_aware(work,read,interval=.001))
            await asyncio.sleep(.01);task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
            self.assertEqual(cleanup,['done'])
        asyncio.run(run())

    def setUp(self):
        self.assertTrue(FILE.is_file(),'Home fallback isolation module is missing')
        spec=importlib.util.spec_from_file_location('fixture_home_queue',FILE)
        self.home=importlib.util.module_from_spec(spec)
        with patch.object(sys,'path',[str(FILE.parent),*sys.path]):
            spec.loader.exec_module(self.home)

    def test_boot_disabled_home_queue_has_zero_claim_capacity_without_reading_controls(self):
        with patch.object(self.home,'mod_enabled',return_value=False,create=True) as flag, \
             patch.dict(self.home.os.environ,{'VF_HOME_WORKER':'1'}), \
             patch.object(self.home.Path,'read_text') as read:
            self.assertEqual(self.home.home_worker_capacity(),0)
        flag.assert_called_once_with('homeQueue')
        read.assert_not_called()

    def test_native_signed_payload_scope_is_recovered_without_changing_media(self):
        scope={'jobId':'a'*8+'-aaaa-aaaa-aaaa-'+'a'*12,'nonce':'b'*8+'-bbbb-bbbb-bbbb-'+'b'*12,'kind':'composition'}
        self.assertEqual(self.home.scope_from_composition({'output':{'filename':
            'vfhome-'+scope['jobId']+'-'+scope['nonce']+'.mp4'}}),scope)
        for name in ('ordinary.mp4','vfhome-../bad.mp4','vfhome-a-b.mp4'):
            self.assertIsNone(self.home.scope_from_composition({'output':{'filename':name}}))
        trimmed=self.home.scope_from_composition({'output':'outputs/video/trim/vfhome-'+scope['jobId']+'-'+scope['nonce']+'.mp4'})
        self.assertEqual(trimmed,{**scope,'kind':'video-trim'})

    def test_home_fallback_takes_a_native_permit_before_process_slot(self):
        order=[]
        class Executor:
            async def _acquire_process_slot(self,cmd,acquire_timeout=None,kind='ffmpeg'):
                order.append('server_process_slot');return 'lease'
            @classmethod
            async def _release_global_process_slot(cls,token):order.append('process_released')
        async def take(scope):order.append('normal_node_permit');return 'permit'
        async def close(identifier):order.append('normal_node_released')
        self.home.install_executor(Executor,acquire=take,release=close)
        async def run():
            token=self.home.HOME_SCOPE.set({'jobId':'job','nonce':'nonce'})
            try:
                e=Executor();self.assertEqual(await e._acquire_process_slot(['ffmpeg']),'lease')
                await Executor._release_global_process_slot('lease')
            finally:self.home.HOME_SCOPE.reset(token)
        asyncio.run(run())
        self.assertEqual(order,['normal_node_permit','server_process_slot','process_released','normal_node_released'])

    def test_process_slot_failure_or_cancel_releases_normal_permit(self):
        closed=[]
        class Executor:
            async def _acquire_process_slot(self,*args,**kwargs):raise asyncio.CancelledError()
            @classmethod
            async def _release_global_process_slot(cls,token):pass
        async def take(scope):return 'permit'
        async def close(identifier):closed.append(identifier)
        self.home.install_executor(Executor,acquire=take,release=close)
        async def run():
            token=self.home.HOME_SCOPE.set({'jobId':'job','nonce':'nonce'})
            try:
                with self.assertRaises(asyncio.CancelledError):await Executor()._acquire_process_slot(['ffmpeg'])
            finally:self.home.HOME_SCOPE.reset(token)
        asyncio.run(run());self.assertEqual(closed,['permit'])

    def test_native_and_probe_paths_do_not_acquire_home_fallback_permits(self):
        calls=[]
        class Executor:
            async def _acquire_process_slot(self,*args,**kwargs):return 'native'
            @classmethod
            async def _release_global_process_slot(cls,token):pass
        async def take(scope):calls.append(scope);return 'permit'
        async def close(identifier):pass
        self.home.install_executor(Executor,acquire=take,release=close)
        async def run():
            e=Executor();await e._acquire_process_slot(['ffmpeg'])
            token=self.home.HOME_SCOPE.set({'jobId':'job','nonce':'nonce'})
            try:await e._acquire_process_slot(['ffprobe'],kind='probe')
            finally:self.home.HOME_SCOPE.reset(token)
        asyncio.run(run());self.assertEqual(calls,[])

    def test_optional_media_operation_output_may_be_null_without_stopping_worker(self):
        for composition in ({'output':None},{},{'output':'path.mp4'},None):
            self.assertIsNone(self.home.scope_from_composition(composition))

    def test_only_a_dedicated_home_consumer_can_claim_home_work(self):
        with patch.dict('os.environ',{},clear=True):
            self.assertEqual(self.home.home_worker_capacity(),0)
        with patch.dict('os.environ',{'VF_HOME_WORKER':'1'},clear=True):
            self.assertGreaterEqual(self.home.home_worker_capacity(),1)

    def test_remote_only_memory_is_distinguished_from_mixed_or_native_work(self):
        self.assertTrue(hasattr(self.home,'install_memory_sampler'),'Missing memory provenance hook')
        class Sampler:
            async def stop(self):return {'incremental_peak_mb':6}
        self.home.install_memory_sampler(Sampler)
        async def run():
            for remote,native,expected in ((True,False,'home'),(True,True,None),(False,True,None)):
                token=self.home.WORK_STATE.set({'remoteVerified':remote,'nativeStarted':native})
                try:
                    report=await Sampler().stop()
                    self.assertEqual(report.get('execution_location'),expected)
                    self.assertEqual(report['incremental_peak_mb'],6)
                finally:self.home.WORK_STATE.reset(token)
        asyncio.run(run())

    def test_fallback_permit_is_renewed_while_waiting_for_a_physical_server_slot(self):
        async def run():
            renewed=asyncio.Event()
            class Executor:
                async def _acquire_process_slot(self,*args,**kwargs):
                    await asyncio.wait_for(renewed.wait(),.05);return 'lease'
                @classmethod
                async def _release_global_process_slot(cls,token):pass
            async def take(scope):return 'permit'
            async def close(identifier):pass
            async def renew(identifier):
                renewed.set();await asyncio.Event().wait()
            with patch.object(self.home,'_renew',renew):
                self.home.install_executor(Executor,acquire=take,release=close)
                token=self.home.HOME_SCOPE.set({'jobId':'job','nonce':'nonce'})
                try:
                    await Executor()._acquire_process_slot(['ffmpeg'])
                    await Executor._release_global_process_slot('lease')
                finally:self.home.HOME_SCOPE.reset(token)
        asyncio.run(run())

    def test_already_reserved_reply_fails_closed(self):
        async def run():
            with patch.object(self.home,'_request',return_value={'state':'already_reserved'}):
                with self.assertRaises((RuntimeError,KeyError)):
                    await self.home.acquire_permit({'jobId':'job','nonce':'stale'})
        asyncio.run(run())

    def _renewal_loss(self,phase):
        async def run():
            events=[];trigger=asyncio.Event();granted=asyncio.Event();cleaning=asyncio.Event()
            class Executor:
                async def _acquire_process_slot(self,*args,**kwargs):
                    if phase=='wait':
                        trigger.set();await asyncio.Event().wait()
                    if phase=='grant':
                        trigger.set()
                        try:await asyncio.Event().wait()
                        except asyncio.CancelledError:pass
                    events.append('physical-grant');return 'lease'
                @classmethod
                async def _release_global_process_slot(cls,token):
                    events.append('physical-release')
                async def encode(self):
                    token=await self._acquire_process_slot(['ffmpeg'])
                    try:
                        events.append('encode-start');granted.set();trigger.set()
                        await asyncio.Event().wait()
                    except asyncio.CancelledError:
                        events.append('terminate-start');cleaning.set()
                        await asyncio.sleep(.01)
                        events.append('process-dead');raise
                    finally:await self._release_global_process_slot(token)
            async def acquire(scope):events.append('permit-active');return 'permit'
            async def release(identifier):events.append('permit-release')
            async def renew(identifier):
                await trigger.wait();raise OSError('fixture renewal lost')
            with patch.object(self.home,'_renew',renew):
                self.home.install_executor(Executor,acquire=acquire,release=release)
                scope=self.home.HOME_SCOPE.set({'jobId':'job','nonce':'nonce'})
                try:
                    owner=asyncio.create_task(Executor().encode())
                    try:
                        await asyncio.wait_for(asyncio.shield(owner),.1)
                    except RuntimeError:pass
                    except TimeoutError:self.fail('Renewal failure did not stop exact owner')
                    except asyncio.CancelledError:self.fail('Renewal loss escaped as worker cancellation')
                    self.assertTrue(owner.done())
                    self.assertEqual(events.count('permit-release'),1)
                    if phase=='wait':self.assertNotIn('physical-grant',events)
                    else:self.assertEqual(events.count('physical-release'),1)
                    if phase=='grant':self.assertNotIn('encode-start',events)
                    if phase=='encode':
                        self.assertLess(events.index('process-dead'),events.index('physical-release'))
                        self.assertLess(events.index('physical-release'),events.index('permit-release'))
                    await asyncio.sleep(0)
                    self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task()],[])
                finally:
                    if not owner.done():
                        owner.cancel();await asyncio.sleep(0);owner.cancel()
                        await asyncio.gather(owner,return_exceptions=True)
                    self.home.HOME_SCOPE.reset(scope)
        asyncio.run(run())

    def test_renewal_loss_cancels_physical_wait_without_leaking_tasks(self):
        self._renewal_loss('wait')

    def test_renewal_loss_at_grant_releases_original_global_token(self):
        self._renewal_loss('grant')

    def test_renewal_loss_during_encode_retains_permit_until_process_dead(self):
        self._renewal_loss('encode')

    def test_transient_json_renewal_retries_but_requires_active(self):
        async def run():
            with patch.object(self.home,'_request',side_effect=[
                json.JSONDecodeError('fixture','',0),OSError('transient'),{'state':'active'}]) as request:
                await self.home._renew_active('permit',retry_delay=.001)
                self.assertEqual(request.call_count,3)
            for reply in ({'state':'queued'},{'state':'failed'},{},None):
                with patch.object(self.home,'_request',return_value=reply) as request:
                    with self.assertRaises(RuntimeError):await self.home._renew_active('permit')
                    self.assertEqual(request.call_count,1)
        asyncio.run(run())

    def test_renewal_retry_is_bounded_below_native_expiry(self):
        async def run():
            with patch.object(self.home,'_request',side_effect=OSError('offline')):
                with self.assertRaises(RuntimeError):
                    await asyncio.wait_for(self.home._renew_active('permit',retry_budget=.01,retry_delay=.001),.1)
        asyncio.run(run())

    def test_missing_or_unauthorized_renewal_does_not_retry(self):
        async def run():
            for code in (401,403,404,409):
                error=urllib.error.HTTPError('http://fixture',code,'fixture',{},None)
                with patch.object(self.home,'_request',side_effect=error) as request:
                    with self.assertRaises(RuntimeError):
                        await self.home._renew_active('permit',retry_budget=.1,retry_delay=.001)
                    self.assertEqual(request.call_count,1)
        asyncio.run(run())

    def test_acquisition_retries_same_request_id_without_duplicate_permits(self):
        async def run():
            posts=[];ids={};calls={'POST':0,'GET':0};scope={'jobId':'job','nonce':'nonce'}
            def request(method,suffix='',body=None):
                calls[method]+=1
                if method=='POST':
                    posts.append(dict(body))
                    identifier=ids.setdefault(body.get('requestId'),str(len(ids)+1))
                    if calls[method]==1:raise TimeoutError('response lost after permit created')
                    return {'id':identifier,'state':'queued'}
                if calls[method]==1:raise TimeoutError('GET response lost')
                return {'state':'active'}
            with patch.object(self.home,'_request',side_effect=request):
                self.assertEqual(await self.home.acquire_permit(scope),'1')
                self.assertEqual(len(ids),1)
                self.assertEqual(posts[0],posts[1])
                self.assertRegex(posts[0]['requestId'],r'^[0-9a-f]{32}$')
                self.assertEqual(await self.home.acquire_permit(scope),'2')
                self.assertNotEqual(posts[-1]['requestId'],posts[0]['requestId'])
                self.assertNotIn('requestId',scope)
        asyncio.run(run())

    def test_admission_keeps_retrying_an_unresponsive_api_past_the_old_40s_budget(self):
        async def run():
            calls={'POST':0}
            def request(method,suffix='',body=None):
                if method=='POST':
                    calls['POST']+=1
                    if calls['POST']<=3:raise TimeoutError('API briefly unresponsive')
                    return {'id':'permit','state':'queued'}
                return {'state':'active'}
            # Per-request budget far below the outage; only the admission deadline bounds it.
            with patch.object(self.home,'_request',side_effect=request),patch.object(self.home,'_HTTP_RETRY_BUDGET',.001,create=True),\
                    patch.object(self.home,'_HTTP_RETRY_DELAY',.001,create=True),patch.object(self.home,'_ADMISSION_DEADLINE',5,create=True):
                self.assertEqual(await self.home.acquire_permit({'jobId':'job','nonce':'nonce'}),'permit')
            self.assertEqual(calls['POST'],4)
        asyncio.run(run())

    def test_exhausted_post_or_get_timeout_is_not_global_job_timeout(self):
        async def run():
            for failed_method in ('POST','GET'):
                released=[]
                def request(method,suffix='',body=None):
                    if method==failed_method:raise TimeoutError('fixture inner socket timeout')
                    return {'id':'permit','state':'queued'}
                async def release(identifier):released.append(identifier)
                with patch.object(self.home,'_request',side_effect=request),patch.object(self.home,'release_permit',release):
                    with patch.object(self.home,'_HTTP_RETRY_BUDGET',.01,create=True),patch.object(self.home,'_HTTP_RETRY_DELAY',.001,create=True),\
                            patch.object(self.home,'_ADMISSION_DEADLINE',.05,create=True):
                        with self.assertRaises(RuntimeError) as error:await self.home.acquire_permit({'jobId':'job','nonce':'nonce'})
                        self.assertNotIsInstance(error.exception,TimeoutError)
                        self.assertEqual(released,[None if failed_method=='POST' else 'permit'])
        asyncio.run(run())

    def _timeout_worker(self):
        class Executor:
            async def _acquire_process_slot(self,*args,**kwargs):return 'fixture'
            @classmethod
            async def _release_global_process_slot(cls,token):pass
        class Engine:
            def __init__(self):self.error=TimeoutError('fixture inner timeout');self.wait=False;self.cancelled=False
            async def _mix_audio_tracks(self,ctx,progress=None):
                if not self.wait:raise self.error
                try:await asyncio.Event().wait()
                except asyncio.CancelledError:self.cancelled=True;raise
            async def render(self):
                async with asyncio.timeout(.01):await self._mix_audio_tracks(None)
        class Worker:
            def __init__(self):self.engine=Engine()
            async def _process_job(self,job_id,job_data=None):return await self.engine.render()
        self.home.install_worker(Worker,Executor)
        return Worker()

    def _timeout_job(self,home=True):
        filename='vfhome-'+'a'*8+'-aaaa-aaaa-aaaa-'+'a'*12+'-'+'b'*8+'-bbbb-bbbb-bbbb-'+'b'*12+'.mp4'
        return {'composition':{'output':{'filename':filename if home else 'ordinary.mp4'}}}

    def test_home_inner_pipeline_timeout_keeps_cause_and_traceback(self):
        async def run():
            worker=self._timeout_worker()
            with self.assertLogs('fixture_home_queue',level='ERROR') as logs:
                with self.assertRaises(RuntimeError) as error:
                    await worker._process_job('fixture',self._timeout_job())
            self.assertIs(error.exception.__cause__,worker.engine.error)
            self.assertIn('_mix_audio_tracks',str(error.exception))
            self.assertIs(logs.records[0].exc_info[1],worker.engine.error)
            self.assertIsNotNone(logs.records[0].exc_info[2])
            original=worker.engine._mix_audio_tracks
            with self.assertLogs('fixture_home_queue',level='ERROR'):
                with self.assertRaises(RuntimeError):await worker._process_job('fixture',self._timeout_job())
            self.assertIs(worker.engine._mix_audio_tracks,original)
            with self.assertNoLogs('fixture_home_queue',level='ERROR'):
                with self.assertRaises(TimeoutError) as native:
                    await worker._process_job('fixture',self._timeout_job(False))
            self.assertIs(native.exception,worker.engine.error)
            self.assertIsNone(self.home.HOME_SCOPE.get())
        asyncio.run(run())

    def test_native_inner_pipeline_timeout_is_unchanged(self):
        async def run():
            worker=self._timeout_worker()
            with self.assertRaises(TimeoutError) as error:
                await worker._process_job('fixture',self._timeout_job(False))
            self.assertIs(error.exception,worker.engine.error)
            self.assertIsNone(self.home.HOME_SCOPE.get())
        asyncio.run(run())

    def test_home_true_outer_deadline_and_external_cancel_are_unchanged(self):
        async def run():
            worker=self._timeout_worker();worker.engine.wait=True
            with self.assertNoLogs('fixture_home_queue',level='ERROR'):
                with self.assertRaises(TimeoutError):await worker._process_job('fixture',self._timeout_job())
            self.assertTrue(worker.engine.cancelled)
            task=asyncio.create_task(worker._process_job('fixture',self._timeout_job()))
            await asyncio.sleep(0);task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
            self.assertEqual([t for t in asyncio.all_tasks() if t is not asyncio.current_task()],[])
        asyncio.run(run())


if __name__=='__main__':unittest.main()
