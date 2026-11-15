"""Explicit regular-High NVENC contract; never the legacy lossless substitution."""
import json
import os
from pathlib import Path
import re
import shutil
from dataclasses import dataclass
from fractions import Fraction

POLICY = 'nvenc-high-qp14-v1'

# Utility intermediates have their own clock. Never relax the final-chunk policy.
UTILITY_TRIM_POLICY = 'nvenc-utility-trim-qp14-v1'
_UTILITY_RATES = {'24/1': 12288, '25/1': 12800, '30/1': 15360, '30000/1001': 30000}
_UTILITY_FLAGS = {'-y', '-hide_banner', '-nostdin', '-nostats', '-an', '-sn', '-dn'}
_UTILITY_OPTIONS = {'-ss', '-t', '-i', '-c:v', '-crf', '-preset', '-c:a', '-b:a',
                    '-ar', '-ac', '-pix_fmt', '-r', '-video_track_timescale', '-profile:v',
                    '-threads', '-movflags', '-map', '-v', '-loglevel', '-progress', '-metadata',
                    '-filter_threads', '-filter_complex_threads'}
_NATIVE_TRIM_GLOBALS = ['-loglevel', 'error', '-y', '-nostats', '-progress', 'pipe:1',
                        '-filter_threads', '1', '-filter_complex_threads', '1']


@dataclass(frozen=True)
class UtilityTrimContract:
    output_path: Path
    fps: str
    time_base: str
    width: int
    height: int
    duration: Fraction
    display: tuple
    audio: tuple


@dataclass(frozen=True)
class UtilityTrimCandidate:
    argv: tuple
    contract: UtilityTrimContract


def _utility_options(argv):
    if (not isinstance(argv, list) or not 3 <= len(argv) <= 96
            or any(not isinstance(arg, str) for arg in argv) or argv[-1] != 'output.mp4'):
        return None
    options, maps, index, input_index = {}, [], 0, None
    while index < len(argv) - 1:
        key = argv[index]
        if key in _UTILITY_FLAGS:
            value, step = True, 1
        elif key in _UTILITY_OPTIONS and index + 1 < len(argv) - 1:
            value, step = argv[index + 1], 2
        else:
            return None
        if key == '-map':
            maps.append(value)
        elif key in options:
            return None
        else:
            options[key] = value
        if key == '-i':
            input_index = index
        index += step
    if (options.get('-i') != '@0.mp4' or options.get('-c:v') != 'libx264'
            or '-t' not in options or '-ss' not in options
            or options.get('-pix_fmt', 'yuv420p') != 'yuv420p'
            or options.get('-profile:v', 'high') != 'high'
            or maps not in ([], ['0:v:0', '0:a?'], ['0:v:0', '0:a:0?'], ['0:v:0'])):
        return None
    native_globals = argv[:len(_NATIVE_TRIM_GLOBALS)] == _NATIVE_TRIM_GLOBALS
    thread_options = {'-filter_threads', '-filter_complex_threads'}
    if thread_options.intersection(options) and not native_globals:
        return None
    # Keep the exact native global controls; encoder/muxer options remain output-only.
    allowed_before_input = _UTILITY_FLAGS | {'-ss', '-v', '-loglevel'}
    if native_globals:
        allowed_before_input |= thread_options | {'-progress'}
    if any(arg not in allowed_before_input
           for arg in argv[:input_index] if arg.startswith('-')):
        return None
    if not options.get('-an') and options.get('-c:a') not in ('aac', 'copy'):
        return None
    if options.get('-c:a') == 'copy' and any(key in options for key in ('-b:a', '-ar', '-ac')):
        return None
    if options.get('-movflags', '+faststart') != '+faststart':
        return None
    if options.get('-metadata', 'encoder=fflow-api') != 'encoder=fflow-api':
        return None
    if options.get('-progress', 'pipe:1') != 'pipe:1':
        return None
    if options.get('-preset', 'fast') not in ('ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'):
        return None
    for key, pattern in (('-b:a', r'[1-9][0-9]{1,2}k'), ('-ar', r'(?:44100|48000)'),
                         ('-ac', r'[12]'), ('-threads', r'(?:[1-9]|1[0-6])'),
                         ('-v', r'(?:error|warning|info)'), ('-loglevel', r'(?:error|warning|info)')):
        if key in options and not re.fullmatch(pattern, options[key]):
            return None
    return options


def _utility_number(text):
    """Plain decimal; binary float noise (12.200000000000003) is rounded to 9 decimals.

    vf-custom:utility-trim-float-noise-v1 (2026-11-11): 14 % of trims carry float noise and missed this
    contract. The argv keeps the caller's string (ffmpeg reads both the same); only the contract uses the
    rounded value, which is within 5e-10 s of it (validation allows one frame).
    """
    if not isinstance(text, str):
        return None
    if re.fullmatch(r'[0-9]{1,7}(?:\.[0-9]{1,9})?', text):
        return Fraction(text)
    if re.fullmatch(r'[0-9]{1,7}\.[0-9]{10,17}', text):
        return Fraction(round(Fraction(text) * 10 ** 9), 10 ** 9)
    return None


def utility_trim_candidate(argv, directory, runner):
    """Opt-in utility API. Caller must carry contract through output validation.

    Kept separate from normalized_candidate; the worker carries this per-job contract.
    Unsupported input/clock/recipe returns None so the original CPU path can run.
    """
    options = _utility_options(argv)
    if options is None:
        return None
    try:
        values = [_utility_number(options.get(key, '')) for key in ('-ss', '-t', '-crf')]
        if any(value is None for value in values):
            return None
        start, duration, crf = values
        if not (start >= 0 and Fraction(1, 20) <= duration <= 600 and 18 <= crf <= 30):
            return None
        directory = Path(directory).resolve()
        source_path = directory / '@0.mp4'
        source_media = probe_media(source_path, runner)
        source = video_stream(source_media)
        audio = [s for s in source_media.get('streams', []) if s.get('codec_type') == 'audio']
        if len(audio) > 1:
            return None
        maps = [argv[i + 1] for i, arg in enumerate(argv[:-1]) if arg == '-map']
        if options.get('-an') or maps == ['0:v:0']:
            audio = []
        audio_contract = []
        for stream in audio:
            if stream.get('codec_name') != 'aac':
                return None
            sample_rate = str(options.get('-ar', stream.get('sample_rate')))
            channels = int(options.get('-ac', stream.get('channels', 0)))
            if sample_rate not in ('44100', '48000') or channels not in (1, 2):
                return None
            audio_contract.append(('aac', sample_rate, channels))
        fps, clock = source.get('r_frame_rate'), source.get('time_base', '')
        if (fps not in _UTILITY_RATES or source.get('avg_frame_rate') != fps
                or source.get('codec_name') != 'h264' or source.get('pix_fmt') != 'yuv420p'
                or source.get('field_order') != 'progressive'
                or source.get('sample_aspect_ratio') != '1:1'
                or not re.fullmatch(r'1/[1-9][0-9]{0,8}', clock)):
            return None
        width, height = source.get('width', 0), source.get('height', 0)
        if not (0 < width <= 1920 and 0 < height <= 1080 and width % 2 == height % 2 == 0):
            return None
        display = tuple((key, source.get(key)) for key in (
            'sample_aspect_ratio', 'field_order', 'color_range', 'color_space', 'color_transfer', 'color_primaries'))
        for key in ('color_space', 'color_transfer', 'color_primaries'):
            if source.get(key) not in (None, 'unknown', 'bt709'):
                return None
        if source.get('color_range') not in (None, 'unknown', 'tv'):
            return None
        scale = Fraction(clock).denominator
        ticks = Fraction(1) / Fraction(fps) / Fraction(clock)
        if ticks.denominator != 1:
            return None
        if '-r' in options and Fraction(options['-r']) != Fraction(fps):
            return None
        if '-video_track_timescale' in options:
            if options['-video_track_timescale'] != str(scale):
                return None
        elif scale != _UTILITY_RATES[fps]:
            # Native x264 would pick another MP4 clock unless explicitly instructed.
            return None
        if start + duration > Fraction(source['duration']):
            return None
        executable = find_ffprobe()
        if not executable:
            return None
        packets = json.loads(runner([
            executable, '-v', 'error', '-select_streams', 'v:0', '-show_packets',
            '-show_entries', 'packet=pts,duration', '-of', 'json', str(source_path)], timeout=15).stdout)['packets']
        points = sorted(int(packet['pts']) for packet in packets)
        if (len(points) < 2 or any(b - a != ticks for a, b in zip(points, points[1:]))
                or any(int(packet['duration']) != ticks for packet in packets)):
            return None
        result, index = [], 0
        while index < len(argv) - 1:
            key = argv[index]
            if key in ('-crf', '-preset', '-profile:v', '-r', '-video_track_timescale'):
                index += 2
            elif key == '-c:v':
                result.extend([key, 'h264_nvenc'])
                index += 2
            else:
                step = 1 if key in _UTILITY_FLAGS else 2
                result.extend(argv[index:index + step])
                index += step
        if '-pix_fmt' not in options:
            result.extend(['-pix_fmt', 'yuv420p'])
        result.extend(['-r', fps, '-video_track_timescale', str(scale), '-g', str(round(2 * Fraction(fps))),
                       '-preset', 'p7', '-tune', 'hq', '-rc', 'constqp', '-qp', '14', '-profile:v', 'high',
                       '-bf', '0', '-forced-idr', '1', '-no-scenecut', '1', 'output.mp4'])
        contract = UtilityTrimContract(directory / 'output.mp4', fps, clock, width, height,
                                       duration, display, tuple(audio_contract))
        return UtilityTrimCandidate(tuple(result), contract)
    except (ValueError, TypeError, KeyError, OSError, RuntimeError, ArithmeticError):
        return None


def validate_utility_trim_output(path, runner, contract):
    """Validate only the output bound to this source-probed utility contract."""
    if not isinstance(contract, UtilityTrimContract) or Path(path).resolve() != contract.output_path:
        raise RuntimeError('nvenc_utility_contract_context')
    media = probe_media(path, runner)
    video = video_stream(media)
    audio = tuple((s.get('codec_name'), s.get('sample_rate'), s.get('channels'))
                  for s in media.get('streams', []) if s.get('codec_type') == 'audio')
    expected = dict(codec_name='h264', profile='High', pix_fmt='yuv420p',
                    r_frame_rate=contract.fps, avg_frame_rate=contract.fps,
                    time_base=contract.time_base, width=contract.width, height=contract.height,
                    **dict(contract.display))
    try:
        period = 1 / Fraction(contract.fps)
        duration = Fraction(video.get('duration', '0'))
        start = Fraction(video.get('start_time', '0'))
        valid = (audio == contract.audio and all(video.get(key) == value for key, value in expected.items())
                 and duration > 0 and abs(duration - contract.duration) <= period
                 and 0 <= start <= period)
    except (ValueError, TypeError, ZeroDivisionError):
        valid = False
    if not valid:
        raise RuntimeError('nvenc_utility_contract_mismatch')
    return media


def _native_crf17_normalization(argv):
    if len(argv) != 26:
        return False
    fixed = {0:'-y', 1:'-i', 2:'@0.mp4', 3:'-vf', 5:'-map', 6:'0:v:0',
             7:'-map', 8:'0:a?', 9:'-c:v', 10:'libx264', 11:'-crf', 12:'17',
             13:'-pix_fmt', 14:'yuv420p', 15:'-r', 16:'24', 17:'-c:a',
             18:'aac', 19:'-b:a', 20:'192k', 21:'-t', 23:'-movflags',
             24:'+faststart', 25:'output.mp4'}
    if any(argv[index] != value for index, value in fixed.items()):
        return False
    if not re.fullmatch(r'(?:0|[1-9][0-9]{0,5})\.[0-9]{3}', argv[22]) or float(argv[22]) < .05:
        return False
    return bool(re.fullmatch(
        r'(?:crop=[1-9][0-9]{0,4}:[1-9][0-9]{0,4}:[0-9]{1,5}:[0-9]{1,5},)?'
        r'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080', argv[4]))


def _native_crf17_credit(argv):
    if len(argv) != 26:
        return False
    try:
        from pc_ffmpeg_protocol import parse_prepared_credit_filter
    except ImportError:
        return False
    spec = parse_prepared_credit_filter(argv[4])
    if not spec or spec['font_ref'] != '@credit.ttf' or not spec['prefix'].endswith(','):
        return False
    # Reuse the exact native normalization argv contract; only its final credit differs.
    base = list(argv)
    base[4] = spec['prefix'][:-1]
    return _native_crf17_normalization(base)


def nvenc_high_argv(argv):
    def value(key):
        return argv[argv.index(key) + 1] if key in argv else None
    if (argv[-1] != 'output.mp4' or value('-c:v') != 'libx264'
            or value('-pix_fmt') != 'yuv420p' or value('-r') not in ('24', '24/1')
            or value('-video_track_timescale') not in (None, '12288')
            or value('-profile:v') not in (None, 'high')
            or any(key in argv for key in ('-b:v', '-maxrate', '-bufsize', '-level:v'))):
        return None
    try:
        crf = float(value('-crf'))
        # Synthetic native CRF17 crop/scale qualification retains the existing QP14 transform.
        if not (18 <= crf <= 30 or crf == 17 and (
                _native_crf17_normalization(argv) or _native_crf17_credit(argv))):
            return None
    except (TypeError, ValueError):
        return None
    result, index = [], 0
    while index < len(argv) - 1:
        key = argv[index]
        if key in ('-crf', '-preset', '-profile:v', '-keyint_min', '-sc_threshold', '-flags'):
            index += 2
        elif key == '-c:v':
            result.extend([key, 'h264_nvenc'])
            index += 2
        else:
            result.append(key)
            index += 1
    if '-g' not in result:
        result.extend(['-g', '48'])
    if '-video_track_timescale' not in result:
        result.extend(['-video_track_timescale', '12288'])
    return result + ['-preset', 'p7', '-tune', 'hq', '-rc', 'constqp', '-qp', '14',
                     '-profile:v', 'high', '-bf', '0', '-forced-idr', '1', '-no-scenecut', '1', argv[-1]]


def find_ffprobe():
    configured = os.environ.get('VF_PC_FFPROBE') or shutil.which('ffprobe')
    if configured and Path(configured).is_file():
        return str(Path(configured).resolve())
    packages = Path.home() / 'AppData/Local/Microsoft/WinGet/Packages'
    candidates = sorted(packages.glob('Gyan.FFmpeg.Shared_*/ffmpeg-*/bin/ffprobe.exe'))
    return str(candidates[-1]) if candidates else None


def probe_media(path, runner):
    executable = find_ffprobe()
    if not executable:
        raise RuntimeError('nvenc_probe_unavailable')
    result = runner([executable, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)], timeout=15)
    return json.loads(result.stdout)


def video_stream(media):
    videos = [s for s in media.get('streams', []) if s.get('codec_type') == 'video']
    if len(videos) != 1:
        raise RuntimeError('nvenc_video_streams')
    return videos[0]


def validate_high_output(path, runner):
    media = probe_media(path, runner)
    video = video_stream(media)
    if (video.get('codec_name') != 'h264' or video.get('profile') != 'High'
            or video.get('pix_fmt') != 'yuv420p' or video.get('r_frame_rate') != '24/1'
            or video.get('time_base') != '1/12288'
            or not 0 < video.get('width', 0) <= 1920 or not 0 < video.get('height', 0) <= 1080
            or float(video.get('duration', 0)) <= 0):
        raise RuntimeError('nvenc_stream_contract_mismatch')
    return media


def normalized_candidate(argv, directory, ffmpeg_runner):
    candidate = nvenc_high_argv(argv)
    if candidate is not None:
        return candidate
    # Native simple trims inherit 24fps/420/12288 from their single H264 source.
    # Do not infer these properties through any filter graph or multi-input command.
    if argv.count('-i') != 1 or any(k in argv for k in ('-vf', '-filter:v', '-filter_complex')):
        return None
    try:
        source = video_stream(probe_media(directory / argv[argv.index('-i') + 1], ffmpeg_runner))
        if (source.get('codec_name') != 'h264' or source.get('pix_fmt') != 'yuv420p'
                or source.get('r_frame_rate') != '24/1' or source.get('avg_frame_rate') != '24/1'
                or source.get('time_base') != '1/12288'
                or source.get('width', 9999) > 1920 or source.get('height', 9999) > 1080):
            return None
        options = list(argv[:-1])
        if '-pix_fmt' not in options:
            options.extend(['-pix_fmt', 'yuv420p'])
        if '-r' not in options:
            options.extend(['-r', '24'])
        return nvenc_high_argv(options + [argv[-1]])
    except Exception:
        return None


def frame_sequence(ffmpeg, path, runner):
    result = runner([ffmpeg, '-v', 'error', '-xerror', '-err_detect', 'explode', '-threads', '1',
                     '-i', str(path), '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-f', 'framemd5', '-'], timeout=90)
    return [line.rsplit(b',', 1)[-1].strip() for line in result.stdout.splitlines()
            if line and not line.startswith(b'#')]


def verify_pair(ffmpeg, cpu, gpu, runner, mixed=True, *, utility_contract=None):
    reference = probe_media(cpu, runner)
    actual = (validate_high_output(gpu, runner) if utility_contract is None else
              validate_utility_trim_output(gpu, runner, utility_contract))
    a, b = video_stream(reference), video_stream(actual)
    for key in ('codec_name', 'profile', 'pix_fmt', 'width', 'height', 'r_frame_rate', 'time_base',
                'sample_aspect_ratio', 'field_order', 'color_range', 'color_space', 'color_transfer', 'color_primaries'):
        if a.get(key) != b.get(key):
            raise RuntimeError('nvenc_reference_contract_' + key)
    period = 1 / float(Fraction(utility_contract.fps)) if utility_contract else 1 / 24
    if (a.get('nb_frames') != b.get('nb_frames') or abs(float(a['duration']) - float(b['duration'])) > period
            or utility_contract and (a.get('avg_frame_rate') != b.get('avg_frame_rate')
                or abs(float(a.get('start_time', 0)) - float(b.get('start_time', 0))) > period)):
        raise RuntimeError('nvenc_reference_timing_mismatch')
    aa = [s for s in reference['streams'] if s['codec_type'] == 'audio']
    ab = [s for s in actual['streams'] if s['codec_type'] == 'audio']
    if len(aa) != len(ab):
        raise RuntimeError('nvenc_reference_audio_streams')
    for index in range(len(aa)):
        if utility_contract:
            for key in ('codec_name', 'sample_rate', 'channels', 'time_base', 'start_time', 'duration'):
                if aa[index].get(key) != ab[index].get(key):
                    raise RuntimeError('nvenc_reference_audio_' + key)
        command = [ffmpeg, '-v', 'error', '-threads', '1', '-i', None, '-map', f'0:a:{index}', '-f', 'hash', '-hash', 'sha256', '-']
        command[command.index('-i') + 1] = str(cpu)
        expected = runner(command, timeout=60).stdout
        command[command.index('-i') + 1] = str(gpu)
        if runner(command, timeout=60).stdout != expected:
            raise RuntimeError('nvenc_reference_audio_changed')
    result = runner([ffmpeg, '-hide_banner', '-threads', '1', '-i', str(cpu), '-threads', '1', '-i', str(gpu),
                     '-filter_complex_threads', '1', '-filter_complex',
                     '[0:v]settb=1/24,setpts=N[a];[1:v]settb=1/24,setpts=N[b];[a][b]ssim', '-an', '-f', 'null', '-'], timeout=90)
    found = re.search(r'All:([0-9.]+)', result.stderr.decode('utf-8', 'replace'))
    if not found or float(found[1]) < .98:
        raise RuntimeError('nvenc_reference_quality_mismatch')
    if mixed:
        individual = {p: frame_sequence(ffmpeg, p, runner) for p in (cpu, gpu)}
        for order in ((cpu, gpu, cpu), (gpu, cpu, gpu)):
            listing = cpu.parent / 'nvenc-verify.ffconcat'
            joined = cpu.parent / 'nvenc-verify.mp4'
            listing.write_text('ffconcat version 1.0\n' + ''.join("file '" + p.name.replace("'", "'\\''") + "'\n" for p in order), encoding='ascii')
            runner([ffmpeg, '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(listing), '-c', 'copy', str(joined)], timeout=30)
            if frame_sequence(ffmpeg, joined, runner) != [f for p in order for f in individual[p]]:
                raise RuntimeError('nvenc_mixed_join_pixel_mismatch')
            joined.unlink(missing_ok=True)
            listing.unlink(missing_ok=True)
    return float(found[1])


def probe_nvenc_high(ffmpeg, root, runner):
    import tempfile
    try:
        with tempfile.TemporaryDirectory(dir=root) as directory:
            directory = Path(directory)
            cpu, gpu = directory / 'cpu.mp4', directory / 'gpu.mp4'
            args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=0.5',
                    '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-r', '24',
                    '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-flags', '+cgop', '-threads', '1', 'output.mp4']
            runner([ffmpeg, *args[:-1], str(cpu)], timeout=30)
            candidate = nvenc_high_argv(args)
            runner([ffmpeg, *candidate[:-1], str(gpu)], timeout=30)
            verify_pair(ffmpeg, cpu, gpu, runner)
            return True
    except Exception:
        return False
