"""Bounded scene offload using existing blobs and CPU/GPU leases. No native encodes."""
import base64,fcntl,hashlib,json,os,random,re,sys,tempfile,time,urllib.request,uuid
from pathlib import Path
from contextlib import redirect_stdout,closing
from pc_node_normalize_cli import _load_hook
PHASE='validate'
# The caller (node/home-scenes.mjs) keeps the native fallback reserve; this only bounds one attempt.
MAX_BUDGET_S=360
# Scenes share the 8 Home graphics slots with Motion (SCENE_SLOTS=8 since 08:15 with 14 Home graphics slots and motionSlots 6). Declining at once sent 21 of 31 attempts
# (2026-11-05) to the saturated server; wait briefly for a slot (and retry a 503 lost race) while the
# budget still covers transfer and Home render (seen up to 95 s). Scenes take at most SCENE_SLOTS of
# the lane so Motion (motionSlots=4) keeps its Home slots: its server fallback costs minutes of
# Chromium, a server scene ~18 s. A slot frees every ~10-20 s; a 150 s wait held Home dispatch
# scopes (39 of 40) while the Home encoders idled, so the wait stays short.
GRAPHICS_WAIT_S=60  # owner 2026-11-05: no fallbacks; wait for a Home graphics slot (budget is ~340 s)
# Home /health took up to 3.5 s under load; 5 s plus tunnel latency failed 22 scenes in 30 min (22:10Z).
HEALTH_TIMEOUT_S=15
RENDER_RESERVE_S=120
BUSY_ANSWER_S=20  # a Home lease/slot miss answers 503 within seconds; a slower 503 means the render ran and failed
SCENE_SLOTS=10  # 2026-11-06 01:55 step-up 8 -> 10: flock full (20/78 home_graphics_full) while Home graphics 5/14, PC CPU 48 %, GPU 76 %
TIMING={}

def graphics_full(health):
    capacity=health.get('graphicsCapacity')
    busy=health.get('graphicsBusy')
    return type(capacity) is int and capacity>0 and type(busy) is int and busy>=capacity

def cpu_full(health):
    # Both scene lanes take a Home CPU lease. Trims fill the 14 CPU slots in bursts and free one
    # every few seconds; declining at once sent 68 of 358 scenes to the server (2026-11-06 03:40Z).
    capacity=health.get('cpuCapacity')
    busy=health.get('cpuBusy')
    return type(capacity) is int and capacity>0 and type(busy) is int and busy>=capacity

GPU_RESERVE=4
def map_lane_ok(health):
    # The map lane (NVDEC + CPU scenes) holds one of the Home GPU slots that NVENC encodes need.
    # 6-9 map scenes held 6-9 of 10 GPU slots while NVENC ran 0-1 sessions and Home finished
    # 1 encode in 16 s (2026-11-06 05:22Z). Scenes use it only while GPU_RESERVE slots stay free for
    # encodes, else the CPU lane (same detection, CPU decode).
    capacity=health.get('gpuCapacity',0);busy=health.get('gpuBusy',0)
    return bool(health.get('nvencReady')) and type(capacity) is int and type(busy) is int and busy<capacity-GPU_RESERVE

def full_reason(health):
    return 'home_cpu_full' if cpu_full(health) else 'home_graphics_full'

SLOT_DIR='/data/runtime/home-scene-slots'
HELD=[]

def take_slot(directory=None):
    # Concurrent CLIs all saw activeJobs<4 and submitted; a flock per slot caps scenes at SCENE_SLOTS.
    # The kernel drops the lock when this process exits, so a crash cannot leak a slot.
    if HELD:return True
    directory=directory or SLOT_DIR
    os.makedirs(directory,exist_ok=True)
    for index in range(SCENE_SLOTS):
        handle=open(os.path.join(directory,f'{index}.lock'),'a')
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:handle.close();continue
        HELD.append(handle);return True
    return False

def slot_free(health,lane_health,lock=True):
    # The lock is taken only right before upload: a slot held through the source download left
    # Home graphics at 2/8 while 197 of 212 scenes fell back (2026-11-05 06:27).
    # Scene concurrency is the flock alone. The lane's activeJobs also counts Motion renders (lane
    # 'motion' whenever Home's GPU slots are full), so comparing it with SCENE_SLOTS reported
    # 'home_graphics_full' for 122 of 284 scenes while Home graphics were 4-6/14 busy (21:50-22:20).
    return not graphics_full(health) and not cpu_full(health) and (not lock or take_slot())

# Each scene CLI holds one of Home's ~35 dispatch scopes. 29 CLIs ran while 10 could render and
# ~19 waited up to 60 s for a graphics slot, so 437 trims + 774 normalizes got no scope and Home's
# encoders idled (2026-11-06 05:25Z). Only SCENE_WAITERS scenes wait at a time; the rest decline at once.
WAIT_DIR='/data/runtime/home-scene-waiters'
SCENE_WAITERS=8  # 4 freed the scopes (admissions 6 -> 57/min) but declined 34 of 106 scenes in 150 s; a slot frees every ~3 s

def take_waiter(directory=None):
    directory=directory or WAIT_DIR
    os.makedirs(directory,exist_ok=True)
    for index in range(SCENE_WAITERS):
        handle=open(os.path.join(directory,f'{index}.lock'),'a')
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:handle.close();continue
        return handle
    return None

def wait_for_slot(hook,home,token,lane,health,lane_health,deadline,sleep=time.sleep,clock=time.monotonic,lock=True,take=None):
    started=clock();waited=TIMING.get('graphicsWaitS',0);waiter=None
    try:
        while (not slot_free(health,lane_health,lock) and deadline-clock()>RENDER_RESERVE_S
               and waited+clock()-started<GRAPHICS_WAIT_S):
            if waiter is None:
                waiter=(take or take_waiter)()
                if waiter is None:
                    TIMING['waitersFull']=TIMING.get('waitersFull',0)+1;break
            sleep(random.uniform(1.5,3.5))
            health=hook.http_request(home,token,'GET','/health',timeout=HEALTH_TIMEOUT_S)
            lane_health=hook.http_request(home,token,'GET','/'+lane+'/health',timeout=HEALTH_TIMEOUT_S)
    finally:
        if waiter is not None:waiter.close()
    TIMING['graphicsWaitS']=round(waited+clock()-started,1)
    return health,lane_health

def resolve_project(job_id,db='/data/vidforge.db',base=Path('/data/projects')):
    import sqlite3
    with closing(sqlite3.connect(Path(db).resolve().as_uri()+'?mode=ro',uri=True,timeout=2)) as connection:
        row=connection.execute('SELECT project_slug FROM pipeline_jobs WHERE job_id=?',(job_id,)).fetchone()
    if not row or not isinstance(row[0],str) or not re.fullmatch(r'[a-zA-Z0-9_-]+',row[0]):return None
    root=base/row[0]
    return root if root.is_dir() and not root.is_symlink() else None

def attempt(r):
    global PHASE
    from urllib.parse import urlparse
    if not re.fullmatch('[a-f0-9-]{36}',r.get('jobId','')):return {'offloaded':False,'reason':'job_scope'}
    url=r.get('sourceUrl') or r.get('localVideoUrl')
    p=urlparse(url)
    if p.scheme not in ('http','https') or p.username or p.password:return {'offloaded':False,'reason':'source_scheme'}
    seconds=float(r['durationSec']);minimum=float(r.get('minShotSec') or max(1,__import__('math').ceil(seconds)))
    maximum=max(1,__import__('math').ceil(seconds))+15
    if not 0<minimum<=maximum<=600:return {'offloaded':False,'reason':'scene_bounds'}
    TIMING['start']=time.monotonic();TIMING['budgetS']=round(min(MAX_BUDGET_S,float(r.get('budgetMs',0))/1000),1)
    deadline=time.monotonic()+max(0,min(MAX_BUDGET_S,float(r.get('budgetMs',0))/1000))
    if deadline-time.monotonic()<15:return {'offloaded':False,'reason':'deadline'}
    hook=_load_hook();settings=hook.runtime_settings()
    if not settings.get('enabled'):return {'offloaded':False,'reason':'disabled'}
    token=Path('/data/runtime/pc-boost-token').read_text().strip();home='http://10.0.3.1:18191'
    PHASE='health';health=hook.http_request(home,token,'GET','/health',timeout=HEALTH_TIMEOUT_S)
    if not health.get('ready'):return {'offloaded':False,'reason':'home_unavailable_or_full'}
    limits=health.get('transferLimits') or {}
    cap=min(80,int(limits.get('sceneMaxFileMb',80)),int(limits.get('ffmpegMaxFileMb',80)),int(limits.get('ffmpegMaxTotalMb',80)))*1024**2
    if cap<1:return {'offloaded':False,'reason':'transfer_disabled'}
    gpu=map_lane_ok(health)
    lane='map' if gpu else 'motion'
    capability=hook.http_request(home,token,'GET','/'+lane+'/health',timeout=HEALTH_TIMEOUT_S)
    health,capability=wait_for_slot(hook,home,token,lane,health,capability,deadline,lock=False)
    if not slot_free(health,capability,lock=False):return {'offloaded':False,'reason':full_reason(health)}
    identifier=uuid.uuid4().hex;submitted=False
    root=resolve_project(r['jobId'])
    if root is None:return {'offloaded':False,'reason':'project_scope'}
    out=root/'home-scene-previews'/r['jobId']/identifier
    try:
        with tempfile.TemporaryDirectory(prefix='vf-scene-source-') as folder:
            PHASE='download';video=Path(folder)/'source.mp4';digest=hashlib.sha256();size=0
            with urllib.request.urlopen(url,timeout=20) as response,video.open('wb') as stream:
                while True:
                    if time.monotonic()>deadline-15:raise TimeoutError('Home scene budget')
                    block=response.read(256*1024)
                    if not block:break
                    size+=len(block)
                    if size>cap:raise ValueError('Source cap')
                    stream.write(block);digest.update(block)
            source=dict(sha256=digest.hexdigest(),size=size)
            PHASE='health';fresh,capability=wait_for_slot(hook,home,token,lane,hook.http_request(home,token,'GET','/health',timeout=HEALTH_TIMEOUT_S),
                hook.http_request(home,token,'GET','/'+lane+'/health',timeout=HEALTH_TIMEOUT_S),deadline)
            if not slot_free(fresh,capability):return {'offloaded':False,'reason':full_reason(fresh)}
            PHASE='upload';hook.upload_with_lane(home,token,{'source.mp4':source},{'source.mp4':video})
        while True:
            remaining=int(deadline-time.monotonic())-5
            if remaining<10:return {'offloaded':False,'reason':'transfer_budget'}
            payload=dict(version=1,id=identifier,contract=capability['contract'],
                operation='native-scenes-gpu-v1' if gpu else 'native-scenes-cpu-v1',source=source,timeoutMs=remaining*1000,
                scene=dict(min_duration_sec=minimum,max_duration_sec=maximum,detection_threshold=27,fallback_interval_sec=10))
            submitted=True
            PHASE='render';TIMING['render']=time.monotonic();TIMING['lane']=lane
            try:result=hook.http_request(home,token,'POST','/'+lane+'/render',payload,remaining+5)
            except urllib.error.HTTPError as exc:
                # 503 = Home had no graphics slot or no CPU/GPU lease; the source is on Home.
                # A lease miss marks the id completed on Home for 610 s, so a retry with the same id
                # only got 'cancelled or replay' (47 futile retries, then server fallback, 2026-11-06).
                # Each retry takes a new id and re-picks the lane: a full Home GPU moves the scene to
                # the CPU lane. A 503 after a real render (slow answer) is a failure, not busy.
                if (exc.code!=503 or deadline-time.monotonic()<=RENDER_RESERVE_S or TIMING.get('graphicsWaitS',0)>=GRAPHICS_WAIT_S
                    or time.monotonic()-TIMING['render']>BUSY_ANSWER_S):raise
                TIMING['busyRetries']=TIMING.get('busyRetries',0)+1
                try:TIMING['busyBody']=exc.read(200).decode(errors='replace')
                except Exception:pass
                time.sleep(random.uniform(1.5,3.5))
                PHASE='health';fresh=hook.http_request(home,token,'GET','/health',timeout=HEALTH_TIMEOUT_S)
                gpu=map_lane_ok(fresh)
                lane='map' if gpu else 'motion';identifier=uuid.uuid4().hex
                if lane=='motion':TIMING['cpuLaneRetries']=TIMING.get('cpuLaneRetries',0)+1
                fresh,capability=wait_for_slot(hook,home,token,lane,fresh,
                    hook.http_request(home,token,'GET','/'+lane+'/health',timeout=HEALTH_TIMEOUT_S),deadline)
                continue
            break
        TIMING['renderS']=round(time.monotonic()-TIMING['render'],1)
        PHASE='verify'
        if (result.get('id')!=identifier or result.get('contract')!=payload['contract']
            or result.get('operation')!=payload['operation'] or result.get('source')!=source
            or result.get('backend') not in ('CPU scenes','NVDEC + CPU scenes')):raise ValueError('Receipt mismatch')
        shots=result.get('shots');thumbs=result.get('thumbnails')
        if not isinstance(shots,list) or not 0<len(shots)<=100 or len(thumbs)!=len(shots):raise ValueError('Scene count')
        out.mkdir(parents=True)
        for index,(shot,thumb) in enumerate(zip(shots,thumbs),1):
            if shot.get('shot_id')!=index or thumb.get('shot_id')!=index:raise ValueError('Scene order')
            if not 0<=shot['start_sec']<shot['end_sec'] or abs(shot['duration_sec']-(shot['end_sec']-shot['start_sec']))>.002:raise ValueError('Scene timing')
            blob=base64.b64decode(thumb['data'],validate=True)
            if not 0<len(blob)<=512*1024 or hashlib.sha256(blob).hexdigest()!=thumb['sha256']:raise ValueError('Preview hash')
            file=out/f'shot_{index}.jpg';file.write_bytes(blob);shot['thumbnailPath']=str(file)
        receipt={k:v for k,v in result.items() if k!='thumbnails'}
        (out/'receipt.json').write_text(json.dumps(receipt))
        return dict(offloaded=True,verified=True,shots=shots,videoFps=result['metadata']['fps'],backend=result['backend'],projectSlug=root.name)
    finally:
        if submitted:
            try:hook.http_request(home,token,'DELETE','/'+lane+'/'+identifier,None,12)
            except Exception:pass

if __name__=='__main__':
    try:
        with redirect_stdout(sys.stderr):result=attempt(json.loads(base64.b64decode(sys.argv[1])))
    except Exception as exc:
        result=dict(offloaded=False,errorType=type(exc).__name__,reason=PHASE)
        if isinstance(exc,urllib.error.HTTPError):
            result['httpStatus']=exc.code
            try:result['httpBody']=exc.read(200).decode(errors='replace')
            except Exception:pass
    try:
        audit={k:result[k] for k in ('offloaded','verified','backend','reason','errorType','httpStatus','httpBody') if k in result}
        audit['at']=time.time()
        if 'start' in TIMING:
            audit.update(elapsedS=round(time.monotonic()-TIMING['start'],1),budgetS=TIMING['budgetS'],lane=TIMING.get('lane'),
                graphicsWaitS=TIMING.get('graphicsWaitS',0),busyRetries=TIMING.get('busyRetries',0),busyBody=TIMING.get('busyBody'),cpuLaneRetries=TIMING.get('cpuLaneRetries',0),waitersFull=TIMING.get('waitersFull',0))
            if 'render' in TIMING:audit['renderS']=TIMING.get('renderS',round(time.monotonic()-TIMING['render'],1))
        target=Path('/data/runtime/home-scenes-cli-last.json');temp=target.with_suffix('.'+uuid.uuid4().hex+'.tmp')
        temp.write_text(json.dumps(audit));os.replace(temp,target)
        log=Path('/data/runtime/home-scenes-cli.jsonl')
        # The audit stopped at 4 MiB (2026-11-06 16:24Z) and monitoring went blind. Rotate instead:
        # at 4 MiB the file becomes .jsonl.1 (replacing the older one), so at most ~8 MiB stay on disk.
        try:
            if log.stat().st_size>=4*1024*1024:os.replace(log,log.with_name(log.name+'.1'))
        except OSError:pass
        with log.open('a') as stream:stream.write(json.dumps(audit)+'\n')
    except OSError:pass
    print(json.dumps(result,separators=(',',':')))
