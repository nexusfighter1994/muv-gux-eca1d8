import importlib.util
import json
from pathlib import Path
import sys
import time
import unittest
import http.client
import os
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('warm_pool', ROOT / 'warm_pool.py')
warm = importlib.util.module_from_spec(spec) if spec else None
try:
    spec.loader.exec_module(warm)
except FileNotFoundError:
    warm = None

FAKE = '''import json,sys,time
print(json.dumps({'ready':True,'contract':'test'}),flush=True)
for line in sys.stdin:
 b=json.loads(line)
 if b.get('sleep'):time.sleep(b['sleep'])
 if b.get('malformed'):print('invalid',flush=True)
 else:print(json.dumps({'results':b['images'],'pid':__import__('os').getpid()}),flush=True)
'''

class WarmTests(unittest.TestCase):
    @unittest.skipUnless(os.name=='nt','Windows descendant cleanup')
    def test_timeout_reaps_real_python_descendant_not_only_venv_launcher(self):
        import ctypes
        from ctypes import wintypes
        script="import sys,subprocess,json,time;child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(json.dumps({'ready':True,'contract':'test','child':child.pid}),flush=True);sys.stdin.readline();time.sleep(30)"
        w=warm.OwnedWorker([sys.executable,'-u','-c',script],'test')
        self.addCleanup(w.close)
        ready=w.warm(5)
        api=ctypes.WinDLL('kernel32',use_last_error=True)
        api.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];api.OpenProcess.restype=wintypes.HANDLE
        api.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
        api.TerminateProcess.argtypes=[wintypes.HANDLE,wintypes.UINT]
        api.CloseHandle.argtypes=[wintypes.HANDLE]
        handle=api.OpenProcess(0x100001,False,ready['child'])
        self.assertTrue(handle)
        try:
            with self.assertRaises(TimeoutError):w.run(b'{"images":[]}',.15)
            self.assertEqual(api.WaitForSingleObject(handle,1500),0,'Real inference descendant survived timeout')
        finally:
            api.TerminateProcess(handle,1);api.CloseHandle(handle)

    @unittest.skipUnless(os.name=='nt','Windows listener ownership')
    def test_loopback_listener_owner_is_exact(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen()
            self.assertEqual(warm.listener_owner(listener.getsockname()[1]),os.getpid())

    def worker(self):
        self.assertIsNotNone(warm, 'Warm OCR pool not implemented')
        w = warm.OwnedWorker([sys.executable, '-u', '-c', FAKE], 'test')
        self.addCleanup(w.close)
        return w

    def test_reuses_exact_process_and_preserves_payload(self):
        w = self.worker()
        b = {'images':[{'id':'日本語', 'bytes':'YWJj'}]}
        a = w.run(json.dumps(b).encode(), 3)
        c = w.run(json.dumps(b).encode(), 3)
        self.assertEqual(a['pid'], c['pid'])
        self.assertEqual(a['results'], b['images'])
        self.assertEqual(c['results'], b['images'])

    def test_deadline_kills_and_reaps_only_owned_child_then_recovers(self):
        a, b = self.worker(), self.worker()
        other = b.run(b'{"images":[]}',3)['pid']
        a.run(b'{"images":[]}',3)
        old = a.proc
        with self.assertRaises(TimeoutError):
            a.run(b'{"images":[],"sleep":10}', .1)
        self.assertIsNotNone(old.poll())
        self.assertEqual(other, b.run(b'{"images":[]}',3)['pid'])
        self.assertNotEqual(old.pid, a.run(b'{"images":[]}',3)['pid'])

    def test_disconnect_and_malformed_output_are_reaped(self):
        w = self.worker()
        w.run(b'{"images":[]}',3)
        old = w.proc
        with self.assertRaises(ConnectionAbortedError):
            w.run(b'{"images":[],"sleep":10}',3,lambda:True)
        self.assertIsNotNone(old.poll())
        w.run(b'{"images":[]}',3)
        old = w.proc
        with self.assertRaises((ValueError, RuntimeError)):
            w.run(b'{"images":[],"malformed":true}',3)
        self.assertIsNotNone(old.poll())

    def test_close_is_idempotent_and_no_child_left(self):
        w = self.worker()
        w.run(b'{"images":[]}',3)
        old=w.proc
        w.close();w.close()
        self.assertIsNotNone(old.poll())

    def test_blocked_stdin_write_obeys_deadline(self):
        self.assertIsNotNone(warm)
        script="import json,time;print(json.dumps({'ready':True,'contract':'test'}),flush=True);time.sleep(10)"
        w=warm.OwnedWorker([sys.executable,'-u','-c',script],'test')
        self.addCleanup(w.close)
        w.warm(3)
        old=w.proc
        started=time.monotonic()
        with self.assertRaises(TimeoutError):w.run(b'x'*1024*1024,.15)
        self.assertLess(time.monotonic()-started,3)
        self.assertIsNotNone(old.poll())

    def test_stopped_worker_cannot_spawn_after_pool_shutdown(self):
        w=self.worker()
        w.stop()
        with self.assertRaises(RuntimeError):w.warm(3)
        self.assertIsNone(w.proc)

    def test_pool_is_bounded_and_releases_on_error(self):
        self.assertIsNotNone(warm, 'Warm OCR pool not implemented')
        p = warm.WorkerPool(lambda:self.worker(),size=2)
        self.addCleanup(p.close)
        with p.lease() as a:
            with p.lease() as b:
                self.assertIsNot(a,b)
                with self.assertRaises(warm.Busy):
                    with p.lease():pass
        try:
            with p.lease():raise ValueError('test')
        except ValueError:pass
        with p.lease():
            with p.lease():pass

    def test_owner_exit_wakes_windows_pinned_handle(self):
        owner=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
        follower=subprocess.Popen([sys.executable,'-c',
            "import sys,os,time;sys.path.insert(0,sys.argv[1]);from warm_pool import watch_parent;watch_parent(int(sys.argv[2]),lambda:os._exit(7));print('ready',flush=True);time.sleep(30)",str(ROOT),str(owner.pid)],stdout=subprocess.PIPE)
        try:
            self.assertEqual(follower.stdout.readline().strip(),b'ready')
            owner.kill();owner.wait(timeout=3)
            self.assertEqual(follower.wait(timeout=3),7)
        finally:
            for p in (owner,follower):
                if p.poll() is None:p.kill()
                p.wait(timeout=3)
            follower.stdout.close()

    def test_http_auth_proxy_exact_payload_and_graceful_owner_cleanup(self):
        self.assertIsNotNone(warm)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);token=root/'token';token.write_text('t'*32)
            script=root/'worker.py'
            script.write_text("import sys,os,json,time;sys.path.insert(0,"+repr(str(ROOT))+");from warm_pool import watch_parent,CONTRACT;watch_parent(int(sys.argv[-1]),lambda:os._exit(0));print(json.dumps({'ready':True,'contract':CONTRACT}),flush=True)\nfor line in sys.stdin:\n b=json.loads(line);print(json.dumps({'model':'rapidocr','results':[{'id':i['id'],'width':640,'height':360,'boxes':[],'text_area_ratio':0,'error':None} for i in b['images']],'pid':os.getpid()}),flush=True)\n")
            with socket.socket() as listener:
                listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
            owner=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
            server=subprocess.Popen([sys.executable,'-c',"import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from warm_pool import serve;serve(Path(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),Path(sys.argv[5]))",str(ROOT),str(token),str(owner.pid),str(port),str(script)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    try:
                        connection=http.client.HTTPConnection('127.0.0.1',port,timeout=1)
                        connection.request('GET','/health',headers={'Authorization':'Bearer '+'t'*32})
                        response=connection.getresponse();health=json.loads(response.read());connection.close()
                        if health.get('ready'):break
                    except (OSError,ValueError):pass
                    time.sleep(.05)
                else:self.fail('HTTP pool never ready')
                connection=http.client.HTTPConnection('127.0.0.1',port,timeout=1)
                connection.request('GET','/health');response=connection.getresponse();response.read();self.assertEqual(response.status,401);connection.close()
                raw=json.dumps({'images':[{'id':'native','data_base64':'YQ=='}],'recognize':True,'max_side':1600}).encode()
                a=warm.try_proxy(raw,token,port);b=warm.try_proxy(raw,token,port)
                self.assertEqual(a['results'],b['results'])
                self.assertEqual(a['results'][0]['id'],'native')
                self.assertIsNone(warm.try_proxy(raw,root/'missing',port))
                owner.kill();owner.wait(timeout=3);self.assertEqual(server.wait(timeout=5),0)
            finally:
                for p in (owner,server):
                    if p.poll() is None:p.kill()
                    p.wait(timeout=5)

if __name__=='__main__':unittest.main()
