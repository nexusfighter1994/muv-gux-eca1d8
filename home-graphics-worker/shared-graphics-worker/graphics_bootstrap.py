"""Explicit release bootstrap, sharing existing adapter accounting and pacing."""
import importlib.util
import json
from pathlib import Path
import sys
import threading
import types

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class Graphics:
    def __init__(self, worker, root):
        if not Path(root).is_absolute(): raise ValueError('VF_GRAPHICS_ROOT must be an absolute frozen release path')
        root = Path(root).resolve(strict=True)
        motion_runtime = root / 'motion-offload/runtime.json'
        map_runtime = root / 'map-offload/runtime.json'
        motion_config = json.loads(motion_runtime.read_text())
        map_config = json.loads(map_runtime.read_text())
        sys.path.insert(0, str(root / 'motion-offload'))
        transport = load('graphics_release_transport', root / 'motion-offload/transport.py')
        # Bind this release's adapter imports, not an older cached transport module.
        previous_transport = sys.modules.get('transport')
        sys.modules['transport'] = transport
        try:
            adapter = load('graphics_release_adapter', root / 'motion-offload/adapter.py')
        finally:
            if previous_transport is None:
                sys.modules.pop('transport', None)
            else:
                sys.modules['transport'] = previous_transport
        maps = load('graphics_release_map', root / 'map-offload/service.py')
        self.worker, self.adapter = worker, adapter
        self.motion = adapter.make_adapter(worker,
            [motion_config['node'], str(root / 'motion-offload/worker.mjs'), str(motion_runtime)],
            motion_config['contract'], config=motion_config)
        self.maps = maps.make_map_service(transport.MotionService,
            [map_config['node'], str(root / 'map-offload/worker.mjs'), str(map_runtime)], map_config['contract'], self.motion)
        if self.maps.slot is not self.motion.slot: raise RuntimeError('Graphics gate must be shared')
        self.maps.kinds = ('map-v1',)
        self.maps.transfer_limits = self.motion.transfer_limits
        self.counts, self.lock = {'completedMap': 0, 'completedMotion': 0, 'completedAlpha': 0}, threading.Lock()
        self.active = 0
        def tracked(native_acquire):
            def acquire():
                with worker.lock:
                    release = native_acquire()
                    if not callable(release): return None
                    self.active += 1
                released = False
                def tracked_release():
                    nonlocal released
                    with worker.lock:
                        if not released:
                            release()
                            self.active -= 1
                            released = True
                return tracked_release
            return acquire
        # Motion: CPU lease (software render); maps: CPU+GPU lease. Both share the graphics gate.
        cpu_acquire = self.motion.acquire_gpu
        self.maps.acquire_gpu = tracked(getattr(self.motion, 'acquire_with_gpu', cpu_acquire))
        self.motion.acquire_gpu = tracked(cpu_acquire)
        for service, counter in [(self.maps, 'completedMap'), (self.motion, 'completedMotion')]:
            original = service.render
            def counted(data, original=original, counter=counter):
                result = original(data)
                if result.get('backend') in ('Vulkan GPU', 'd3d11/nvidia', 'software/cpu') and result.get('sha256') and result.get('data'):
                    completed = 'completedAlpha' if counter == 'completedMotion' and data.get('kind') == transport.ALPHA_KIND else counter
                    with self.lock: self.counts[completed] += 1
                return result
            service.render = counted

    def health(self):
        motion, maps = self.motion.health(), self.maps.health()
        with self.lock:
            return dict(self.counts, graphicsBusy=int(self.active), graphicsCapacity=getattr(self.motion, 'slots', 1),
                        graphicsRecoveryVersion=2,
                        graphicsQuarantined=motion['quarantinedJobs'] + maps['quarantinedJobs'],
                        graphicsRecovered=motion['recoveredJobs'] + maps['recoveredJobs'],
                        graphicsActiveJobs=motion['activeJobs'] + maps['activeJobs'])

    def dispatch(self, handler, down, up):
        original = handler.path
        service = self.maps if original.startswith('/map/') else self.motion
        if original.startswith('/map/'): handler.path = '/motion/' + original[len('/map/'):]
        # Existing paced dispatch needs only these two worker fields.
        view = types.SimpleNamespace(motion=service, transfer_limits=self.worker.transfer_limits)
        try: return self.adapter.paced_dispatch(handler, view, down, up)
        finally: handler.path = original

    def close(self):
        try: self.maps.close()
        finally: self.motion.close()

def attach_graphics(worker, root):
    graphics = Graphics(worker, root)
    native_health = worker.health
    def health():
        with worker.lock: return dict(native_health(), **graphics.health())
    worker.health = health
    worker.graphics = graphics
    return graphics
