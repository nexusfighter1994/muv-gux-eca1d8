"""Authenticated loopback FFmpeg worker; stdlib only, Windows/Linux compatible."""
import argparse
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from pc_scene_runner import SceneRunner, remove_stale_dirs
from pc_nvenc_sessions import NvencSessions
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pc_transfer_runtime import TransferLimits
from pc_transfer_limits import MIB, check_render_sizes
from pc_ffmpeg_protocol import (DEFAULTS, MAX_BODY, MAX_INPUT, MAX_TOTAL, MAX_OUTPUT, SCENE_MAX_INPUT,
                                CREDIT_ASSETS_VERSION, checked_config, validate_argv,
                                materialize_credit_argv)
from pc_nvenc_high import (POLICY as NVENC_POLICY, nvenc_high_argv, normalized_candidate,
                           probe_nvenc_high, validate_high_output, verify_pair,
                           utility_trim_candidate, validate_utility_trim_output)
from pc_cuda_scale import (POLICY as CUDA_SCALE_POLICY, cuda_scale_candidate,
                           policy_enabled as cuda_scale_enabled, probe_cuda_scale,
                           validate_cuda_scale_output, CudaScaleCandidate,
                           NATIVE_FILTER as CUDA_SCALE_NATIVE_FILTER,
                           CUDA_FILTER as CUDA_SCALE_FILTER)
from pc_nvenc_high import probe_media

CREATE_FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def run(command, timeout=30):
    return subprocess.run(command, capture_output=True, timeout=timeout, creationflags=CREATE_FLAGS, check=True)


def frame_hash(ffmpeg, path, runner=run):
    result = runner([ffmpeg, '-v', 'error', '-i', str(path), '-map', '0:v:0', '-f', 'hash', '-hash', 'sha256', '-'])
    return result.stdout.strip()


def reference_hash(ffmpeg, argv, directory, files, runner=run):
    """Hash raw frames from the original filter/timing/pixel-format command."""
    args = raw_video_args(ffmpeg, argv, directory, files, 'error')
    args.extend(['-an', '-c:v', 'rawvideo', '-f', 'hash', '-hash', 'sha256', '-'])
    return runner(args, timeout=120).stdout.strip()


def filter_output_pix_fmt(ffmpeg, argv, directory, files, runner=run):
    """Pixel format the original filter graph hands to the encoder (one frame, no encode).
    rawvideo accepts every format, so this is exactly what libx264 would receive."""
    args = raw_video_args(ffmpeg, argv, directory, files, 'info')
    args.extend(['-an', '-frames:v', '1', '-c:v', 'rawvideo', '-f', 'null', '-'])
    log = runner(args, timeout=30).stderr.decode('utf-8', 'replace')
    found = re.findall(r'Stream #\d+:\d+[^\n]*: Video: rawvideo[^,\n]*, ([a-z0-9]+)', log)
    return found[-1] if found else None


def raw_video_args(ffmpeg, argv, directory, files, level):
    argv = materialize_credit_argv(argv, directory, files)
    skip = {'-c:v', '-codec:v', '-vcodec', '-crf', '-preset', '-c:a', '-b:a', '-ar', '-ac',
            '-movflags', '-progress', '-video_track_timescale', '-f',
            '-metadata', '-g', '-keyint_min', '-sc_threshold', '-flags'}
    args, pos = [ffmpeg, '-nostdin', '-v', level], 0
    while pos < len(argv) - 1:
        key = argv[pos]
        if key in skip:
            pos += 2
            continue
        if key == '-map' and ':a' in argv[pos + 1]:
            pos += 2
            continue
        if key == '-i':
            args.extend(['-protocol_whitelist', 'file,pipe', '-format_whitelist',
                         'mov,matroska,webm,image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe'])
        args.append(str(directory / key) if key in files else key)
        pos += 1
    return args


def cuda_decode_argv(argv):
    """Decode one video on CUDA; preserve every encoder, audio and filter option."""
    if (argv[-1] != 'output.mp4' or argv.count('-i') != 1 or '-filter_complex' in argv
            or '-c:v' not in argv or argv[argv.index('-c:v') + 1] != 'libx264'):
        return None
    if Path(argv[argv.index('-i') + 1]).suffix.lower() not in ('.mp4', '.mov', '.mkv'):
        return None
    if '-pix_fmt' in argv and argv[argv.index('-pix_fmt') + 1] != 'yuv420p':
        return None
    index = argv.index('-i')
    return argv[:index] + ['-hwaccel', 'cuda'] + argv[index:]


def h264_decode_source(ffmpeg, source):
    try:
        result = run([ffmpeg, '-hide_banner', '-nostdin', '-i', str(source),
                      '-map', '0:v:0', '-frames:v', '0', '-c:v', 'copy', '-f', 'null', '-'], timeout=8)
        header = result.stderr.decode('utf-8', 'replace').split('Output #')[0]
        streams = re.findall(r'Stream #.*?: Video: ([^\r\n]+)', header)
        if len(streams) != 1:
            return False
        line = streams[0]
        size = re.search(r'\b(\d{2,5})x(\d{2,5})\b', line)
        return bool(line.startswith(('h264 (High)', 'h264 (Main)', 'h264 (Constrained Baseline)', 'h264 (Baseline)'))
                    and re.search(r'\byuv420p\b', line) and size
                    and int(size[1]) <= 1920 and int(size[2]) <= 1080)
    except Exception:
        return False


def probe_cuda_decode(ffmpeg, root):
    try:
        with tempfile.TemporaryDirectory(dir=root) as directory:
            source = Path(directory) / 'source.mp4'
            cpu, gpu = Path(directory) / 'cpu.mp4', Path(directory) / 'gpu.mp4'
            run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=0.5',
                 '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', str(source)])
            args = ['-v', 'error', '-i', str(source), '-an', '-c:v', 'libx264',
                    '-crf', '18', '-preset', 'fast', '-threads', '1', '-pix_fmt', 'yuv420p']
            run([ffmpeg, *args, str(cpu)])
            run([ffmpeg, '-hwaccel', 'cuda', *args, str(gpu)])
            return frame_hash(ffmpeg, cpu) == frame_hash(ffmpeg, gpu)
    except Exception:
        return False


class RateLimiter:
    """Process-wide pacing (all threads share one budget) so the boost never saturates the
    owner's home line. Pacing reads/writes backs the tunnel off through TCP flow control."""

    def __init__(self, megabits_per_second, key=None):
        self.default = max(0.0, float(megabits_per_second))
        self.bytes_per_second = self.default * 1_000_000 / 8
        self.key, self.checked = key, 0.0
        self.lock = threading.Lock()
        self.next_free = time.monotonic()

    def refresh(self):
        # Live limit without a restart: runtime/net-limits.json {"downMbit": n, "upMbit": n}.
        if not self.key or time.monotonic() - self.checked < 5:
            return
        self.checked = time.monotonic()
        mbit = self.default
        try:
            value = json.loads(NET_LIMITS_FILE.read_text()).get(self.key)
            if type(value) in (int, float) and 0 < value <= 1000:
                mbit = float(value)
        except (OSError, ValueError, AttributeError):
            pass
        self.bytes_per_second = mbit * 1_000_000 / 8

    def take(self, nbytes):
        self.refresh()
        if self.bytes_per_second <= 0:
            return
        with self.lock:
            now = time.monotonic()
            start = max(self.next_free, now)
            self.next_free = start + nbytes / self.bytes_per_second
        if start > now:
            time.sleep(start - now)


# Owner's limits (2026-10-03: 80 % of before): 120 Mbit/s server->PC (inputs); 43 Mbit/s PC->server
# (outputs) = 80 % of the ~54 Mbit/s the home upload actually reached - a full upload stalls the home line.
NET_LIMITS_FILE = Path(__file__).resolve().parent / 'runtime' / 'net-limits.json'
DOWNLOAD_LIMIT = RateLimiter(os.environ.get('VF_PC_MAX_DOWN_MBIT', '120'), 'downMbit')
UPLOAD_LIMIT = RateLimiter(os.environ.get('VF_PC_MAX_UP_MBIT', '43'), 'upMbit')


def low_res_simple_trim(argv, directory, contract=None, limit=240):
    """vf-custom:utility-trim-gpu-overflow-v1: single-input, unfiltered command (output size = source
    size) whose source has at most `limit` lines. Any probe problem answers False (GPU stays allowed)."""
    if argv.count('-i') != 1 or any(k in argv for k in ('-vf', '-filter:v', '-filter_complex', '-s')):
        return False
    if contract is not None:
        return 0 < contract.height <= limit
    try:
        from pc_nvenc_high import probe_media, video_stream
        source = video_stream(probe_media(Path(directory) / argv[argv.index('-i') + 1], run))
        return 0 < int(source.get('height') or 0) <= limit
    except Exception:
        return False


def log_job_shape(root, argv, eligible, nvenc, lane):
    """One line per job (no paths): which commands arrive, to see what a GPU could take."""
    def value(key):
        return argv[argv.index(key) + 1] if key in argv and argv.index(key) + 1 < len(argv) else '-'
    shape = {'t': round(time.time()), 'lane': lane, 'eligible': eligible, 'nvenc': nvenc,
             'out': Path(argv[-1]).suffix.lower(), 'cv': value('-c:v'), 'ca': value('-c:a'),
             'pix': value('-pix_fmt'), 'vf': '-vf' in argv or '-filter:v' in argv,
             'fc': '-filter_complex' in argv, 'af': '-af' in argv or '-filter:a' in argv,
             'bitrate': any(k in argv for k in ('-b:v', '-maxrate')), 'frames': value('-frames:v')}
    try:
        with open(Path(root) / 'job-shapes.jsonl', 'a', encoding='utf-8') as stream:
            stream.write(json.dumps(shape) + '\n')
    except OSError:
        pass


class Worker:
    def __init__(self, ffmpeg, token, root, probe_gpu=True, nvenc_enabled=None):
        self.ffmpeg, self.token = str(Path(ffmpeg).resolve()), token
        if not Path(self.ffmpeg).is_file() or len(token) < 8:
            raise ValueError('FFmpeg or authentication unavailable')
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.transfer_limits = TransferLimits(self.root / 'pc-transfer-limits.json')
        self.lock = threading.RLock()
        self.nvenc_sessions = NvencSessions()
        self.config = dict(DEFAULTS)
        self.jobs = {}
        self.busy = {'cpu': 0, 'gpu': 0}
        self.completed = {'cpu': 0, 'gpu': 0}
        # Finish times of the last few seconds: most jobs take < 1 s, so an instantaneous
        # count reads 0 although the PC is busy all the time (UI and scheduler credit).
        self.recent = {'cpu': [], 'gpu': []}
        self.gpu_started = 0
        self.gpu_cpu_recoveries = 0
        self.completed_nvenc = 0
        self.nvenc_started = 0
        self.nvenc_last_error = None
        self.nvenc_requalifying = False
        self.nvenc_recheck_due = 0
        self.nvenc_recheck_thread = None
        self.nvenc_requalifications = 0
        self.nvenc_failure_epoch = 0
        self.nvenc_fatal_error = None
        self.nvenc_utility_error = None
        self.cuda_scale_ready = False
        self.cuda_scale_error = None
        self.cuda_scale_started = 0
        self.cuda_scale_completed = 0
        self.cuda_scale_cpu_recoveries = 0
        self.last_cuda_scale = None
        self.cuda_scale_policy_path = self.root / 'cuda-scale-policy.json'
        self.decode_sources = {}
        self.failed = 0
        self.last_error = None
        # Last request that came through the tunnel (the server probes every 3 s and syncs every 15 s).
        # Local checks (watchdog, desktop status light) send X-VF-Local: 1 and do not count.
        self.last_remote = None
        self.ready = False
        try:
            run([self.ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:d=0.1',
                 '-c:v', 'libx264', '-f', 'null', '-'])
            self.ready = True
        except Exception:
            pass
        self.gpu_ready = self.ready and probe_gpu and probe_cuda_decode(self.ffmpeg, self.root)
        if nvenc_enabled is None:
            try:
                policy = json.loads((self.root / 'nvenc-high-policy.json').read_text())
                nvenc_enabled = policy.get('enabled') is True and policy.get('version') == NVENC_POLICY
            except (OSError, ValueError, AttributeError):
                nvenc_enabled = False
        self.nvenc_enabled = bool(nvenc_enabled)
        self.nvenc_ready = bool(self.nvenc_enabled and self.ready and probe_gpu
                                and probe_nvenc_high(self.ffmpeg, self.root, run))
        scale_probe = {}
        self.cuda_scale_ready = bool(self.nvenc_ready and self.gpu_ready and probe_gpu
                                     and probe_cuda_scale(self.ffmpeg, self.root, run, diagnostics=scale_probe))
        self.cuda_scale_error = scale_probe.get('error')
        # Scene detection runs in WSL with the server's exact packages; unavailable unless verified.
        # Worker count comes from the VidForge PC Boost settings (sceneWorkers), like CPU/GPU workers.
        self.scenes = SceneRunner(self.root, self.blob_path, probe=probe_gpu, background_probe=True,
                                  capacity=self.config['sceneWorkers'],
                                  transfer_limits=self.transfer_limits.get)
        self.stopping = threading.Event()
        self.reaper = threading.Thread(target=self.reap, daemon=True)
        self.reaper.start()

    def windowed_active(self, lane, window=5.0):
        """Running jobs plus jobs finished within `window` seconds, capped at capacity."""
        cutoff = time.monotonic() - window
        self.recent[lane] = [t for t in self.recent[lane] if t >= cutoff]
        return min(self.config[lane + 'Workers'], self.busy[lane] + len(self.recent[lane]))

    def health(self):
        with self.lock:
            # cpuBusy/gpuBusy stay instantaneous: the FFlow hook admits against them.
            return dict(service='vidforge-pc-ffmpeg', protocolVersion=2,
                        creditAssetsVersion=CREDIT_ASSETS_VERSION,
                        utilityTrimVersion=1,
                        transferLimits=self.transfer_limits.get(),
                        ready=self.ready, gpuReady=self.gpu_ready or self.nvenc_ready, cpuBusy=self.busy['cpu'],
                        cpuActive=self.windowed_active('cpu'), gpuActive=self.windowed_active('gpu'),
                        gpuAvailable=self.gpu_ready or self.nvenc_ready,
                        completedCpu=self.completed['cpu'], completedGpu=self.completed['gpu'], failed=self.failed,
                        gpuMode=NVENC_POLICY if self.nvenc_ready else 'cuda-decode-original-x264',
                        nvencReady=self.nvenc_ready, completedNvenc=self.completed_nvenc,
                        **self.nvenc_sessions.snapshot(),
                        gpuEncodingOnly=self.nvenc_enabled,
                        nvencLastError=self.nvenc_last_error,
                          nvencRecoveryVersion=1, nvencRequalifying=self.nvenc_requalifying,
                          nvencRequalifications=self.nvenc_requalifications,
                          nvencFatalError=self.nvenc_fatal_error,
                          nvencUtilityReady=self.nvenc_ready and self.nvenc_utility_error is None,
                          nvencUtilityLastError=self.nvenc_utility_error,
                          nvencIsolationVersion=1,
                        cudaScalePolicy=CUDA_SCALE_POLICY,
                        cudaScaleReady=self.cuda_scale_ready and self.nvenc_ready and self.gpu_ready,
                        cudaScaleEnabled=cuda_scale_enabled(self.cuda_scale_policy_path),
                        cudaScaleStarted=self.cuda_scale_started, cudaScaleCompleted=self.cuda_scale_completed,
                        cudaScaleCpuRecoveries=self.cuda_scale_cpu_recoveries,
                        cudaScaleLastError=self.cuda_scale_error, lastCudaScale=self.last_cuda_scale,
                        gpuCpuRecoveries=self.gpu_cpu_recoveries,
                        gpuBusy=self.busy['gpu'], cpuCapacity=self.config['cpuWorkers'],
                        gpuCapacity=self.config['gpuWorkers'] if self.gpu_ready or self.nvenc_ready else 0,
                        lastError=self.last_error,
                        remoteAge=None if self.last_remote is None else round(time.monotonic() - self.last_remote, 1),
                        quality='nvenc-high-qp14;sampled-native-quality-audio-mixed-join' if self.nvenc_ready else
                                'original-x264;cuda-decode-sampled-encoded-pixel-hash;nvenc-disabled', config=dict(self.config),
                        **self.scenes.health())

    def update_config(self, update):
        with self.lock:
            self.config = checked_config(update, self.config)
            self.scenes.set_workers(self.config['sceneWorkers'])
            return dict(self.config)

    def submit(self, payload):
        if not isinstance(payload, dict) or set(payload) - {'argv', 'files', 'timeout', 'gpuEligible', 'gpuPolicy'}:
            raise ValueError('Invalid render request')
        if payload.get('gpuPolicy') not in (None, NVENC_POLICY):
            raise ValueError('Unsupported GPU policy')
        argv, files = payload.get('argv'), payload.get('files')
        if not isinstance(files, dict):
            raise ValueError('Invalid files')
        positions = validate_argv(argv, files)
        timeout = payload.get('timeout', 180)
        if type(timeout) not in (int, float) or not 0 < timeout <= 600:
            raise ValueError('Invalid timeout')
        limits = self.transfer_limits.get()
        with self.lock:
            if not self.ready or not self.config['enabled']:
                raise RuntimeError('disabled')
            # Legacy gpuEligible never enables encoding; only VF's explicit versioned policy does.
            policy_requested = payload.get('gpuPolicy') == NVENC_POLICY
            use_nvenc = self.nvenc_ready and policy_requested and self.config['gpuWorkers'] > 0
            gpu_cmd = cuda_decode_argv(argv) if not policy_requested and self.gpu_ready and self.config['gpuWorkers'] > 0 else None
            lane = 'gpu' if (gpu_cmd or use_nvenc) and self.busy['gpu'] < self.config['gpuWorkers'] else 'cpu'
            if self.busy[lane] >= self.config[lane + 'Workers']:
                raise RuntimeError('busy')
            self.busy[lane] += 1
        directory = None
        try:
            directory = Path(tempfile.mkdtemp(prefix='render-', dir=self.root))
            total = 0
            sizes = []
            inline = any(not isinstance(encoded, dict) for encoded in files.values())
            for name, encoded in files.items():
                if isinstance(encoded, dict):
                    blob = self.blob_path(encoded.get('sha256'))
                    if not blob.is_file() or blob.stat().st_size != encoded.get('size'):
                        raise ValueError('Missing input blob')
                    size = blob.stat().st_size
                    sizes.append(size)
                    check_render_sizes(sizes, limits)
                    total += size
                    if inline and total > MAX_TOTAL:
                        raise ValueError('Input exceeds limit')
                    os.utime(blob)
                    try:
                        os.link(blob, directory / name)
                    except OSError:
                        shutil.copyfile(blob, directory / name)
                    continue
                max_inline = min(MAX_INPUT, limits['ffmpegMaxFileMb'] * MIB)
                if not isinstance(encoded, str) or len(encoded) > (max_inline * 4 // 3 + 4):
                    raise ValueError('Input exceeds limit')
                data = base64.b64decode(encoded, validate=True)
                sizes.append(len(data))
                check_render_sizes(sizes, limits)
                total += len(data)
                if not data or len(data) > MAX_INPUT or total > MAX_TOTAL:
                    raise ValueError('Input exceeds limit')
                (directory / name).write_bytes(data)
            encoding = False
            utility_contract = None
            scale_plan = None
            if lane == 'gpu' and use_nvenc:
                candidate = normalized_candidate(argv, directory, run)
                if candidate is None and self.nvenc_utility_error is None:
                    try:
                        utility = utility_trim_candidate(argv, directory, run)
                    except subprocess.SubprocessError:
                        utility = None
                    if utility is not None:
                        candidate = list(utility.argv)
                        utility_contract = utility.contract
                # vf-custom:utility-trim-gpu-overflow-v1 (2026-11-11): GPU slots are first-come, and most
                # <=240p trims are NVENC-eligible, so they filled the GPU and 1080p trims fell back to x264
                # (12-20 vs 2.0-2.3 core-s). <=240p cost x264 and NVENC about the same CPU (0.4-1.3 vs
                # 0.6-0.9 core-s, NVENC files ~2x larger): keep them on x264 while a CPU slot is free.
                if candidate is not None and low_res_simple_trim(argv, directory, utility_contract):
                    with self.lock:
                        if self.busy['cpu'] < self.config['cpuWorkers']:
                            self.busy['gpu'] -= 1
                            self.busy['cpu'] += 1
                            lane = 'cpu'
                            candidate = None
                            utility_contract = None
                if candidate is not None:
                    gpu_cmd = candidate
                    encoding = True
                    if (utility_contract is None and self.cuda_scale_ready and self.gpu_ready
                            and cuda_scale_enabled(self.cuda_scale_policy_path)):
                        scale_plan = cuda_scale_candidate(argv, candidate, directory,
                            probe=lambda path: probe_media(path, run))
                        if scale_plan is not None:
                            gpu_cmd = list(scale_plan.argv)
                    # Utility trims qualify CPU decode + NVENC with their original clock.
                    if scale_plan is None and utility_contract is None and cuda_decode_argv(argv) and self.gpu_ready:
                        source = directory / argv[argv.index('-i') + 1]
                        if h264_decode_source(self.ffmpeg, source):
                            index = gpu_cmd.index('-i')
                            gpu_cmd = gpu_cmd[:index] + ['-hwaccel', 'cuda'] + gpu_cmd[index:]
            if lane == 'gpu' and not encoding:
                name = argv[argv.index('-i') + 1]
                reference = files[name]
                digest = reference.get('sha256') if isinstance(reference, dict) else None
                with self.lock:
                    supported = self.decode_sources.get(digest) if digest else None
                if supported is None:
                    supported = h264_decode_source(self.ffmpeg, directory / name)
                    if digest:
                        with self.lock:
                            if len(self.decode_sources) >= 512:
                                self.decode_sources.clear()
                            self.decode_sources[digest] = supported
                supported = supported and gpu_cmd is not None
                if not supported:
                    with self.lock:
                        if self.busy['cpu'] >= self.config['cpuWorkers']:
                            raise RuntimeError('busy')
                        self.busy['gpu'] -= 1
                        self.busy['cpu'] += 1
                        lane = 'cpu'
            log_job_shape(self.root, argv, gpu_cmd is not None, encoding, lane)
            # Compare native encoded frames, not raw source frames: both paths use x264.
            verify = False
            mixed_verify = False
            if lane == 'gpu':
                with self.lock:
                    if encoding:
                        self.nvenc_started += 1
                        verify = self.nvenc_started <= 3 or self.nvenc_started % 20 == 0
                        mixed_verify = self.nvenc_started <= 3
                        if scale_plan is not None:
                            self.cuda_scale_started += 1
                            verify = verify or self.cuda_scale_started <= 3 or self.cuda_scale_started % 20 == 0
                            mixed_verify = mixed_verify or self.cuda_scale_started <= 3
                    else:
                        self.gpu_started += 1
                        verify = self.gpu_started <= 3 or self.gpu_started % 20 == 0
            chosen = gpu_cmd if lane == 'gpu' else argv
            command = self.file_command(chosen, directory, files, cuda_scale_plan=scale_plan)
            job = dict(id=uuid.uuid4().hex, state='running', lane=lane, directory=directory,
                       transferLimits=dict(limits),
                       touched=time.monotonic(), process=None, cancel=threading.Event(),
                       command=command, cpu_command=self.file_command(argv, directory, files),
                       output=directory / argv[-1], timeout=float(timeout), original_argv=argv,
                       file_names=list(files), verify=verify, nvenc=encoding, mixed_verify=mixed_verify)
            if utility_contract is not None:
                job['utility_contract'] = utility_contract
            if scale_plan is not None:
                job['cuda_scale_plan'] = scale_plan
                job['cuda_scale_started_at'] = time.monotonic()
            with self.lock:
                self.jobs[job['id']] = job
            job['thread'] = threading.Thread(target=self.render, args=(job,), daemon=True)
            job['thread'].start()
            return {'id': job['id'], 'state': 'running', 'lane': lane}
        except BaseException:
            with self.lock:
                self.busy[lane] -= 1
            if directory:
                shutil.rmtree(directory, ignore_errors=True)
            raise

    def file_command(self, argv, directory, files, *, cuda_scale_plan=None):
        if cuda_scale_plan is not None:
            if (not isinstance(cuda_scale_plan, CudaScaleCandidate)
                    or tuple(argv) != cuda_scale_plan.argv or set(files) != {'@0.mp4'}):
                raise ValueError('Invalid internal CUDA scale plan')
            # Validate native file/filter materialization before applying the owned transform.
            approved = list(argv)
            approved[approved.index('-vf') + 1] = CUDA_SCALE_NATIVE_FILTER
            argv = materialize_credit_argv(approved, directory, files)
            argv[argv.index('-vf') + 1] = CUDA_SCALE_FILTER
        else:
            argv = materialize_credit_argv(argv, directory, files)
        command = [self.ffmpeg, '-nostdin']
        for arg in argv:
            if arg == '-i':
                command.extend(['-protocol_whitelist', 'file,pipe', '-format_whitelist',
                                'mov,matroska,webm,image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,mp3,wav,aac,flac'])
            command.append(str(directory / arg) if arg in files or arg == argv[-1] else arg)
        return command

    def blob_path(self, digest):
        if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('Invalid blob digest')
        return self.root / 'blobs' / digest

    def store_blob(self, digest, length, reader):
        target = self.blob_path(digest)
        # Generic streamed blobs can serve either render or scene jobs; admission checks their own cap.
        limits = self.transfer_limits.get()
        maximum = max(limits['ffmpegMaxFileMb'], limits['sceneMaxFileMb']) * MIB
        if type(length) is not int or not 0 < length <= maximum:
            raise ValueError('Blob size')
        target.parent.mkdir(exist_ok=True)
        if target.is_file() and target.stat().st_size == length:
            os.utime(target)
            return {'present': True}
        hasher, remaining = hashlib.sha256(), length
        descriptor, temporary = tempfile.mkstemp(prefix='.blob-', dir=target.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                while remaining:
                    # 256 KiB steps keep pacing smooth; the limiter blocks before the next read.
                    chunk = reader(min(256 * 1024, remaining))
                    if not chunk or len(chunk) > remaining:
                        raise ValueError('Truncated blob')
                    DOWNLOAD_LIMIT.take(len(chunk))
                    remaining -= len(chunk)
                    hasher.update(chunk)
                    stream.write(chunk)
            if hasher.hexdigest() != digest:
                raise ValueError('Blob digest mismatch')
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return {'present': True}

    def prune_blobs(self, keep_seconds=1800, max_bytes=8 * 1024 ** 3):
        directory = self.root / 'blobs'
        if not directory.is_dir():
            return
        # Partial uploads cut off by a worker restart never finish; drop them after an hour.
        for partial in directory.glob('.blob-*'):
            try:
                if time.time() - partial.stat().st_mtime > 3600:
                    partial.unlink(missing_ok=True)
            except OSError:
                pass
        blobs = sorted((p for p in directory.iterdir() if p.is_file() and not p.name.startswith('.')),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        # Never let the cache push the drive below 3 GB free (C: filled up on 2026-10-02).
        held = sum(blob.stat().st_size for blob in blobs)
        max_bytes = max(0, min(max_bytes, held + shutil.disk_usage(directory).free - 3 * 1024 ** 3))
        total, now = 0, time.time()
        for blob in blobs:
            total += blob.stat().st_size
            if now - blob.stat().st_mtime > keep_seconds or total > max_bytes:
                blob.unlink(missing_ok=True)

    def sweep_render_dirs(self, max_age=600):
        # Setup between mkdtemp and job registration takes seconds; 10 min idle means orphaned.
        with self.lock:
            live = {Path(job['directory']).name for job in self.jobs.values()}
        return remove_stale_dirs(list(self.root.glob('render-*')), live, max_age)

    def run_job(self, job, command, timeout=60):
        deadline = min(job['deadline'], time.monotonic() + timeout)
        with self.nvenc_sessions.session(command, job, deadline):
            return self._run_job(job, command, max(0, deadline - time.monotonic()))

    def _run_job(self, job, command, timeout=60):
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, creationflags=CREATE_FLAGS)
        job['process'] = process
        deadline = min(job['deadline'], time.monotonic() + timeout)
        try:
            while True:
                if job['cancel'].is_set() or time.monotonic() > deadline:
                    raise RuntimeError('cancelled_or_timeout')
                try:
                    stdout, stderr = process.communicate(timeout=.1)
                    if process.returncode:
                        raise RuntimeError('validation_failed')
                    return subprocess.CompletedProcess(command, 0, stdout, stderr)
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def execute_render(self, job, command):
        started = time.monotonic()
        retry_until = min(started + 15, started + max(0, (job['deadline'] - started) / 2))
        attempts = 0
        while True:
            try:
                with self.nvenc_sessions.session(command, job):
                    log = job['directory'] / 'stderr.log'
                    offset = log.stat().st_size if log.exists() else 0
                    return self._execute_render(job, command)
            except RuntimeError as exc:
                if str(exc) != 'ffmpeg_failed' or 'h264_nvenc' not in command:
                    raise
                # Other apps/camera workers can hold driver-wide sessions. Retry only an
                # exact empty encoder-start failure, never a partially encoded artifact.
                tail = ''
                if log.exists():
                    with log.open('rb') as stream:
                        stream.seek(max(offset, log.stat().st_size - 8192))
                        tail = stream.read(8192).decode('utf-8', 'replace')
                empty = not job['output'].exists() or job['output'].stat().st_size <= 32
                if not (empty and 'OpenEncodeSessionEx failed: incompatible client key (21)' in tail
                        and 'Nothing was written into output file' in tail):
                    raise
                attempts += 1
                job['nvencSessionRetries'] = attempts
                if job['cancel'].is_set():
                    raise RuntimeError('cancelled') from exc
                if attempts >= 12 or time.monotonic() >= retry_until:
                    raise RuntimeError('nvenc_session_busy') from exc
                job['cancel'].wait(min(.25 * attempts, 2, max(0, retry_until - time.monotonic())))

    def _execute_render(self, job, command):
        process = None
        try:
            with (job['directory'] / 'stderr.log').open('ab') as stderr:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=stderr, creationflags=CREATE_FLAGS)
                job['process'] = process
                while process.poll() is None:
                    if job['cancel'].is_set() or time.monotonic() > job['deadline']:
                        process.kill()
                        process.wait(timeout=5)
                        raise RuntimeError('cancelled' if job['cancel'].is_set() else 'timeout')
                    output = job['output']
                    if output.exists() and output.stat().st_size > MAX_OUTPUT:
                        raise RuntimeError('output_too_large')
                    time.sleep(.05)
                if process.returncode:
                    raise RuntimeError('ffmpeg_failed')
                output = job['output']
                if not output.is_file() or not 32 < output.stat().st_size <= MAX_OUTPUT:
                    raise RuntimeError('invalid_output')
        finally:
            if process and process.poll() is None:
                process.kill()
                process.wait(timeout=5)

    def request_nvenc_recheck(self, reason):
        if reason != 'ffmpeg_failed':
            return False
        with self.lock:
            if (not self.nvenc_enabled or self.nvenc_requalifying or self.nvenc_fatal_error
                    or self.stopping.is_set() or not self.config['enabled'] or self.config['gpuWorkers'] <= 0
                    or self.nvenc_last_error != reason
                    or time.monotonic() < self.nvenc_recheck_due):
                return False
            self.nvenc_requalifying = True
            self.nvenc_recheck_due = time.monotonic() + 60
            epoch = self.nvenc_failure_epoch

        def check():
            reserved = False
            try:
                if self.stopping.wait(5):
                    return
                with self.lock:
                    if (not self.config['enabled'] or self.config['gpuWorkers'] <= 0
                            or self.busy['gpu'] >= self.config['gpuWorkers']):
                        return
                    self.busy['gpu'] += 1
                    reserved = True
                probe_job={'cancel':self.stopping,'deadline':time.monotonic()+90,'process':None}
                probe_runner=lambda command,timeout=30:self.run_job(probe_job,command,timeout)
                passed = probe_nvenc_high(self.ffmpeg, self.root, probe_runner)
                with self.lock:
                    if (passed and not self.stopping.is_set() and self.config['enabled']
                            and self.config['gpuWorkers'] > 0
                            and not self.nvenc_fatal_error
                            and self.nvenc_failure_epoch == epoch and self.nvenc_last_error == reason):
                        self.nvenc_ready = True
                        self.nvenc_last_error = None
                        self.nvenc_requalifications += 1
            finally:
                with self.lock:
                    if reserved:
                        self.busy['gpu'] -= 1
                    self.nvenc_requalifying = False

        with self.lock:
            if self.stopping.is_set():
                self.nvenc_requalifying=False
                return False
            self.nvenc_recheck_thread = threading.Thread(target=check, daemon=True)
            self.nvenc_recheck_thread.start()
        return True

    def record_render_failure(self, job, error, gpu_recovery=False):
        identifier = job.get('id', '')
        if not re.fullmatch(r'[a-f0-9]{32}', identifier):
            return
        try:
            directory = self.root / ('gpu-recoveries' if gpu_recovery else 'failures')
            directory.mkdir(exist_ok=True)
            log = job['directory'] / 'stderr.log'
            tail = ''
            if log.is_file():
                with log.open('rb') as stream:
                    stream.seek(max(0, log.stat().st_size - 8192))
                    tail = stream.read(8192).decode('utf-8', 'replace')
            record = {'at': time.time(), 'id': identifier, 'error': str(error),
                      'lane': job['lane'], 'nvenc': job.get('nvenc', False),
                      'cudaScale': 'cuda_scale_plan' in job,
                      'argv': job.get('original_argv'), 'stderrTail': tail,
                      'cpuRecoveryPending': gpu_recovery}
            (directory / (identifier + '.json')).write_text(json.dumps(record), encoding='utf-8')
        except (OSError, KeyError, TypeError, ValueError):
            pass

    def render(self, job):
        job['deadline'] = time.monotonic() + job['timeout']
        runner = lambda command, timeout=60: self.run_job(job, command, timeout)
        recovered = False
        try:
            output = job['output']
            try:
                self.execute_render(job, job['command'])
                runner([self.ffmpeg, '-v', 'error', '-xerror', '-threads', '1', '-i', str(output), '-map', '0', '-f', 'null', '-'])
                if job.get('nvenc'):
                    if 'utility_contract' in job:
                        validate_utility_trim_output(output, runner, job['utility_contract'])
                    else:
                        media = validate_high_output(output, runner)
                        if 'cuda_scale_plan' in job:
                            validate_cuda_scale_output(media, job['cuda_scale_plan'])
                if job['lane'] == 'gpu' and job.get('verify', True):
                    reference = job['directory'] / 'cpu-reference.mp4'
                    runner(job['cpu_command'][:-1] + [str(reference)], timeout=120)
                    if job.get('nvenc'):
                        contract_options = ({'utility_contract': job['utility_contract']}
                                            if 'utility_contract' in job else {})
                        job['qualitySsim'] = verify_pair(self.ffmpeg, reference, output, runner,
                                                       mixed=job.get('mixed_verify', False), **contract_options)
                    elif frame_hash(self.ffmpeg, reference, runner) != frame_hash(self.ffmpeg, output, runner):
                        raise RuntimeError('gpu_pixel_hash_mismatch')
                    reference.unlink(missing_ok=True)
            except RuntimeError as exc:
                if (job['lane'] != 'gpu' or job['cancel'].is_set()
                        or str(exc) in ('cancelled', 'timeout', 'cancelled_or_timeout', 'output_too_large')
                        or time.monotonic() >= job['deadline']):
                    raise
                with self.lock:
                    if job.get('nvenc'):
                        utility_failure = ('utility_contract' in job
                                           and str(exc) == 'nvenc_utility_contract_mismatch')
                        scale_failure = ('cuda_scale_plan' in job and str(exc) in
                                         ('cuda_scale_output_mismatch', 'nvenc_reference_quality_mismatch'))
                        isolated = utility_failure or scale_failure or str(exc) == 'nvenc_session_busy'
                        if 'cuda_scale_plan' in job:
                            self.cuda_scale_ready = False
                            self.cuda_scale_error = str(exc)
                            self.cuda_scale_cpu_recoveries += 1
                        if utility_failure:
                            # Reject this output and quarantine this recipe, not unrelated NVENC work.
                            self.nvenc_utility_error = str(exc)
                        elif not isolated:
                            self.nvenc_failure_epoch += 1
                            if str(exc)!='ffmpeg_failed':
                                self.nvenc_fatal_error=str(exc)
                            self.nvenc_ready = False
                            self.nvenc_last_error = str(exc)
                    else:
                        self.gpu_ready = False
                    self.gpu_cpu_recoveries += 1
                self.record_render_failure(job, exc, gpu_recovery=True)
                output.unlink(missing_ok=True)
                try:
                    self.execute_render(job, job['cpu_command'])
                finally:
                    if job.get('nvenc') and not isolated:
                        self.request_nvenc_recheck(str(exc))
                runner([self.ffmpeg, '-v', 'error', '-xerror', '-threads', '1', '-i', str(output), '-map', '0', '-f', 'null', '-'])
                recovered = True
            if job['cancel'].is_set():
                raise RuntimeError('cancelled')
            with output.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            with self.lock:
                job['sha256'] = digest
                job['state'] = 'done'
                job['gpuRecoveredOnCpu'] = recovered
                self.completed['cpu' if recovered else job['lane']] += 1
                if job.get('nvenc') and not recovered:
                    self.completed_nvenc += 1
                    if 'cuda_scale_plan' in job:
                        self.cuda_scale_completed += 1
                        self.last_cuda_scale = {'id': job['id'], 'sha256': digest,
                            'frames': job['cuda_scale_plan'].frames, 'policy': CUDA_SCALE_POLICY,
                            'atUtcEpoch': time.time(), 'qualitySsim': job.get('qualitySsim'),
                            'elapsedMs': round((time.monotonic() - job['cuda_scale_started_at']) * 1000)}
        except Exception as exc:
            self.record_render_failure(job, exc)
            with self.lock:
                job['state'] = 'failed'
                self.failed += 1
                job['error'] = str(exc) if isinstance(exc, RuntimeError) else 'execution_failed'
                self.last_error = job['error']
        finally:
            with self.lock:
                self.busy[job['lane']] -= 1
                job['finished'] = time.monotonic()
                self.recent[job['lane']].append(job['finished'])

    def status(self, identifier, metadata=False):
        with self.lock:
            job = self.jobs.get(identifier)
            if not job:
                raise KeyError(identifier)
            job['touched'] = time.monotonic()
            result = {key: job[key] for key in ('id', 'state', 'lane')}
            if job['state'] == 'done':
                output = job['output']
                result.update(size=output.stat().st_size, suffix=output.suffix, sha256=job['sha256'])
                result['gpuPolicy'] = NVENC_POLICY if job.get('nvenc') and not job.get('gpuRecoveredOnCpu') else None
                if 'cuda_scale_plan' in job and not job.get('gpuRecoveredOnCpu'):
                    result['cudaScalePolicy'] = CUDA_SCALE_POLICY
            elif job['state'] == 'failed':
                result['error'] = job['error']
        if result['state'] == 'done' and not metadata:
            result['data'] = base64.b64encode(output.read_bytes()).decode('ascii')
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

    def reap(self):
        ticks = 0
        while not self.stopping.wait(1):
            ticks += 1
            if not self.nvenc_ready and self.nvenc_last_error=='ffmpeg_failed':
                self.request_nvenc_recheck('ffmpeg_failed')
            if ticks % 60 == 0:
                try:
                    self.prune_blobs()
                except OSError:
                    pass
                try:
                    self.sweep_render_dirs()
                    self.scenes.sweep()
                except Exception:
                    pass
            with self.lock:
                for identifier, job in list(self.jobs.items()):
                    if time.monotonic() - job['touched'] > 20:
                        self.cancel(identifier)
            self.scenes.reap()

    def close(self):
        self.stopping.set()
        with self.lock:
            probe_thread=self.nvenc_recheck_thread
            jobs = list(self.jobs.values())
            for job in jobs:
                job['cancel'].set()
        for job in jobs:
            job['thread'].join(timeout=8)
        if probe_thread and probe_thread is not threading.current_thread():
            probe_thread.join(timeout=8)
        self.reaper.join(timeout=2)
        for job in jobs:
            shutil.rmtree(job['directory'], ignore_errors=True)
        self.scenes.close()



class _WorkerHTTPServer(ThreadingHTTPServer):
    # vf-custom:home-listen-backlog-v1: socketserver default is 5; a full queue refuses connections,
    # which the server sees through the SSH tunnel as RemoteDisconnected (job declined, Home 5 s offline).
    request_queue_size = 128


def make_server(worker, port=18191):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def dispatch(self):
            try:
                auth = self.headers.get('Authorization', '')
                if not hmac.compare_digest(auth, 'Bearer ' + worker.token):
                    return self.respond(401, {'error': 'unauthorized'})
                if self.headers.get('X-VF-Local') != '1':
                    worker.last_remote = time.monotonic()
                if self.path.startswith(('/motion/', '/map/')):
                    graphics = getattr(worker, 'graphics', None)
                    if graphics is None: return self.respond(503, {'error': 'graphics_offline'})
                    return graphics.dispatch(self, DOWNLOAD_LIMIT, UPLOAD_LIMIT)
                data = None
                if self.command in ('POST', 'PUT') and not self.path.startswith('/blobs/'):
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= (16384 if self.path in ('/config', '/config/validate', '/transfer-limits') else MAX_BODY):
                        return self.respond(413, {'error': 'body_limit'})
                    self.connection.settimeout(15)
                    data = json.loads(self.rfile.read(length))
                blob = re.fullmatch(r'/blobs/([a-f0-9]{64})', self.path)
                if blob and self.command == 'GET':
                    path = worker.blob_path(blob[1])
                    return self.respond(200, {'present': path.is_file()})
                if blob and self.command == 'PUT':
                    return self.respond(200, worker.store_blob(blob[1], int(self.headers.get('Content-Length', '0')), self.rfile.read))
                if self.path == '/health' and self.command == 'GET':
                    result = worker.health()
                elif self.path == '/transfer-limits' and self.command == 'GET':
                    result = {'limits': worker.transfer_limits.get()}
                elif self.path == '/transfer-limits' and self.command in ('PUT', 'POST'):
                    result = {'limits': worker.transfer_limits.set(data)}
                elif self.path == '/config' and self.command == 'GET':
                    with worker.lock:
                        result = dict(worker.config)
                elif self.path == '/config' and self.command == 'PUT':
                    result = worker.update_config(data)
                elif self.path == '/config/validate' and self.command == 'POST':
                    with worker.lock:
                        result = {'valid': True, 'proposed': checked_config(data, worker.config)}
                elif self.path == '/renders' and self.command == 'POST':
                    result = worker.submit(data)
                elif self.path == '/scenes' and self.command == 'POST':
                    result = worker.scenes.submit(data)
                elif re.fullmatch(r'/scenes/[a-f0-9]{32}(?:\?wait=\d{1,2})?', self.path):
                    path, _, query = self.path.partition('?')
                    identifier = path.rsplit('/', 1)[1]
                    if self.command == 'GET':
                        result = worker.scenes.status(identifier, wait=float(query[5:]) if query else 0.0)
                    elif self.command == 'DELETE':
                        result = worker.scenes.cancel(identifier)
                    else:
                        return self.respond(405, {'error': 'method'})
                elif re.fullmatch(r'/renders/[a-f0-9]{32}/output', self.path) and self.command == 'GET':
                    identifier = self.path.split('/')[2]
                    result = worker.status(identifier, metadata=True)
                    if result['state'] != 'done':
                        return self.respond(409, {'error': 'not_ready'})
                    with worker.lock:
                        output = worker.jobs[identifier]['output']
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(result['size']))
                    self.end_headers()
                    with output.open('rb') as stream:
                        while data := stream.read(256 * 1024):
                            UPLOAD_LIMIT.take(len(data))
                            with worker.lock:
                                worker.jobs[identifier]['touched'] = time.monotonic()
                            self.wfile.write(data)
                    return
                elif re.fullmatch(r'/renders/[a-f0-9]{32}(?:\?metadata=1)?', self.path):
                    if self.command == 'GET':
                        result = worker.status(self.path.split('?')[0].rsplit('/', 1)[1], metadata='?' in self.path)
                    elif self.command == 'DELETE':
                        result = worker.cancel(self.path.rsplit('/', 1)[1])
                    else:
                        return self.respond(405, {'error': 'method'})
                else:
                    return self.respond(404, {'error': 'not_found'})
                self.respond(200, result)
            except (ValueError, TypeError):
                self.respond(400, {'error': 'invalid_request'})
            except KeyError:
                self.respond(404, {'error': 'not_found'})
            except RuntimeError:
                self.respond(503, {'error': 'unavailable'})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.respond(500, {'error': 'internal_error'})

        def respond(self, code, data):
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_PUT = do_POST = do_DELETE = dispatch

    return _WorkerHTTPServer(('127.0.0.1', port), Handler)


def initial_config(path):
    return None if path is None else checked_config(json.loads(Path(path).read_text(encoding='utf-8')))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--token-file', type=Path, default=Path(__file__).resolve().parent.parent / 'private' / 'pc-boost-token.txt')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent / 'runtime')
    parser.add_argument('--port', type=int, default=18191)
    parser.add_argument('--initial-config-file', type=Path)
    args = parser.parse_args()
    config = initial_config(args.initial_config_file)
    # Token creation is owned by the parent; startup never changes an existing credential.
    worker = Worker(args.ffmpeg, args.token_file.read_text().strip(), args.root)
    if config is not None:
        worker.update_config(config)
    graphics_root = os.environ.get('VF_GRAPHICS_ROOT')
    if graphics_root:
        sys.path.insert(0, str(Path(graphics_root).resolve() / 'shared-graphics-worker'))
        from graphics_bootstrap import attach_graphics
        attach_graphics(worker, graphics_root)
    server = make_server(worker, args.port)
    print(json.dumps(worker.health()), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            if getattr(worker, 'graphics', None): worker.graphics.close()
        finally:
            worker.close()


if __name__ == '__main__':
    main()
