import asyncio
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import patch

CORE=Path(__file__).resolve().parents[1]/'fflow'
sys.path.insert(0,str(CORE))
import pc_ffmpeg_hook as hook
from pc_home_queue import HOME_SCOPE


def busy():
    return urllib.error.HTTPError('fixture',503,'busy',{},None)


class HomeBusyWaitTests(unittest.TestCase):
    def run_submit(self,side_effect,wait_s=60):
        async def no_sleep(_):return None
        with patch.object(hook,'http_request',side_effect=side_effect) as request,\
             patch.object(hook.asyncio,'sleep',no_sleep):
            result=asyncio.run(hook.submit_render('fixture','fixture',{},wait_s=wait_s))
        return result,request.call_count

    def test_home_work_waits_through_503_busy_instead_of_falling_back(self):
        token=HOME_SCOPE.set({'jobId':'test','nonce':'test'})
        try:
            result,calls=self.run_submit([busy(),busy(),{'id':'abc'}])
            self.assertEqual(result,{'id':'abc'});self.assertEqual(calls,3)
        finally:HOME_SCOPE.reset(token)

    def test_server_work_keeps_immediate_fallback_on_503(self):
        with self.assertRaises(urllib.error.HTTPError):self.run_submit([busy(),{'id':'abc'}])

    def test_other_http_errors_are_not_retried(self):
        token=HOME_SCOPE.set({'jobId':'test','nonce':'test'})
        try:
            with self.assertRaises(urllib.error.HTTPError):
                self.run_submit([urllib.error.HTTPError('fixture',400,'bad',{},None),{'id':'abc'}])
        finally:HOME_SCOPE.reset(token)

    def test_wait_is_bounded(self):
        token=HOME_SCOPE.set({'jobId':'test','nonce':'test'})
        try:
            with self.assertRaises(urllib.error.HTTPError):self.run_submit([busy()]*50,wait_s=0)
        finally:HOME_SCOPE.reset(token)

    def test_poll_delay_backs_off_to_one_second(self):
        self.assertEqual(hook.poll_delay(0),.2)
        self.assertLess(hook.poll_delay(2),.5)
        self.assertEqual(hook.poll_delay(10),1.0)

    def run_download(self,side_effect,home=True):
        async def no_sleep(_):return None
        token=HOME_SCOPE.set({'jobId':'test','nonce':'test'}) if home else None
        try:
            with patch.object(hook,'download_and_publish',side_effect=side_effect) as download,\
                 patch.object(hook.asyncio,'sleep',no_sleep):
                asyncio.run(hook.download_with_retry('u','t','id',{},None,'ffmpeg',None))
            return download.call_count
        finally:
            if token:HOME_SCOPE.reset(token)

    def test_failed_result_transfer_is_downloaded_again(self):
        self.assertEqual(self.run_download([ValueError('Output transfer integrity failed'),TimeoutError('timed out'),None]),3)

    def test_bad_output_and_server_work_are_not_retried(self):
        with self.assertRaises(ValueError):self.run_download([ValueError('Unexpected output duration'),None])
        with self.assertRaises(ValueError):self.run_download([ValueError('Output transfer integrity failed'),None],home=False)

    def test_home_health_retries_once_with_longer_timeout(self):
        async def no_sleep(_):return None
        token=HOME_SCOPE.set({'jobId':'test','nonce':'test'})
        try:
            with patch.object(hook,'http_request',side_effect=[TimeoutError('timed out'),{'ready':True}]) as request,\
                 patch.object(hook.asyncio,'sleep',no_sleep):
                self.assertEqual(asyncio.run(hook.home_health('u','t')),{'ready':True})
            self.assertEqual(request.call_count,2);self.assertEqual(request.call_args.args[-1],30)
        finally:HOME_SCOPE.reset(token)
        with patch.object(hook,'http_request',side_effect=TimeoutError('timed out')):
            with self.assertRaises(TimeoutError):asyncio.run(hook.home_health('u','t'))

    def test_render_deadline_is_longer_only_for_home_work(self):
        # vf-custom:home-hook-timeouts-v1 (2026-11-12): 210/420 -> 420/900 s
        self.assertEqual(hook.render_deadline(None),420)
        self.assertEqual(hook.render_deadline(600),420)
        token=HOME_SCOPE.set({'jobId':'test','nonce':'test'})
        try:
            self.assertEqual(hook.render_deadline(None),900)
            self.assertEqual(hook.render_deadline(600),600)
            self.assertEqual(hook.render_deadline(300),300)
        finally:HOME_SCOPE.reset(token)

    def test_gone_home_job_is_not_downloaded_again(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.run_download([urllib.error.HTTPError('u',404,'gone',{},None),None])

    def test_download_retries_are_bounded(self):
        with self.assertRaises(TimeoutError):self.run_download([TimeoutError('timed out')]*5)

    def test_decline_reasons_are_counted_and_rate_limited(self):
        hook._declines.clear()
        with patch.object(hook.logger,'warning') as warn:
            for t in (0,1,2,61):hook.note_decline('home 503 busy',now=t)
        self.assertEqual(warn.call_count,2);self.assertEqual(hook._declines['home 503 busy']['count'],4)


if __name__=='__main__':unittest.main()
