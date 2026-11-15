"""Give the Home ffmpeg worker a real listen queue (2026-11-10).

pc_ffmpeg_worker.py serves the control and transfer API with
  ThreadingHTTPServer(('127.0.0.1', port), Handler)
and so inherits socketserver's request_queue_size = 5. The Python docs: once that queue is full, further
connections are refused. All server traffic reaches the worker through SSH reverse tunnels; a refused local
connect closes the tunnel channel and the server sees "RemoteDisconnected: Remote end closed connection without
response", declines the job and keeps Home offline for 5 s. Seen 0-30 times an hour on 2026-11-10 (typically
0.3 % of the Home jobs, in bursts of 366-465 jobs per 5 minutes); a local probe found one of 240 connects
delayed by 680 ms, the signature of a full queue.

The server class becomes a subclass with request_queue_size = 128. Nothing else changes. The running worker keeps
its old queue: the edit reaches the worker at its next start.
"""
import ast

MARKER = '# vf-custom:home-listen-backlog-v1'
NATIVE = "    return ThreadingHTTPServer(('127.0.0.1', port), Handler)\n"
PATCHED = "    return _WorkerHTTPServer(('127.0.0.1', port), Handler)\n"
ANCHOR = '\ndef make_server('
CLASS = (
    '\nclass _WorkerHTTPServer(ThreadingHTTPServer):\n'
    f'    {MARKER}: socketserver default is 5; a full queue refuses connections,\n'
    '    # which the server sees through the SSH tunnel as RemoteDisconnected (job declined, Home 5 s offline).\n'
    '    request_queue_size = 128\n'
    '\n'
)
BACKLOG = 128


def patch_worker(text):
    if MARKER in text:
        if text.count(MARKER) != 1:
            raise RuntimeError('Home listen backlog marker duplicated')
        return text
    if text.count(NATIVE) != 1 or text.count(ANCHOR) != 1 or 'ThreadingHTTPServer' not in text.split(ANCHOR)[0]:
        raise RuntimeError('Native Home worker server site missing or ambiguous')
    if text.index(NATIVE) < text.index(ANCHOR):
        raise RuntimeError('Native Home worker server site missing or ambiguous')
    result = text.replace(ANCHOR, '\n' + CLASS.rstrip('\n') + '\n\n' + ANCHOR, 1).replace(NATIVE, PATCHED, 1)
    tree = ast.parse(result)
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == '_WorkerHTTPServer']
    if len(classes) != 1 or result.count(MARKER) != 1 or NATIVE in result:
        raise RuntimeError('Home listen backlog patch verification failed')
    return result
