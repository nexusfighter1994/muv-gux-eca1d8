from pathlib import Path
import asyncio
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch

CORE=Path(__file__).resolve().parents[1]/'fflow'
sys.path.insert(0,str(CORE))
import pc_ffmpeg_hook as hook

HOME='http://10.0.3.1:18191'


class DownloadKeepAliveTests(unittest.TestCase):
    def test_touches_job_until_stopped(self):
        stop=threading.Event();calls=[]
        def request(*args):
            calls.append(args)
            if len(calls)==3:stop.set()
        with patch.object(hook,'http_request',side_effect=request):
            hook.keep_alive(HOME,'t','a'*32,stop,interval=.01)
        self.assertEqual(len(calls),3)
        self.assertEqual(calls[0][2:4],('GET','/renders/'+'a'*32+'?metadata=1'))

    def test_errors_never_end_the_keepalive(self):
        stop=threading.Event();calls=[]
        def request(*args):
            calls.append(args)
            if len(calls)==2:stop.set()
            raise OSError('tunnel down')
        with patch.object(hook,'http_request',side_effect=request):
            hook.keep_alive(HOME,'t','b'*32,stop,interval=.01)
        self.assertEqual(len(calls),2)

    def test_download_keeps_job_alive_and_stops_afterwards(self):
        calls=[]
        def slow_download(url,transfer):time.sleep(.25)
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(hook,'KEEPALIVE_S',.02), \
             patch.object(hook,'http_request',side_effect=lambda *a:calls.append(a)), \
             patch.object(hook,'over_bulk',side_effect=slow_download), \
             patch.object(hook,'publish_file',new_callable=AsyncMock):
            output=Path(folder)/'out.mp4'
            asyncio.run(hook.download_and_publish(HOME,'t','c'*32,{'suffix':'.mp4','size':1000},output,'ffmpeg',None))
            during=len(calls);time.sleep(.1)
        self.assertGreaterEqual(during,3)
        self.assertLessEqual(len(calls)-during,1)


if __name__=='__main__':unittest.main()
