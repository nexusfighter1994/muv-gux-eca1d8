import threading, json, base64, hashlib
from transport import MotionService, dispatch_motion, MAX_BODY, MAX_ARTIFACT, artifact_bytes

def make_adapter(worker, command, contract, config=None):
    config = {} if config is None else config
    if not isinstance(config, dict) or config.get('contract', contract) != contract:
        raise ValueError('motion capability contract')
    def lease(kinds):
        def acquire():
            with worker.lock:
                if worker.stopping.is_set() or not worker.ready or not worker.config['enabled']:
                    return None
                if any(worker.busy[k] >= worker.config[k+'Workers'] for k in kinds):
                    return None
                for k in kinds:
                    worker.busy[k] += 1
            released = False
            def release():
                nonlocal released
                with worker.lock:
                    if not released:
                        released = True
                        for k in kinds:
                            worker.busy[k] -= 1
            return release
        return acquire
    # Motion renders on the CPU (software browser path): one CPU lease, the GPU budget stays
    # free for NVENC/SigLIP. Maps (Vulkan) keep the CPU+GPU lease (acquire_with_gpu).
    service = MotionService(command, contract, lease(('cpu',)), kinds=config.get('kinds'),
                            max_output_bytes=config.get('maxOutputBytes'),
                            max_response_bytes=config.get('maxResponseBytes'),
                            transfer_limits=worker.transfer_limits.get)
    service.acquire_with_gpu = lease(('cpu', 'gpu'))
    return service

def patch_worker(source):
    source=source.replace('\r\n','\n')
    if hashlib.sha256(source.encode()).hexdigest()!='46e38f991e7ef84cf42e114a88842940292c542f4160a2b2b7b2cc8f951fd06d':raise ValueError('worker version/hash changed')
    auth="                data = None\n"
    route="                blob = re.fullmatch(r'/blobs/([a-f0-9]{64})', self.path)\n"
    if source.count(auth)!=1 or source.count(route)!=1: raise ValueError('worker anchors changed')
    bootstrap="    server = make_server(worker, args.port)\n"
    if source.count(bootstrap)!=1:raise ValueError('worker bootstrap changed')
    source=source.replace(bootstrap,"    import os\n    motion_runtime = os.environ.get('VF_MOTION_RUNTIME_JSON')\n    if motion_runtime:\n        from adapter import make_adapter\n        motion_config = json.loads(Path(motion_runtime).read_text())\n        worker.motion = make_adapter(worker, [motion_config['node'], str(Path(__file__).with_name('worker.mjs')), motion_runtime], motion_config['contract'], config=motion_config)\n"+bootstrap)
    source=source.replace(auth,"                if self.path.startswith('/motion'):\n                    if not getattr(worker, 'motion', None): return self.respond(503, {'error': 'unavailable'})\n                    from adapter import paced_dispatch\n                    return paced_dispatch(self, worker, DOWNLOAD_LIMIT, UPLOAD_LIMIT)\n"+auth)
    cleanup="        worker.close()\n"
    if source.count(cleanup)!=1:raise ValueError('worker cleanup changed')
    source=source.replace(cleanup,"        try:\n            if getattr(worker, 'motion', None): worker.motion.close()\n        finally:\n            worker.close()\n")
    # Clone retains the existing worker's readonly dependency location.
    return "import sys\nsys.path.extend(['E:/VidForgeHomeBoost/vf-speed-20261002/ffmpeg','E:/VidForgeHomeBoost/vf-speed-20261002'])\n"+source

def paced_dispatch(handler, worker, down, up):
    length=int(handler.headers.get('Content-Length','0'))
    if length>MAX_BODY or length<0: return handler.respond(413,{})
    handler.connection.settimeout(15)
    parts=[]; remaining=length
    while remaining:
        size=min(256*1024,remaining); down.take(size)
        chunk=handler.rfile.read(size)
        if not chunk: raise ValueError('truncated body')
        parts.append(chunk);remaining-=len(chunk)
    data=json.loads(b''.join(parts)) if length else None
    rendering = handler.path == '/motion/render' and handler.command == 'POST'
    max_output, max_response = worker.motion.output_limits(data) if rendering else (MAX_ARTIFACT, MAX_BODY)
    limits=worker.transfer_limits.get()
    if isinstance(data,dict) and 'assets' in data:
        sizes=[len(artifact_bytes(a['data'],MAX_ARTIFACT)) for a in data['assets']]
        if sum(sizes)>MAX_ARTIFACT:raise ValueError('input assets cap')
        if any(n>limits['ffmpegMaxFileMb']*1024**2 for n in sizes) or sum(sizes)>limits['ffmpegMaxTotalMb']*1024**2:raise ValueError('custom input cap')
    old=handler.respond
    def respond(code,value):
        if code==200 and isinstance(value,dict) and 'data' in value:
            size=len(artifact_bytes(value['data'],max_output))
            if size>min(limits['ffmpegMaxFileMb'],limits['ffmpegMaxTotalMb'])*1024**2:raise ValueError('custom output cap')
        body=json.dumps(value).encode()
        if len(body)>max_response:raise ValueError('response cap')
        handler.send_response(code);handler.send_header('Content-Type','application/json');handler.send_header('Content-Length',str(len(body)));handler.end_headers()
        for i in range(0,len(body),256*1024):
            block=body[i:i+256*1024];up.take(len(block));handler.wfile.write(block)
    handler.respond=respond
    try:
        if not dispatch_motion(handler,worker.motion,data): respond(404,{})
    finally: handler.respond=old
