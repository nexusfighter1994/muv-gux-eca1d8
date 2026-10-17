import importlib.util
from pathlib import Path
import sys
import unittest

CORE = Path(__file__).resolve().parents[1] / 'fflow'
sys.path.insert(0, str(CORE))
from pc_ffmpeg_protocol import validate_argv
from pc_transfer_limits import check_render_sizes, DEFAULT_LIMITS


class CompositionCapacityTests(unittest.TestCase):
    def command(self, count=11):
        files = {f'@{i}.mp4': {} for i in range(count)}
        argv = ['-y']
        for name in files:
            argv += ['-threads', '1', '-i', name]
        argv += ['-filter_complex',
                 '[0:v]setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709[v];'
                 'anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:1[a]',
                 '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '18',
                 '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', '24',
                 '-c:a', 'aac', 'output.mp4']
        return argv, files

    def test_native_eleven_input_composition_is_admitted(self):
        argv, files = self.command()
        self.assertEqual(len(validate_argv(argv, files)), 11)
        check_render_sizes([1024] * 11, DEFAULT_LIMITS)

    def test_boundary_is_bounded_at_32_inputs(self):
        argv, files = self.command(32)
        self.assertEqual(len(validate_argv(argv, files)), 32)
        check_render_sizes([1024] * 32, DEFAULT_LIMITS)
        argv, files = self.command(33)
        with self.assertRaises(ValueError):
            validate_argv(argv, files)
        with self.assertRaises(ValueError):
            check_render_sizes([1024] * 33, DEFAULT_LIMITS)

    def test_total_file_caps_and_external_filter_sources_still_rejected(self):
        with self.assertRaises(ValueError):
            check_render_sizes([10 * 1024**2] * 11, DEFAULT_LIMITS)
        for graph in ("movie=/etc/passwd[v]", "amovie=https://example.com/test[a]",
                      "drawtext=textfile=/etc/passwd[v]"):
            argv, files = self.command()
            argv[argv.index('-filter_complex') + 1] = graph
            with self.assertRaises(ValueError):
                validate_argv(argv, files)


if __name__ == '__main__':
    unittest.main()
