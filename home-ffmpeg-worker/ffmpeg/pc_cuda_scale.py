"""Worker-owned, opt-in CUDA scaler for one qualified native normalization recipe."""
from dataclasses import dataclass
from fractions import Fraction
import json
import math
import subprocess
from pathlib import Path
import tempfile

from pc_nvenc_high import (_native_crf17_normalization, nvenc_high_argv,
                           probe_media, video_stream, verify_pair)

POLICY = 'cuda-scale-normalize-v1'
NATIVE_FILTER = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080'
CUDA_FILTER = 'scale_cuda=1920:1080:interp_algo=bicubic:format=yuv420p'
COLORS = dict(color_range='tv', color_space='bt709', color_transfer='bt709', color_primaries='bt709')


@dataclass(frozen=True)
class CudaScaleCandidate:
    argv: tuple
    frames: int
    audio: tuple


def policy_enabled(path):
    try:
        path = Path(path)
        if path.is_symlink():
            return False
        with path.open('rb') as stream:
            raw = stream.read(513)
        if len(raw) > 512:
            return False
        value = json.loads(raw)
        return (isinstance(value, dict) and set(value) == {'version', 'enabled'}
                and type(value['version']) is int and value['version'] == 1
                and value['enabled'] is True)
    except (OSError, ValueError, TypeError):
        return False


def cuda_scale_candidate(original, encoded, directory, *, probe):
    if (not isinstance(original, list) or not _native_crf17_normalization(original)
            or original[4] != NATIVE_FILTER or encoded != nvenc_high_argv(original)):
        return None
    try:
        duration = Fraction(original[22])
        if not Fraction(1, 20) <= duration <= 600:
            return None
        media = probe(Path(directory) / '@0.mp4')
        source = video_stream(media)
        width, height = source.get('width'), source.get('height')
        if (type(width) is not int or type(height) is not int
                or not 0 < width < 1920 or not 0 < height < 1080
                or width % 2 or height % 2 or width * 9 != height * 16):
            return None
        expected = dict(codec_name='h264', pix_fmt='yuv420p', r_frame_rate='24/1',
                        avg_frame_rate='24/1', sample_aspect_ratio='1:1', field_order='progressive', **COLORS)
        if (any(source.get(k) != v for k, v in expected.items())
                or source.get('side_data_list') or Fraction(source.get('start_time', '-1')) != 0
                or Fraction(source.get('duration', '0')) < duration):
            return None
        streams = media.get('streams', [])
        audio = [s for s in streams if s.get('codec_type') == 'audio']
        if len(streams) != 1 + len(audio) or len(audio) > 1:
            return None
        if any(s.get('codec_name') != 'aac' or s.get('sample_rate') not in ('44100','48000')
               or s.get('channels') not in (1,2) for s in audio):
            return None
        result = list(encoded)
        result[result.index('-vf') + 1] = CUDA_FILTER
        pos = result.index('-pix_fmt')
        del result[pos:pos+2]
        pos = result.index('-i')
        result[pos:pos] = ['-hwaccel','cuda','-hwaccel_output_format','cuda']
        result[-1:-1] = ['-color_range','tv','-colorspace','bt709',
                         '-color_trc','bt709','-color_primaries','bt709']
        return CudaScaleCandidate(tuple(result), math.ceil(duration * 24),
            tuple((s['codec_name'],s['sample_rate'],s['channels']) for s in audio))
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, ArithmeticError, subprocess.SubprocessError):
        return None


def validate_cuda_scale_output(media, plan):
    try:
        if not isinstance(plan, CudaScaleCandidate):
            raise ValueError('missing scale contract')
        video = video_stream(media)
        streams = media['streams']
        audio = tuple((s.get('codec_name'),s.get('sample_rate'),s.get('channels'))
                      for s in streams if s.get('codec_type') == 'audio')
        expected = dict(codec_name='h264',profile='High',pix_fmt='yuv420p',width=1920,height=1080,
                        time_base='1/12288',r_frame_rate='24/1',avg_frame_rate='24/1',
                        sample_aspect_ratio='1:1',field_order='progressive', **COLORS)
        valid = (len(streams) == 1 + len(audio) and audio == plan.audio
                 and all(video.get(k) == v for k,v in expected.items())
                 and int(video.get('nb_frames', '0')) == plan.frames
                 and abs(Fraction(video.get('duration','0')) - Fraction(plan.frames,24)) <= Fraction(1,12288)
                 and Fraction(video.get('start_time','-1')) == 0)
        if not valid:
            raise ValueError('scaled output contract changed')
    except (ValueError, TypeError, KeyError, RuntimeError, ArithmeticError) as error:
        raise RuntimeError('cuda_scale_output_mismatch') from error


def probe_cuda_scale(ffmpeg, root, runner, *, diagnostics=None):
    """Qualify the actual decoder/scaler/encoder, audio and mixed joins together."""
    try:
        with tempfile.TemporaryDirectory(dir=root) as temp:
            directory = Path(temp)
            source = directory / '@0.mp4'
            runner([ffmpeg,'-v','error','-f','lavfi','-i','testsrc2=s=1280x720:r=24:d=0.5',
                    '-f','lavfi','-i','sine=sample_rate=48000:duration=0.5',
                    '-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p',
                    '-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709',
                    '-color_range','tv','-c:a','aac','-ac','2',str(source)],timeout=30)
            original = ['-y','-i','@0.mp4','-vf',NATIVE_FILTER,'-map','0:v:0','-map','0:a?',
                        '-c:v','libx264','-crf','17','-pix_fmt','yuv420p','-r','24',
                        '-c:a','aac','-b:a','192k','-t','0.500','-movflags','+faststart','output.mp4']
            plan = cuda_scale_candidate(original,nvenc_high_argv(original),directory,
                                        probe=lambda path:probe_media(path,runner))
            if plan is None:
                if diagnostics is not None:
                    diagnostics['error'] = 'cuda_scale_probe_source_unqualified'
                return False
            cpu,gpu = directory/'cpu.mp4',directory/'gpu.mp4'
            def materialize(argv, output):
                return [ffmpeg,*[str(source) if v=='@0.mp4' else str(output) if v=='output.mp4' else v for v in argv]]
            runner(materialize(original,cpu),timeout=30)
            runner(materialize(plan.argv,gpu),timeout=30)
            validate_cuda_scale_output(probe_media(gpu,runner),plan)
            verify_pair(ffmpeg,cpu,gpu,runner,mixed=True)
            return True
    except Exception as error:
        if diagnostics is not None:
            diagnostics['error'] = (type(error).__name__ + ': ' + str(error))[:500]
        return False
