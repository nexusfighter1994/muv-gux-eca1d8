#!/usr/bin/env python3
"""Linux root integration test. All network mutations occur in fresh private namespaces."""
import argparse
import concurrent.futures
import http.client
import importlib.util
import json
import os
import pathlib
import select
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).resolve()
SOURCE = HERE.parents[1] / 'helpers' / 'host_pc_tunnel_limiter.py'


def load():
    spec = importlib.util.spec_from_file_location('host_pc_tunnel_limiter', SOURCE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def serve():
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def do_GET(self):
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == '/health':
                body = b'ok'
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            count = int(urllib.parse.parse_qs(parsed.query)['bytes'][0])
            self.send_response(200)
            self.send_header('Content-Length', str(count))
            self.end_headers()
            chunk = b'x' * 65536
            while count:
                size = min(count, len(chunk))
                self.wfile.write(chunk[:size])
                count -= size
        def do_POST(self):
            remaining = int(self.headers['Content-Length'])
            while remaining:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk: raise RuntimeError('short_body')
                remaining -= len(chunk)
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'ok')
        def log_message(self, *args): pass
    for port in (18191, 18194, 18195):
        server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print('ready', flush=True)
    threading.Event().wait()


def traffic(mode):
    start = time.monotonic()
    size = 1024 * 1024
    ports = (18195,) if mode == 'bypass' else (18191, 18194)
    def transfer(port):
        connection = http.client.HTTPConnection('10.0.3.1', port, timeout=15)
        try:
            if mode == 'post':
                connection.request('POST', '/consume', b'p' * size)
            else:
                connection.request('GET', '/data?bytes=' + str(size))
            response = connection.getresponse()
            body = response.read()
            assert response.status == 200 and len(body) == (2 if mode == 'post' else size)
            return size
        finally:
            connection.close()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        total = sum(pool.map(transfer, ports))
    print(json.dumps({'mode': mode, 'bytes': total, 'seconds': time.monotonic() - start}), flush=True)


def live_connection():
    connection = http.client.HTTPConnection('10.0.3.1', 18191, timeout=20)
    connection.request('GET', '/data?bytes=' + str(3 * 1024 * 1024))
    response = connection.getresponse()
    assert response.status == 200
    body = response.read(65536)
    port_before = connection.sock.getsockname()[1]
    print(json.dumps({'ready': True}), flush=True)
    total = len(body) + len(response.read())
    connection.request('GET', '/health')
    health = connection.getresponse()
    assert health.read() == b'ok' and total == 3 * 1024 * 1024
    port_after = connection.sock.getsockname()[1]
    connection.close()
    print(json.dumps({'sameTcpConnection': port_before == port_after, 'bytes': total}), flush=True)


def loopback_health():
    maximum = 0
    for _ in range(15):
        start = time.monotonic()
        connection = http.client.HTTPConnection('127.0.0.1', 18191, timeout=1)
        connection.request('GET', '/health')
        response = connection.getresponse()
        assert response.read() == b'ok'
        maximum = max(maximum, time.monotonic() - start)
        connection.close()
        time.sleep(.1)
    print(json.dumps({'requests': 15, 'maxSeconds': maximum}), flush=True)


def integration():
    assert os.geteuid() == 0 and sys.platform == 'linux'
    module = load()
    suffix = uuid.uuid4().hex[:8]
    gateway_ns, vf_ns = 'vfpcg' + suffix, 'vfpcv' + suffix
    created = []
    children = []
    commands = []
    report = {'namespaceGateway': gateway_ns, 'namespaceVF': vf_ns, 'productionMutations': 0}
    def command(args, timeout=20):
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True)
        return result.stdout
    def nsargs(namespace, *args):
        return ['/usr/sbin/ip', 'netns', 'exec', namespace, *args]
    def kernel_json(namespace, *args):
        return json.loads(command(nsargs(namespace, '/usr/sbin/ip', '-d', '-j', *args)))
    class RecordingKernel(module.Kernel):
        def run(self, args):
            if args[:3] in (['tc', 'qdisc', 'add'], ['tc', 'qdisc', 'change'], ['tc', 'filter', 'add']) or args[:2] == ['ip', 'link']:
                commands.append(list(args))
            return super().run(args)
    kernel = RecordingKernel(prefix=['/usr/sbin/ip', 'netns', 'exec', gateway_ns])
    generation = ['lab-one']
    def discover():
        inner = kernel_json(vf_ns, 'link', 'show', 'dev', 'vfeth')[0]
        matches = [v for v in kernel_json(gateway_ns, 'link', 'show') if v['ifindex'] == inner['link_index']]
        assert len(matches) == 1
        host = matches[0]
        return module.LinkIdentity(host['ifname'], host['ifindex'], host['address'], inner['ifindex'], generation[0], None, 1500)
    desired = {'downMbit': 8, 'upMbit': 4}
    revision = ['a1234567-89ab-4cde-8fab-0123456789ab']
    acknowledgements = []
    def request(method, endpoint, body=None):
        if method == 'GET': return {'desired': desired.copy(), 'revision': revision[0]}
        assert endpoint == '/api/pc-boost/bandwidth/readback'
        assert set(body) == {'revision', 'observed', 'proof'} and body['proof'] == 'tc_qdisc'
        assert body['observed'] == desired
        acknowledgements.append(body)
        return {'ok': True, 'proof': 'tc_qdisc'}
    def new_pair(name):
        command(['/usr/sbin/ip', '-n', gateway_ns, 'link', 'add', name, 'type', 'veth', 'peer', 'name', 'vfeth'])
        command(['/usr/sbin/ip', '-n', gateway_ns, 'link', 'set', 'vfeth', 'netns', vf_ns])
        command(['/usr/sbin/ip', '-n', gateway_ns, 'addr', 'add', '10.0.3.1/24', 'dev', name])
        command(['/usr/sbin/ip', '-n', gateway_ns, 'link', 'set', name, 'up'])
        command(['/usr/sbin/ip', '-n', vf_ns, 'addr', 'add', '10.0.3.21/24', 'dev', 'vfeth'])
        command(['/usr/sbin/ip', '-n', vf_ns, 'link', 'set', 'vfeth', 'up'])
    try:
        for namespace in (gateway_ns, vf_ns):
            command(['/usr/sbin/ip', 'netns', 'add', namespace])
            created.append(namespace)
            command(['/usr/sbin/ip', '-n', namespace, 'link', 'set', 'lo', 'up'])
        new_pair('gweth')
        server = subprocess.Popen(nsargs(gateway_ns, '/usr/bin/python3', '-B', str(HERE), '--serve'),
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        children.append(server)
        assert select.select([server.stdout], [], [], 8)[0] and server.stdout.readline().strip() == 'ready'
        with tempfile.TemporaryDirectory(prefix='vf-tc-test-') as directory:
            store = module.StateStore(pathlib.Path(directory) / 'state.json')
            module.reconcile_once(kernel, discover, store, request)
            first_count = len(commands)
            assert first_count == 13
            module.reconcile_once(kernel, discover, store, request)
            assert len(commands) == first_count
            report['idempotentRestart'] = True
            for mode, lower, upper in (('post', 1.6, 12), ('get', 3.4, 15)):
                transfer = subprocess.Popen(nsargs(vf_ns, '/usr/bin/python3', '-B', str(HERE), '--traffic', mode),
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                children.append(transfer)
                health = json.loads(command(nsargs(gateway_ns, '/usr/bin/python3', '-B', str(HERE), '--health'), timeout=5))
                stdout, stderr = transfer.communicate(timeout=20)
                assert transfer.returncode == 0, stderr
                result = json.loads(stdout)
                assert lower < result['seconds'] < upper, result
                assert health['maxSeconds'] < .5, health
                report[mode] = {**result, 'loopbackHealth': health}
            bypass = json.loads(command(nsargs(vf_ns, '/usr/bin/python3', '-B', str(HERE), '--traffic', 'bypass')))
            assert bypass['seconds'] < 1, bypass
            report['unmatchedPort'] = bypass
            report['kernelSnapshotBeforeRateChange'] = kernel.snapshot(discover())
            live = subprocess.Popen(nsargs(vf_ns, '/usr/bin/python3', '-B', str(HERE), '--live'),
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            children.append(live)
            assert select.select([live.stdout], [], [], 8)[0]
            assert json.loads(live.stdout.readline())['ready']
            before = len(commands)
            desired.update(downMbit=12, upMbit=8)
            revision[0] = 'b1234567-89ab-4cde-8fab-0123456789ab'
            module.reconcile_once(kernel, discover, store, request)
            changes = commands[before:]
            assert len(changes) == 2 and all(c[:3] == ['tc', 'qdisc', 'change'] for c in changes)
            stdout, stderr = live.communicate(timeout=20)
            assert live.returncode == 0, stderr
            report['liveRateChange'] = json.loads(stdout)
            assert report['liveRateChange']['sameTcpConnection']
            report['rateChangeCommands'] = changes
            report['kernelSnapshotAfterRateChange'] = kernel.snapshot(discover())
            # Recreate only the test pair. Owned IFBs persist; new veth is rediscovered.
            kernel.run(['ip', 'link', 'del', discover().device])
            generation[0] = 'lab-two'
            new_pair('gwnew')
            before = len(commands)
            module.reconcile_once(kernel, discover, store, request)
            reconnect = commands[before:]
            assert len(reconnect) == 5 and not any('tbf' in c for c in reconnect)
            health = json.loads(command(nsargs(gateway_ns, '/usr/bin/python3', '-B', str(HERE), '--health'), timeout=5))
            report['recreatedVeth'] = {'device': discover().device, 'changes': reconnect, 'loopbackHealth': health}
            report['acks'] = acknowledgements
            report['passed'] = True
    except Exception as error:
        report['passed'] = False
        report['errorType'] = type(error).__name__
        if isinstance(error, module.SafetyError): report['errorCode'] = error.code
        try:
            report['kernelSnapshotOnFailure'] = kernel.snapshot(discover())
        except Exception:
            pass
        raise
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
                try: child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
        for namespace in reversed(created):
            command(['/usr/sbin/ip', 'netns', 'del', namespace])
        report['cleanedNamespaces'] = created
        report['mutatingCommands'] = commands
        output = HERE.parent / 'host-pc-tunnel-limiter-netns-results.json'
        output.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps({k: v for k, v in report.items() if not k.startswith('kernelSnapshot') and k != 'mutatingCommands'}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--traffic', choices=('post', 'get', 'bypass'))
    parser.add_argument('--health', action='store_true')
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    if args.serve: serve()
    elif args.traffic: traffic(args.traffic)
    elif args.health: loopback_health()
    elif args.live: live_connection()
    else: integration()
