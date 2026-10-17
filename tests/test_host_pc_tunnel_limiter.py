import copy
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'helpers' / 'host_pc_tunnel_limiter.py'
if SOURCE.exists():
    spec = importlib.util.spec_from_file_location('host_pc_tunnel_limiter', SOURCE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
else:
    module = None

RATES = {'downMbit': 120, 'upMbit': 37}
REVISION = 'a1234567-89ab-4cde-8fab-0123456789ab'


def identity():
    return module.LinkIdentity('vethvf', 6600, '82:48:eb:eb:f5:b1', 2, 'container-one', 'br-vf', 1500)


def empty_snapshot(link=None):
    link = link or identity()
    return {'links': [{'ifname': link.device, 'ifindex': link.ifindex, 'address': link.mac,
                      'link_index': link.peer_ifindex, 'master': link.bridge, 'mtu': link.mtu,
                      'linkinfo': {'info_kind': 'veth'}, 'flags': ['UP']}],
            'qdiscs': {link.device: [{'kind': 'noqueue', 'root': True, 'handle': '0:'}]},
            'filters': {'ingress': [], 'egress': []}}


def owned_state(link=None):
    link = link or identity()
    return {'version': 1, 'links': {link.key: True}, 'last_rates': RATES.copy()}


def owned_snapshot(rates=None, link=None):
    rates, link = rates or RATES, link or identity()
    snapshot = empty_snapshot(link)
    snapshot['qdiscs'][link.device].append({'kind': 'clsact', 'handle': 'ffff:', 'parent': 'ffff:fff1'})
    for direction, device, handle, key in [('ingress', 'vfboostdn', '7a01:', 'downMbit'),
                                          ('egress', 'vfboostup', '7a02:', 'upMbit')]:
        suffix = 'down' if key == 'downMbit' else 'up'
        snapshot['links'].append({'ifname': device, 'ifindex': 7000 + len(snapshot['links']),
                                 'ifalias': 'vf-pc-tunnel-limiter:v1:' + suffix,
                                 'flags': ['UP'], 'mtu': 1500, 'linkinfo': {'info_kind': 'ifb'}})
        parameters = module.queue_parameters(rates[key])
        snapshot['qdiscs'][device] = [{'kind': 'tbf', 'handle': handle, 'root': True,
                                      'options': {'rate': rates[key] * 125000, **parameters}}]
        for port in (18191, 18194):
            keys = {'eth_type': 'ipv4', 'ip_proto': 'tcp',
                    'src_ip': '10.0.3.21' if direction == 'ingress' else '10.0.3.1',
                    'dst_ip': '10.0.3.1' if direction == 'ingress' else '10.0.3.21',
                    'dst_port' if direction == 'ingress' else 'src_port': port}
            snapshot['filters'][direction].append({'kind': 'flower', 'protocol': 'ip', 'pref': 31000 + port,
                'chain': 0, 'options': {'handle': 1, 'keys': keys, 'skip_hw': True,
                'actions': [{'kind': 'mirred', 'eaction': 'redirect', 'direction': 'egress', 'to_dev': device,
                             'control_action': {'type': 'stolen'}}]}})
    return snapshot


class TestLimiter(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(module, 'Required host limiter implementation is missing')

    def test_rates_and_default_without_setting_seed(self):
        self.assertEqual(module.validate_bridge_state({'desired': None, 'revision': None}), (RATES, None))
        self.assertEqual(module.validate_bridge_state({'desired': RATES, 'revision': REVISION}), (RATES, REVISION))

    def test_invalid_rates_never_mean_unlimited(self):
        for value in (0, -1, 1001, 4097, True, 1.5, '120', float('nan'), float('inf'), None):
            with self.subTest(value=value), self.assertRaises(module.SafetyError):
                module.validate_rates({'downMbit': value, 'upMbit': 37})
        for value in ({'downMbit': 120}, {'downMbit': 120, 'upMbit': 37, 'command': 'bad'}, []):
            with self.assertRaises(module.SafetyError):
                module.validate_rates(value)

    def test_invalid_revision_or_state(self):
        for state in ({'desired': RATES, 'revision': None}, {'desired': None, 'revision': REVISION},
                      {'desired': RATES, 'revision': 'x' * 4097}, {'desired': RATES, 'revision': REVISION, 'extra': 1}):
            with self.assertRaises(module.SafetyError):
                module.validate_bridge_state(state)

    def test_queue_is_bounded_for_all_ui_rates(self):
        for rate in range(1, 1001):
            q = module.queue_parameters(rate)
            self.assertGreaterEqual(q['burst'], 65536)
            self.assertLessEqual(q['burst'], q['limit'])
            self.assertLessEqual(q['limit'], 8 * 1024 * 1024)
            self.assertLessEqual(q['limit'] / (rate * 125000), 1)

    def test_first_plan_has_two_aggregate_tbf_and_four_filters(self):
        plan = module.build_plan(identity(), empty_snapshot(), {'version': 1, 'links': {}, 'last_rates': None}, RATES)
        tbfs = [c for c in plan.commands if c[:3] == ['tc', 'qdisc', 'add'] and 'tbf' in c]
        filters = [c for c in plan.commands if c[:3] == ['tc', 'filter', 'add']]
        self.assertEqual(len(tbfs), 2)
        self.assertEqual(len(filters), 4)
        self.assertTrue(plan.claim_clsact)
        for command in plan.commands:
            self.assertNotIn('flush', command)
            self.assertNotIn('eth0', command)
            self.assertNotIn('br-vf', command)
            self.assertNotIn('replace', command)
        for direction, device, port_key in [('ingress', 'vfboostdn', 'dst_port'), ('egress', 'vfboostup', 'src_port')]:
            selected = [c for c in filters if c[5] == direction]
            self.assertEqual(len(selected), 2)
            self.assertTrue(all(c[-1] == device and port_key in c for c in selected))
        self.assertTrue(all('egress' in c[c.index('mirred') + 1:] for c in filters))

    def test_direction_ip_matches_are_exact(self):
        commands = module.build_plan(identity(), empty_snapshot(), {'version': 1, 'links': {}, 'last_rates': None}, RATES).commands
        for c in [x for x in commands if x[:3] == ['tc', 'filter', 'add']]:
            ingress = 'ingress' in c[:c.index('flower')]
            self.assertEqual(c[c.index('src_ip') + 1], '10.0.3.21/32' if ingress else '10.0.3.1/32')
            self.assertEqual(c[c.index('dst_ip') + 1], '10.0.3.1/32' if ingress else '10.0.3.21/32')

    def test_restart_is_idempotent(self):
        self.assertEqual(module.build_plan(identity(), owned_snapshot(), owned_state(), RATES).commands, [])

    def test_real_tc_headers_and_mirred_action_verified(self):
        s = owned_snapshot()
        for direction in ('ingress', 'egress'):
            entries = []
            for f in s['filters'][direction]:
                f['options']['actions'][0]['mirred_action'] = f['options']['actions'][0].pop('eaction')
                entries += [{k: f[k] for k in ('kind', 'protocol', 'pref', 'chain')}, f]
            s['filters'][direction] = entries
        self.assertEqual(module.observe(identity(), s, RATES, owned_state()), RATES)

    def test_orphan_or_foreign_tc_header_rejected(self):
        s = owned_snapshot()
        s['filters']['ingress'].append({'kind': 'flower', 'protocol': 'ip', 'pref': 120, 'chain': 0})
        with self.assertRaises(module.SafetyError): module.observe(identity(), s, RATES, owned_state())

    def test_kernel_requests_raw_json_for_exact_queue_limit(self):
        calls = []
        class Recording(module.Kernel):
            def json(self, args):
                calls.append(args)
                return empty_snapshot()['links'] if args[0] == 'ip' else []
        Recording().snapshot(identity())
        self.assertTrue(all('-r' in c for c in calls if 'qdisc' in c))

    def test_rate_change_only_changes_owned_tbf(self):
        rates = {'downMbit': 8, 'upMbit': 4}
        commands = module.build_plan(identity(), owned_snapshot(), owned_state(), rates).commands
        self.assertEqual(len(commands), 2)
        self.assertTrue(all(c[:3] == ['tc', 'qdisc', 'change'] and 'tbf' in c for c in commands))
        self.assertEqual({c[c.index('dev') + 1] for c in commands}, {'vfboostdn', 'vfboostup'})

    def test_tc_tick_rounding_is_not_a_perpetual_rate_change(self):
        rates = {'downMbit': 12, 'upMbit': 8}
        s = owned_snapshot(rates)
        s['qdiscs']['vfboostdn'][0]['options']['burst'] -= 1
        self.assertEqual(module.observe(identity(), s, rates, owned_state()), rates)
        s['qdiscs']['vfboostdn'][0]['options']['burst'] -= 100
        with self.assertRaises(module.SafetyError): module.observe(identity(), s, rates, owned_state())

    def test_live_190_70_tick_rounded_burst_acknowledges_without_mutation(self):
        rates = {'downMbit': 190, 'upMbit': 70}
        revision = 'fd7e07e4-0d08-49b4-b76c-11bc3ac1e62d'
        snapshot = owned_snapshot(rates)
        snapshot['qdiscs']['vfboostdn'][0]['options'].update(burst=237498, burst_raw='26259')
        snapshot['qdiscs']['vfboostup'][0]['options'].update(burst=87499, burst_raw='26259')
        calls = []
        test = self
        class Backend:
            def snapshot(self, link): return snapshot
            def run(self, command): test.fail('Correct 190/70 kernel state must not be changed: ' + repr(command))
        def request(method, endpoint, body=None):
            calls.append((method, endpoint, body))
            return {'desired': rates, 'revision': revision} if method == 'GET' else {'ok': True, 'proof': 'tc_qdisc'}
        with tempfile.TemporaryDirectory() as directory:
            store = module.StateStore(pathlib.Path(directory) / 'state.json')
            store.save(owned_state())
            result = module.reconcile_once(Backend(), identity, store, request)
            self.assertEqual(store.load()['last_rates'], rates)
        self.assertEqual(result['changes'], 0)
        self.assertEqual([c for c in calls if c[0] == 'POST'], [
            ('POST', '/api/pc-boost/bandwidth/readback',
             {'revision': revision, 'observed': rates, 'proof': 'tc_qdisc'})])

    def test_tick_rounding_is_rate_scaled_and_still_rejects_parameter_drift(self):
        for rate in range(1, 1001):
            rates = {'downMbit': rate, 'upMbit': rate}
            snapshot = owned_snapshot(rates)
            requested = module.queue_parameters(rate)['burst']
            allowance = (rate * 125000 * 64 + 999999999) // 1000000000 + 1
            self.assertLessEqual(allowance, 9)
            for device in ('vfboostdn', 'vfboostup'):
                snapshot['qdiscs'][device][0]['options']['burst'] = requested - allowance
            with self.subTest(rate=rate):
                self.assertEqual(module.observe(identity(), snapshot, rates, owned_state()), rates)
            for field, value in (('burst', requested - allowance - 1), ('burst', requested + 1),
                                 ('rate', rate * 125000 - 1),
                                 ('limit', module.queue_parameters(rate)['limit'] + 1)):
                invalid = copy.deepcopy(snapshot)
                invalid['qdiscs']['vfboostdn'][0]['options'][field] = value
                with self.subTest(rate=rate, field=field, value=value), self.assertRaises(module.SafetyError):
                    module.observe(identity(), invalid, rates, owned_state())

    def test_foreign_veth_root_or_ingress_qdisc_rejected(self):
        for kind in ('tbf', 'ingress', 'htb'):
            s = empty_snapshot()
            s['qdiscs'][identity().device] = [{'kind': kind, 'root': True, 'handle': '9:'}]
            with self.assertRaises(module.SafetyError):
                module.build_plan(identity(), s, owned_state(), RATES)

    def test_unowned_clsact_is_not_adopted(self):
        with self.assertRaises(module.SafetyError):
            module.build_plan(identity(), owned_snapshot(), {'version': 1, 'links': {}, 'last_rates': None}, RATES)

    def test_foreign_ifb_alias_kind_or_root_rejected(self):
        for mutate in (lambda s: s['links'][1].update(ifalias='other-owner'),
                       lambda s: s['links'][1]['linkinfo'].update(info_kind='dummy'),
                       lambda s: s['qdiscs']['vfboostdn'][0].update(handle='9:'),
                       lambda s: s['qdiscs']['vfboostdn'][0].update(kind='htb')):
            s = owned_snapshot()
            mutate(s)
            with self.assertRaises(module.SafetyError):
                module.build_plan(identity(), s, owned_state(), RATES)

    def test_unexpected_tbf_options_rejected(self):
        s = owned_snapshot()
        s['qdiscs']['vfboostdn'][0]['options']['minburst'] = 1500
        with self.assertRaises(module.SafetyError): module.observe(identity(), s, RATES, owned_state())

    def test_nonstandard_mtu_rejected_before_creating_ifb(self):
        link = module.LinkIdentity('vethvf', 6600, identity().mac, 2, 'container-one', 'br-vf', 9000)
        with self.assertRaises(module.SafetyError):
            module.build_plan(link, empty_snapshot(link), {'version': 1, 'links': {}, 'last_rates': None}, RATES)

    def test_foreign_filter_and_narrowed_classifier_rejected(self):
        for mutate in (lambda f: f.update(pref=100), lambda f: f.update(kind='u32'),
                       lambda f: f['options']['keys'].update(dst_ip='10.0.3.22'),
                       lambda f: f['options']['keys'].update(src_port=12345),
                       lambda f: f['options']['actions'][0].update(to_dev='otherifb'),
                       lambda f: f['options']['actions'][0].update(eaction='mirror'),
                       lambda f: f['options'].update(skip_hw=False)):
            s = owned_snapshot()
            mutate(s['filters']['ingress'][0])
            with self.assertRaises(module.SafetyError):
                module.build_plan(identity(), s, owned_state(), RATES)

    def test_missing_filter_is_repaired_but_not_acknowledged_early(self):
        s = owned_snapshot()
        s['filters']['egress'].pop()
        p = module.build_plan(identity(), s, owned_state(), RATES)
        self.assertEqual(len(p.commands), 1)
        with self.assertRaises(module.SafetyError):
            module.observe(identity(), s, RATES, owned_state())

    def test_observed_rate_is_kernel_value_not_file(self):
        rates = {'downMbit': 8, 'upMbit': 4}
        self.assertEqual(module.observe(identity(), owned_snapshot(rates), rates, owned_state()), rates)
        s = owned_snapshot(rates)
        s['qdiscs']['vfboostup'][0]['options']['rate'] = 375000
        with self.assertRaises(module.SafetyError):
            module.observe(identity(), s, rates, owned_state())

    def test_no_ack_when_ifb_down_or_link_identity_changed(self):
        for mutate in (lambda s: s['links'][1].update(flags=[]), lambda s: s['links'][0].update(ifindex=6601),
                       lambda s: s['links'][0].update(address='00:11:22:33:44:55')):
            s = owned_snapshot()
            mutate(s)
            with self.assertRaises(module.SafetyError):
                module.observe(identity(), s, RATES, owned_state())

    def test_container_recreation_binds_new_link_not_stale_name(self):
        newer = module.LinkIdentity('vethnew', 7700, '00:11:22:33:44:55', 2, 'container-two', 'br-vf', 1500)
        s = owned_snapshot()
        s['links'][0] = empty_snapshot(newer)['links'][0]
        s['qdiscs'] = {k: v for k, v in s['qdiscs'].items() if k != identity().device}
        s['qdiscs'][newer.device] = empty_snapshot(newer)['qdiscs'][newer.device]
        s['filters'] = {'ingress': [], 'egress': []}
        p = module.build_plan(newer, s, owned_state(), RATES)
        self.assertEqual(len([c for c in p.commands if c[:3] == ['tc', 'filter', 'add']]), 4)
        self.assertFalse(any(identity().device in c for c in p.commands))
        self.assertFalse(any('tbf' in c for c in p.commands))

    def test_reconciler_exact_ack_and_no_settings_seed(self):
        calls = []
        class Backend:
            def __init__(self): self.done = False
            def snapshot(self, link): return owned_snapshot() if self.done else empty_snapshot()
            def run(self, command): self.done = True
        def request(method, endpoint, body=None):
            calls.append((method, endpoint, body))
            return {'desired': None, 'revision': None} if method == 'GET' else {'ok': True, 'proof': 'tc_qdisc'}
        with tempfile.TemporaryDirectory() as directory:
            store = module.StateStore(pathlib.Path(directory) / 'state.json')
            module.reconcile_once(Backend(), identity, store, request)
        posts = [x for x in calls if x[0] == 'POST']
        self.assertEqual(posts, [('POST', '/api/pc-boost/bandwidth/readback',
                                 {'revision': None, 'observed': RATES, 'proof': 'tc_qdisc'})])
        self.assertFalse(any(x[0] == 'PATCH' for x in calls))

    def test_failed_or_stale_verification_never_posts(self):
        for stale in (False, True):
            calls = []
            class Backend:
                def snapshot(self, link):
                    s = owned_snapshot()
                    if not stale: s['filters']['egress'].pop()
                    return s
                def run(self, command): pass
            def request(method, endpoint, body=None):
                calls.append((method, endpoint))
                revision = REVISION if len(calls) == 1 else 'b1234567-89ab-4cde-8fab-0123456789ab'
                return {'desired': RATES, 'revision': revision}
            with tempfile.TemporaryDirectory() as d:
                store = module.StateStore(pathlib.Path(d) / 'state.json')
                store.save(owned_state())
                with self.assertRaises(module.SafetyError):
                    module.reconcile_once(Backend(), identity, store, request)
            self.assertFalse(any(x[0] == 'POST' for x in calls))

    def test_failed_clsact_add_does_not_claim_foreign_ownership(self):
        class Backend:
            def snapshot(self, link): return empty_snapshot()
            def run(self, command):
                if command[-1] == 'clsact': raise module.SafetyError('kernel_command_failed')
        with tempfile.TemporaryDirectory() as d:
            store = module.StateStore(pathlib.Path(d) / 'state.json')
            with self.assertRaises(module.SafetyError):
                module.apply_and_verify(Backend(), identity, store, RATES)
            self.assertNotIn(identity().key, store.load()['links'])

    def test_token_4097_or_control_characters_invalid(self):
        with tempfile.TemporaryDirectory() as d:
            file = pathlib.Path(d) / 'token'
            for content in ('x' * 4097, 'a\nb', 'a\x00b', ''):
                file.write_text(content, encoding='ascii')
                with self.assertRaises(module.SafetyError): module.read_token(file)
            file.write_text('x' * 4096, encoding='ascii')
            self.assertEqual(len(module.read_token(file)), 4096)

    def test_transport_redirect_does_not_send_token_to_target(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/leak-target')
                self.end_headers()
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as d:
                file = pathlib.Path(d) / 'token'
                file.write_text('synthetic-test-token', encoding='ascii')
                client = module.ApiClient(file, origin=f'http://127.0.0.1:{server.server_port}')
                with self.assertRaises(module.SafetyError): client.request('GET', '/api/pc-boost/bandwidth/bridge')
            self.assertEqual(received, ['/api/pc-boost/bandwidth/bridge'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_private_endpoint_allowlist(self):
        client = module.ApiClient(pathlib.Path('not-read'), origin='http://127.0.0.1:8000')
        for method, endpoint in [('PATCH', '/api/pc-boost/bandwidth'), ('GET', '/api/owner'), ('POST', '/api/pc-boost/bandwidth/bridge')]:
            with self.assertRaises(module.SafetyError): client.request(method, endpoint)


if __name__ == '__main__':
    unittest.main()
