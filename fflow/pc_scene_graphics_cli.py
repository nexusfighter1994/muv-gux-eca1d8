"""Bounded scene offload using existing blobs and CPU/GPU leases. No native encodes."""
import base64,hashlib,json,os,re,sys,tempfile,time,urllib.request,uuid
from pathlib import Path
from contextlib import redirect_stdout,closing
from pc_node_normalize_cli import _load_hook
PHASE='validate'

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
    deadline=time.monotonic()+max(0,min(90,float(r.get('budgetMs',0))/1000))
    if deadline-time.monotonic()<15:return {'offloaded':False,'reason':'deadline'}
    hook=_load_hook();settings=hook.runtime_settings()
    if not settings.get('enabled'):return {'offloaded':False,'reason':'disabled'}
    token=Path('/data/runtime/pc-boost-token').read_text().strip();home='http://10.0.3.1:18191'
    PHASE='health';health=hook.http_request(home,token,'GET','/health',timeout=5)
    if not health.get('ready') or health.get('cpuBusy',0)>=health.get('cpuCapacity',0):return {'offloaded':False,'reason':'home_unavailable_or_full'}
    limits=health.get('transferLimits') or {}
    cap=min(80,int(limits.get('sceneMaxFileMb',80)),int(limits.get('ffmpegMaxFileMb',80)),int(limits.get('ffmpegMaxTotalMb',80)))*1024**2
    if cap<1:return {'offloaded':False,'reason':'transfer_disabled'}
    gpu=health.get('nvencReady') and health.get('gpuBusy',0)<health.get('gpuCapacity',0)
    lane='map' if gpu else 'motion'
    capability=hook.http_request(home,token,'GET','/'+lane+'/health',timeout=5)
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
            PHASE='upload';hook.upload_with_lane(home,token,{'source.mp4':source},{'source.mp4':video})
        remaining=int(deadline-time.monotonic())-5
        if remaining<10:return {'offloaded':False,'reason':'transfer_budget'}
        payload=dict(version=1,id=identifier,contract=capability['contract'],
            operation='native-scenes-gpu-v1' if gpu else 'native-scenes-cpu-v1',source=source,timeoutMs=remaining*1000,
            scene=dict(min_duration_sec=minimum,max_duration_sec=maximum,detection_threshold=27,fallback_interval_sec=10))
        submitted=True
        PHASE='render';result=hook.http_request(home,token,'POST','/'+lane+'/render',payload,remaining+5)
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
    except Exception as exc:result=dict(offloaded=False,errorType=type(exc).__name__,reason=PHASE)
    try:
        audit={k:result[k] for k in ('offloaded','verified','backend','reason','errorType') if k in result}
        audit['at']=time.time()
        target=Path('/data/runtime/home-scenes-cli-last.json');temp=target.with_suffix('.'+uuid.uuid4().hex+'.tmp')
        temp.write_text(json.dumps(audit));os.replace(temp,target)
    except OSError:pass
    print(json.dumps(result,separators=(',',':')))
