"""Closed media protocol; only exact native credits may attach text/font assets."""
import hashlib
from pathlib import Path
import re

MAX_INPUT = 64 * 1024 * 1024
MAX_TOTAL = 96 * 1024 * 1024
# Scene-detection sources (blob store only; render inputs keep MAX_INPUT/MAX_TOTAL).
SCENE_MAX_INPUT = 400 * 1024 * 1024
MAX_OUTPUT = 512 * 1024 * 1024
MAX_BODY = 140 * 1024 * 1024
DEFAULTS = dict(enabled=False, cpuWorkers=5, gpuWorkers=4,
                siglipEnabled=True, siglipConcurrency=1)
FLAGS = {'-y', '-n', '-hide_banner', '-nostats', '-stats', '-nostdin', '-an', '-vn', '-sn', '-dn', '-shortest'}
VALUES = {'-i', '-c:v', '-codec:v', '-vcodec', '-c:a', '-b:a', '-ar', '-ac', '-crf', '-preset', '-pix_fmt', '-r', '-s',
          '-vf', '-filter:v', '-filter_complex', '-map', '-t', '-ss', '-to', '-threads',
          '-filter_threads', '-filter_complex_threads', '-progress', '-loglevel', '-v',
          '-movflags', '-loop', '-stream_loop', '-framerate', '-fps_mode', '-vsync',
          '-video_track_timescale', '-avoid_negative_ts', '-max_muxing_queue_size',
          '-b:v', '-maxrate', '-bufsize', '-profile:v', '-level:v', '-f',
          '-metadata', '-g', '-keyint_min', '-sc_threshold', '-flags',
          '-color_primaries', '-color_trc', '-colorspace', '-color_range', '-sws_flags',
          '-frames', '-frames:v', '-q:v', '-q:a', '-af', '-filter:a', '-sample_fmt', '-c'}
FILTERS = {'scale', 'scale2ref', 'crop', 'pad', 'setsar', 'setdar', 'fps', 'setpts', 'trim',
           'format', 'zoompan', 'overlay', 'xfade', 'concat', 'split', 'null', 'fade',
           'transpose', 'hflip', 'vflip', 'rotate', 'eq', 'colorbalance', 'colorchannelmixer',
           'unsharp', 'gblur', 'boxblur', 'drawbox', 'tpad', 'loop', 'select', 'interpolate',
           'minterpolate', 'tmix', 'tblend', 'settb', 'atrim', 'asetpts', 'aresample',
           'aformat', 'anull', 'apad', 'afade', 'volume', 'amix', 'amerge', 'asplit',
           'adelay', 'atempo', 'loudnorm', 'highpass', 'lowpass', 'acompressor', 'alimiter',
           'setparams', 'anullsrc'}
FILE_NAME = re.compile(r'@[0-9]+\.(?:mp4|mov|mkv|webm|png|jpg|jpeg|webp|bmp|mp3|wav|m4a|aac|flac)', re.I)
OUTPUT_NAME = re.compile(r'output\.(?:mp4|png|jpg|jpeg|wav|mp3|m4a|aac|flac)')
CREDIT_ASSETS_VERSION = 1
CREDIT_ASSET_LIMITS = {'@credit.txt': 64 * 1024, '@credit.ttf': 16 * 1024 * 1024,
                       '@credit.otf': 16 * 1024 * 1024}
_CREDIT_PREFIX = (r'(?:(?:crop=[1-9][0-9]{0,4}:[1-9][0-9]{0,4}:[0-9]{1,5}:[0-9]{1,5},)?'
                  r'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,)?')
_CREDIT_TAIL = r':fontcolor=white@0\.6:fontsize=(?P<fontsize>[1-9][0-9]{0,2}):x=12:y=12'
_NATIVE_CREDIT = re.compile(
    rf"(?P<prefix>{_CREDIT_PREFIX})drawtext=textfile='(?P<text_path>(?:[A-Za-z]\\:)?/[A-Za-z0-9_./ -]+\.credit\.txt)'"
    + _CREDIT_TAIL)
_PREPARED_CREDIT = re.compile(
    rf"(?P<prefix>{_CREDIT_PREFIX})drawtext=textfile='@credit.txt':fontfile='(?P<font_ref>@credit\.(?:ttf|otf))'"
    + _CREDIT_TAIL)


def _safe_credit_path(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:[A-Za-z]:)?/[A-Za-z0-9_./ @-]+', value):
        raise ValueError('Unsafe credit asset path')
    if any(part in ('', '.', '..') for part in value.split('/')[1:]):
        raise ValueError('Unsafe credit asset path components')
    return value


def parse_native_credit_filter(value):
    """Syntax only; caller MUST bind text_path to output+'.credit.txt' and its root."""
    if not isinstance(value, str) or len(value) > 32768:
        return None
    match = _NATIVE_CREDIT.fullmatch(value)
    if not match or int(match['fontsize']) > 128:
        return None
    path = match['text_path'].replace('\\:', ':')
    try:
        _safe_credit_path(path)
    except ValueError:
        return None
    return dict(text_path=path, prefix=match['prefix'], fontsize=int(match['fontsize']))


def parse_prepared_credit_filter(value):
    """Only relocatable references; never an absolute path supplied by a client."""
    if not isinstance(value, str) or len(value) > 32768:
        return None
    match = _PREPARED_CREDIT.fullmatch(value)
    if not match or int(match['fontsize']) > 128:
        return None
    return dict(prefix=match['prefix'], fontsize=int(match['fontsize']),
                text_ref='@credit.txt', font_ref=match['font_ref'])


def prepare_credit_filter(spec, font_ref):
    if (not isinstance(spec, dict) or set(spec) != {'text_path', 'prefix', 'fontsize'}
            or not isinstance(spec['prefix'], str) or not re.fullmatch(_CREDIT_PREFIX, spec['prefix'])
            or type(spec['fontsize']) is not int or not 1 <= spec['fontsize'] <= 128
            or font_ref not in ('@credit.ttf', '@credit.otf')):
        raise ValueError('Invalid credit specification')
    return (spec['prefix'] + "drawtext=textfile='@credit.txt':fontfile='" + font_ref + "'"
            + f":fontcolor=white@0.6:fontsize={spec['fontsize']}:x=12:y=12")


def validate_credit_asset(name, data):
    limit = CREDIT_ASSET_LIMITS.get(name, 0)
    if not isinstance(data, bytes) or not 0 < len(data) <= limit:
        raise ValueError('Invalid credit asset size')
    if name == '@credit.txt':
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError as exc:
            raise ValueError('Credit text must be UTF-8') from exc
        # Native expansion is preserved for plain text; expressions could depend
        # on machine-local time/metadata and must never change pixels remotely.
        if '\x00' in text or '%{' in text or any(ord(c) < 32 and c not in '\n\r\t' for c in text):
            raise ValueError('Unsupported credit text expression or control character')
    elif data[:4] not in (b'\x00\x01\x00\x00', b'OTTO', b'true'):
        raise ValueError('Only single-face TrueType/OpenType fonts are supported')


def read_credit_asset(path, name):
    path = Path(path)
    if (path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction())
            or not path.is_file()):
        raise ValueError('Credit asset must be a regular local file')
    with path.open('rb') as stream:
        data = stream.read(CREDIT_ASSET_LIMITS.get(name, 0) + 1)
    validate_credit_asset(name, data)
    return data


def _credit_reference(files, name):
    reference = files.get(name) if isinstance(files, dict) else None
    if (not isinstance(reference, dict) or set(reference) != {'sha256', 'size'}
            or not isinstance(reference['sha256'], str)
            or not re.fullmatch(r'[a-f0-9]{64}', reference['sha256'])
            or type(reference['size']) is not int
            or not 0 < reference['size'] <= CREDIT_ASSET_LIMITS[name]):
        raise ValueError('Credit assets require bounded SHA-256 blob references')
    return reference


def materialize_credit_argv(argv, directory, files):
    """After validate_argv(original), map credits in CPU/GPU argv to verified local files.

    Does not change media inputs, output, encoders or GPU eligibility. Call for
    BOTH execution and CPU-reference commands before spawning FFmpeg.
    """
    result = list(argv)
    for pos, key in enumerate(argv[:-1]):
        if key not in ('-vf', '-filter:v', '-filter_complex', '-af', '-filter:a'):
            continue
        value = argv[pos + 1]
        spec = parse_prepared_credit_filter(value)
        if spec is None:
            validate_filter(value)
            continue
        if key not in ('-vf', '-filter:v'):
            raise ValueError('Credits require the native video filter')
        directory = Path(directory)
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError('Invalid credit work directory')
        paths = {}
        for role in ('text_ref', 'font_ref'):
            name = spec[role]
            reference = _credit_reference(files, name)
            path = directory / name
            data = read_credit_asset(path, name)
            if path.resolve().parent != directory.resolve():
                raise ValueError('Credit asset escaped work directory')
            if len(data) != reference['size'] or hashlib.sha256(data).hexdigest() != reference['sha256']:
                raise ValueError('Credit asset integrity mismatch')
            paths[role] = _safe_credit_path(path.absolute().as_posix()).replace(':', '\\:')
        result[pos + 1] = (spec['prefix'] + "drawtext=textfile='" + paths['text_ref']
                           + "':fontfile='" + paths['font_ref'] + "'"
                           + f":fontcolor=white@0.6:fontsize={spec['fontsize']}:x=12:y=12")
    return result


def checked_config(update, current=None):
    if not isinstance(update, dict) or set(update) - (set(DEFAULTS) | {'sceneWorkers'}):
        raise ValueError('Unknown configuration keys')
    result = dict(DEFAULTS if current is None else current)
    for key, value in update.items():
        if key in ('enabled', 'siglipEnabled'):
            if type(value) is not bool:
                raise ValueError('Boolean required')
        elif type(value) is not int or not (1 if key == 'siglipConcurrency' else 0) <= value <= 25:
            raise ValueError('Worker count outside safe range')
        result[key] = value
    return result


def validate_filter(value, file_names=None):
    if len(value) > 32768 or any(c in value for c in ('\n', '\r', '\x00')):
        raise ValueError('Invalid filter')
    credit = parse_prepared_credit_filter(value)
    if credit:
        for name in (credit['text_ref'], credit['font_ref']):
            _credit_reference(file_names, name)
        return {credit['text_ref'], credit['font_ref']}
    # Split only real graph delimiters, not commas inside quoted expressions.
    pieces, start, quote, depth, escaped = [], 0, None, 0, False
    for pos, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == '\\':
            escaped = True
            continue
        if char in "'\"":
            if quote == char:
                quote = None
            elif quote is None:
                quote = char
        elif quote is None:
            if char == '(':
                depth += 1
            elif char == ')':
                depth -= 1
            elif char in ',;' and depth == 0:
                pieces.append(value[start:pos])
                start = pos + 1
    if quote or depth or escaped:
        raise ValueError('Unbalanced filter expression')
    pieces.append(value[start:])
    for piece in pieces:
        match = re.match(r'^\s*(?:\[[A-Za-z0-9_:]+\]\s*)*([a-z0-9_]+)(?:=|\[|\s*$)', piece)
        if not match or match[1] not in FILTERS:
            raise ValueError('Unsupported filter')


def validate_argv(argv, file_names):
    if not isinstance(argv, list) or not 3 <= len(argv) <= 256 or not all(isinstance(x, str) and len(x) < 32769 and '\x00' not in x for x in argv):
        raise ValueError('Invalid argv')
    if not file_names or len(file_names) > 32 or any(not FILE_NAME.fullmatch(x) and x not in CREDIT_ASSET_LIMITS for x in file_names):
        raise ValueError('Invalid file names')
    if not OUTPUT_NAME.fullmatch(argv[-1]):
        raise ValueError('Only one supported media output is allowed')
    image_output = argv[-1].endswith(('.png', '.jpg', '.jpeg'))
    audio_output = argv[-1].endswith(('.mp3', '.wav', '.m4a', '.aac', '.flac'))
    positions, codecs, pos, assets, filter_count = [], [], 0, set(), 0
    while pos < len(argv) - 1:
        key = argv[pos]
        if key in FLAGS:
            pos += 1
            continue
        if key not in VALUES or pos + 1 >= len(argv) - 1:
            raise ValueError('Unsupported option')
        value = argv[pos + 1]
        if key == '-i':
            if value not in file_names or not FILE_NAME.fullmatch(value):
                raise ValueError('Only attached inputs are allowed')
            positions.append(pos + 1)
        elif key in ('-vf', '-filter:v', '-filter_complex', '-af', '-filter:a'):
            filter_count += 1
            references = validate_filter(value, file_names)
            if references:
                if key not in ('-vf', '-filter:v'):
                    raise ValueError('Credits require the native video filter')
                assets.update(references)
        elif key in ('-c:v', '-codec:v', '-vcodec'):
            if value != 'libx264':
                raise ValueError('Only original x264 video encodes can offload')
            codecs.append(value)
        elif key == '-progress':
            if value != 'pipe:1':
                raise ValueError('Invalid progress sink')
        elif key == '-c:a':
            if value not in ('aac', 'copy', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'libmp3lame', 'flac'):
                raise ValueError('Unsupported audio encoder')
        elif key == '-c':
            if value != 'copy':
                raise ValueError('Unsupported stream encoder')
        elif key in ('-frames', '-frames:v'):
            if value != '1' or not image_output:
                raise ValueError('Only single-frame images supported')
        elif key == '-metadata':
            if value != 'encoder=fflow-api' and not re.fullmatch(r'title=fflow composition [A-Za-z0-9_-]{1,128}', value):
                raise ValueError('Only known FFlow metadata is supported')
        elif key in ('-g', '-keyint_min'):
            if not re.fullmatch(r'[0-9]{1,3}', value) or not 1 <= int(value) <= 600:
                raise ValueError('Invalid GOP interval')
        elif key == '-sc_threshold':
            if value != '0':
                raise ValueError('Only the native disabled scene-cut threshold is supported')
        elif key == '-flags':
            if value != '+cgop':
                raise ValueError('Only native closed-GOP flags are supported')
        elif key == '-f':
            if value != 'mp4':
                raise ValueError('Unsupported container')
        elif key in ('-threads', '-filter_threads', '-filter_complex_threads'):
            if not value.isdigit() or not 1 <= int(value) <= 16:
                raise ValueError('Invalid thread cap')
        elif key == '-map':
            if not re.fullmatch(r'(?:(?:[0-9]|[12][0-9]|3[01])(?::[va](?::[0-9])?)?\??|\[[A-Za-z0-9_]+\])', value):
                raise ValueError('Only video maps are supported')
        elif not re.fullmatch(r'[A-Za-z0-9_.:+/=-]{1,128}', value):
            raise ValueError('Invalid option value')
        pos += 2
    if assets and (filter_count != 1 or len(positions) != 1 or audio_output):
        raise ValueError('Credits require one input and one exact native video filter')
    if not positions or not (codecs or image_output or audio_output or '-c' in argv) or set(argv[i] for i in positions) | assets != set(file_names):
        raise ValueError('Self-contained video encode required')
    return positions


def nvenc_argv(argv):
    """Lossless only, and only formats supported by the verified GPU probe."""
    # Published chunks carry voiceover and must keep the native High-profile
    # CPU encode. Lossless NVENC remains useful for explicitly silent visuals.
    if '-an' not in argv:
        return None
    if argv[-1] != 'output.mp4' or '-pix_fmt' not in argv or argv[argv.index('-pix_fmt') + 1] != 'yuv420p':
        return None
    if '-c:v' not in argv or argv[argv.index('-c:v') + 1] != 'libx264':
        return None
    if any(x in argv for x in ('-af', '-filter:a')) or ('-filter_complex' in argv and re.search(r'\b(?:amix|atrim|asetpts|aformat|anull|apad|afade|aresample|asplit|volume|adelay)\b', argv[argv.index('-filter_complex') + 1])):
        return None
    if any(key in argv for key in ('-b:v', '-maxrate', '-bufsize', '-profile:v', '-level:v')):
        return None
    result, index = [], 0
    while index < len(argv) - 1:
        key = argv[index]
        if key in ('-crf', '-preset'):
            index += 2
            continue
        if key in ('-c:v', '-codec:v', '-vcodec'):
            result.extend([key, 'h264_nvenc'])
            index += 2
            continue
        result.append(key)
        index += 1
    return result + ['-preset', 'lossless', argv[-1]]
