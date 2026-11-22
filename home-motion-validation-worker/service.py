"""Authenticated, bounded native Motion validation. No render-parent lifecycle changes."""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from process_tree import TreeProcess

ROOT=Path(__file__).resolve().parent
CONTRACT='vf-native-motion-validation-20261031-v1'
MAX_BODY=48*1024*1024

def validate_body(p):
    if not isinstance(p,dict) or set(p)-{'compositionHtml','assets','fps','resolution','contract','realAssets'}: raise ValueError('Fields')
    if p.get('contract')!=CONTRACT or p.get('fps')!=24 or p.get('resolution')!='1920x1080' or type(p.get('realAssets')) is not bool: raise ValueError('Contract')
    if not isinstance(p.get('compositionHtml'),str) or len(p['compositionHtml'].encode())>2*1024*1024: raise ValueError('HTML')
    if not isinstance(p.get('assets'),list) or len(p['assets'])>32: raise ValueError('Assets')
    names=set();total=0
    for a in p['assets']:
        if not isinstance(a,dict) or set(a)-{'filename','data','sha256'}: raise ValueError('Asset fields')
        name=a.get('filename','')
        if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}',name) or '..' in name or name.endswith('.') or re.match(r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)',name,re.I) or name.lower() in names or name.lower() in {'request.json','result.json','stdout.log','stderr.log','appdata','localappdata'}: raise ValueError('Asset name')
        names.add(name.lower())
        if 'data' not in a:
            if 'sha256' in a: raise ValueError('Missing asset')
            continue
        data=base64.b64decode(a['data'],validate=True);total+=len(data)
        if total>32*1024*1024 or hashlib.sha256(data).hexdigest()!=a.get('sha256'): raise ValueError('Asset integrity')
    return p

def run_owned(command,root,timeout,disconnected=lambda:False):
    deadline=time.monotonic()+timeout
    clean=False
    with (root/'stdout.log').open('wb') as out,(root/'stderr.log').open('wb') as err:
        proc=TreeProcess(command,stdin=subprocess.DEVNULL,stdout=out,stderr=err)
        try:
            while proc.poll() is None:
                if disconnected(): raise ConnectionAbortedError('Caller disconnected')
                if time.monotonic()>=deadline: raise TimeoutError('Validation deadline')
                if any((root/n).stat().st_size>4*1024*1024 for n in ('stdout.log','stderr.log')): raise RuntimeError('Output limit')
                time.sleep(.1)
            if proc.returncode: raise RuntimeError('Native child failed')
            target=root/'result.json'
            if target.stat().st_size>2*1024*1024: raise RuntimeError('Result limit')
            return json.loads(target.read_text(encoding='utf8'))
        finally:
            try:
                if not proc.tree_exited(): proc.terminate_tree()
                clean=proc.wait_tree(15)
                if not clean: raise RuntimeError('Owned process tree not reaped')
                proc.dispose()
            except Exception as error: raise CleanupError('Owned process cleanup unconfirmed') from error

class CleanupError(RuntimeError): pass

# 2026-11-21: slot count from VF_VALIDATION_SLOTS or validation-slots.json next to this file ({"slots": n}), 1-8,
# default 2. The server accepts any reported capacity 1-8 and admits that many validations.
def validation_slots():
    raw=os.environ.get('VF_VALIDATION_SLOTS','')
    if not raw:
        try: raw=json.loads((Path(__file__).resolve().parent/'validation-slots.json').read_text(encoding='utf8')).get('slots','')
        except Exception: raw=''
    try: n=int(raw)
    except Exception: n=2
    return n if 1<=n<=8 else 2

class State:
    def __init__(self,token,config_path):
        self.token=token;self.config_path=config_path
        self.config=json.loads(config_path.read_text(encoding='utf8'))
        for name,expected in self.config['files'].items():
            if hashlib.sha256(Path(name).read_bytes()).hexdigest()!=expected: raise RuntimeError('Pinned native runtime changed')
        self.lock=threading.Lock();self.capacity=validation_slots();self.slots=threading.BoundedSemaphore(self.capacity)
        self.active=self.completed=self.rejected=self.failed=self.quarantined=0
    def snapshot(self):
        with self.lock: return dict(ready=not self.quarantined,contract=CONTRACT,capacity=self.capacity,active=self.active,completed=self.completed,rejected=self.rejected,failed=self.failed,quarantined=self.quarantined,backend='native-hyperframes-cpu-browser')

class Handler(BaseHTTPRequestHandler):
    def setup(self): super().setup();self.connection.settimeout(20)
    def log_message(self,*args): pass
    def reply(self,status,body):
        data=json.dumps(body,allow_nan=False).encode()
        try:
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except OSError: pass
    def auth(self):
        if hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+self.server.state.token): return True
        self.reply(401,{'error':'Unauthorized'});return False
    def disconnected(self):
        try:
            ready,_,_=select.select([self.connection],[],[],0)
            return bool(ready) and not self.connection.recv(1,socket.MSG_PEEK)
        except OSError: return True
    def do_GET(self):
        if not self.auth(): return
        if self.path!='/health': self.reply(404,{});return
        self.reply(200,self.server.state.snapshot())
    def do_POST(self):
        if not self.auth(): return
        if self.path!='/validate': self.reply(404,{});return
        s=self.server.state
        if s.quarantined or not s.slots.acquire(False): self.reply(429,{'error':'Validation busy/unavailable'});return
        with s.lock:s.active+=1
        root=None;clean=True;started=time.monotonic()
        try:
            size=int(self.headers.get('Content-Length','0'))
            timeout=min(350,max(.001,float(self.headers.get('X-VF-Deadline-Ms','350000'))/1000))
            if not 0<size<=MAX_BODY: raise ValueError('Body size')
            raw=self.rfile.read(size)
            if len(raw)!=size: raise ValueError('Incomplete body')
            p=validate_body(json.loads(raw))
            root=Path(tempfile.mkdtemp(prefix='request-',dir=s.config['workRoot']))
            (root/'request.json').write_bytes(raw)
            result=run_owned([s.config['node'],str(ROOT/'worker.mjs'),str(s.config_path),str(root)],root,max(.001,timeout-(time.monotonic()-started)),self.disconnected)
            if result.get('contract')!=CONTRACT or type(result.get('result',{}).get('valid')) is not bool: raise RuntimeError('Invalid native result')
            with s.lock:
                s.completed+=1;s.rejected+=not result['result']['valid']
            self.reply(200,result)
        except CleanupError:
            clean=False
            with s.lock:s.quarantined+=1;s.failed+=1
            self.reply(503,{'error':'Owned tree cleanup unconfirmed'})
        except (ValueError,TypeError):
            with s.lock:s.failed+=1
            self.reply(400,{'error':'Invalid native validation request'})
        except Exception:
            with s.lock:s.failed+=1
            self.reply(503,{'error':'Native validation unavailable'})
        finally:
            if clean and root:
                try: shutil.rmtree(root)
                except OSError: pass
            with s.lock:s.active-=1
            if clean:s.slots.release()

def main():
    p=argparse.ArgumentParser();p.add_argument('--token-file',required=True);p.add_argument('--config',required=True);p.add_argument('--port',type=int,default=18197);a=p.parse_args()
    token=Path(a.token_file).read_text().strip()
    if len(token)<16: raise RuntimeError('Token missing')
    server=ThreadingHTTPServer(('127.0.0.1',a.port),Handler);server.daemon_threads=True
    server.state=State(token,Path(a.config));server.serve_forever(.5)
if __name__=='__main__':main()
