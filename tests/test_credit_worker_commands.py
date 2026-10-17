import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

WORKER = Path('E:/VidForgeHomeBoost/vf-speed-20261002/ffmpeg')
sys.path.insert(0, str(WORKER))
from pc_ffmpeg_worker import Worker, raw_video_args


class CreditWorkerTests(unittest.TestCase):
    def test_cpu_gpu_and_reference_commands_use_identical_verified_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            files = {}
            for name, data in {'@credit.txt': b'Credit: Test', '@credit.ttf': b'\0\1\0\0font'}.items():
                (directory / name).write_bytes(data)
                files[name] = dict(sha256=hashlib.sha256(data).hexdigest(), size=len(data))
            files['@0.mp4'] = dict(sha256='0'*64, size=1)
            vf = "drawtext=textfile='@credit.txt':fontfile='@credit.ttf':fontcolor=white@0.6:fontsize=24:x=12:y=12"
            argv = ['-y', '-i', '@0.mp4', '-vf', vf, '-c:v', 'libx264', '-r', '24', 'output.mp4']
            worker = Worker.__new__(Worker)
            worker.ffmpeg = 'ffmpeg'
            cpu = worker.file_command(argv, directory, files)
            gpu_argv = list(argv)
            gpu_argv[gpu_argv.index('libx264')] = 'h264_nvenc'
            gpu = worker.file_command(gpu_argv, directory, files)
            reference = raw_video_args('ffmpeg', argv, directory, files, 'error')
            filters = [cmd[cmd.index('-vf')+1] for cmd in (cpu, gpu, reference)]
            self.assertEqual(len(set(filters)), 1)
            self.assertNotIn("textfile='@credit.txt'", filters[0])
            self.assertIn(directory.as_posix().replace(':', '\\:'), filters[0])
            self.assertEqual(cpu[-1], str(directory/'output.mp4'))
            self.assertIn('libx264', cpu)
            self.assertIn('h264_nvenc', gpu)
            (directory / '@credit.txt').write_bytes(b'Tampered')
            with self.assertRaises(ValueError):
                worker.file_command(argv, directory, files)

    def test_plain_media_arguments_are_unchanged(self):
        worker = Worker.__new__(Worker)
        worker.ffmpeg = 'ffmpeg'
        argv = ['-i', '@0.mp4', '-vf', 'scale=1920:1080', '-c:v', 'libx264', 'output.mp4']
        result = worker.file_command(argv, Path('C:/work'), {'@0.mp4': {}})
        self.assertIn('scale=1920:1080', result)
        self.assertEqual(result[-1], str(Path('C:/work/output.mp4')))


if __name__ == '__main__':
    unittest.main()
