"""Original camera-path pixels, encoded with the qualified NVENC High policy."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading

OPERATION = 'native-camera-nvenc-v1'
POLICY = 'nvenc-high-qp14-v1'

def validate_render(value):
    keys = {'source', 'target_resolution', 'fps', 'duration_frames', 'camera_path', 'wait_for_results'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('Exact native camera request required')
    if (value['source'] not in ('source.png', 'source.jpg', 'source.jpeg', 'source.webp')
        or value['target_resolution'] != '1920x1080' or type(value['fps']) is not int or value['fps'] != 24
        or type(value['duration_frames']) is not int or not 1 <= value['duration_frames'] <= 1440
        or value['wait_for_results'] is not False):
        raise ValueError('Unsupported camera format/duration')
    camera = value['camera_path']
    if not isinstance(camera, dict) or camera.get('treatment') is not None:
        raise ValueError('Treatments remain native')
    if set(camera) - {'presentation', 'track', 'card', 'backdrop', 'interpolation', 'treatment'}:
        raise ValueError('Unknown camera feature')
    track = camera.get('track')
    if not isinstance(track, dict) or not track or len(track) > 9:
        raise ValueError('Missing camera track')
    for series in track.values():
        if (not isinstance(series, list) or not 1 <= len(series) <= 1440
            or any(type(x) not in (float, int) or not math.isfinite(x) or abs(x) > 10000 for x in series)):
            raise ValueError('Camera track bounds')
    return value

def encode_args(output, frames):
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
        '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', '1920x1080', '-r', '24', '-i', 'pipe:0',
        '-map', '0:v', '-frames:v', str(frames), '-an', '-c:v', 'h264_nvenc',
        '-preset', 'p7', '-tune', 'hq', '-rc', 'constqp', '-qp', '14', '-profile:v', 'high',
        '-bf', '0', '-forced-idr', '1', '-no-scenecut', '1', '-g', '48',
        '-pix_fmt', 'yuv420p', '-fps_mode', 'cfr', '-video_track_timescale', '12288',
        '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
        '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-movflags', '+faststart', str(output)]

def execute(payload, config, root):
    from camera_native import CameraPath, CameraPathRenderer, decode_still, cv2, np
    render = validate_render(payload['render'])
    if payload.get('operation') != OPERATION: raise ValueError('Operation')
    cv2.setNumThreads(1)
    assets = payload.get('assets')
    if not isinstance(assets, list) or len(assets) != 1: raise ValueError('One still required')
    asset = assets[0]
    if asset.get('filename') != render['source']: raise ValueError('Source binding')
    data = base64.b64decode(asset['data'], validate=True)
    if not 0 < len(data) <= 16 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != asset['sha256']:
        raise ValueError('Source size/hash')
    source = root / render['source']
    source.write_bytes(data)
    image = decode_still(source)
    if image.shape[0] * image.shape[1] > 40_000_000: raise ValueError('Source dimensions')
    frames = render['duration_frames']
    renderer = CameraPathRenderer(image, CameraPath.model_validate(render['camera_path']), 1920, 1080, frames)
    output = root / 'result.mp4'
    error_file = root / 'encode.stderr'
    with error_file.open('wb') as errors:
        process = subprocess.Popen([config['ffmpeg'], *encode_args(output, frames)], stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL, stderr=errors, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        timer = threading.Timer(payload['timeoutMs'] / 1000, process.kill)
        timer.start()
        sampled = {}
        try:
            for index in range(frames):
                raw = np.ascontiguousarray(renderer.frame(index)).tobytes()
                if index in (0, frames // 2, frames - 1): sampled[str(index)] = hashlib.sha256(raw).hexdigest()
                process.stdin.write(raw)
            process.stdin.close()
            if process.wait(timeout=30): raise RuntimeError('NVENC encode failed')
        finally:
            timer.cancel()
            if process.poll() is None: process.kill(); process.wait(timeout=10)
    result = subprocess.run([config['ffprobe'], '-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(output)],
        capture_output=True, check=True, timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    streams = json.loads(result.stdout)['streams']
    if len(streams) != 1: raise ValueError('Unexpected audio/streams')
    video = streams[0]
    expected = dict(codec_name='h264', profile='High', pix_fmt='yuv420p', width=1920, height=1080,
                    r_frame_rate='24/1', avg_frame_rate='24/1', time_base='1/12288', nb_read_frames=str(frames))
    if any(video.get(k) != v for k, v in expected.items()): raise ValueError('Output stream contract')
    if abs(float(video['start_time'])) > .001 or abs(float(video['duration']) - frames / 24) > .002:
        raise ValueError('Output timing contract')
    blob = output.read_bytes()
    if not 0 < len(blob) <= 32 * 1024 * 1024: raise ValueError('Output size')
    return dict(version=1, id=payload['id'], contract=payload['contract'], operation=OPERATION,
        backend='NVENC High', gpuPolicy=POLICY, sha256=hashlib.sha256(blob).hexdigest(),
        data=base64.b64encode(blob).decode(), probe=video, rawFrameHashes=sampled,
        treatmentStatus={'treatment': None, 'treatment_applied': False, 'treatment_reason': None})

if __name__ == '__main__':
    config = json.loads(Path(sys.argv[1]).read_text())
    payload = json.loads(sys.stdin.read(24 * 1024 * 1024))
    print(json.dumps(execute(payload, config, Path(sys.argv[2])), separators=(',', ':')))
