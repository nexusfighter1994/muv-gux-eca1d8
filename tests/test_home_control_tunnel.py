from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import patch

CORE=Path(__file__).resolve().parents[1]/'fflow'
sys.path.insert(0,str(CORE))
import pc_ffmpeg_hook as hook

HOME='http://10.0.3.1:18191'
CONTROL='http://10.0.3.1:18291'


def refused():
    return urllib.error.URLError(ConnectionRefusedError(111,'Connection refused'))


class ControlTunnelTests(unittest.TestCase):
    def setUp(self):
        hook._control.update(paused_until=0.0,fallbacks=0)

    def call(self,side_effect,method='GET'):
        with patch.object(hook,'direct_request',side_effect=side_effect) as direct:
            try:return hook.http_request(HOME,'t',method,'/health',None,5),[c.args[0] for c in direct.call_args_list]
            except Exception as exc:return exc,[c.args[0] for c in direct.call_args_list]

    def test_small_requests_use_the_control_tunnel(self):
        self.assertEqual(self.call([{'ready':True}]),({'ready':True},[CONTROL]))

    def test_other_urls_are_untouched(self):
        self.assertIsNone(hook.control_url('http://10.0.3.1:18194'))
        self.assertIsNone(hook.control_url('http://127.0.0.1:9000'))

    def test_absent_forward_falls_back_even_for_submit(self):
        result,urls=self.call([refused(),{'id':'x'}],method='POST')
        self.assertEqual(result,{'id':'x'});self.assertEqual(urls,[CONTROL,HOME])
        self.assertGreater(hook._control['paused_until'],0)

    def test_paused_control_route_goes_straight_to_main(self):
        self.call([refused(),{}],method='POST')
        self.assertEqual(self.call([{'ok':1}]),({'ok':1},[HOME]))

    def test_timed_out_submit_is_not_sent_twice(self):
        result,urls=self.call([TimeoutError('timed out'),{'id':'x'}],method='POST')
        self.assertIsInstance(result,TimeoutError);self.assertEqual(urls,[CONTROL])

    def test_timed_out_poll_is_repeated_on_main(self):
        result,urls=self.call([TimeoutError('timed out'),{'state':'running'}])
        self.assertEqual(result,{'state':'running'});self.assertEqual(urls,[CONTROL,HOME])

    def test_home_http_errors_are_not_repeated(self):
        result,urls=self.call([urllib.error.HTTPError(CONTROL,503,'busy',None,None),{}],method='POST')
        self.assertIsInstance(result,urllib.error.HTTPError);self.assertEqual(urls,[CONTROL])
        self.assertEqual(hook._control['paused_until'],0.0)

    def test_pause_expires(self):
        hook._control['paused_until']=100.0
        self.assertIsNone(hook.control_url(HOME,now=99))
        self.assertEqual(hook.control_url(HOME,now=101),CONTROL)


if __name__=='__main__':unittest.main()
