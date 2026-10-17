#!/usr/bin/env python3
"""Owned host-side aggregate shaping for the two VF home-boost service ports."""
import argparse
import json
import math
import os
import pathlib
import re
import signal
import stat
import subprocess
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass

VF_IP = '10.0.3.21'
GATEWAY = '10.0.3.1'
PORTS = (18191, 18194)
DEFAULT_RATES = {'downMbit': 120, 'upMbit': 37}
API_ORIGIN = 'http://10.0.3.21:8000'
TOKEN_FILE = '/var/lib/docker/volumes/aufsetzen-apps_vidforge-data/_data/runtime/pc-boost-token'
STATE_FILE = '/var/lib/vf-pc-tunnel-limiter/state.json'
LOCK_FILE = '/run/vf-pc-tunnel-limiter/reconciler.lock'
OWNER = 'vf-pc-tunnel-limiter:v1:'
PSCHED_TICK_NS = 64
DIRECTIONS = (('ingress', 'vfboostdn', '7a01:', 'downMbit', 'down'),
              ('egress', 'vfboostup', '7a02:', 'upMbit', 'up'))
ENDPOINTS = {'GET': '/api/pc-boost/bandwidth/bridge', 'POST': '/api/pc-boost/bandwidth/readback'}


class SafetyError(Exception):
    """Only fixed, credential-free error codes reach logs."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def validate_rates(value):
    if not isinstance(value, dict) or set(value) != {'downMbit', 'upMbit'}:
        raise SafetyError('invalid_rates')
    if any(type(v) is not int or not 1 <= v <= 1000 for v in value.values()):
        raise SafetyError('invalid_rates')
    return dict(value)


def validate_bridge_state(value):
    if not isinstance(value, dict) or set(value) != {'desired', 'revision'}:
        raise SafetyError('invalid_bridge_state')
    if value['desired'] is None:
        if value['revision'] is not None:
            raise SafetyError('invalid_revision')
        return dict(DEFAULT_RATES), None
    rates = validate_rates(value['desired'])
    revision = value['revision']
    try:
        if not isinstance(revision, str) or len(revision) != 36 or str(uuid.UUID(revision)) != revision:
            raise ValueError()
    except ValueError:
        raise SafetyError('invalid_revision') from None
    return rates, revision


def queue_parameters(rate):
    validate_rates({'downMbit': rate, 'upMbit': rate})
    per_second = rate * 125000
    burst = max(65536, math.ceil(per_second / 100))
    limit = min(8 * 1024 * 1024, max(burst, math.ceil(per_second / 4)))
    return {'burst': burst, 'limit': limit}


def read_token(file):
    try:
        fd = os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise SafetyError('invalid_token')
            raw = stream.read(4098).strip()
        if not 1 <= len(raw) <= 4096 or any(b < 33 or b > 126 for b in raw):
            raise SafetyError('invalid_token')
        return raw.decode('ascii')
    except OSError:
        raise SafetyError('token_unavailable') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ApiClient:
    def __init__(self, token_file, origin=API_ORIGIN):
        parsed = urllib.parse.urlsplit(origin)
        if (parsed.scheme != 'http' or parsed.hostname not in (VF_IP, '127.0.0.1')
                or parsed.username or parsed.password or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment):
            raise SafetyError('invalid_api_origin')
        if parsed.hostname == VF_IP and parsed.port != 8000:
            raise SafetyError('invalid_api_origin')
        self.origin = origin.rstrip('/')
        self.token_file = pathlib.Path(token_file)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, endpoint, body=None):
        if ENDPOINTS.get(method) != endpoint or (method == 'GET' and body is not None):
            raise SafetyError('invalid_api_operation')
        token = read_token(self.token_file)
        if method == 'POST' and (not isinstance(body, dict) or set(body) != {'revision', 'observed', 'proof'}
                                or body['proof'] != 'tc_qdisc'):
            raise SafetyError('invalid_readback')
        payload = None if body is None else json.dumps(body, allow_nan=False).encode('utf-8')
        request = urllib.request.Request(self.origin + endpoint, method=method, data=payload,
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=5) as response:
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise SafetyError('api_response_too_large')
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise SafetyError('invalid_api_response')
                return result
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise SafetyError('api_unavailable') from None


@dataclass(frozen=True)
class LinkIdentity:
    device: str
    ifindex: int
    mac: str
    peer_ifindex: int
    container_id: str
    bridge: str | None
    mtu: int

    @property
    def key(self):
        return f'{self.container_id}:{self.ifindex}:{self.mac}'


@dataclass
class Plan:
    commands: list
    claim_clsact: bool = False


def links_by_name(snapshot):
    result = {v['ifname']: v for v in snapshot['links']}
    if len(result) != len(snapshot['links']):
        raise SafetyError('duplicate_link_name')
    return result


def verify_link(identity, snapshot):
    if identity.mtu != 1500 or not re.fullmatch(r'[A-Za-z0-9_.-]{1,15}', identity.device):
        raise SafetyError('invalid_link_name')
    link = links_by_name(snapshot).get(identity.device)
    if (not link or link.get('ifindex') != identity.ifindex or link.get('address') != identity.mac
            or link.get('link_index') != identity.peer_ifindex or link.get('master') != identity.bridge
            or link.get('mtu') != identity.mtu or 'UP' not in link.get('flags', [])
            or link.get('linkinfo', {}).get('info_kind') != 'veth'):
        raise SafetyError('link_identity_changed')


def handle_number(value):
    try:
        return int(value, 0) if isinstance(value, str) else int(value)
    except (ValueError, TypeError):
        raise SafetyError('foreign_filter') from None


def filter_port(filter_, direction, device):
    options = filter_.get('options', {})
    keys = dict(options.get('keys', {}))
    for field in ('src_ip', 'dst_ip'):
        if isinstance(keys.get(field), str):
            keys[field] = keys[field].removesuffix('/32')
    port_key = 'dst_port' if direction == 'ingress' else 'src_port'
    port = keys.get(port_key)
    if isinstance(port, str) and port.isdecimal():
        port = int(port)
        keys[port_key] = port
    expected = {'eth_type': 'ipv4', 'ip_proto': 'tcp',
                'src_ip': VF_IP if direction == 'ingress' else GATEWAY,
                'dst_ip': GATEWAY if direction == 'ingress' else VF_IP, port_key: port}
    actions = options.get('actions', [])
    if (filter_.get('kind') != 'flower' or filter_.get('protocol') != 'ip' or filter_.get('chain', 0) != 0
            or port not in PORTS or filter_.get('pref') != 31000 + port
            or handle_number(options.get('handle', filter_.get('handle'))) != 1
            or keys != expected or not options.get('skip_hw') or options.get('skip_sw')
            or len(actions) != 1):
        raise SafetyError('foreign_filter')
    action = actions[0]
    if (action.get('kind') != 'mirred' or action.get('mirred_action', action.get('eaction')) != 'redirect'
            or ('mirred_action' in action and 'eaction' in action and action['mirred_action'] != action['eaction'])
            or action.get('direction') != 'egress' or action.get('to_dev') != device
            or action.get('control_action', {}).get('type') != 'stolen'):
        raise SafetyError('foreign_filter')
    return port


def concrete_filters(entries):
    details = [f for f in entries if 'options' in f]
    headers = [f for f in entries if 'options' not in f]
    seen = set()
    for header in headers:
        signature = tuple(header.get(k, 0 if k == 'chain' else None) for k in ('kind', 'protocol', 'pref', 'chain'))
        if (set(header) - {'kind', 'protocol', 'pref', 'chain'} or signature in seen
                or sum(tuple(f.get(k, 0 if k == 'chain' else None) for k in ('kind', 'protocol', 'pref', 'chain')) == signature
                       for f in details) != 1):
            raise SafetyError('foreign_filter_header')
        seen.add(signature)
    return details


def tbf_parameters(qdisc):
    options = qdisc.get('options', {})
    if set(options) - {'rate', 'burst', 'limit', 'lat', 'burst_raw'}:
        raise SafetyError('foreign_tbf_options')
    values = (options.get('rate'), options.get('burst'), options.get('limit'))
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0 for v in values):
        raise SafetyError('missing_tbf_proof')
    return values


def tbf_command(verb, device, handle, rate):
    q = queue_parameters(rate)
    return ['tc', 'qdisc', verb, 'dev', device, 'root', 'handle', handle, 'tbf',
            'rate', f'{rate}mbit', 'burst', str(q['burst']), 'limit', str(q['limit'])]


def redirect_command(identity, direction, device, port):
    source, destination = (VF_IP, GATEWAY) if direction == 'ingress' else (GATEWAY, VF_IP)
    return ['tc', 'filter', 'add', 'dev', identity.device, direction, 'protocol', 'ip',
            'pref', str(31000 + port), 'handle', '1', 'flower', 'skip_hw',
            'src_ip', source + '/32', 'dst_ip', destination + '/32', 'ip_proto', 'tcp',
            'dst_port' if direction == 'ingress' else 'src_port', str(port),
            'action', 'mirred', 'egress', 'redirect', 'dev', device]


def build_plan(identity, snapshot, state, rates):
    rates = validate_rates(rates)
    verify_link(identity, snapshot)
    commands = []
    links = links_by_name(snapshot)
    qdiscs = snapshot['qdiscs'].get(identity.device, [])
    roots = [q for q in qdiscs if q.get('root')]
    clsacts = [q for q in qdiscs if q.get('kind') == 'clsact' and q.get('handle') == 'ffff:']
    if (len(roots) != 1 or roots[0].get('kind') != 'noqueue' or roots[0].get('handle') != '0:'
            or len(clsacts) > 1 or len(qdiscs) != len(roots) + len(clsacts)):
        raise SafetyError('foreign_veth_qdisc')
    if clsacts and state.get('links', {}).get(identity.key) is not True:
        raise SafetyError('unowned_clsact')
    seen = {}
    for direction, device, _, _, _ in DIRECTIONS:
        found = [filter_port(f, direction, device) for f in concrete_filters(snapshot['filters'][direction])]
        if len(found) != len(set(found)):
            raise SafetyError('duplicate_filter')
        seen[direction] = set(found)
        if found and not clsacts:
            raise SafetyError('foreign_filter')
    # Complete the ownership/conflict scan before generating any changes.
    for _, device, handle, key, suffix in DIRECTIONS:
        link = links.get(device)
        existing = snapshot['qdiscs'].get(device, [])
        if link:
            if (link.get('linkinfo', {}).get('info_kind') != 'ifb' or link.get('ifalias') != OWNER + suffix
                    or link.get('mtu') != identity.mtu):
                raise SafetyError('foreign_ifb')
            if len(existing) > 1:
                raise SafetyError('foreign_ifb_qdisc')
            if existing and not (existing[0].get('root') and
                ((existing[0].get('kind') == 'tbf' and existing[0].get('handle') == handle)
                 or (existing[0].get('kind') == 'noqueue' and existing[0].get('handle') == '0:'))):
                raise SafetyError('foreign_ifb_qdisc')
        elif existing:
            raise SafetyError('ifb_identity_missing')
    for _, device, handle, key, suffix in DIRECTIONS:
        link = links.get(device)
        if not link:
            commands += [['ip', 'link', 'add', device, 'numtxqueues', '1', 'numrxqueues', '1', 'type', 'ifb'],
                         ['ip', 'link', 'set', 'dev', device, 'alias', OWNER + suffix]]
        existing = snapshot['qdiscs'].get(device, [])
        tbf = existing[0] if existing and existing[0].get('kind') == 'tbf' else None
        if not tbf:
            commands.append(tbf_command('add', device, handle, rates[key]))
        else:
            rate, burst, limit = tbf_parameters(tbf)
            desired = queue_parameters(rates[key])
            # Linux dumps 64 ns ticks; tc also truncates the reconstructed byte count.
            rounding = (rates[key] * 125000 * PSCHED_TICK_NS + 999999999) // 1000000000 + 1
            if (rate != rates[key] * 125000 or limit != desired['limit']
                    or not desired['burst'] - rounding <= burst <= desired['burst']):
                commands.append(tbf_command('change', device, handle, rates[key]))
        if not link or 'UP' not in link.get('flags', []):
            commands.append(['ip', 'link', 'set', 'dev', device, 'up'])
    if not clsacts:
        commands.append(['tc', 'qdisc', 'add', 'dev', identity.device, 'handle', 'ffff:', 'clsact'])
    for direction, device, _, _, _ in DIRECTIONS:
        commands.extend(redirect_command(identity, direction, device, port) for port in PORTS if port not in seen[direction])
    return Plan(commands, not clsacts)


def observe(identity, snapshot, rates, state):
    if build_plan(identity, snapshot, state, rates).commands:
        raise SafetyError('kernel_verification_failed')
    observed = {}
    for _, device, _, key, _ in DIRECTIONS:
        rate, _, _ = tbf_parameters(snapshot['qdiscs'][device][0])
        mbit = rate * 8 / 1000000
        if mbit != rates[key]:
            raise SafetyError('kernel_rate_mismatch')
        observed[key] = int(mbit)
    return observed


class StateStore:
    def __init__(self, file):
        self.file = pathlib.Path(file)

    def load(self):
        if not self.file.exists():
            return {'version': 1, 'links': {}, 'last_rates': None}
        try:
            if self.file.is_symlink() or self.file.stat().st_size > 1024 * 1024:
                raise SafetyError('invalid_state')
            value = json.loads(self.file.read_text(encoding='utf-8'))
            if (set(value) != {'version', 'links', 'last_rates'} or value['version'] != 1
                    or not isinstance(value['links'], dict) or len(value['links']) > 10000
                    or any(not isinstance(k, str) or v is not True for k, v in value['links'].items())):
                raise SafetyError('invalid_state')
            if value['last_rates'] is not None:
                validate_rates(value['last_rates'])
            return value
        except (OSError, ValueError, TypeError):
            raise SafetyError('invalid_state') from None

    def save(self, value):
        self.file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary = tempfile.mkstemp(prefix='.limiter-', dir=self.file.parent)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump(value, stream, allow_nan=False, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
            if os.name == 'posix':
                directory = os.open(self.file.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class Kernel:
    BINARIES = {'ip': '/usr/sbin/ip', 'tc': '/usr/sbin/tc', 'docker': '/usr/bin/docker', 'nsenter': '/usr/bin/nsenter'}

    def __init__(self, prefix=()):
        self.prefix = list(prefix)

    def run(self, command):
        try:
            executable = self.BINARIES[command[0]]
            result = subprocess.run(self.prefix + [executable] + command[1:], capture_output=True,
                                    text=True, timeout=8, check=False)
            if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
                raise SafetyError('kernel_command_failed')
            return result.stdout
        except (OSError, subprocess.TimeoutExpired, KeyError):
            raise SafetyError('kernel_command_failed') from None

    def json(self, command):
        try:
            return json.loads(self.run(command))
        except ValueError:
            raise SafetyError('invalid_kernel_json') from None

    def snapshot(self, identity):
        links = self.json(['ip', '-d', '-j', 'link', 'show'])
        qdiscs = {}
        available = {v['ifname'] for v in links}
        for device in (identity.device, 'vfboostdn', 'vfboostup'):
            # Raw JSON exposes the exact limit; normal tc JSON reports only derived latency.
            qdiscs[device] = self.json(['tc', '-j', '-s', '-r', 'qdisc', 'show', 'dev', device]) if device in available else []
        filters = {direction: self.json(['tc', '-j', '-s', 'filter', 'show', 'dev', identity.device, direction])
                   for direction in ('ingress', 'egress')}
        return {'links': links, 'qdiscs': qdiscs, 'filters': filters}

    def discover(self):
        fmt = '{"id":{{json .Id}},"pid":{{.State.Pid}},"running":{{.State.Running}},"networks":{{json .NetworkSettings.Networks}}}'
        info = self.json(['docker', 'inspect', '--format', fmt, 'aufsetzen-vidforge'])
        network = info.get('networks', {}).get('aufsetzen-apps', {})
        if (info.get('running') is not True or type(info.get('pid')) is not int or info['pid'] < 2
                or network.get('IPAddress') != VF_IP or network.get('Gateway') != GATEWAY
                or network.get('GlobalIPv6Address') or not isinstance(info.get('id'), str)):
            raise SafetyError('vf_network_unavailable')
        base = ['nsenter', '--target', str(info['pid']), '--net', '/usr/sbin/ip']
        addresses = self.json(base + ['-j', 'addr', 'show'])
        candidates = [v for v in addresses if any(a.get('local') == VF_IP and a.get('prefixlen') == 24 for a in v.get('addr_info', []))]
        if len(candidates) != 1:
            raise SafetyError('vf_address_mismatch')
        inner = candidates[0]
        route = self.json(base + ['-j', 'route', 'get', GATEWAY])
        if len(route) != 1 or route[0].get('dev') != inner['ifname'] or route[0].get('prefsrc', route[0].get('src')) != VF_IP:
            raise SafetyError('vf_route_mismatch')
        inner_links = self.json(base + ['-d', '-j', 'link', 'show', 'dev', inner['ifname']])
        if len(inner_links) != 1 or type(inner_links[0].get('link_index')) is not int:
            raise SafetyError('vf_peer_unavailable')
        host_links = self.json(['ip', '-d', '-j', 'link', 'show'])
        matches = [v for v in host_links if v['ifindex'] == inner_links[0]['link_index']]
        if len(matches) != 1:
            raise SafetyError('vf_peer_unavailable')
        host = matches[0]
        bridge = host.get('master')
        bridge_links = [v for v in host_links if v['ifname'] == bridge and v.get('linkinfo', {}).get('info_kind') == 'bridge']
        if len(bridge_links) != 1:
            raise SafetyError('vf_bridge_mismatch')
        bridge_addresses = self.json(['ip', '-j', 'addr', 'show', 'dev', bridge])
        if not any(a.get('local') == GATEWAY and a.get('prefixlen') == 24 for v in bridge_addresses for a in v.get('addr_info', [])):
            raise SafetyError('vf_gateway_mismatch')
        identity = LinkIdentity(host['ifname'], host['ifindex'], host['address'], inner['ifindex'], info['id'], bridge, inner['mtu'])
        verify_link(identity, {'links': host_links})
        return identity


def apply_and_verify(kernel, discover, store, rates):
    identity = discover()
    state = store.load()
    plan = build_plan(identity, kernel.snapshot(identity), state, rates)
    for command in plan.commands:
        kernel.run(command)
        if plan.claim_clsact and command == ['tc', 'qdisc', 'add', 'dev', identity.device, 'handle', 'ffff:', 'clsact']:
            state['links'][identity.key] = True
            store.save(state)
    if discover() != identity:
        raise SafetyError('vf_generation_changed')
    observed = observe(identity, kernel.snapshot(identity), rates, state)
    state['last_rates'] = dict(rates)
    store.save(state)
    return identity, observed, len(plan.commands)


def reconcile_once(kernel, discover, store, request):
    try:
        desired = request('GET', ENDPOINTS['GET'])
    except SafetyError:
        safe = store.load()['last_rates']
        if safe is not None:
            apply_and_verify(kernel, discover, store, safe)
        raise
    rates, revision = validate_bridge_state(desired)
    identity, observed, changes = apply_and_verify(kernel, discover, store, rates)
    if validate_bridge_state(request('GET', ENDPOINTS['GET'])) != (rates, revision):
        raise SafetyError('api_revision_changed')
    if discover() != identity:
        raise SafetyError('vf_generation_changed')
    # A fresh complete kernel snapshot is mandatory immediately before acknowledgement.
    observed = observe(identity, kernel.snapshot(identity), rates, store.load())
    body = {'revision': revision, 'observed': observed, 'proof': 'tc_qdisc'}
    response = request('POST', ENDPOINTS['POST'], body)
    if response.get('ok') is not True or response.get('proof') != 'tc_qdisc':
        raise SafetyError('readback_rejected')
    return {'observed': observed, 'changes': changes, 'device': identity.device, 'ifindex': identity.ifindex}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--token-file', default=TOKEN_FILE)
    parser.add_argument('--state-file', default=STATE_FILE)
    parser.add_argument('--lock-file', default=LOCK_FILE)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--check', action='store_true', help='Read-only plan; no rules, state changes or acknowledgement')
    args = parser.parse_args()
    if os.name != 'posix' or os.geteuid() != 0:
        print('limiter: root Linux host required', flush=True)
        return 1
    client, kernel, store = ApiClient(args.token_file), Kernel(), StateStore(args.state_file)
    if args.check:
        try:
            rates, _ = validate_bridge_state(client.request('GET', ENDPOINTS['GET']))
            identity = kernel.discover()
            plan = build_plan(identity, kernel.snapshot(identity), store.load(), rates)
            print(json.dumps({'checkOnly': True, 'plannedChanges': len(plan.commands), 'desired': rates,
                              'device': identity.device, 'ifindex': identity.ifindex, 'active': not plan.commands}))
            return 0
        except SafetyError as error:
            print('limiter: ' + error.code, flush=True)
            return 1
    import fcntl
    lock_path = pathlib.Path(args.lock_file)
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    lock = os.fdopen(descriptor, 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('limiter: another reconciler owns the lock', flush=True)
        lock.close()
        return 1
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    last_status = None
    try:
        while not stop.is_set():
            try:
                result = reconcile_once(kernel, kernel.discover, store, client.request)
                status = ('applied', result['device'], tuple(result['observed'].values()))
                if status != last_status or result['changes']:
                    print(json.dumps({'status': 'applied', **result}), flush=True)
                code = 0
            except SafetyError as error:
                status, code = (error.code,), 1
                if status != last_status:
                    print('limiter: ' + error.code, flush=True)
            except Exception:
                status, code = ('internal_error',), 1
                if status != last_status:
                    print('limiter: internal_error; existing kernel rules retained', flush=True)
            last_status = status
            if args.once:
                return code
            stop.wait(5)
    finally:
        # Stopping the daemon retains the last safe cap; never turn failures into unlimited traffic.
        lock.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
