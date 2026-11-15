from pathlib import Path
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

CORE=Path(os.environ.get('HV_CORE') or Path(__file__).resolve().parents[1]/'fflow')
sys.path.insert(0,str(CORE))
import pc_ffmpeg_hook as hook

FFMPEG=shutil.which('ffmpeg')


@unittest.skipUnless(FFMPEG and shutil.which('ffprobe'),'ffmpeg and ffprobe are required')
class HomeVerifyProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base=Path(tempfile.mkdtemp(prefix='hv-'))
        cls.good=cls.base/'good.mp4'
        subprocess.run([FFMPEG,'-v','error','-y','-f','lavfi','-i','testsrc=size=320x240:rate=24','-t','2','-c:v','libx264',
                        '-preset','ultrafast','-pix_fmt','yuv420p',str(cls.good)],check=True)
        cls.image=cls.base/'good.png'
        subprocess.run([FFMPEG,'-v','error','-y','-f','lavfi','-i','testsrc=size=64x64:rate=1','-frames:v','1',str(cls.image)],check=True)
        data=bytearray(cls.good.read_bytes())
        # keep the container index (moov, at the end) and destroy the coded pictures in the middle
        start=data.find(b'mdat')+64
        end=start+max(2000,(len(data)-start)//3)
        data[start:end]=os.urandom(end-start)
        cls.corrupt=cls.base/'corrupt.mp4'
        cls.corrupt.write_bytes(bytes(data))

    def setUp(self):
        self.dir=Path(tempfile.mkdtemp(prefix='hv-case-',dir=self.base))
        self.settings=self.dir/'verify.json'
        os.environ['VF_HOME_VERIFY']=str(self.settings)
        hook._verify_cache[1]=None

    def tearDown(self):
        os.environ.pop('VF_HOME_VERIFY',None)
        hook._verify_cache[1]=None

    def mode(self,**value):
        self.settings.write_text(json.dumps(value),encoding='utf-8')
        hook._verify_cache[1]=None

    def publish(self,source,suffix='.mp4',expected=2.0):
        temporary=self.dir/('.pc-boost-x'+suffix)
        shutil.copyfile(source,temporary)
        output=self.dir/('out'+suffix)
        asyncio.run(hook.publish_file(str(temporary),output,FFMPEG,expected))
        return output,temporary

    def test_settings_default_to_the_full_decode(self):
        self.assertEqual(hook.verify_settings(self.settings),{'mode':'decode','sample':20,'alwaysMb':8})
        self.settings.write_text('not json')
        self.assertEqual(hook.verify_settings(self.settings)['mode'],'decode')
        self.settings.write_text('{"mode":"probe"}')
        self.assertEqual(hook.verify_settings(self.settings),{'mode':'probe','sample':20,'alwaysMb':8})
        self.settings.write_text('{"mode":"probe","sample":0,"alwaysMb":"x"}')
        self.assertEqual(hook.verify_settings(self.settings),{'mode':'probe','sample':20,'alwaysMb':8})
        self.settings.write_text('{"mode":"probe","sample":5,"alwaysMb":32}')
        self.assertEqual(hook.verify_settings(self.settings),{'mode':'probe','sample':5,'alwaysMb':32})
        self.settings.write_text('{"mode":"something"}')
        self.assertEqual(hook.verify_settings(self.settings)['mode'],'decode')

    def test_when_the_full_decode_is_due(self):
        decode={'mode':'decode','sample':20,'alwaysMb':8};probe={'mode':'probe','sample':20,'alwaysMb':8}
        self.assertTrue(hook.full_decode_due(100,decode))
        self.assertTrue(hook.full_decode_due(8*1024*1024,probe))
        with patch.object(hook.random,'randrange',return_value=3):self.assertFalse(hook.full_decode_due(100,probe))
        with patch.object(hook.random,'randrange',return_value=0):self.assertTrue(hook.full_decode_due(100,probe))

    def test_without_the_switch_every_result_is_decoded_as_before(self):
        with patch.object(hook,'probe_output',side_effect=AssertionError('probe must not run')):
            output,temporary=self.publish(self.good)
        self.assertTrue(output.exists());self.assertFalse(temporary.exists())
        with self.assertRaisesRegex(ValueError,'failed local decode'):self.publish(self.corrupt)

    def test_probe_mode_accepts_a_good_file_without_decoding(self):
        self.mode(mode='probe',sample=1000)
        with patch.object(hook.random,'randrange',return_value=7),patch.object(hook,'decode_output',side_effect=AssertionError('decode must not run')):
            output,temporary=self.publish(self.good)
        self.assertEqual(output.read_bytes(),self.good.read_bytes());self.assertFalse(temporary.exists())

    def test_probe_mode_keeps_the_duration_and_empty_checks(self):
        self.mode(mode='probe',sample=1000)
        with patch.object(hook.random,'randrange',return_value=7):
            with self.assertRaisesRegex(ValueError,'Unexpected output duration'):self.publish(self.good,expected=10.0)
            self.assertFalse((self.dir/'out.mp4').exists());self.assertFalse((self.dir/'.pc-boost-x.mp4').exists())
            garbage=self.dir/'garbage.bin';garbage.write_bytes(b'\0'*5000)
            with self.assertRaisesRegex(ValueError,'failed local probe|Empty video output'):self.publish(garbage)
            self.publish(self.good,expected=None)

    def test_probe_mode_images(self):
        self.mode(mode='probe',sample=1000)
        with patch.object(hook.random,'randrange',return_value=7):
            output,_=self.publish(self.image,suffix='.png',expected=None)
            self.assertTrue(output.exists())
            text=self.dir/'text.bin';text.write_bytes(b'hello world'*50)
            with self.assertRaises(ValueError):self.publish(text,suffix='.png',expected=None)

    def test_the_sampled_decode_still_catches_a_broken_stream(self):
        self.mode(mode='probe',sample=1000)
        with patch.object(hook.random,'randrange',return_value=7):
            output,_=self.publish(self.corrupt)  # index intact: the probe alone cannot see it (Home decoded it, sha256 matched)
            self.assertTrue(output.exists())
        with patch.object(hook.random,'randrange',return_value=0):
            with self.assertRaisesRegex(ValueError,'failed local decode'):self.publish(self.corrupt)

    def test_large_results_are_always_decoded(self):
        self.mode(mode='probe',sample=1000,alwaysMb=1)
        big=self.dir/'big.mp4'
        subprocess.run([FFMPEG,'-v','error','-y','-f','lavfi','-i','testsrc2=size=1280x720:rate=24','-t','2','-c:v','libx264',
                        '-preset','ultrafast','-qp','0','-pix_fmt','yuv420p',str(big)],check=True)
        self.assertGreater(big.stat().st_size,1024*1024)
        with patch.object(hook.random,'randrange',return_value=7),patch.object(hook,'probe_output',side_effect=AssertionError('probe must not run')):
            output,_=self.publish(big)
        self.assertTrue(output.exists())

    def test_missing_ffprobe_falls_back_to_the_decode(self):
        self.mode(mode='probe',sample=1000)
        with patch.object(hook.random,'randrange',return_value=7),patch.object(hook,'probe_output',side_effect=FileNotFoundError('ffprobe')):
            output,_=self.publish(self.good)
            self.assertTrue(output.exists())
            with self.assertRaisesRegex(ValueError,'failed local decode'):self.publish(self.corrupt)


if __name__=='__main__':unittest.main()
