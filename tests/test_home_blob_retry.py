from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import patch

CORE=Path(__file__).resolve().parents[1]/'fflow'
sys.path.insert(0,str(CORE))
import pc_ffmpeg_hook as hook
from pc_home_queue import HOME_SCOPE

REF={'sha256':'a'*64,'size':4}


def rejected(code=500):
    return urllib.error.HTTPError('u',code,'blob upload rejected',None,None)


class HomeBlobRetryTests(unittest.TestCase):
    def run_upload(self,side_effect,present=False,home=True):
        token=HOME_SCOPE.set({'jobId':'test','nonce':'test'}) if home else None
        try:
            with patch.object(hook,'put_blob',side_effect=side_effect) as put,\
                 patch.object(hook,'missing_blobs',return_value={} if present else {'in':REF}):
                hook.upload_blobs('u','t',{'in':REF},{'in':Path('unused')},sleep=lambda s:None)
            return put.call_count
        finally:
            if token:HOME_SCOPE.reset(token)

    def test_home_500_and_broken_pipe_are_sent_again(self):
        self.assertEqual(self.run_upload([rejected(),BrokenPipeError(32,'Broken pipe'),None]),3)

    def test_blob_that_arrived_meanwhile_is_not_sent_again(self):
        self.assertEqual(self.run_upload([rejected(),None],present=True),1)

    def test_4xx_is_final(self):
        with self.assertRaises(urllib.error.HTTPError):self.run_upload([rejected(400),None])

    def test_retries_are_bounded(self):
        with self.assertRaises(urllib.error.HTTPError):self.run_upload([rejected()]*5)

    def test_server_work_is_not_retried(self):
        with self.assertRaises(urllib.error.HTTPError):self.run_upload([rejected(),None],home=False)


if __name__=='__main__':unittest.main()
