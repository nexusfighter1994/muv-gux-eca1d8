"""Independent Home jobs retain native signed queue leases and bounded CPU fallback."""
import asyncio
from contextvars import ContextVar
from functools import wraps
import json
import logging
import os
from pathlib import Path
import re
import signal
import sys
import time
import urllib.error
import urllib.request
import uuid

try:
    from .mod_flags import mod_enabled
except ImportError:
    from mod_flags import mod_enabled

HOME_SCOPE=ContextVar('vf_home_scope',default=None)
WORK_STATE=ContextVar('vf_home_work_state',default=None)
_UUID=r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
_NAME=re.compile(r'^vfhome-('+_UUID+r')-('+_UUID+r')\.mp4$')
_HTTP_RETRY_BUDGET=40
_HTTP_RETRY_DELAY=2
_ADMISSION_DEADLINE=900


def scope_from_composition(composition):
    if not isinstance(composition,dict):return None
    output=composition.get('output')
    if isinstance(output,dict):name=output.get('filename');kind='composition'
    elif isinstance(output,str) and output.startswith('outputs/video/trim/'):
        name=output.removeprefix('outputs/video/trim/');kind='video-trim'
    else:return None
    match=_NAME.fullmatch(name) if isinstance(name,str) else None
    return {'jobId':match[1],'nonce':match[2],'kind':kind} if match else None


def home_worker_capacity():
    if not mod_enabled('homeQueue'):return 0
    if os.environ.get('VF_HOME_WORKER')!='1':return 0
    try:
        value=json.loads(Path('/data/runtime/pc-home-admission.json').read_text())
        extra=value.get('extra')
        if type(extra) is int and 0<=extra<=50:return max(1,extra)
    except (OSError,ValueError,TypeError):pass
    return 1


def install_home_consumer(worker_cls):
    def setup_signals(self):
        self._vf_home_retire_requested=False
        def retire(signum,frame):
            # Native shutdown also stops the processing-lease heartbeat. Defer it
            # until the next claim boundary, including a claim already in flight.
            self._vf_home_retire_requested=True
        signal.signal(signal.SIGTERM,retire)
        signal.signal(signal.SIGINT,retire)

    def retiring(self):
        if getattr(self,'_vf_home_retire_requested',False):self._shutdown_event.set()
        return self._shutdown_event.is_set()

    async def wait(self):
        if retiring(self):return None
        await self.job_queue.register_worker(self._worker_id,
            ttl_seconds=90)
        if retiring(self):return None
        result=await self.job_queue.dequeue_and_start(active_limit=-1,worker_id=self._worker_id)
        # A claimed job must finish with its original lease before acknowledging.
        if result:return result
        if retiring(self):return None
        await asyncio.sleep(.5)
        return None
    worker_cls._setup_signal_handlers=setup_signals
    worker_cls._wait_for_job=wait


def _request(method,suffix='',body=None):
    token=Path('/data/runtime/pc-boost-token').read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:8000/internal/vf-home-slot'+suffix,
        data=None if body is None else json.dumps(body).encode(),method=method,
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request,timeout=5) as response:
        value=response.read(65537)
        if len(value)>65536:raise ValueError('Invalid native fallback admission reply')
        return json.loads(value)


async def release_permit(identifier):
    if not identifier:return
    try:await asyncio.to_thread(_request,'DELETE','/'+identifier)
    except Exception:pass  # The native90s expiry releases a dead client independently.


async def acquire_permit(scope):
    identifier=None
    body={**scope,'requestId':uuid.uuid4().hex}
    try:
        deadline=time.monotonic()+_ADMISSION_DEADLINE
        while True:
            try:
                # A briefly unresponsive VidForge API must not fail the render: keep the
                # idempotent POST (same requestId) going for the whole admission deadline.
                value=await _request_retry('POST','',body,retry_budget=max(1,deadline-time.monotonic()))
                break
            except urllib.error.HTTPError as e:
                if e.code!=409 or time.monotonic()>deadline:raise
                await asyncio.sleep(2)
        if not isinstance(value,dict) or value.get('state')=='already_reserved':
            raise HomeFallbackAdmissionError('Native Home fallback admission failed')
        identifier=value.get('id')
        if not isinstance(identifier,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}',identifier):
            identifier=None
            raise HomeFallbackAdmissionError('Invalid native Home fallback permit')
        while time.monotonic()<deadline:
            value=await _request_retry('GET','/'+identifier,retry_budget=max(1,deadline-time.monotonic()))
            if not isinstance(value,dict):raise HomeFallbackAdmissionError('Invalid native Home fallback status')
            if value.get('state')=='active':return identifier
            if value.get('state')!='queued':raise HomeFallbackAdmissionError('Native Home fallback admission failed')
            await asyncio.sleep(.5)
        raise HomeFallbackAdmissionError('Native Home fallback admission timed out')
    except (OSError,TimeoutError):
        await asyncio.shield(release_permit(identifier))
        raise HomeFallbackAdmissionError('Native Home fallback admission unavailable') from None
    except BaseException:
        await asyncio.shield(release_permit(identifier));raise


class HomeFallbackAdmissionError(RuntimeError):
    """Fail this FFlow operation after its native cancellation cleanup."""


async def _request_retry(method,suffix='',body=None,retry_budget=None,retry_delay=None):
    retry_budget=_HTTP_RETRY_BUDGET if retry_budget is None else retry_budget
    retry_delay=_HTTP_RETRY_DELAY if retry_delay is None else retry_delay
    deadline=time.monotonic()+retry_budget
    while True:
        try:
            remaining=deadline-time.monotonic()
            if remaining<=0:raise TimeoutError()
            value=await asyncio.wait_for(asyncio.to_thread(_request,method,suffix,body),
                timeout=min(5,remaining))
        except urllib.error.HTTPError as error:
            if error.code not in (408,429) and not 500<=error.code<=599:
                raise
        except (OSError,ValueError,TimeoutError):
            pass
        else:
            return value
        remaining=deadline-time.monotonic()
        if remaining<=0:
            raise HomeFallbackAdmissionError('Native Home fallback '+method+' retry exhausted') from None
        await asyncio.sleep(min(retry_delay,remaining))


async def _renew_active(identifier,retry_budget=None,retry_delay=None):
    try:value=await _request_retry('GET','/'+identifier,retry_budget=retry_budget,retry_delay=retry_delay)
    except urllib.error.HTTPError:
        raise HomeFallbackAdmissionError('Native Home fallback permit unavailable') from None
    if not isinstance(value,dict) or value.get('state')!='active':
        raise HomeFallbackAdmissionError('Native Home fallback permit is not active')


async def _renew(identifier):
    while True:
        await asyncio.sleep(15)
        await _renew_active(identifier)


def install_executor(cls,acquire=acquire_permit,release=release_permit):
    if getattr(cls,'_vf_home_installed',False):return
    original_acquire=cls._acquire_process_slot
    original_release=cls._release_global_process_slot
    leases={}
    async def watch(identifier,state):
        try:
            await _renew(identifier)
            raise HomeFallbackAdmissionError('Native Home fallback renewal stopped')
        except BaseException:
            if not state['closing']:
                state['failed']=True
                owner=state['owner']
                if not owner.done() and not owner.cancelling():
                    state['cancelled_owner']=owner.cancel('Native Home fallback renewal lost')
    async def stop_watch(state):
        state['closing']=True
        state['renew'].cancel()
        await asyncio.gather(state['renew'],return_exceptions=True)
    def fail_owner(state):
        if state['cancelled_owner']:
            state['owner'].uncancel()
            raise HomeFallbackAdmissionError('Native Home fallback renewal lost') from None
    async def take(self,cmd,acquire_timeout=None,kind='ffmpeg'):
        scope=HOME_SCOPE.get()
        identifier=await acquire(scope) if scope and kind=='ffmpeg' else None
        if not identifier:
            token=await original_acquire(self,cmd,acquire_timeout=acquire_timeout,kind=kind)
            if kind=='ffmpeg' and WORK_STATE.get() is not None:WORK_STATE.get()['nativeStarted']=True
            return token
        state={'owner':asyncio.current_task(),'closing':False,'failed':False,'cancelled_owner':False}
        state['renew']=asyncio.create_task(watch(identifier,state))
        physical=asyncio.create_task(original_acquire(self,cmd,acquire_timeout=acquire_timeout,kind=kind))
        try:
            # Shield the grant result so cancellation cannot discard a returned Redis token.
            token=await asyncio.shield(physical)
            if state['failed']:raise HomeFallbackAdmissionError('Native Home fallback renewal lost')
        except BaseException:
            await stop_watch(state)
            physical.cancel()
            result=(await asyncio.gather(physical,return_exceptions=True))[0]
            try:
                if not isinstance(result,BaseException):await original_release(result)
            finally:await asyncio.shield(release(identifier))
            fail_owner(state)
            raise
        if kind=='ffmpeg' and WORK_STATE.get() is not None:
            WORK_STATE.get()['nativeStarted']=True
        leases[token]=(identifier,state)
        return token
    async def give(inner_cls,token):
        item=leases.pop(token,None)
        if item:await stop_watch(item[1])
        try:await original_release(token)
        finally:
            if item:
                await asyncio.shield(release(item[0]))
        if item:fail_owner(item[1])
    cls._acquire_process_slot=take
    cls._release_global_process_slot=classmethod(give)
    cls._vf_home_installed=True


def install_memory_sampler(cls):
    if getattr(cls,'_vf_home_memory_installed',False):return
    original=cls.stop
    async def stop(self):
        report=await original(self)
        state=WORK_STATE.get()
        if isinstance(report,dict) and state and state.get('remoteVerified') and not state.get('nativeStarted'):
            report={**report,'execution_location':'home'}
        return report
    cls.stop=stop
    cls._vf_home_memory_installed=True


def note_remote_success():
    state=WORK_STATE.get()
    if state is not None:state['remoteVerified']=True


def install_composition_timeout_diagnostics(engine):
    # Guard awaits inside render's outer timeout, never render or its deadline itself.
    names=('_validate_composition','_download_sources','_probe_sources',
        '_validate_reverse_effects','_try_single_pass','_prepare_segments',
        '_concatenate_segments','_mix_audio_tracks','_apply_composition_filters',
        '_apply_composition_subtitles','_encode_final_output','_upload_output')
    def guard(original,name):
        @wraps(original)
        async def call(*args,**kwargs):
            scope=HOME_SCOPE.get()
            if not scope or scope.get('kind')!='composition':
                return await original(*args,**kwargs)
            try:return await original(*args,**kwargs)
            except TimeoutError as error:
                logging.getLogger(__name__).exception('Home composition inner timeout in %s',name)
                raise RuntimeError('Home composition inner timeout in '+name) from error
        call._vf_home_timeout_guard=True
        return call
    for name in names:
        original=getattr(engine,name,None)
        if callable(original) and not getattr(original,'_vf_home_timeout_guard',False):
            setattr(engine,name,guard(original,name))


def install_worker(worker_cls,executor_cls):
    if getattr(worker_cls,'_vf_home_installed',False):return
    install_executor(executor_cls)
    sampler=getattr(sys.modules.get(worker_cls.__module__),'_TreeMemorySampler',None)
    if sampler is not None:install_memory_sampler(sampler)
    original=worker_cls._process_job
    async def process(self,job_id,job_data=None):
        if job_data is None:
            existing=await self.job_queue.get_job(job_id)
            composition=existing.composition
        else:
            raw=job_data.get('composition','{}')
            try:composition=json.loads(raw) if isinstance(raw,str) else raw
            except ValueError:composition={}
        token=HOME_SCOPE.set(scope_from_composition(composition))
        work=WORK_STATE.set({'remoteVerified':False,'nativeStarted':False})
        try:
            if HOME_SCOPE.get() and HOME_SCOPE.get().get('kind')=='composition':
                install_composition_timeout_diagnostics(getattr(self,'engine',None))
            return await original(self,job_id,job_data)
        finally:WORK_STATE.reset(work);HOME_SCOPE.reset(token)
    worker_cls._process_job=process
    worker_cls._vf_home_installed=True
