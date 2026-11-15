import asyncio
import http.client
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'fflow'))
spec = importlib.util.spec_from_file_location('admission_protocol_subject', ROOT / 'fflow/pc_home_queue.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


class AdmissionProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_get_protocol_fault_retries_same_permit(self):
        calls = []

        def request(method, suffix, body):
            calls.append((method, suffix, body))
            if len(calls) == 1:
                raise http.client.BadStatusLine('\x17\x03\x03\x00\x13')
            return {'state': 'active'}

        with patch.object(subject, '_request', request):
            value = await subject._request_retry('GET', '/owned-permit', retry_budget=.5, retry_delay=0)
        self.assertEqual(value, {'state': 'active'})
        self.assertEqual(calls, [('GET', '/owned-permit', None)] * 2)

    async def test_post_uses_original_idempotent_request_id(self):
        body = {'requestId': 'same-owned-request', 'nonce': 'original'}
        seen = []

        def request(method, suffix, payload):
            seen.append((method, payload))
            if len(seen) == 1:
                raise http.client.IncompleteRead(b'{', 10)
            return {'id': 'owned', 'state': 'queued'}

        with patch.object(subject, '_request', request):
            await subject._request_retry('POST', '', body, retry_budget=.5, retry_delay=0)
        self.assertEqual(len(seen), 2)
        self.assertTrue(all(method == 'POST' and payload is body for method, payload in seen))
        self.assertEqual(body['requestId'], 'same-owned-request')

    async def test_permanent_protocol_fault_exhausts_original_budget(self):
        with patch.object(subject, '_request', side_effect=http.client.BadStatusLine('bad')):
            with self.assertRaisesRegex(subject.HomeFallbackAdmissionError, 'GET retry exhausted'):
                await asyncio.wait_for(subject._request_retry('GET', '/owned', retry_budget=.02, retry_delay=.002), 1)

    async def test_auth_failure_is_not_retried(self):
        error = urllib.error.HTTPError('http://local', 401, 'unauthorized', None, None)
        with patch.object(subject, '_request', side_effect=error) as request:
            with self.assertRaises(urllib.error.HTTPError):
                await subject._request_retry('GET', '/owned', retry_budget=.5, retry_delay=0)
        self.assertEqual(request.call_count, 1)

    async def test_parent_cancellation_is_not_retried(self):
        with patch.object(subject, '_request', side_effect=asyncio.CancelledError) as request:
            with self.assertRaises(asyncio.CancelledError):
                await subject._request_retry('GET', '/owned', retry_budget=.5, retry_delay=0)
        self.assertEqual(request.call_count, 1)

    async def test_invalid_request_configuration_still_fails_immediately(self):
        with patch.object(subject, '_request', side_effect=http.client.InvalidURL('bad')) as request:
            with self.assertRaises(http.client.InvalidURL):
                await subject._request_retry('GET', '/owned', retry_budget=.5, retry_delay=0)
        self.assertEqual(request.call_count, 1)


if __name__ == '__main__':
    unittest.main()
