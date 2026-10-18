import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import unittest


CORE = Path(__file__).resolve().parents[1] / 'fflow'
FILE = CORE / 'pc_node_media_recipes.py'
SIMPLE = '[0:v][1:v]overlay=0:0:eof_action=pass[v]'
TIMED = ('[0:v]fps=24,setsar=1[base];[1:v]fps=24,setpts=PTS+0.5000/TB[fx];'
         '[base][fx]overlay=0:0:eof_action=pass,format=yuv420p[v]')
STILL = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24'


def overlay(graph=SIMPLE, crf='20'):
    return ['-i', '/data/projects/base.mp4', '-i', '/data/projects/overlay.mov',
            '-filter_complex', graph, '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264',
            '-crf', crf, '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
            '/data/projects/composited.part.mp4']


def image():
    return ['-loop', '1', '-i', '/data/projects/image.png', '-t', '3.000', '-vf', STILL,
            '-r', '24', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '/data/projects/image.part.mp4']


def mirror():
    return ['-y', '-i', '/data/projects/base.mp4', '-filter:v', 'hflip', '-c:v', 'libx264',
            '-preset', 'fast', '-crf', '18', '-an', '/data/projects/mirrored.part.mp4']


class MediaRecipeTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(FILE.is_file(), 'closed native media recipe classifier is missing')
        spec = importlib.util.spec_from_file_location('node_media_recipes', FILE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_observed_blur_overlay_and_closed_clock(self):
        args = json.loads((Path(__file__).parent/'fixtures/home-media-blur-overlay.json').read_text())['argv']
        before = list(args)
        self.assertEqual(self.module.classify_argv(args), 'composite-blur-overlay')
        self.assertEqual(args, before)
        for flag, value in [('-crf','16'),('-r','30'),('-g','60'),('-c:a','aac'),('-movflags','+faststart')]:
            changed=list(args);changed[changed.index(flag)+1]=value
            self.assertIsNone(self.module.classify_argv(changed))
        for old,new in [('sigma=18','sigma=99'),('start=0.5000','start=4.5000'),('PTS+0.5000/TB','PTS+0.6000/TB'),('d=0.5500','d=9.0000'),('[l0]','[l1]')]:
            changed=list(args);changed[5]=changed[5].replace(old,new,1)
            self.assertIsNone(self.module.classify_argv(changed))

    def test_exact_recipes_keep_native_arguments_and_audio(self):
        for argv, expected in [(overlay(), 'composite-overlay'),
                               (overlay(TIMED, '18'), 'composite-overlay'),
                               (image(), 'broll-simpleimage'), (mirror(), 'video-mirror')]:
            before = copy.deepcopy(argv)
            self.assertEqual(self.module.classify_argv(argv), expected)
            self.assertEqual(argv, before)

    def test_rejects_changed_fixed_tokens_and_extra_arguments(self):
        for argv in [overlay(), image(), mirror()]:
            for index in range(len(argv)):
                changed = list(argv)
                changed[index] = 'invalid'
                self.assertIsNone(self.module.classify_argv(changed), (index, argv))
            for changed in [argv + ['-an'], ['ffmpeg'] + argv, argv[:-1],
                            ['-y', '-hide_banner', '-loglevel', 'error'] + argv]:
                self.assertIsNone(self.module.classify_argv(changed))

    def test_rejects_masks_unbounded_offsets_and_non_native_duration(self):
        for offset in ['0.0000', '-0.5000', '0.5', 'NaN', 'Infinity', '600.0001', '00.5000']:
            self.assertIsNone(self.module.classify_argv(overlay(TIMED.replace('0.5000', offset), '18')))
        for graph in [SIMPLE + ';movie=/etc/passwd[v]', TIMED + ';[2:v]alphaextract[mask]',
                      '[1:v]fps=24,setpts=PTS+0.0000/TB[l0];[0:v][l0]overlay=0:0:eof_action=pass[v]']:
            self.assertIsNone(self.module.classify_argv(overlay(graph)))
        for duration in ['3', '0.000', '600.001', '003.000']:
            argv = image(); argv[5] = duration
            self.assertIsNone(self.module.classify_argv(argv))

    def test_rejects_malformed_values_without_importing_transport(self):
        for value in [None, {}, [], 'ffmpeg', [None], ['x'] * 257]:
            self.assertIsNone(self.module.classify_argv(value))
        for bad in ['', 'a\n.mp4', 'a\r.mp4', 'a\0.mp4', 'a' * 32769 + '.mp4']:
            argv = overlay(); argv[1] = bad
            self.assertIsNone(self.module.classify_argv(argv))

    @unittest.skipUnless(shutil.which('node'), 'Node required for cross-language contract check')
    def test_node_and_python_classification_are_identical(self):
        cases = [overlay(), overlay(TIMED, '18'), image(), mirror(), mirror()[1:],
                 ['-y', '-y'] + mirror()[1:], None, [], ['x'] * 257]
        blur=json.loads((Path(__file__).parent/'fixtures/home-media-blur-overlay.json').read_text())['argv']
        cases.append(blur)
        for index in range(len(blur)):
            changed=list(blur);changed[index]='invalid';cases.append(changed)
        for original in [overlay(), overlay(TIMED, '18'), image(), mirror()]:
            for index in range(len(original)):
                argv = list(original); argv[index] = 'invalid'
                cases.append(argv)
        for offset in ['0.0000', '600.0000', '600.0001', '01.0000', '0.5', 'NaN']:
            cases.append(overlay(TIMED.replace('0.5000', offset), '18'))
        node_file = CORE.parent / 'node' / 'home-media-recipes.mjs'
        script = ('import fs from "node:fs";import {classifyHomeMediaArgv as classify} from '
                  + json.dumps(node_file.as_uri()) + ';'
                  'console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,"utf8")).map(classify)));')
        result = subprocess.run(['node', '--input-type=module', '-e', script],
                                input=json.dumps(cases), text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), [self.module.classify_argv(argv) for argv in cases])


if __name__ == '__main__':
    unittest.main()
