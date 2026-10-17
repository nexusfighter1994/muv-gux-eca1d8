import copy
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

CORE=Path(__file__).resolve().parents[1]/'fflow'
sys.path.insert(0,str(CORE))
spec=importlib.util.spec_from_file_location('credit_cli',CORE/'pc_node_normalize_cli.py')
cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)

class CreditTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.data=Path(self.tmp.name);self.root=self.data/'projects';self.root.mkdir()
        self.src=self.root/'source.mp4';self.src.write_bytes(b'source')
        self.out=self.root/'output.mp4';self.text=Path(str(self.out)+'.credit.txt');self.text.write_text('Quelle: Test')
        env=patch.dict(os.environ,{'DATA_DIR':str(self.data)});env.start();self.addCleanup(env.stop)
        self.text_filter_path=self.text.as_posix().replace(':','\\:')
        self.filter="scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,drawtext=textfile='"+self.text_filter_path+"':fontcolor=white@0.6:fontsize=24:x=12:y=12"
        self.request={'argv':['-y','-i',str(self.src),'-vf',self.filter,'-map','0:v:0','-map','0:a?',
            '-c:v','libx264','-crf','17','-pix_fmt','yuv420p','-r','24','-c:a','aac','-b:a','192k',
            '-t','3.000','-movflags','+faststart',str(self.out)],'options':{'timeoutMs':180000}}

    def test_exact_native_credit_preserves_argv_text_and_duration(self):
        before=copy.deepcopy(self.request)
        actual=cli.qualify(self.request)
        self.assertEqual(actual['argv'],before['argv']);self.assertEqual(actual['duration'],3.0)
        self.assertEqual(self.text.read_text(),'Quelle: Test')

    def test_other_text_files_and_injected_filters_are_rejected(self):
        other=self.root/'unrelated.txt';other.write_text('not this operation')
        for bad in [self.filter.replace(self.text_filter_path,other.as_posix().replace(':','\\:')),
                    self.filter+',hflip',self.filter.replace('white@0.6','red'),
                    self.filter.replace('x=12','x=10')]:
            req=copy.deepcopy(self.request);req['argv'][4]=bad
            with self.subTest(filter=bad),self.assertRaises(ValueError):cli.qualify(req)

if __name__=='__main__':unittest.main()
