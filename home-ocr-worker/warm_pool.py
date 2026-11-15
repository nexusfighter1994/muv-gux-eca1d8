"""Bounded local OCR model reuse; each timed-out request owns one reapable child."""
import argparse
from contextlib import contextmanager
import hmac
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import select
import socket
import subprocess
import sys
import threading
import time

CONTRACT = 'vf-home-ocr-warm-v1-20261101'
MAX_BODY = 64*1024*1024
MAX_REPLY = 2*1024*1024
ROOT = Path(__file__).resolve().parent
OCR_SLOTS = 4  # warm workers = parallel OCR requests; keep equal to service.OCR_SLOTS (2026-11-15, was 2)


def source_contract():
    digest=hashlib.sha256()
    files=[ROOT/'service.py',ROOT/'warm_pool.py',ROOT/'owned_windows.py',*sorted((ROOT/'native/app').glob('*.py'))]
    for file in files:
        digest.update(str(file.relative_to(ROOT)).encode());digest.update(file.read_bytes())
    return digest.hexdigest()


class Busy(Exception):
    pass


class OwnedWorker:
    def __init__(self, command, contract=CONTRACT):
        self.command, self.contract = command, contract
        self.proc = None
        self.responses = None
        self.ready = None
        self.stopped = False
        self.lifecycle = threading.RLock()
        self.job = None

    def close(self):
        with self.lifecycle:
            p, self.proc = self.proc, None
            job, self.job = self.job, None
            self.ready = None
        if p is not None:
            try:
                if job:job.close(p.pid)
            finally:
                if p.poll() is None:p.kill()
                p.wait(timeout=10)
                for pipe in (p.stdin, p.stdout):
                    try: pipe.close()
                    except OSError: pass
        elif job:job.close()

    def stop(self):
        with self.lifecycle:
            self.stopped = True
            self.close()

    def _receive(self, deadline, disconnected):
        while True:
            if disconnected():
                raise ConnectionAbortedError('Caller disconnected')
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise TimeoutError('OCR deadline')
            try:
                value = self.responses.get(timeout=min(.1, remaining))
            except queue.Empty:
                continue
            if isinstance(value, BaseException):
                raise value
            return value

    def warm(self, timeout=120, disconnected=lambda:False):
        with self.lifecycle:
            if self.stopped:raise RuntimeError('Worker stopped')
            if self.proc is not None and self.proc.poll() is None and self.ready:
                return self.ready
            self.close()
            flags = subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
            try:
                if os.name=='nt':
                    from owned_windows import WindowsTree
                    self.job=WindowsTree()
                self.proc = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                             stderr=subprocess.DEVNULL, creationflags=flags)
                if self.job:self.job.capture(self.proc.pid)
            except BaseException:self.close();raise
            responses = self.responses = queue.Queue(maxsize=2)
            proc = self.proc
        def read():
            try:
                while True:
                    line = proc.stdout.readline(MAX_REPLY+1)
                    if not line or len(line)>MAX_REPLY or not line.endswith(b'\n'):
                        raise RuntimeError('Warm OCR response unavailable')
                    responses.put_nowait(json.loads(line))
            except BaseException as error:
                try: responses.put_nowait(error)
                except queue.Full: pass
        threading.Thread(target=read,daemon=True).start()
        try:
            value = self._receive(time.monotonic()+timeout, disconnected)
            if value.get('ready') is not True or value.get('contract') != self.contract:
                raise RuntimeError('Warm OCR contract mismatch')
            if self.job:self.job.capture(proc.pid)
            self.ready = value
            return value
        except BaseException:
            self.close()
            raise

    def run(self, raw, timeout, disconnected=lambda:False):
        deadline = time.monotonic()+timeout
        try:
            self.warm(timeout, disconnected)
            proc, responses = self.proc, self.responses
            def write():
                try:
                    proc.stdin.write(raw+b'\n');proc.stdin.flush()
                except BaseException as error:
                    try: responses.put_nowait(error)
                    except queue.Full: pass
            threading.Thread(target=write,daemon=True).start()
            return self._receive(deadline, disconnected)
        except BaseException:
            self.close()
            raise


class WorkerPool:
    def __init__(self, factory, size=OCR_SLOTS):
        if not 1 <= size <= 8:
            raise ValueError('OCR request slots must be 1-8')
        self.workers = [factory() for _ in range(size)]
        self.available = queue.Queue(maxsize=size)
        self.closed = False
        for worker in self.workers:self.available.put_nowait(worker)

    @contextmanager
    def lease(self):
        if self.closed:raise Busy('Pool closed')
        try:worker=self.available.get_nowait()
        except queue.Empty:raise Busy('OCR busy')
        try:yield worker
        finally:
            if not self.closed:self.available.put_nowait(worker)

    def close(self):
        self.closed = True
        for worker in self.workers:worker.stop()


def watch_parent(pid, stopped):
    """Windows handle pins the original owner across possible PID reuse."""
    if os.name == 'nt':
        import ctypes
        api = ctypes.WinDLL('kernel32',use_last_error=True)
        api.OpenProcess.argtypes = [ctypes.c_uint32,ctypes.c_bool,ctypes.c_uint32]
        api.OpenProcess.restype = ctypes.c_void_p
        api.WaitForSingleObject.argtypes = [ctypes.c_void_p,ctypes.c_uint32]
        api.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = api.OpenProcess(0x100000,False,pid)
        if not handle:stopped();return
        def wait():
            try:
                if api.WaitForSingleObject(handle,0xffffffff)==0:stopped()
            finally:api.CloseHandle(handle)
    else:
        def wait():
            while True:
                try:os.kill(pid,0)
                except ProcessLookupError:stopped();return
                time.sleep(.25)
    threading.Thread(target=wait,daemon=True).start()


def listener_owner(port):
    if os.name!='nt':raise RuntimeError('Explicit parent PID required')
    import ctypes
    class Row(ctypes.Structure):
        _fields_=[(name,ctypes.c_uint32) for name in ('state','local_addr','local_port','remote_addr','remote_port','pid')]
    api=ctypes.WinDLL('iphlpapi',use_last_error=True).GetExtendedTcpTable
    api.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32),ctypes.c_bool,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_uint32]
    size=ctypes.c_uint32()
    if api(None,ctypes.byref(size),False,2,3,0) != 122:raise RuntimeError('Listener table unavailable')
    data=ctypes.create_string_buffer(size.value)
    if api(data,ctypes.byref(size),False,2,3,0):raise RuntimeError('Listener table changed')
    count=ctypes.c_uint32.from_buffer(data).value
    rows=(Row*count).from_buffer(data,4)
    owners={r.pid for r in rows if socket.ntohs(r.local_port&0xffff)==port and r.local_addr==0x0100007f}
    if len(owners)!=1:raise RuntimeError('Unique loopback OCR owner required')
    return owners.pop()


def try_proxy(raw, token_file, port=18208):
    if (ROOT/'warm-disabled').exists():return None
    if not token_file.exists():return None
    try:token = token_file.read_text().strip()
    except OSError:return None
    if len(token)<16:return None
    headers = {'Authorization':'Bearer '+token}
    connection = http.client.HTTPConnection('127.0.0.1',port,timeout=.5)
    try:
        connection.request('GET','/health',headers=headers)
        response = connection.getresponse()
        value = json.loads(response.read(16384))
        if response.status!=200 or value.get('ready') is not True or value.get('contract')!=CONTRACT or value.get('sourceContract')!=source_contract():
            return None
    except (OSError,ValueError,http.client.HTTPException):return None
    finally:connection.close()
    # Once submitted, never repeat an ambiguous request through the cold path.
    connection = http.client.HTTPConnection('127.0.0.1',port,timeout=360)
    try:
        connection.request('POST','/ocr',body=raw,headers={**headers,'Content-Type':'application/json'})
        response = connection.getresponse()
        result = response.read(MAX_REPLY+1)
        if response.status!=200 or len(result)>MAX_REPLY:
            raise RuntimeError('Warm OCR request failed')
        value = json.loads(result)
        if value.get('model')!='rapidocr' or not isinstance(value.get('results'),list):
            raise RuntimeError('Warm OCR result invalid')
        return value
    finally:connection.close()


def serve(token_file, parent_pid, port=18208, worker_script=None):
    from service import validate_body
    token = token_file.read_text().strip()
    if len(token)<16:raise RuntimeError('Token unavailable')
    script = worker_script or ROOT/'service.py'
    pool = WorkerPool(lambda:OwnedWorker([sys.executable,'-u',str(script),'--warm-child','--owner-pid',str(os.getpid())]))
    source=source_contract()
    retiring=threading.Event()
    counters={'completed':0,'failed':0,'active':0}
    lock=threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        def setup(self):super().setup();self.connection.settimeout(20)
        def log_message(self,*args):pass
        def auth(self):
            if hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+token):return True
            self.reply(401,{'error':'Unauthorized'});return False
        def reply(self,status,value):
            raw=json.dumps(value,allow_nan=False).encode()
            try:
                self.send_response(status);self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
            except OSError:pass
        def disconnected(self):
            try:
                readable,_,_=select.select([self.connection],[],[],0)
                return bool(readable) and not self.connection.recv(1,socket.MSG_PEEK)
            except OSError:return True
        def do_GET(self):
            if not self.auth():return
            if self.path!='/health':self.reply(404,{});return
            ready=not retiring.is_set() and all(w.proc is not None and w.proc.poll() is None and w.ready for w in pool.workers)
            with lock:value=dict(counters)
            self.reply(200,dict(ready=bool(ready),contract=CONTRACT,sourceContract=source,capacity=len(pool.workers),**value))
        def do_POST(self):
            if not self.auth():return
            if self.path!='/ocr':self.reply(404,{});return
            if retiring.is_set():self.reply(503,{'error':'OCR source changed'});return
            try:
                with pool.lease() as worker:
                    with lock:counters['active']+=1
                    try:
                        length=int(self.headers.get('Content-Length','0'))
                        if not 0<length<=MAX_BODY:raise ValueError('Body limit')
                        raw=self.rfile.read(length)
                        if len(raw)!=length:raise ValueError('Incomplete body')
                        validate_body(json.loads(raw))
                        result=worker.run(raw,360,self.disconnected)
                        if result.get('model')!='rapidocr' or any(r.get('error') for r in result.get('results',[])):
                            raise RuntimeError('OCR result invalid')
                        with lock:counters['completed']+=1
                        self.reply(200,result)
                    finally:
                        with lock:counters['active']-=1
            except Busy:self.reply(429,{'error':'OCR busy'})
            except BaseException:
                with lock:counters['failed']+=1
                self.reply(503,{'error':'OCR request failed'})
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler);server.daemon_threads=True
    def maintain():
        while not pool.closed:
            try:changed=source_contract()!=source or (ROOT/'warm-disabled').exists()
            except OSError:changed=True
            if changed:
                retiring.set()
                with lock:idle=counters['active']==0
                if idle:
                    server.shutdown();return
                time.sleep(.25);continue
            for _ in range(len(pool.workers)):
                try:
                    with pool.lease() as worker:worker.warm()
                except Exception:pass
            time.sleep(1)
    threading.Thread(target=maintain,daemon=True).start()
    watch_parent(parent_pid,lambda:threading.Thread(target=server.shutdown,daemon=True).start())
    try:server.serve_forever(poll_interval=.25)
    finally:pool.close();server.server_close()


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--token-file',type=Path,required=True)
    parser.add_argument('--parent-pid',type=int)
    parser.add_argument('--owner-port',type=int)
    parser.add_argument('--port',type=int,default=18208)
    args=parser.parse_args()
    owner=args.parent_pid or listener_owner(args.owner_port or 18196)
    serve(args.token_file,owner,args.port)
