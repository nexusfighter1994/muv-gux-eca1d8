import ast
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('fxw', HERE / 'fx-encode-wait-install.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# The native shape of FrameWriter._complete plus the unrelated 10 s wait of the reader.
NATIVE = '''import subprocess


class Reader:
    def close(self):
        try:
            self.proc.wait(timeout=10)
        except Exception:
            pass


class Writer:
    def _complete(self):
        try:
            self.proc.stdin.close()
        except BrokenPipeError:
            pass
        try:
            code = self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            raise RuntimeError('ffmpeg encode did not stop after its input closed')
        return code
'''


def test_only_the_encoder_exit_wait_changes():
    out = mod.patch_runner(NATIVE)
    assert out.count(mod.MARKER) == 1
    assert 'code = self.proc.wait(timeout=90)  # vf-custom:fx-encode-wait-v1 (native 30)\n' in out
    assert 'self.proc.wait(timeout=10)' in out, 'reader cleanup wait untouched'
    changed = [(a, b) for a, b in zip(NATIVE.splitlines(), out.splitlines()) if a != b]
    assert len(changed) == 1 and len(NATIVE.splitlines()) == len(out.splitlines())
    ast.parse(out)


def test_idempotent():
    once = mod.patch_runner(NATIVE)
    assert mod.patch_runner(once) == once


def test_fails_closed_when_missing_or_ambiguous():
    twice = NATIVE + NATIVE.split('class Writer:')[1].replace('_complete', '_complete2')
    for text in ('x = 1\n', NATIVE.replace('timeout=30', 'timeout=45'), 'class Writer:' + twice.split('class Writer:', 1)[1] if False else twice):
        try:
            mod.patch_runner(text)
        except RuntimeError as exc:
            assert 'missing or ambiguous' in str(exc), exc
        else:
            raise AssertionError('must fail closed')


def test_duplicate_marker_fails():
    try:
        mod.patch_runner(mod.MARKER + '\n' + mod.MARKER + '\n')
    except RuntimeError as exc:
        assert 'duplicated' in str(exc)
    else:
        raise AssertionError('must fail closed')


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print('ok', name)
