import importlib.util, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('scene_worker',Path(__file__).parents[1]/'home-graphics-worker/native-camera/scene_worker.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SceneTests(unittest.TestCase):
    def setUp(self):
        self.p={'operation':'native-scenes-cpu-v1','source':{'sha256':'a'*64,'size':1000},
            'scene':dict(min_duration_sec=3,max_duration_sec=18,detection_threshold=27,fallback_interval_sec=10)}
    def test_original_thresholds(self):self.assertEqual(m.validate(self.p)[1]['detection_threshold'],27)
    def test_closed_requests(self):
        for patch in [{'operation':'other'},{'source':{'sha256':'../foo','size':100}},
            {'scene':dict(self.p['scene'],detection_threshold=25)},{'source':{'sha256':'a'*64,'size':100*1024*1024}}]:
            with self.assertRaises(ValueError):m.validate(dict(self.p,**patch))
if __name__=='__main__':unittest.main()
