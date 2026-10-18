import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

CORE=Path(__file__).resolve().parents[1]/'fflow'
sys.path.insert(0,str(CORE))

class MediaCliTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        path=CORE/'pc_node_media_cli.py'
        self.assertTrue(path.exists(),'media CLI missing')
        spec=importlib.util.spec_from_file_location('media_cli',path)
        self.cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.cli)
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)/'projects';self.root.mkdir()
        self.source=self.root/'a.mp4';self.source.write_bytes(b'source')
        self.output=self.root/'out.mp4'
        p=patch.dict(os.environ,{'DATA_DIR':self.tmp.name});p.start();self.addCleanup(p.stop)
        self.request={'argv':['-y','-i',str(self.source),'-filter:v','hflip','-c:v','libx264',
            '-preset','fast','-crf','18','-an',str(self.output)],'options':{'timeoutMs':120000}}
        self.probe=lambda p:{'streams':[{'codec_type':'video','codec_name':'h264','pix_fmt':'yuv420p',
            'width':1920,'height':1080,'r_frame_rate':'24/1','avg_frame_rate':'24/1',
            'time_base':'1/12288','duration':'2.0'}]}

    def test_known_recipe_requires_source_clock_and_preserves_input(self):
        value=self.cli.qualify(self.request,probe=self.probe,classify=lambda a:'mirror')
        self.assertEqual(value['duration'],2.0)
        self.assertIn('24',value['argv']);self.assertNotIn('-r',self.request['argv'])
        bad=lambda p:{'streams':[dict(self.probe(p)['streams'][0],avg_frame_rate='30/1')]}
        with self.assertRaises(ValueError):self.cli.qualify(self.request,probe=bad,classify=lambda a:'mirror')

    def test_path_escape_collision_and_nonrecipe_fail_closed(self):
        for change in ('escape','collision','unknown'):
            request={'argv':list(self.request['argv']),'options':dict(self.request['options'])}
            if change=='escape':request['argv'][-1]=str(Path(self.tmp.name)/'out.mp4')
            if change=='collision':request['argv'][-1]=str(self.source)
            with self.subTest(change=change),self.assertRaises(ValueError):
                self.cli.qualify(request,probe=self.probe,classify=lambda a:None if change=='unknown' else 'mirror')

    def test_gpu_only_transport_rejects_cpu_overflow_and_cpu_recovery(self):
        for response,path in [({'id':'job','lane':'cpu'},'/renders'),
                              ({'state':'done','gpuPolicy':None},'/renders/job?metadata=1')]:
            calls=[]
            hook=types.SimpleNamespace(select_gpu_policy=lambda *a:None)
            def http(url,token,method,p,data=None,timeout=5):
                calls.append((method,p));return response if method!='DELETE' else {}
            hook.http_request=http
            original=hook.http_request
            with self.cli.gpu_only_transport(hook):
                with self.assertRaises(RuntimeError):hook.http_request('http://pc','private','POST' if path=='/renders' else 'GET',path)
            self.assertIs(hook.http_request,original)
            if path=='/renders':self.assertIn(('DELETE','/renders/job'),calls)

    async def test_unavailable_remote_does_not_publish_or_modify_source(self):
        hook=types.SimpleNamespace(select_gpu_policy=lambda *a:None,http_request=lambda *a,**kw:{})
        async def attempt(*a,**kw):return None
        hook.try_offload=attempt
        result=await self.cli.offload(self.request,hook=hook,probe=self.probe,classify=lambda a:'mirror')
        self.assertFalse(result['offloaded']);self.assertFalse(self.output.exists())
        self.assertEqual(self.source.read_bytes(),b'source')

if __name__=='__main__':unittest.main()
