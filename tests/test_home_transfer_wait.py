import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch,Mock

CORE=Path(__file__).resolve().parents[1]/'fflow'
sys.path.insert(0,str(CORE))
import pc_ffmpeg_hook as hook
from pc_home_queue import HOME_SCOPE


class HomeTransferWaitTests(unittest.TestCase):
    def test_home_waits_for_large_upload_slot_instead_of_immediately_using_server(self):
        slot=Mock();token=HOME_SCOPE.set({'jobId':'test','nonce':'test'})
        try:
            with patch.object(hook,'missing_blobs',return_value={'@0.mp4':{'size':25*1024**2}}),\
                 patch.object(hook,'acquire_big_slot',side_effect=[None,slot]),\
                 patch.object(hook,'upload_blobs') as upload,patch.object(hook.time,'sleep'):
                hook.upload_with_lane('fixture','fixture',{},{});upload.assert_called_once()
            slot.close.assert_called_once()
        finally:HOME_SCOPE.reset(token)

    def test_normal_server_lease_keeps_original_nonblocking_transfer_gate(self):
        with patch.object(hook,'missing_blobs',return_value={'@0.mp4':{'size':25*1024**2}}),\
             patch.object(hook,'acquire_big_slot',return_value=None),\
             patch.object(hook,'upload_blobs') as upload:
            with self.assertRaises(hook.NoBigSlot):hook.upload_with_lane('fixture','fixture',{}, {})
            upload.assert_not_called()


if __name__=='__main__':unittest.main()
