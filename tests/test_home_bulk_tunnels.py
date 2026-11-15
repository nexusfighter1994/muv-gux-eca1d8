from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import patch

CORE=Path(__file__).resolve().parents[1]/'fflow'
sys.path.insert(0,str(CORE))
import pc_ffmpeg_hook as hook

HOME='http://10.0.3.1:18191'
B=lambda p:'http://10.0.3.1:%d'%p


def refused():
    return urllib.error.URLError(ConnectionRefusedError(111,'Connection refused'))


class BulkTunnelTests(unittest.TestCase):
    def setUp(self):
        hook._bulk.update(next=0,paused={})

    def test_round_robin_over_bulk_ports_then_main(self):
        self.assertEqual(hook.bulk_urls(HOME),[B(18391),B(18491),B(18591),HOME])
        self.assertEqual(hook.bulk_urls(HOME),[B(18491),B(18591),B(18391),HOME])

    def test_other_urls_are_untouched(self):
        self.assertEqual(hook.bulk_urls('http://10.0.3.1:18194'),['http://10.0.3.1:18194'])

    def test_paused_port_is_skipped_until_it_expires(self):
        hook.pause_bulk(B(18491),now=100)
        self.assertNotIn(B(18491),hook.bulk_urls(HOME,now=150))
        self.assertIn(B(18491),hook.bulk_urls(HOME,now=100+hook.CONTROL_PAUSE_S+1))

    def test_refused_bulk_port_moves_on(self):
        seen=[]
        def transfer(target):
            seen.append(target)
            if target!=B(18591):raise ConnectionRefusedError(111,'refused')
            return 'ok'
        self.assertEqual(hook.over_bulk(HOME,transfer),'ok')
        self.assertEqual(seen,[B(18391),B(18491),B(18591)])
        self.assertIn(18391,hook._bulk['paused'])

    def test_all_refused_ends_on_main(self):
        seen=[]
        def transfer(target):
            seen.append(target)
            if target!=HOME:raise refused()
            return 'main'
        self.assertEqual(hook.over_bulk(HOME,transfer),'main');self.assertEqual(seen[-1],HOME)

    def test_failed_transfer_is_not_repeated_here(self):
        seen=[]
        def transfer(target):
            seen.append(target);raise BrokenPipeError(32,'Broken pipe')
        with self.assertRaises(BrokenPipeError):hook.over_bulk(HOME,transfer)
        self.assertEqual(len(seen),1);self.assertIn(18391,hook._bulk['paused'])

    def test_home_http_error_does_not_pause(self):
        def transfer(target):raise urllib.error.HTTPError(target,500,'blob upload rejected',None,None)
        with self.assertRaises(urllib.error.HTTPError):hook.over_bulk(HOME,transfer)
        self.assertEqual(hook._bulk['paused'],{})

    def test_put_blob_uses_bulk_route(self):
        with patch.object(hook,'put_blob_once',return_value=None) as once:
            hook.put_blob(HOME,'t',{'sha256':'a'*64,'size':1},Path('x'))
        self.assertEqual(once.call_args.args[0],B(18391))


if __name__=='__main__':unittest.main()
