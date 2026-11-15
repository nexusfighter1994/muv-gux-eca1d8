import ast
import importlib.util
import socket
import threading
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('hlb', HERE / 'home-listen-backlog-install.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# The native shape: import, some code, the factory with its nested handler.
NATIVE = '''import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def helper():
    return 1


def make_server(worker, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            body = json.dumps({'ready': True, 'worker': worker}).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


def main():
    return make_server(None, 0)
'''


def test_only_the_server_class_changes():
    out = mod.patch_worker(NATIVE)
    assert out.count(mod.MARKER) == 1
    assert "return _WorkerHTTPServer(('127.0.0.1', port), Handler)" in out
    assert "return ThreadingHTTPServer(" not in out
    removed = [l for l in NATIVE.splitlines() if l not in out.splitlines()]
    assert removed == ["    return ThreadingHTTPServer(('127.0.0.1', port), Handler)"], removed
    tree = ast.parse(out)
    names = [n.name for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef))]
    assert names == ['helper', '_WorkerHTTPServer', 'make_server', 'main'], names


def test_patched_server_listens_with_the_larger_queue_and_serves():
    scope = {}
    exec(compile(mod.patch_worker(NATIVE), 'pc_ffmpeg_worker.py', 'exec'), scope)
    server = scope['make_server']('w1', 0)
    try:
        assert type(server).__name__ == '_WorkerHTTPServer'
        assert server.request_queue_size == mod.BACKLOG == 128
        assert server.daemon_threads is True, 'ThreadingHTTPServer behaviour kept'
        port = server.server_address[1]
        # 60 connections queued before the server accepts anything: with the default queue of 5 most of
        # these would be refused or stall; all must connect now.
        pending = []
        for _ in range(60):
            s = socket.socket(); s.settimeout(3)
            s.connect(('127.0.0.1', port)); pending.append(s)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        for s in pending:
            s.close()
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=5) as r:
            assert r.status == 200 and b'"ready": true' in r.read()
    finally:
        server.shutdown(); server.server_close()


def test_idempotent():
    once = mod.patch_worker(NATIVE)
    assert mod.patch_worker(once) == once


def test_fails_closed_when_missing_or_ambiguous():
    for text in ('x = 1\n',
                 NATIVE.replace("ThreadingHTTPServer(('127.0.0.1', port), Handler)", "ThreadingHTTPServer(('0.0.0.0', port), Handler)"),
                 NATIVE + "\n\ndef other(port, Handler):\n    return ThreadingHTTPServer(('127.0.0.1', port), Handler)\n",
                 NATIVE.replace('def make_server(', 'def build_server(')):
        try:
            mod.patch_worker(text)
        except RuntimeError as exc:
            assert 'missing or ambiguous' in str(exc), exc
        else:
            raise AssertionError('must fail closed')


def test_duplicate_marker_fails():
    try:
        mod.patch_worker(mod.MARKER + '\n' + mod.MARKER + '\n')
    except RuntimeError as exc:
        assert 'duplicated' in str(exc)
    else:
        raise AssertionError('must fail closed')


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print('ok', name)
