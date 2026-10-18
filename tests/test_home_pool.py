import ast
import asyncio
import json
from pathlib import Path
import unittest
import os
import signal
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

FILE=Path(__file__).resolve().parents[1]/'fflow'/'pc_home_pool.py'


class HomePoolTests(unittest.TestCase):
    def load(self):
        tree=ast.parse(FILE.read_text())
        selected=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))
                  and n.name in ('restart_delay','children_to_retire','children_to_start',
                                 'ElasticHomePoolTarget','control_ceiling',
                                 'native_worker_environment','unexpected_exit')]
        ns={'Path':Path,'os':os};exec(compile(ast.Module(body=selected,type_ignores=[]),str(FILE),'exec'),ns)
        return ns

    def test_worker_crashes_cannot_make_a_respawn_storm(self):
        delay=self.load().get('restart_delay')
        self.assertIsNotNone(delay,'Missing bounded restart cooldown')
        self.assertEqual([delay(n) for n in (1,2,3,4,20)],[2,4,8,16,60])

    def test_intentional_idle_scale_down_is_not_a_crash(self):
        check=self.load().get('unexpected_exit')
        self.assertIsNotNone(check)
        self.assertFalse(check(-15,True))
        self.assertTrue(check(-15,False))
        self.assertFalse(check(0,False))

    def test_retirement_prefers_idle_and_accounts_for_in_progress_retirements(self):
        select=self.load()['children_to_retire']
        self.assertEqual(select([10,11,12,13],2,{10,12},set()),[11,13])
        self.assertEqual(select([10,11,12,13],2,{10,12},{11,13}),[])
        self.assertEqual(select([10,11,12,13],1,{10,12},{11,13}),[10])
        self.assertEqual(select([10,11],0,{10,11},set()),[10,11])
        self.assertEqual(select([10,11],4,set(),set()),[])

    def test_replacement_waits_for_physical_capacity_and_never_revives_retirees(self):
        select=self.load()['children_to_start']
        self.assertEqual(select([10,11,12,13],4,{11,13},4),0)
        self.assertEqual(select([10,12,13],4,{13},4),1)
        self.assertEqual(select([10,12],4,set(),4),2)
        self.assertEqual(select([10,12],2,set(),24),0)
        self.assertEqual(select([10,12],0,{10,12},0),0)

    def test_actual_admissions_ramp_to_full_capacity_not_backlog_size(self):
        policy=self.load()['ElasticHomePoolTarget']()
        for t,active in enumerate(range(0,25,2)):
            self.assertEqual(policy.update(24,active,t),min(24,active+2))
        self.assertEqual(policy.update(24,24,20),24)

    def test_small_demand_and_direct_only_do_not_warm_extra_flow_workers(self):
        policy=self.load()['ElasticHomePoolTarget']()
        self.assertEqual(policy.update(0,0,0),0)
        self.assertEqual(policy.update(1,0,1),1)
        self.assertEqual(policy.update(0,0,2),0)

    def test_idle_pool_shrinks_after_hysteresis_and_repeated_polling_does_not_reset_it(self):
        policy=self.load()['ElasticHomePoolTarget']()
        self.assertEqual(policy.update(24,22,0),24)
        for now in range(1,31):
            self.assertEqual(policy.update(24,0,now),24)
        self.assertEqual(policy.update(24,0,31),2)
        self.assertEqual(policy.update(24,0,120),2)

    def test_renewed_load_resets_shrink_window_and_growth_is_immediate(self):
        policy=self.load()['ElasticHomePoolTarget']()
        self.assertEqual(policy.update(24,6,0),8)
        self.assertEqual(policy.update(24,0,1),8)
        self.assertEqual(policy.update(24,6,20),8)
        self.assertEqual(policy.update(24,0,21),8)
        self.assertEqual(policy.update(24,0,50),8)
        self.assertEqual(policy.update(24,0,51),2)
        self.assertEqual(policy.update(24,4,52),6)

    def test_shrink_preserves_peak_demand_seen_within_window(self):
        policy=self.load()['ElasticHomePoolTarget']()
        self.assertEqual(policy.update(24,10,0),12)
        self.assertEqual(policy.update(24,0,1),12)
        self.assertEqual(policy.update(24,6,15),12)
        self.assertEqual(policy.update(24,0,31),8)

    def test_offline_or_lower_ceiling_never_waits_for_hysteresis(self):
        policy=self.load()['ElasticHomePoolTarget']()
        self.assertEqual(policy.update(24,22,0),24)
        self.assertEqual(policy.update(6,22,1),6)
        self.assertEqual(policy.update(0,6,2),0)
        self.assertEqual(policy.update(24,0,3),2)

    def test_stale_or_invalid_control_fails_closed_without_altering_native_limits(self):
        ceiling=self.load()['control_ceiling']
        self.assertEqual(ceiling({'extra':24,'updatedAt':1000},1001),24)
        self.assertEqual(ceiling({'extra':24,'updatedAt':1000},16000),24,'a 15 s server stall keeps the pool')
        self.assertEqual(ceiling({'extra':24,'updatedAt':1000},61000),0)
        self.assertEqual(ceiling({'extra':24,'updatedAt':1001},1000),0)
        for value in (None,[],{}, {'extra':'24','updatedAt':1000},
                      {'extra':True,'updatedAt':1000},{'extra':24,'updatedAt':float('nan')}):
            self.assertEqual(ceiling(value,1000),0)
        self.assertEqual(ceiling({'extra':0,'updatedAt':1000},1001),0)

    def test_home_consumers_inherit_the_exact_native_storage_environment(self):
        find=self.load().get('native_worker_environment')
        self.assertIsNotNone(find,'Missing native environment inheritance')
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);process=root/'123';process.mkdir()
            (process/'cmdline').write_bytes(b'python\x00worker.py\x00')
            (process/'environ').write_bytes(b'TMPDIR=/data/engines/fflow/tmp\x00WORKER_CONCURRENCY=1\x00FFLOW_MAX_FFMPEG_PROCESSES=14\x00')
            with patch.object(os,'readlink',return_value='/app/engines/fflow'):
                source=find(root,{123})
            self.assertEqual(source['env']['TMPDIR'],'/data/engines/fflow/tmp')
            self.assertEqual(source['env']['FFLOW_MAX_FFMPEG_PROCESSES'],'14')
            self.assertEqual(source['cwd'],'/app/engines/fflow')
            with self.assertRaises(RuntimeError):find(root,set())


class HomePoolManagerTests(unittest.IsolatedAsyncioTestCase):
    async def run_manager(self,steps):
        tree=ast.parse(FILE.read_text())
        definitions=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef))]
        clock=SimpleNamespace(value=0)
        processes={};signals=[];handlers={};snapshots=[];owners=set();calls=[]
        state={'redis_error':False,'closed':False}
        with tempfile.TemporaryDirectory() as temp:
            runtime=Path(temp)
            def control(value):
                (runtime/'pc-home-admission.json').write_text(json.dumps(
                    {'extra':value,'updatedAt':(1000+clock.value)*1000}))
            control(24)

            class Child:
                def __init__(self,pid):self.pid=pid;self.code=None
                def poll(self):return self.code
                def send_signal(self,sig):signals.append((self.pid,sig))

            def spawn(argv,**kwargs):
                calls.append((argv,kwargs))
                child=Child(5000+len(processes));processes[child.pid]=child
                return child

            class Redis:
                async def ping(self):
                    if state['redis_error']:raise OSError('fixture unavailable')
                async def scan_iter(self,**kwargs):
                    yield 'fflow:workers:worker-123-native'
                    for pid,child in processes.items():
                        if child.code is None:yield f'fflow:workers:worker-{pid}-home'
                async def smembers(self,key):return {str(pid) for pid in owners}|{'123'}
                async def hget(self,key,field):return 'worker-'+key.split(':')[1]+'-fixture'
                async def aclose(self):state['closed']=True

            redis=Redis()
            class Queue:
                async def _get_redis(self):return redis

            async def sleep(delay):
                snapshots.append(json.loads((runtime/'pc-home-pool.json').read_text()))
                index=len(snapshots)-1
                if index>=len(steps):raise AssertionError('Manager did not stop')
                action=steps[index]
                clock.value=action.get('now',clock.value+1)
                if 'owners' in action:owners.clear();owners.update(action['owners'])
                state['redis_error']=action.get('redis_error',False)
                for pid in action.get('exited',()):processes[pid].code=0
                control(action.get('ceiling',24))
                if action.get('stop'):handlers[signal.SIGTERM](signal.SIGTERM,None)

            ns={'__file__':str(FILE),'Path':lambda p:runtime if str(p)=='/data/runtime' else Path(p),
                'os':os,'json':json,'sys':SimpleNamespace(executable='fixture-python'),
                'signal':SimpleNamespace(SIGTERM=signal.SIGTERM,SIGINT=signal.SIGINT,
                    signal=lambda sig,fn:handlers.__setitem__(sig,fn)),
                'subprocess':SimpleNamespace(Popen=spawn),
                'asyncio':SimpleNamespace(sleep=sleep),
                'time':SimpleNamespace(time=lambda:1000+clock.value,monotonic=lambda:clock.value),
                'fcntl':SimpleNamespace(LOCK_EX=1,LOCK_NB=2,flock=lambda *args:None),
                'get_job_queue':Queue,'mod_enabled':lambda key:True}
            exec(compile(ast.Module(body=definitions,type_ignores=[]),str(FILE),'exec'),ns)
            ns['native_worker_environment']=lambda *args:{'pid':123,'cwd':'/app/engines/fflow',
                'env':{'FFLOW_MAX_FFMPEG_PROCESSES':'14'}}
            await ns['manage']()
        self.assertTrue(state['closed'])
        for argv,kwargs in calls:
            self.assertEqual(argv,['fixture-python',str(FILE),'consume'])
            self.assertEqual(kwargs['env'],{'FFLOW_MAX_FFMPEG_PROCESSES':'14','VF_HOME_WORKER':'1'})
        return snapshots,signals

    async def test_manager_ramps_delays_shrink_excludes_retirees_and_drains_on_zero(self):
        snapshots,signals=await self.run_manager([
            {'now':1,'owners':{5000,5001}},
            {'now':2,'owners':set()},
            {'now':31},
            {'now':32},
            {'now':33},
            {'now':34,'ceiling':0},
            {'now':35,'ceiling':0,'exited':range(5000,5004)},
            {'now':36,'ceiling':0,'stop':True},
        ])
        self.assertEqual([s['target'] for s in snapshots],[2,4,4,4,2,2,0,0])
        self.assertEqual([s['workers'] for s in snapshots],[2,4,4,4,4,4,4,0])
        self.assertEqual(snapshots[4]['retiringPids'],[5000,5001])
        self.assertEqual(snapshots[5]['retiringPids'],[5000,5001])
        self.assertEqual(snapshots[4]['readyWorkers'],2)
        self.assertEqual(snapshots[6]['readyWorkers'],0)
        self.assertEqual(signals,[(pid,signal.SIGTERM) for pid in range(5000,5004)])

    async def test_lull_never_retires_busy_workers_and_retiring_encoders_still_count_as_load(self):
        snapshots,signals=await self.run_manager([
            {'now':1,'owners':{5000,5001}},
            {'now':2,'owners':{5000,5001,5002,5003}},
            {'now':3,'owners':{5000,5001,5002,5003}},
            {'now':4,'owners':{5000}},
            {'now':40,'owners':{5000,5004}},
            {'now':41,'owners':{5000,5004}},
            {'now':42,'ceiling':1,'owners':{5000,5004}},
            {'now':43,'ceiling':0,'stop':True,'exited':range(5000,5006)},
        ])
        self.assertEqual([s['target'] for s in snapshots[:5]],[2,4,6,6,6])
        # After the 30 s lull the target falls to the peak seen (4), but the busy 5000/5004 stay.
        self.assertEqual(snapshots[5]['target'],4)
        self.assertNotIn(5000,snapshots[5]['retiringPids']);self.assertNotIn(5004,snapshots[5]['retiringPids'])
        self.assertEqual(sorted(snapshots[5]['retiringPids']),[5001,5002])
        # A lower ceiling does retire busy workers (offline / capacity drop).
        self.assertIn(5000,snapshots[7]['retiringPids'] if len(snapshots)>7 else snapshots[6]['retiringPids'])

    async def test_lost_registry_does_not_scale_from_unknown_activity_or_advertise_ready(self):
        snapshots,signals=await self.run_manager([
            {'now':1,'redis_error':True},
            {'now':2,'ceiling':0},
            {'now':3,'ceiling':0,'exited':(5000,5001),'stop':True},
        ])
        self.assertFalse(snapshots[1]['ready'])
        self.assertEqual(snapshots[1]['workers'],2)
        self.assertEqual(snapshots[1]['readyWorkers'],0)
        self.assertEqual(snapshots[2]['target'],0)
        self.assertEqual(signals,[(5000,signal.SIGTERM),(5001,signal.SIGTERM)])


if __name__=='__main__':unittest.main()
