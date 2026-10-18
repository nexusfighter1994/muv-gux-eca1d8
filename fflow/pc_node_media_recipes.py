"""Closed native argv syntax only; the owning CLI checks paths and probes.

Recipe names match node/home-media-recipes.mjs. No transport, FFlow imports,
policy selection, argument rewrites or filesystem access belong here.
"""
import re


SIMPLE_GRAPH = '[0:v][1:v]overlay=0:0:eof_action=pass[v]'
TIMED_GRAPH = re.compile(
    r'\[0:v\]fps=24,setsar=1\[base\];\[1:v\]fps=24'
    r'(?:,setpts=PTS\+((?:0|[1-9][0-9]{0,5})\.[0-9]{4})/TB)?\[fx\];'
    r'\[base\]\[fx\]overlay=0:0:eof_action=pass,format=yuv420p\[v\]')
STILL_GRAPH = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24'
PRESETS = frozenset(('veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'))
OVERLAY = ['-i', None, '-i', None, '-filter_complex', None, '-map', '[v]',
           '-map', '0:a?', '-c:v', 'libx264', '-crf', None, '-preset', None,
           '-pix_fmt', 'yuv420p', '-c:a', 'copy', None]
IMAGE = ['-loop', '1', '-i', None, '-t', None, '-vf', STILL_GRAPH, '-r', '24',
         '-pix_fmt', 'yuv420p', '-c:v', 'libx264', None]
MIRROR = ['-i', None, '-filter:v', 'hflip', '-c:v', 'libx264',
          '-preset', 'fast', '-crf', '18', '-an', None]
BLUR_OVERLAY = OVERLAY[:18] + ['-fps_mode','cfr','-r','24/1','-g','48',
    '-keyint_min','48','-sc_threshold','0','-flags','+cgop','-video_track_timescale','12288',
    '-movflags','+negative_cts_offsets','-c:a','copy',None]
BLUR_GRAPH = re.compile(r'\[0:v\]setpts=PTS-STARTPTS,fps=24\[bfs\];\[bfs\]split=2\[gk0\]\[gc0\];\[gc0\]trim=start=(\d{1,3}\.\d{4}):end=(\d{1,3}\.\d{4}),setpts=PTS-STARTPTS,scale=2016:1134:flags=bicubic,crop=1920:1080,gblur=sigma=18:steps=2,format=yuva420p,fade=t=in:st=0:d=(\d{1,3}\.\d{4}):alpha=1,fade=t=out:st=(\d{1,3}\.\d{4}):d=(\d{1,3}\.\d{4}):alpha=1,setpts=PTS\+(\d{1,3}\.\d{4})/TB\[gw0\];\[gk0\]\[gw0\]overlay=0:0:eof_action=pass\[gb0\];\[1:v\]fps=24,setpts=PTS\+(\d{1,3}\.\d{4})/TB\[l0\];\[gb0\]\[l0\]overlay=0:0:eof_action=pass\[v\]', re.ASCII)


def _valid_blur_graph(graph):
    match = BLUR_GRAPH.fullmatch(graph)
    if not match:
        return False
    values = list(map(float, match.groups()))
    start,end,fade_in,fade_start,fade_out,offset,layer_offset = values
    return (all(0 <= v <= 600 for v in values) and start < end and offset == start
            and layer_offset <= end and fade_in > 0 and fade_out > 0
            and fade_in <= end-start+0.0002 and fade_start+fade_out <= end-start+0.0002)


def _matches(argv, template):
    return len(argv) == len(template) and all(
        expected is None or argv[index] == expected for index, expected in enumerate(template))


def _media(value, extensions):
    return isinstance(value, str) and not value.startswith('-') and bool(
        re.search(r'\.(?:' + extensions + r')\Z', value, re.IGNORECASE))


def classify_argv(argv):
    """Return a recipe string or None, without mutating the original argv.

    Accept one remaining native -y only. The bridge has already removed it()'s
    common launch/thread prefix; unknown prefix flags must not be normalized.
    """
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 256
            or any(not isinstance(value, str) or not 1 <= len(value) <= 32768
                   or any(char in value for char in ('\0', '\r', '\n')) for value in argv)):
        return None
    args = argv[1:] if argv[0] == '-y' else argv
    if not args or not _media(args[-1], 'mp4'):
        return None
    if (_matches(args, BLUR_OVERLAY) and _media(args[1], 'mp4') and _media(args[3], 'mp4|mov')
            and args[13] == '18' and args[15] in PRESETS and _valid_blur_graph(args[5])):
        return 'composite-blur-overlay'
    if (_matches(args, OVERLAY) and _media(args[1], 'mp4')
            and _media(args[3], 'mp4|mov') and args[15] in PRESETS):
        if args[5] == SIMPLE_GRAPH and args[13] == '20':
            return 'composite-overlay'
        timed = TIMED_GRAPH.fullmatch(args[5])
        if (timed and args[13] == '18'
                and (timed[1] is None or 0 < float(timed[1]) <= 600)):
            return 'composite-overlay'
        return None
    if (_matches(args, IMAGE) and _media(args[3], 'png|jpg|jpeg|webp|bmp')
            and re.fullmatch(r'(?:0|[1-9][0-9]{0,5})\.[0-9]{3}', args[5])
            and 0.05 <= float(args[5]) <= 600):
        return 'broll-simpleimage'
    if _matches(args, MIRROR) and _media(args[1], 'mp4'):
        return 'video-mirror'
    return None
