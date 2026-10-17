"""Own Home-only pickup processes; the native14-worker controller is untouched."""
import asyncio
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT=Path('/app/engines/fflow')
sys.path.insert(0,str(ROOT))
from src.queue.jobs import get_job_queue
from src.core.pc_home_queue import install_home_consumer
from src.core.mod_flags import mod_enabled


def restart_delay(failures):
    return min(60,2**min(6,max(1,failures)))


def unexpected_exit(returncode,intentional):
    return returncode!=0 and not intentional


def control_ceiling(control,now_ms):
    if not isinstance(control,dict):return 0
    extra=control.get('extra');updated=control.get('updatedAt')
    if type(extra) is not int or type(updated) not in (int,float):return 0
    if not 0<=now_ms-updated<15000:return 0
    return max(0,min(50,extra))


class ElasticHomePoolTarget:
    def __init__(self,warm=2,shrink_after=30):
        self.warm=warm;self.shrink_after=shrink_after
        self.target=0;self.low_since=None;self.low_peak=0

    def update(self,ceiling,active,now):
        desired=min(ceiling,max(0,active)+self.warm) if ceiling else 0
        if self.target>ceiling or desired>=self.target:
            self.target=desired if self.target<=ceiling else ceiling
            self.low_since=None;self.low_peak=0
        else:
            if self.low_since is None:self.low_since=now
            self.low_peak=max(self.low_peak,desired)
            if now-self.low_since>=self.shrink_after:
                self.target=self.low_peak;self.low_since=None;self.low_peak=0
        return self.target


def children_to_retire(pids,target,owners,retiring):
    available=[pid for pid in pids if pid not in retiring]
    ordered=[pid for pid in available if pid not in owners]+[pid for pid in available if pid in owners]
    return ordered[:max(0,len(available)-target)]


def children_to_start(pids,target,retiring,ceiling):
    available=len(set(pids)-retiring)
    return max(0,min(target-available,ceiling-len(pids)))


def native_worker_environment(root,registered):
    for pid in sorted(registered):
        p=root/str(pid)
        try:
            args=[x for x in (p/'cmdline').read_bytes().split(b'\0') if x]
            if len(args)!=2 or args[1]!=b'worker.py':continue
            env=dict(x.decode().split('=',1) for x in (p/'environ').read_bytes().split(b'\0') if b'=' in x)
            return {'pid':pid,'cwd':os.readlink(p/'cwd'),'env':env}
        except (OSError,ValueError):continue
    raise RuntimeError('No registered native worker environment available')


async def consume():
    if not mod_enabled('homeQueue'):
        return
    import src.queue.worker as module
    cls=next(value for value in vars(module).values() if isinstance(value,type)
             and hasattr(value,'_process_job') and hasattr(value,'_wait_for_job'))
    install_home_consumer(cls)
    await cls().start()


async def manage():
    if not mod_enabled('homeQueue'):
        return
    runtime=Path('/data/runtime')
    lock=(runtime/'pc-home-pool.lock').open('a+')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError:
        lock.close();return
    queue=get_job_queue();redis=await queue._get_redis()
    children={}
    intentional_stops=set()
    policy=ElasticHomePoolTarget()
    failures=0;next_start=0;last_error=None
    stopping=False
    def stop(*args):
        nonlocal stopping
        stopping=True
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    while True:
        try:
            control=json.loads((runtime/'pc-home-admission.json').read_text())
            ceiling=control_ceiling(control,time.time()*1000)
        except (OSError,ValueError,TypeError):ceiling=0
        if stopping:ceiling=0
        for pid,child in list(children.items()):
            result=child.poll()
            if result is not None:
                children.pop(pid)
                if unexpected_exit(result,pid in intentional_stops):
                    failures+=1;next_start=time.monotonic()+restart_delay(failures)
                    last_error={'pid':pid,'exitCode':result,'checkedAt':int(time.time()*1000)}
                intentional_stops.discard(pid)
        if stopping and not children:break
        try:
            await redis.ping()
            registered=set()
            async for key in redis.scan_iter(match='fflow:workers:worker-*',count=50):
                try:registered.add(int(key.rsplit(':',1)[-1].split('-')[1]))
                except (ValueError,IndexError):pass
            source=native_worker_environment(Path('/proc'),registered)
            owners=set()
            for identifier in await redis.smembers('fflow:active'):
                worker=await redis.hget('job:'+identifier,'worker_id')
                if worker:
                    try:owners.add(int(worker.split('-')[1]))
                    except (ValueError,IndexError):pass
        except Exception as error:
            # Startup/reconnection may temporarily have no native worker. Keep owned
            # children alive and stop admitting new work until storage context is known.
            file=runtime/'pc-home-pool.json';tmp=file.with_suffix('.next')
            tmp.write_text(json.dumps({'mode':'home-only','ready':False,'pid':os.getpid(),
                'checkedAt':int(time.time()*1000),'target':0,'workers':len(children),
                'readyWorkers':0,'nativeTargetUnchanged':True,'errorType':type(error).__name__}))
            tmp.replace(file)
            await asyncio.sleep(2)
            continue
        active=len((set(children)&owners)-intentional_stops)
        target=policy.update(ceiling,active,time.monotonic())
        if time.monotonic()>=next_start:
            for _ in range(children_to_start(list(children),target,intentional_stops,ceiling)):
                env={**source['env'],'VF_HOME_WORKER':'1'}
                log=(runtime/'pc-home-worker.log').open('ab',buffering=0)
                try:
                    child=subprocess.Popen([sys.executable,__file__,'consume'],cwd=source['cwd'],env=env,
                                           stdout=log,stderr=log)
                finally:log.close()
                children[child.pid]=child
        for pid in children_to_retire(list(children),target,owners,intentional_stops):
            child=children[pid]
            # Home's handler stops new claims, not heartbeats or active encodes.
            # Process exit acknowledges retirement; never signal FFmpeg or a group.
            intentional_stops.add(pid)
            try:child.send_signal(signal.SIGTERM)
            except ProcessLookupError:pass
        status={'mode':'home-only','ready':True,'pid':os.getpid(),'checkedAt':int(time.time()*1000),
                'target':target,'workers':len(children),'pids':sorted(children),'nativeTargetUnchanged':True,
                'ceiling':ceiling,'activeWorkers':len(set(children)&owners),
                'retiringPids':sorted(intentional_stops),
                'readyWorkers':len((set(children)&registered)-intentional_stops),
                'nativeEnvironmentPid':source['pid'],
                'lastError':last_error,'restartCooldownSeconds':max(0,next_start-time.monotonic())}
        file=runtime/'pc-home-pool.json';tmp=file.with_suffix('.next')
        tmp.write_text(json.dumps(status));tmp.replace(file)
        if stopping and not children:break
        await asyncio.sleep(1)
    try:await redis.aclose()
    finally:lock.close()


if __name__=='__main__':
    asyncio.run(consume() if len(sys.argv)>1 and sys.argv[1]=='consume' else manage())
