"""Scene detection on the home PC, inside WSL Ubuntu with the server's exact packages.

Only the PySceneDetect pass runs here (scene/raw_detect.py, line for line FFlow's
src/core/scenes.py detection part). Filtering, fallback intervals and min/max windowing stay
on the server with its own code, so identical raw cuts give identical shots.
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

DISTRO = 'Ubuntu-24.04'
LINUX_PYTHON = '/opt/scene/bin/python'
RUNNER = Path(__file__).resolve().parent.parent / 'scene' / 'raw_detect.py'
# 5 detections with OpenCV's default threading start ~87 threads each on 24 hardware threads.
# Four decode threads per detection: identical scenes on real sources (H.264 frame threading is
# bit-exact), 10-69 % faster per job under production load (2026-10-03). 0 = OpenCV default.
SCENE_THREADS = max(0, int(os.environ.get('VF_PC_SCENE_THREADS', '4')))
THREAD_ENV = (['env', f'OPENCV_FFMPEG_CAPTURE_OPTIONS=threads;{SCENE_THREADS}', 'OMP_NUM_THREADS=1',
               'OPENBLAS_NUM_THREADS=1'] if SCENE_THREADS else [])
# Live tuning without a restart: runtime/scene-tuning.json {"queue": int}.
_TUNING = {'checked': 0.0, 'values': {}}


def tuning(root, max_age=5.0):
    if time.monotonic() - _TUNING['checked'] > max_age:
        try:
            values = json.loads((Path(root) / 'scene-tuning.json').read_text())
            _TUNING['values'] = values if isinstance(values, dict) else {}
        except (OSError, ValueError):
            _TUNING['values'] = {}
        _TUNING['checked'] = time.monotonic()
    return _TUNING['values']
# Verified 14/14 identical to the server (2026-10-02); anything else must not run.
EXPECTED = {'numpy': '2.5.1', 'cv2': '5.0.0', 'scenedetect': '0.7', 'avcodec': '62.28.101', 'swscale': '9.5.101'}
CREATE_FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
VERSION_PROBE = (
    "import json,numpy,cv2,scenedetect,re;"
    "b=cv2.getBuildInformation();"
    "f=lambda k:(re.search(k+r':\\s+YES \\(([0-9.]+)\\)',b) or [None,None])[1];"
    "print(json.dumps({'numpy':numpy.__version__,'cv2':cv2.__version__,'scenedetect':scenedetect.__version__,"
    "'avcodec':f('avcodec'),'swscale':f('swscale')}))"
)


def linux_path(path):
    """E:\\a\\b -> /mnt/e/a/b (WSL drvfs mount)."""
    resolved = Path(path).resolve()
    drive = resolved.drive.rstrip(':').lower()
    if not re.fullmatch(r'[a-z]', drive):
        raise ValueError('Unsupported path')
    return '/mnt/' + drive + '/' + '/'.join(resolved.parts[1:])


def wsl(args, timeout):
    return subprocess.run(['wsl.exe', '-d', DISTRO, '-u', 'root', '--', *args], capture_output=True,
                          timeout=timeout, creationflags=CREATE_FLAGS)


def probe_runtime():
    try:
        result = wsl([LINUX_PYTHON, '-c', VERSION_PROBE], timeout=120)
        found = json.loads(result.stdout.decode('utf-8', 'replace').strip().splitlines()[-1])
        return found == EXPECTED and RUNNER.is_file(), found
    except Exception as exc:  # WSL missing, distro stopped beyond timeout, broken venv
        return False, {'error': type(exc).__name__}


def remove_stale_dirs(directories, live, max_age):
    """Delete job directories no live job owns once nothing in them changed for `max_age` seconds.

    The first rmtree can fail silently on Windows (a scanner still holds the fresh output.mp4) and a
    worker restart forgets its jobs; both left 1155 render folders (206 GB) on E: by 2026-10-05.
    """
    removed, now = 0, time.time()
    for directory in directories:
        try:
            if directory.name in live or not directory.is_dir():
                continue
            newest = max([directory.stat().st_mtime] + [p.stat().st_mtime for p in directory.iterdir()])
            if now - newest > max_age:
                shutil.rmtree(directory, ignore_errors=True)
                removed += not directory.exists()
        except OSError:
            continue
    return removed


class SceneRunner:
    def __init__(self, root, blob_path, capacity=5, probe=True, queue=None, transfer_limits=None, background_probe=False):
        self.root = Path(root) / 'scenes'
        self.root.mkdir(parents=True, exist_ok=True)
        self.blob_path = blob_path
        if transfer_limits is None:
            from pc_transfer_limits import read_limits
            transfer_limits = lambda: read_limits(Path(root) / 'pc-transfer-limits.json', max_age=0)
        self.transfer_limits = transfer_limits
        # `capacity` detections run at once; up to `queue` more are accepted and wait here, so the
        # next source uploads (and the server extracts thumbnails) while the workers keep running.
        self.capacity = capacity
        self.queue = max(0, int(os.environ.get('VF_PC_SCENE_QUEUE', '3') if queue is None else queue))
        self.lock = threading.RLock()
        self.gate = threading.Condition(self.lock)
        self.jobs = {}
        self.busy = 0
        self.running = 0
        self.completed = 0
        self.failed = 0
        self.recent = []
        self.last_error = None
        self.ready, self.versions = probe_runtime() if probe and not background_probe else (False, {})
        # WSL can hang as a whole (2026-10-10: even `wsl --shutdown` hung). Every detection then ran
        # into its timeout while the server waited for it. The watchdog takes scenes offline after two
        # failed liveness checks (sceneCapacity 0, the server detects locally) and back once WSL answers
        # and the runtime probe passes again.
        self.wsl_failures = 0
        if probe:
            threading.Thread(target=self.probe_and_watch if background_probe else self.watchdog, daemon=True).start()

    def probe_and_watch(self):
        ready, versions = probe_runtime()
        with self.lock:
            self.ready, self.versions = ready, versions
        self.watchdog()

    def watchdog(self, interval=60, timeout=20):
        while True:
            time.sleep(interval)
            try:
                alive = wsl(['true'], timeout=timeout).returncode == 0
            except Exception:
                alive = False
            if alive:
                self.wsl_failures = 0
                if not self.ready:
                    ready, versions = probe_runtime()
                    with self.lock:
                        self.ready, self.versions = ready, versions
                        if ready:
                            self.last_error = None
                continue
            self.wsl_failures += 1
            if self.wsl_failures >= 2 and self.ready:
                with self.lock:
                    self.ready = False
                    self.last_error = 'wsl_unresponsive'

    def accepted(self):
        queue = tuning(self.root.parent).get('queue', self.queue)
        if type(queue) is not int or not 0 <= queue <= 12:
            queue = self.queue
        return self.capacity + queue if self.capacity > 0 else 0

    def set_workers(self, workers):
        with self.gate:
            self.capacity = max(0, int(workers))
            self.gate.notify_all()

    def health(self, window=5.0):
        with self.lock:
            cutoff = time.monotonic() - window
            self.recent = [t for t in self.recent if t >= cutoff]
            # sceneBusy/sceneCapacity count accepted jobs (the server admits against them);
            # sceneWorkers/sceneRunning/sceneActive describe the detections actually running.
            return dict(sceneReady=self.ready, sceneBusy=self.busy, sceneCapacity=self.accepted() if self.ready else 0,
                        sceneWorkers=self.capacity if self.ready else 0, sceneRunning=self.running,
                        sceneQueued=self.busy - self.running,
                        sceneActive=min(self.capacity, self.running + len(self.recent)),
                        completedScene=self.completed, failedScene=self.failed, sceneLastError=self.last_error)

    def submit(self, payload):
        if not isinstance(payload, dict) or set(payload) - {'source', 'threshold', 'timeout'}:
            raise ValueError('Invalid scene request')
        source, threshold = payload.get('source'), payload.get('threshold')
        timeout = payload.get('timeout', 120)
        if not isinstance(source, dict) or type(threshold) not in (int, float) or not 0 < threshold <= 255:
            raise ValueError('Invalid scene request')
        if type(timeout) not in (int, float) or not 0 < timeout <= 600:
            raise ValueError('Invalid timeout')
        blob = self.blob_path(source.get('sha256'))
        if not blob.is_file() or blob.stat().st_size != source.get('size'):
            raise ValueError('Missing input blob')
        from pc_transfer_limits import worker_allows_scene
        limits = self.transfer_limits()
        if not worker_allows_scene(blob.stat().st_size, limits):
            raise ValueError('Scene input exceeds offload limit')
        with self.lock:
            if not self.ready:
                raise RuntimeError('scenes_unavailable')
            if self.busy >= self.accepted():
                raise RuntimeError('busy')
            self.busy += 1
        directory = None
        try:
            identifier = uuid.uuid4().hex
            directory = self.root / identifier
            directory.mkdir()
            video = directory / 'source.mp4'
            try:
                video.hardlink_to(blob)
            except OSError:
                shutil.copyfile(blob, video)
            job = dict(id=identifier, state='running', directory=directory, video=video, threshold=float(threshold),
                       transferLimits=dict(limits),
                       timeout=float(timeout), touched=time.monotonic(), cancel=threading.Event(), process=None,
                       done=threading.Event(), deadline=time.monotonic() + float(timeout), started=False)
            with self.lock:
                self.jobs[identifier] = job
            job['thread'] = threading.Thread(target=self.run, args=(job,), daemon=True)
            job['thread'].start()
            return {'id': identifier, 'state': 'running'}
        except BaseException:
            with self.lock:
                self.busy -= 1
            if directory:
                shutil.rmtree(directory, ignore_errors=True)
            raise

    def run(self, job):
        try:
            # Queued jobs wait for a free worker; the caller's timeout counts from acceptance.
            # A detection that starts with too little budget left is killed late and wasted; hand it
            # back at once instead (the server then runs it natively). Live-tunable: "minStart".
            min_start = tuning(self.root.parent).get('minStart', 60)
            if type(min_start) not in (int, float) or not 0 <= min_start <= 300:
                min_start = 60
            min_start = min(min_start, job['timeout'] / 2)
            with self.gate:
                while (self.running >= self.capacity and not job['cancel'].is_set()
                       and time.monotonic() < job['deadline'] - min_start):
                    self.gate.wait(0.5)
                if job['cancel'].is_set():
                    raise RuntimeError('cancelled')
                if time.monotonic() >= job['deadline'] - min_start:
                    raise RuntimeError('timeout')
                self.running += 1
                job['started'] = True
            remaining = job['deadline'] - time.monotonic()
            # `timeout -s KILL` bounds the Linux process even if wsl.exe is killed on cancel.
            # --exec: no shell in between (the ';' in the OpenCV option must reach env unchanged).
            command = ['wsl.exe', '-d', DISTRO, '-u', 'root', '--exec', *THREAD_ENV, 'timeout', '-s', 'KILL', str(max(1, int(remaining))),
                       LINUX_PYTHON, '-W', 'ignore', linux_path(RUNNER), repr(job['threshold']), linux_path(job['video'])]
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, creationflags=CREATE_FLAGS)
            job['process'] = process
            deadline = time.monotonic() + remaining + 10
            while process.poll() is None:
                if job['cancel'].is_set() or time.monotonic() > deadline:
                    raise RuntimeError('cancelled' if job['cancel'].is_set() else 'timeout')
                time.sleep(.1)
            stdout = process.stdout.read().decode('utf-8', 'replace')
            if process.returncode:
                raise RuntimeError('scene_detection_failed')
            line = [l for l in stdout.splitlines() if l.startswith('{')][-1]
            raw = json.loads(line)
            result = {'scenes': raw['scenes'], 'duration_sec': raw['duration_sec'], 'fps': raw['fps']}
            if not isinstance(result['scenes'], list) or any(
                    not (isinstance(s, list) and len(s) == 2 and all(isinstance(v, (int, float)) for v in s))
                    for s in result['scenes']):
                raise RuntimeError('invalid_scene_result')
            with self.lock:
                job['result'] = result
                job['state'] = 'done'
                self.completed += 1
            try:
                frames = (raw.get('duration_sec') or 0) * (raw.get('fps') or 0)
                with open(self.root.parent / 'scene-jobs.jsonl', 'a', encoding='utf-8') as log:
                    log.write(json.dumps({'t': round(time.time()), 'seconds': raw.get('seconds'), 'frames': round(frames),
                                          'threads': SCENE_THREADS, 'workers': self.capacity}) + '\n')
            except (OSError, TypeError, ValueError):
                pass
        except Exception as exc:
            with self.lock:
                job['state'] = 'failed'
                job['error'] = str(exc) if isinstance(exc, RuntimeError) else 'execution_failed'
                self.failed += 1
                self.last_error = job['error']
        finally:
            process = job.get('process')
            if process and process.poll() is None:
                process.kill()
                try:
                    wsl(['pkill', '-KILL', '-f', linux_path(job['directory'])], timeout=20)
                except Exception:
                    pass
            with self.gate:
                self.busy -= 1
                if job['started']:
                    self.running -= 1
                    self.recent.append(time.monotonic())
                job['finished'] = time.monotonic()
                self.gate.notify_all()
            job['done'].set()

    def status(self, identifier, wait=0.0):
        """Long-poll: block up to `wait` seconds for completion - one tunnel round trip
        instead of polling every 0.5 s over a 1-3 s link."""
        with self.lock:
            job = self.jobs.get(identifier)
            if not job:
                raise KeyError(identifier)
            job['touched'] = time.monotonic()
        if wait > 0:
            job['done'].wait(min(wait, 12.0))
        with self.lock:
            job['touched'] = time.monotonic()
            result = {'id': job['id'], 'state': job['state']}
            if job['state'] == 'done':
                result['result'] = job['result']
            elif job['state'] == 'failed':
                result['error'] = job['error']
            return result

    def cancel(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            if job:
                job['cancel'].set()
                if 'finished' in job:
                    self.jobs.pop(identifier)
                    shutil.rmtree(job['directory'], ignore_errors=True)
            return {'cancelled': True}

    def reap(self, idle=20):
        with self.lock:
            for identifier, job in list(self.jobs.items()):
                if time.monotonic() - job['touched'] > idle:
                    self.cancel(identifier)

    def sweep(self, max_age=3600):
        with self.lock:
            live = {job['directory'].name for job in self.jobs.values()}
        return remove_stale_dirs(list(self.root.iterdir()), live, max_age)

    def close(self):
        with self.lock:
            jobs = list(self.jobs.values())
            for job in jobs:
                job['cancel'].set()
        for job in jobs:
            job['thread'].join(timeout=8)
            shutil.rmtree(job['directory'], ignore_errors=True)
