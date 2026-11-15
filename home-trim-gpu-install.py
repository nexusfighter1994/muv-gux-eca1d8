"""Install the Home trim GPU patch (2026-11-11) into a Home ffmpeg worker directory.

1. pc_ffmpeg_worker.py - vf-custom:utility-trim-gpu-overflow-v1
   GPU slots are taken first-come. Most <=240p trims are NVENC-eligible, so they filled the 10 GPU slots
   and 1080p trims fell back to x264. <=240p simple trims (one input, no filter: output size = source
   size) now stay on x264 while a CPU slot is free and use the GPU only as overflow; >=360p keeps GPU first.
2. pc_nvenc_high.py - vf-custom:utility-trim-float-noise-v1
   Trim times sometimes arrive as binary float noise (-t 12.200000000000003, 14 % of trims). The utility
   NVENC contract only accepted up to 9 decimals. Such values are rounded to 9 decimals for the contract;
   the argv keeps the caller's string (ffmpeg reads both the same).

A/B on the Home PC under load (2026-11-11, 12.2 s trims, CPU core-seconds x264 / NVENC):
<=240p 0.4-1.3 / 0.6-0.9, 360p 3.8-5.3 / 1.2-1.4, 1080p 12.0-19.7 / 2.0-2.3.

Usage: python home-trim-gpu-install.py <worker dir> [<worker dir> ...]
Idempotent; writes *.before-trim-gpu-20261111 backups once. Takes effect after the worker restarts.
"""
import shutil
import sys
from pathlib import Path

SUFFIX = '.before-trim-gpu-20261111'
NVENC_MARK = 'vf-custom:utility-trim-float-noise-v1'
WORKER_MARK = 'vf-custom:utility-trim-gpu-overflow-v1'

NVENC_OLD = """        for key in ('-ss', '-t', '-crf'):
            if not re.fullmatch(r'[0-9]{1,7}(?:\\.[0-9]{1,9})?', options.get(key, '')):
                return None
        start, duration, crf = (Fraction(options[key]) for key in ('-ss', '-t', '-crf'))
"""
NVENC_NEW = """        values = [_utility_number(options.get(key, '')) for key in ('-ss', '-t', '-crf')]
        if any(value is None for value in values):
            return None
        start, duration, crf = values
"""
NVENC_HELPER_ANCHOR = 'def utility_trim_candidate(argv, directory, runner):\n'
NVENC_HELPER = '''def _utility_number(text):
    """Plain decimal; binary float noise (12.200000000000003) is rounded to 9 decimals.

    vf-custom:utility-trim-float-noise-v1 (2026-11-11): 14 % of trims carry float noise and missed this
    contract. The argv keeps the caller's string (ffmpeg reads both the same); only the contract uses the
    rounded value, which is within 5e-10 s of it (validation allows one frame).
    """
    if not isinstance(text, str):
        return None
    if re.fullmatch(r'[0-9]{1,7}(?:\\.[0-9]{1,9})?', text):
        return Fraction(text)
    if re.fullmatch(r'[0-9]{1,7}\\.[0-9]{10,17}', text):
        return Fraction(round(Fraction(text) * 10 ** 9), 10 ** 9)
    return None


'''

WORKER_HELPER_ANCHOR = 'def log_job_shape(root, argv, eligible, nvenc, lane):\n'
WORKER_HELPER = '''def low_res_simple_trim(argv, directory, contract=None, limit=240):
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


'''
WORKER_OLD = """                    if utility is not None:
                        candidate = list(utility.argv)
                        utility_contract = utility.contract
                if candidate is not None:
"""
WORKER_NEW = """                    if utility is not None:
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
"""


def patch(path, mark, edits):
    raw = path.read_bytes()
    text = raw.decode('utf-8').replace('\r\n', '\n')
    if mark in text:
        return 'already'
    for old, new in edits:
        if text.count(old) != 1:
            raise SystemExit(f'{path}: anchor found {text.count(old)} times, expected 1')
        text = text.replace(old, new)
    compile(text, str(path), 'exec')
    backup = path.with_name(path.name + SUFFIX)
    if not backup.exists():
        shutil.copy2(path, backup)
    if b'\r\n' in raw:
        text = text.replace('\n', '\r\n')
    path.write_bytes(text.encode('utf-8'))
    return 'patched'


def main(dirs):
    for d in map(Path, dirs):
        print(d / 'pc_nvenc_high.py', patch(d / 'pc_nvenc_high.py', NVENC_MARK,
                                             [(NVENC_OLD, NVENC_NEW), (NVENC_HELPER_ANCHOR, NVENC_HELPER + NVENC_HELPER_ANCHOR)]))
        print(d / 'pc_ffmpeg_worker.py', patch(d / 'pc_ffmpeg_worker.py', WORKER_MARK,
                                               [(WORKER_OLD, WORKER_NEW), (WORKER_HELPER_ANCHOR, WORKER_HELPER + WORKER_HELPER_ANCHOR)]))


if __name__ == '__main__':
    main(sys.argv[1:])
