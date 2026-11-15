"""Local-only, authenticated native OCR sidecar with owned request subprocesses."""
import argparse
import hashlib
import hmac
import json
import os
import select
import socket
from pathlib import Path
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONTRACT = 'vf-home-ocr-native-v1-20261029'
ROOT = Path(__file__).resolve().parent
MAX_BODY = 64 * 1024 * 1024
MODELS = {
    'ch_PP-OCRv4_rec_infer.onnx': '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b',
    'ch_PP-OCRv4_det_infer.onnx': 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
}
WARM_IMAGE_WORKERS = 4
OCR_SLOTS = 4  # parallel OCR requests; vf-custom 2026-11-15, owner: "Mehr ocr am pc? Mach" (was 2: ~440/h got 429 busy)

def authorized(header, token):
    return len(token) >= 16 and hmac.compare_digest(header or '', 'Bearer ' + token)

def deadline_seconds(value):
    return max(.001, min(360, float(value) / 1000))

def validate_body(body):
    if not isinstance(body, dict): raise ValueError('Expected object')
    images = body.get('images')
    if not isinstance(images, list) or not 1 <= len(images) <= 24: raise ValueError('Image count')
    ids = set()
    for image in images:
        if not isinstance(image, dict) or image.get('image_url'): raise ValueError('Inline images only')
        key, data = image.get('id'), image.get('data_base64')
        if not isinstance(key, str) or not 1 <= len(key) <= 200 or key in ids: raise ValueError('Image ID')
        if not isinstance(data, str) or not 1 <= len(data) <= 28*1024*1024: raise ValueError('Image bytes')
        ids.add(key)
    if type(body.get('recognize', True)) is not bool: raise ValueError('Recognition flag')
    if type(body.get('max_side', 960)) is not int or not 160 <= body.get('max_side', 960) <= 1920: raise ValueError('Resolution')
    return body

def verify_models():
    import rapidocr_onnxruntime
    root = Path(rapidocr_onnxruntime.__file__).parent
    hashes = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*.onnx') if p.name in MODELS}
    if hashes != MODELS: raise RuntimeError('Native OCR models mismatch')
    return hashes

def child(use_pool=True):
    raw = sys.stdin.buffer.read(MAX_BODY + 1)
    body = validate_body(json.loads(raw))
    if use_pool:
        from warm_pool import try_proxy
        result = try_proxy(json.dumps(body).encode(), ROOT.parent.parent / 'vf-speed-20261002/private/pc-boost-token.txt')
        if result is not None:
            print(json.dumps(result, allow_nan=False))
            return
    import asyncio
    from types import SimpleNamespace
    sys.path.insert(0, str(ROOT / 'native'))
    from app.ocr import OcrService, RapidOcrEngine
    from app.schemas import OcrRequest
    verify_models()
    service = OcrService(SimpleNamespace(internal_token='', fflow_base_url=''), RapidOcrEngine(max_instances=2), workers=2)
    result = asyncio.run(service.run(OcrRequest.model_validate(body)))
    print(json.dumps(result, allow_nan=False))


def warm_child(owner_pid):
    from warm_pool import CONTRACT as WARM_CONTRACT, watch_parent
    watch_parent(owner_pid, lambda: os._exit(0))
    import asyncio
    from types import SimpleNamespace
    sys.path.insert(0, str(ROOT / 'native'))
    from app.ocr import OcrService, RapidOcrEngine
    from app.schemas import OcrRequest
    models = verify_models()
    engine = RapidOcrEngine(max_instances=WARM_IMAGE_WORKERS)
    engine.prepare()
    print(json.dumps({'ready':True, 'contract':WARM_CONTRACT, 'models':models}), flush=True)
    while True:
        raw = sys.stdin.buffer.readline(MAX_BODY + 1)
        if not raw:
            return
        if len(raw)>MAX_BODY or not raw.endswith(b'\n'):
            raise ValueError('Body limit')
        body = validate_body(json.loads(raw))
        service = OcrService(SimpleNamespace(internal_token='', fflow_base_url=''), engine, workers=WARM_IMAGE_WORKERS)
        result = asyncio.run(service.run(OcrRequest.model_validate(body)))
        print(json.dumps(result, allow_nan=False), flush=True)

def run_owned(args, raw, timeout, disconnected=lambda:False):
    flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
    proc=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=flags)
    deadline=time.monotonic()+timeout
    data=raw
    try:
        while True:
            if disconnected(): raise ConnectionAbortedError('Caller disconnected')
            remaining=deadline-time.monotonic()
            if remaining<=0: raise TimeoutError('OCR deadline')
            try:
                out,err=proc.communicate(data,timeout=min(.25,remaining))
                if proc.returncode: raise RuntimeError('OCR subprocess failed')
                return out
            except subprocess.TimeoutExpired:
                data=None
    finally:
        if proc.poll() is None: proc.kill()
        proc.communicate()

class State:
    def __init__(self, token):
        self.token = token
        self.models = verify_models()
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(OCR_SLOTS)
        self.active = self.completed = self.failed = self.images = self.timed_out = 0
        self.started = time.time()

    def snapshot(self):
        with self.lock:
            return dict(ready=True, contract=CONTRACT, backend='native-rapidocr-cpu', capacity=OCR_SLOTS,
                        active=self.active, completed=self.completed, failed=self.failed, images=self.images,
                        timedOut=self.timed_out, models=self.models, uptimeSeconds=int(time.time()-self.started))

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, *args): pass

    def reply(self, status, body):
        data=json.dumps(body, allow_nan=False).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(data)))
            self.end_headers();self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, OSError): pass

    def auth(self):
        if authorized(self.headers.get('Authorization'), self.server.state.token): return True
        self.reply(401, {'error':'Unauthorized'});return False

    def disconnected(self):
        try:
            readable,_,_=select.select([self.connection],[],[],0)
            return bool(readable) and not self.connection.recv(1,socket.MSG_PEEK)
        except OSError: return True

    def do_GET(self):
        if not self.auth(): return
        if self.path != '/health': self.reply(404, {'error':'Not found'});return
        self.reply(200, self.server.state.snapshot())

    def do_POST(self):
        if not self.auth(): return
        if self.path != '/ocr': self.reply(404, {'error':'Not found'});return
        state=self.server.state
        if not state.slots.acquire(blocking=False): self.reply(429, {'error':'OCR busy'});return
        with state.lock:state.active+=1
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=MAX_BODY: raise ValueError('Body limit')
            timeout=deadline_seconds(self.headers.get('X-VF-Deadline-Ms','180000'))
            started=time.monotonic()
            raw=self.rfile.read(length)
            if len(raw)!=length: raise ValueError('Incomplete body')
            body=validate_body(json.loads(raw))
            remaining=max(.001,timeout-(time.monotonic()-started))
            out=run_owned([sys.executable,str(ROOT/'service.py'),'--child'],json.dumps(body).encode(),remaining,self.disconnected)
            result=json.loads(out)
            if any(row.get('error') for row in result.get('results',[])): raise RuntimeError('OCR image failed')
            with state.lock:state.completed+=1;state.images+=len(result['results'])
            self.reply(200,result)
        except TimeoutError:
            with state.lock:state.failed+=1;state.timed_out+=1
            self.reply(504,{'error':'OCR deadline'})
        except (ValueError, json.JSONDecodeError):
            with state.lock:state.failed+=1
            self.reply(400,{'error':'Invalid OCR request'})
        except Exception:
            with state.lock:state.failed+=1
            self.reply(503,{'error':'OCR unavailable; use native fallback'})
        finally:
            with state.lock:state.active-=1
            state.slots.release()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--child',action='store_true')
    parser.add_argument('--cold',action='store_true')
    parser.add_argument('--warm-child',action='store_true')
    parser.add_argument('--owner-pid',type=int)
    parser.add_argument('--token-file')
    parser.add_argument('--port',type=int,default=18196)
    args=parser.parse_args()
    if args.warm_child:
        if not args.owner_pid or args.owner_pid<1:raise ValueError('Owner required')
        warm_child(args.owner_pid);return
    if args.child:child(use_pool=not args.cold);return
    token=Path(args.token_file).read_text().strip()
    if len(token)<16:raise RuntimeError('Token unavailable')
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    server.daemon_threads=True;server.state=State(token)
    server.serve_forever(poll_interval=.5)

if __name__=='__main__':main()
