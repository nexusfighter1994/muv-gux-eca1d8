import sys
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]/'fflow'))
import pc_scene_graphics_cli as scene

class SceneCapacity(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.slots=tempfile.mkdtemp();self.patch=patch.object(scene,'SLOT_DIR',self.slots);self.patch.start()
        self.waiters=tempfile.mkdtemp();self.wpatch=patch.object(scene,'WAIT_DIR',self.waiters);self.wpatch.start()
        for h in scene.HELD:h.close()
        scene.HELD.clear()
    def tearDown(self):
        for h in scene.HELD:h.close()
        scene.HELD.clear();self.patch.stop();self.wpatch.stop()

    def test_only_a_few_scenes_wait_and_the_rest_decline_at_once(self):
        held=[scene.take_waiter() for _ in range(scene.SCENE_WAITERS)]
        self.assertTrue(all(held));self.assertIsNone(scene.take_waiter())
        full={'ready':True,'graphicsBusy':14,'graphicsCapacity':14}
        hook=SimpleNamespace(http_request=Mock(return_value=full))
        now=[0.0];sleep=lambda s:now.__setitem__(0,now[0]+s);scene.TIMING.clear()
        scene.wait_for_slot(hook,'h','t','map',full,{},deadline=300,sleep=sleep,clock=lambda:now[0],lock=False)
        self.assertEqual(hook.http_request.call_count,0);self.assertEqual(scene.TIMING['waitersFull'],1)
        for h in held:h.close()
        self.assertIsNotNone(scene.take_waiter())

    def test_waiter_slot_is_released_after_the_wait(self):
        full={'ready':True,'graphicsBusy':14,'graphicsCapacity':14};free={'ready':True,'graphicsBusy':3,'graphicsCapacity':14}
        hook=SimpleNamespace(http_request=Mock(side_effect=[free,{}]))
        now=[0.0];sleep=lambda s:now.__setitem__(0,now[0]+s);scene.TIMING.clear()
        scene.wait_for_slot(hook,'h','t','map',full,{},deadline=300,sleep=sleep,clock=lambda:now[0],lock=False)
        held=[scene.take_waiter() for _ in range(scene.SCENE_WAITERS)]
        self.assertTrue(all(held))
        for h in held:h.close()

    def test_flock_caps_concurrent_scenes(self):
        import subprocess,sys as s2
        code=("import sys;sys.path.insert(0,%r);import pc_scene_graphics_cli as c,time;c.SLOT_DIR=%r;"
              "print(c.take_slot(),flush=True);time.sleep(3)")%(str(Path(__file__).parents[1]/'fflow'),self.slots)
        procs=[subprocess.Popen([s2.executable,'-c',code],stdout=subprocess.PIPE,text=True) for _ in range(scene.SCENE_SLOTS)]
        firsts=[p.stdout.readline().strip() for p in procs]
        self.assertEqual(firsts,['True']*scene.SCENE_SLOTS)
        self.assertFalse(scene.take_slot())
        for p in procs:p.wait()
        self.assertTrue(scene.take_slot())

    def test_full_graphics_pool_declines_before_source_download(self):
        hook=SimpleNamespace(runtime_settings=lambda:{'enabled':True},http_request=Mock(return_value={
            'ready':True,'cpuBusy':1,'cpuCapacity':18,'graphicsBusy':8,'graphicsCapacity':8}))
        request={'jobId':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','sourceUrl':'http://local/source.mp4','durationSec':5,'budgetMs':90000}
        with patch.object(scene,'_load_hook',return_value=hook),patch.object(Path,'read_text',return_value='test-token'),patch.object(scene,'resolve_project',return_value=None) as resolve:
            result=scene.attempt(request)
        self.assertEqual(result,{'offloaded':False,'reason':'home_graphics_full'})
        resolve.assert_not_called()
        self.assertEqual(hook.http_request.call_count,2)  # Home health + lane health, no wait on a 90 s budget

    def test_open_and_legacy_graphics_health_are_not_rejected(self):
        for health in ({'graphicsBusy':7,'graphicsCapacity':8},{}):
            self.assertFalse(scene.graphics_full(health))

    def test_all_reported_slots_are_counted(self):
        for busy in (8,9):
            self.assertTrue(scene.graphics_full({'graphicsBusy':busy,'graphicsCapacity':8}))

    def test_pool_filling_during_download_skips_upload(self):
        hook=SimpleNamespace(runtime_settings=lambda:{'enabled':True},http_request=Mock(side_effect=[
            {'ready':True,'cpuBusy':1,'cpuCapacity':18,'graphicsBusy':7,'graphicsCapacity':8},
            {'contract':'test'}, {'graphicsBusy':8,'graphicsCapacity':8}, {'contract':'test'}]),upload_with_lane=Mock())
        request={'jobId':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','sourceUrl':'http://local/source.mp4','durationSec':5,'budgetMs':90000}
        with patch.object(scene,'_load_hook',return_value=hook),patch.object(Path,'read_text',return_value='test-token'),patch.object(scene,'resolve_project',return_value=Path('/unused')),patch('urllib.request.urlopen',return_value=io.BytesIO(b'source')):
            result=scene.attempt(request)
        self.assertEqual(result['reason'],'home_graphics_full')
        hook.upload_with_lane.assert_not_called()

    def test_full_pool_is_awaited_while_budget_covers_render(self):
        full={'ready':True,'graphicsBusy':8,'graphicsCapacity':8};free={'ready':True,'graphicsBusy':7,'graphicsCapacity':8}
        hook=SimpleNamespace(http_request=Mock(side_effect=[free,{'activeJobs':1}]))
        now=[0.0];sleep=lambda s:now.__setitem__(0,now[0]+s);scene.TIMING.clear()
        health,lane=scene.wait_for_slot(hook,'h','t','map',full,{'activeJobs':1},deadline=300,sleep=sleep,clock=lambda:now[0])
        self.assertTrue(scene.slot_free(health,lane));self.assertEqual(hook.http_request.call_count,2)

    def test_motion_jobs_on_the_lane_do_not_block_scenes(self):
        # Lane 'motion' counts Motion renders too; only real Home graphics saturation blocks a scene.
        open_pool={'graphicsBusy':5,'graphicsCapacity':14}
        self.assertTrue(scene.slot_free(open_pool,{'activeJobs':scene.SCENE_SLOTS+4},lock=False))
        self.assertTrue(scene.slot_free(open_pool,{},lock=False))
        self.assertFalse(scene.slot_free({'graphicsBusy':14,'graphicsCapacity':14},{},lock=False))

    def test_wait_stops_at_render_reserve_and_wait_cap(self):
        full={'ready':True,'graphicsBusy':8,'graphicsCapacity':8}
        hook=SimpleNamespace(http_request=Mock(return_value=full))
        now=[0.0];sleep=lambda s:now.__setitem__(0,now[0]+s);scene.TIMING.clear()
        health,lane=scene.wait_for_slot(hook,'h','t','map',full,{},deadline=200,sleep=sleep,clock=lambda:now[0])
        self.assertFalse(scene.slot_free(health,lane));self.assertLessEqual(now[0],200-scene.RENDER_RESERVE_S+3.5)
        now[0]=0.0;scene.TIMING.clear()
        scene.wait_for_slot(hook,'h','t','map',full,{},deadline=10000,sleep=sleep,clock=lambda:now[0])
        self.assertLessEqual(now[0],scene.GRAPHICS_WAIT_S+3.5)

    def test_busy_503_on_submit_is_retried_not_declined(self):
        import urllib.error
        ok={'ready':True,'cpuBusy':1,'cpuCapacity':18,'graphicsBusy':5,'graphicsCapacity':8}
        posts=[]
        def http(home,token,method,path,body=None,timeout=None):
            if method=='POST':
                posts.append(path)
                if len(posts)==1:raise urllib.error.HTTPError(path,503,'busy',None,None)
                return {}
            return {'contract':'test','activeJobs':1} if path.endswith('/health') and path!='/health' else ok
        hook=SimpleNamespace(runtime_settings=lambda:{'enabled':True},http_request=http,upload_with_lane=Mock())
        request={'jobId':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','sourceUrl':'http://local/source.mp4','durationSec':5,'budgetMs':300000}
        scene.TIMING.clear()
        with patch.object(scene,'_load_hook',return_value=hook),patch.object(Path,'read_text',return_value='test-token'),patch.object(scene,'resolve_project',return_value=Path('/unused')),patch('urllib.request.urlopen',return_value=io.BytesIO(b'source')),patch.object(scene.time,'sleep',lambda s:None):
            with self.assertRaisesRegex(ValueError,'Receipt mismatch'):scene.attempt(request)
        self.assertEqual(len(posts),2);self.assertEqual(scene.TIMING['busyRetries'],1)

    def run_busy(self,health_after,posts,slow=False):
        import urllib.error
        first={'ready':True,'nvencReady':True,'cpuBusy':1,'cpuCapacity':14,'gpuBusy':3,'gpuCapacity':10,'graphicsBusy':5,'graphicsCapacity':14}
        clock=[0.0]
        def http(home,token,method,path,body=None,timeout=None):
            if method=='POST':
                posts.append((path,body['id'],body['operation']))
                if slow:clock[0]+=scene.BUSY_ANSWER_S+1
                if len(posts)==1:raise urllib.error.HTTPError(path,503,'busy',None,None)
                return {}
            if method=='DELETE':return {}
            if path=='/health':return first if not posts else health_after
            return {'contract':path.split('/')[1]}
        hook=SimpleNamespace(runtime_settings=lambda:{'enabled':True},http_request=http,upload_with_lane=Mock())
        request={'jobId':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','sourceUrl':'http://local/source.mp4','durationSec':5,'budgetMs':300000}
        scene.TIMING.clear()
        with patch.object(scene,'_load_hook',return_value=hook),patch.object(Path,'read_text',return_value='test-token'),patch.object(scene,'resolve_project',return_value=Path('/unused')),\
             patch('urllib.request.urlopen',return_value=io.BytesIO(b'source')),patch.object(scene.time,'sleep',lambda s:None),\
             patch.object(scene.time,'monotonic',lambda:clock[0]):
            return scene.attempt(request)

    def test_busy_retry_uses_a_new_id_because_home_burns_the_old_one(self):
        posts=[];free={'ready':True,'nvencReady':True,'cpuBusy':1,'cpuCapacity':14,'gpuBusy':3,'gpuCapacity':10,'graphicsBusy':5,'graphicsCapacity':14}
        with self.assertRaisesRegex(ValueError,'Receipt mismatch'):self.run_busy(free,posts)
        self.assertEqual([p[0] for p in posts],['/map/render','/map/render'])
        self.assertNotEqual(posts[0][1],posts[1][1])

    def test_full_home_gpu_moves_the_retry_to_the_cpu_lane(self):
        posts=[];gpu_full={'ready':True,'nvencReady':True,'cpuBusy':1,'cpuCapacity':14,'gpuBusy':10,'gpuCapacity':10,'graphicsBusy':5,'graphicsCapacity':14}
        with self.assertRaisesRegex(ValueError,'Receipt mismatch'):self.run_busy(gpu_full,posts)
        self.assertEqual(posts[1][0],'/motion/render');self.assertEqual(posts[1][2],'native-scenes-cpu-v1')
        self.assertEqual(scene.TIMING['cpuLaneRetries'],1)

    def test_map_lane_leaves_gpu_slots_for_nvenc(self):
        base={'nvencReady':True,'gpuCapacity':10}
        self.assertTrue(scene.map_lane_ok({**base,'gpuBusy':5}))
        self.assertFalse(scene.map_lane_ok({**base,'gpuBusy':6}))
        self.assertFalse(scene.map_lane_ok({**base,'gpuBusy':0,'nvencReady':False}))
        self.assertFalse(scene.map_lane_ok({}))

    def test_busy_gpu_sends_the_scene_to_the_cpu_lane(self):
        posts=[];busy={'ready':True,'nvencReady':True,'cpuBusy':1,'cpuCapacity':14,'gpuBusy':7,'gpuCapacity':10,'graphicsBusy':5,'graphicsCapacity':14}
        import urllib.error
        def http(home,token,method,path,body=None,timeout=None):
            if method=='POST':posts.append((path,body['operation']));return {}
            if method=='DELETE':return {}
            if path=='/health':return busy
            return {'contract':path.split('/')[1]}
        hook=SimpleNamespace(runtime_settings=lambda:{'enabled':True},http_request=http,upload_with_lane=Mock())
        request={'jobId':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','sourceUrl':'http://local/source.mp4','durationSec':5,'budgetMs':300000}
        scene.TIMING.clear()
        with patch.object(scene,'_load_hook',return_value=hook),patch.object(Path,'read_text',return_value='test-token'),patch.object(scene,'resolve_project',return_value=Path('/unused')),\
             patch('urllib.request.urlopen',return_value=io.BytesIO(b'source')),patch.object(scene.time,'sleep',lambda s:None):
            with self.assertRaisesRegex(ValueError,'Receipt mismatch'):scene.attempt(request)
        self.assertEqual(posts,[('/motion/render','native-scenes-cpu-v1')])

    def test_full_home_cpu_is_awaited_instead_of_declined(self):
        cpu_full={'ready':True,'cpuBusy':14,'cpuCapacity':14,'graphicsBusy':3,'graphicsCapacity':14}
        cpu_free={'ready':True,'cpuBusy':13,'cpuCapacity':14,'graphicsBusy':3,'graphicsCapacity':14}
        self.assertFalse(scene.slot_free(cpu_full,{},lock=False))
        self.assertEqual(scene.full_reason(cpu_full),'home_cpu_full')
        hook=SimpleNamespace(http_request=Mock(side_effect=[cpu_free,{'contract':'c'}]))
        now=[0.0];sleep=lambda s:now.__setitem__(0,now[0]+s);scene.TIMING.clear()
        health,lane=scene.wait_for_slot(hook,'h','t','map',cpu_full,{},deadline=300,sleep=sleep,clock=lambda:now[0],lock=False)
        self.assertTrue(scene.slot_free(health,lane,lock=False))

    def test_cpu_full_at_start_no_longer_declines_at_once(self):
        cpu_full={'ready':True,'cpuBusy':14,'cpuCapacity':14,'graphicsBusy':3,'graphicsCapacity':14}
        hook=SimpleNamespace(runtime_settings=lambda:{'enabled':True},http_request=Mock(return_value=cpu_full))
        request={'jobId':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','sourceUrl':'http://local/source.mp4','durationSec':5,'budgetMs':90000}
        with patch.object(scene,'_load_hook',return_value=hook),patch.object(Path,'read_text',return_value='test-token'),patch.object(scene,'resolve_project',return_value=None):
            result=scene.attempt(request)
        self.assertEqual(result,{'offloaded':False,'reason':'home_cpu_full'})

    def test_slow_503_after_a_real_render_is_not_retried(self):
        import urllib.error
        posts=[]
        with self.assertRaises(urllib.error.HTTPError):self.run_busy({},posts,slow=True)
        self.assertEqual(len(posts),1)

if __name__=='__main__':unittest.main()
