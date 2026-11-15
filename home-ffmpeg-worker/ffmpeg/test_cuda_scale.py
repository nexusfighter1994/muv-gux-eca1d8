import copy
import json
from pathlib import Path
import tempfile
import subprocess
import unittest

from pc_nvenc_high import nvenc_high_argv
try:
    import pc_cuda_scale as feature
except ModuleNotFoundError:
    feature = None

FILTER = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080'


def native():
    return ['-y','-i','@0.mp4','-vf',FILTER,'-map','0:v:0','-map','0:a?',
            '-c:v','libx264','-crf','17','-pix_fmt','yuv420p','-r','24',
            '-c:a','aac','-b:a','192k','-t','4.000','-movflags','+faststart','output.mp4']


def media():
    return {'streams':[dict(codec_type='video',codec_name='h264',pix_fmt='yuv420p',
        width=1280,height=720,r_frame_rate='24/1',avg_frame_rate='24/1',time_base='1/12288',
        duration='5.000000',start_time='0.000000',sample_aspect_ratio='1:1',field_order='progressive',
        color_range='tv',color_space='bt709',color_transfer='bt709',color_primaries='bt709'),
        dict(codec_type='audio',codec_name='aac',sample_rate='48000',channels=2)]}


class CudaScaleTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(feature,'CUDA scale feature has not been implemented')

    def candidate(self, original=None, source=None):
        original = native() if original is None else original
        source = media() if source is None else source
        return feature.cuda_scale_candidate(original,nvenc_high_argv(original),Path('/owned'),probe=lambda _:source)

    def test_internal_transform_preserves_native_audio_timing_and_original(self):
        original=native();before=copy.deepcopy(original);plan=self.candidate(original)
        self.assertIsNotNone(plan)
        args=list(plan.argv)
        self.assertEqual(original,before)
        self.assertEqual(args[args.index('-vf')+1],'scale_cuda=1920:1080:interp_algo=bicubic:format=yuv420p')
        self.assertEqual(args[args.index('-hwaccel_output_format')+1],'cuda')
        self.assertNotIn('-pix_fmt',args,'hardware frames must not trigger implicit CPU conversion')
        for key in ['-t','-r','-c:a','-b:a','-movflags']:
            self.assertEqual(args[args.index(key)+1],original[original.index(key)+1])
        self.assertEqual(args[args.index('-qp')+1],'14')
        self.assertEqual(args[args.index('-video_track_timescale')+1],'12288')
        self.assertEqual(plan.frames,96)

    def test_unsupported_recipes_do_not_even_probe(self):
        variants=[]
        for key,value in [('-crf','18'),('-r','25'),('-vf','crop=640:360:0:0,'+FILTER),('-vf',FILTER+',hflip')]:
            args=native();args[args.index(key)+1]=value;variants.append(args)
        variants.append(['-stream_loop','3',*native()])
        for args in variants:
            with self.subTest(args=args):
                self.assertIsNone(feature.cuda_scale_candidate(args,nvenc_high_argv(args),Path('/owned'),
                    probe=lambda _:self.fail('unsupported recipe probed')))

    def test_unproven_source_properties_stay_on_existing_path(self):
        cases=[('codec_name','hevc'),('pix_fmt','yuv420p10le'),('width',1920),
               ('height',721),('r_frame_rate','25/1'),('avg_frame_rate','24000/1001'),
               ('field_order','tt'),('sample_aspect_ratio','4:3'),('color_space','bt2020nc'),
               ('color_range','pc'),('color_transfer','smpte2084'),('color_primaries','unknown'),
               ('start_time','0.050000'),('duration','3.000000'),('side_data_list',[{'rotation':90}])]
        for key,value in cases:
            with self.subTest(key=key):
                source=media();source['streams'][0][key]=value
                self.assertIsNone(self.candidate(source=source))
        source=media();source['streams'].append(copy.deepcopy(source['streams'][0]))
        self.assertIsNone(self.candidate(source=source))
        source=media();source['streams'][1]['codec_name']='opus'
        self.assertIsNone(self.candidate(source=source))

    def test_probe_failure_is_not_permission_to_guess(self):
        def failed(_):raise RuntimeError('probe failed')
        self.assertIsNone(feature.cuda_scale_candidate(native(),nvenc_high_argv(native()),Path('/owned'),probe=failed))

    def test_ffprobe_process_failures_decline_only_optional_scale(self):
        for error in [subprocess.CalledProcessError(1,['ffprobe']),subprocess.TimeoutExpired(['ffprobe'],15)]:
            def fail(_):raise error
            with self.subTest(error=type(error).__name__):
                self.assertIsNone(feature.cuda_scale_candidate(native(),nvenc_high_argv(native()),Path('/owned'),probe=fail))

    def test_policy_missing_invalid_or_unknown_is_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'cuda-scale-policy.json'
            self.assertFalse(feature.policy_enabled(path))
            for value in [dict(version=1,enabled=False),dict(version=2,enabled=True),dict(version=True,enabled=True),
                          dict(version=1,enabled=1),dict(version=1,enabled=True,argv=['bad'])]:
                path.write_text(json.dumps(value))
                self.assertFalse(feature.policy_enabled(path),value)
            path.write_text(json.dumps(dict(version=1,enabled=True)))
            self.assertTrue(feature.policy_enabled(path))
            path.write_text('{')
            self.assertFalse(feature.policy_enabled(path))

    def test_each_output_must_match_frames_clock_color_and_audio(self):
        plan=self.candidate();good=media()
        good['streams'][0].update(width=1920,height=1080,profile='High',nb_frames='96',duration='4.000000')
        feature.validate_cuda_scale_output(good,plan)
        for key,value in [('nb_frames','95'),('duration','4.083333'),('width',1280),
                          ('time_base','1/90000'),('color_range','pc'),('start_time','0.041667')]:
            with self.subTest(key=key):
                bad=copy.deepcopy(good);bad['streams'][0][key]=value
                with self.assertRaisesRegex(RuntimeError,'cuda_scale_output_mismatch'):
                    feature.validate_cuda_scale_output(bad,plan)
        bad=copy.deepcopy(good);bad['streams'][1]['sample_rate']='44100'
        with self.assertRaises(RuntimeError):feature.validate_cuda_scale_output(bad,plan)

    def test_optional_probe_failure_has_bounded_diagnostic_not_false_success(self):
        info={}
        def fail(*args,**kwargs):raise RuntimeError('planned qualification failure')
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(feature.probe_cuda_scale('ffmpeg',tmp,fail,diagnostics=info))
        self.assertIn('planned qualification failure',info['error'])


if __name__=='__main__':unittest.main()
