"""Original PySceneDetect/windows and previews; optional NVDEC, never NVENC."""
import base64,hashlib,json,math,os,re,subprocess,sys,shutil
from pathlib import Path
from dataclasses import asdict

def validate(payload):
    if payload.get('operation') not in ('native-scenes-cpu-v1','native-scenes-gpu-v1'):raise ValueError('Scene operation')
    source=payload.get('source',{})
    if set(source)!={'sha256','size'} or not re.fullmatch('[a-f0-9]{64}',source.get('sha256','')):
        raise ValueError('Scene source')
    if type(source['size']) is not int or not 0<source['size']<=80*1024*1024:raise ValueError('Scene size')
    args=payload.get('scene',{})
    if set(args)!={'min_duration_sec','max_duration_sec','detection_threshold','fallback_interval_sec'}:
        raise ValueError('Exact scene request')
    if any(type(x) not in (int,float) or not math.isfinite(x) or not 0<x<=600 for x in args.values()):
        raise ValueError('Scene parameter bounds')
    if args['detection_threshold']!=27 or args['fallback_interval_sec']!=10 or args['min_duration_sec']>args['max_duration_sec']:
        raise ValueError('Native scene contract')
    return source,args

def execute(payload,config,root):
    source,args=validate(payload)
    blob=Path(config['blobRoot'])/source['sha256']
    if blob.is_symlink() or not blob.is_file() or blob.stat().st_size!=source['size']:raise ValueError('Blob missing')
    video=root/'source.mp4'
    try:os.link(blob,video)
    except OSError:shutil.copyfile(blob,video)
    if hashlib.sha256(video.read_bytes()).hexdigest()!=source['sha256']:raise ValueError('Blob changed')
    probe=json.loads(subprocess.check_output([config['ffprobe'],'-v','error','-show_streams','-of','json',str(video)],timeout=20))
    streams=[s for s in probe['streams'] if s.get('codec_type')=='video']
    if len(streams)!=1:raise ValueError('Single scene source')
    stream=streams[0]
    if stream['codec_name']!='h264' or stream.get('pix_fmt')!='yuv420p' or stream['width']*stream['height']>1920*1080:
        raise ValueError('Scene source outside qualification')
    from scenes_native import detect_video_scenes
    gpu=[]
    if payload['operation']=='native-scenes-gpu-v1':
        import scenedetect
        from gpu_scene_stream import GpuSceneStream
        def opener(path):
            v=GpuSceneStream(path,config['ffmpeg']);gpu.append(v);return v
        scenedetect.open_video=opener
    try:
        metadata,shots=detect_video_scenes(video,args['min_duration_sec'],args['max_duration_sec'],27,10)
    finally:
        for v in gpu:v.close()
    if not shots or len(shots)>100:raise ValueError('Scene result count')
    thumbs=[]
    for shot in shots:
        output=root/('shot_'+str(shot.shot_id)+'.jpg')
        subprocess.run([config['ffmpeg'],'-v','error','-nostdin','-threads','1','-ss',str(shot.start_sec+shot.duration_sec/2),
            '-i',str(video),'-frames:v','1','-vf','scale=480:-1','-y',str(output)],
            capture_output=True,check=True,timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        data=output.read_bytes()
        if not 0<len(data)<=512*1024:raise ValueError('Scene preview size')
        thumbs.append(dict(shot_id=shot.shot_id,sha256=hashlib.sha256(data).hexdigest(),data=base64.b64encode(data).decode()))
    return dict(version=1,id=payload['id'],contract=payload['contract'],operation=payload['operation'],
        backend='NVDEC + CPU scenes' if gpu else 'CPU scenes',source=source,metadata=asdict(metadata),
        shots=[asdict(s) for s in shots],thumbnails=thumbs)

if __name__=='__main__':
    config=json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(execute(json.loads(sys.stdin.read(200000)),config,Path(sys.argv[2])),separators=(',',':')))
