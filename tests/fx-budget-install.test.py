import ast
import importlib.util
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('fxb', HERE / 'fx-budget-install.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# The native shape of fxtransitions/service.py (budget function plus the start of its caller).
NATIVE = '''import asyncio
import os


def fx_timeout_seconds(windows) -> float:
    """Generous wall-clock budget: ~3 s per window frame, at least two minutes."""
    frames = sum(max(0, int(w['end']) - int(w['start'])) for w in windows)
    override = os.environ.get('FFLOW_FX_TIMEOUT_SECONDS')
    if override:
        try:
            return max(10.0, float(override))
        except ValueError:
            pass
    return max(120.0, frames * 3.0)


async def run_fx_transitions(spec: dict, timeout: float | None = None) -> dict:
    timeout = fx_timeout_seconds(spec['windows']) if timeout is None else timeout
    return {'timeout': timeout}
'''


def load(text):
    scope = {}
    exec(compile(text, 'service.py', 'exec'), scope)
    return scope['fx_timeout_seconds']


def test_only_the_budget_line_changes():
    out = mod.patch_service(NATIVE)
    assert out.count(mod.MARKER) == 1
    changed = [(a, b) for a, b in zip(NATIVE.splitlines(), out.splitlines()) if a != b]
    assert len(changed) == 1 and len(NATIVE.splitlines()) == len(out.splitlines())
    assert changed[0][0] == '    return max(120.0, frames * 3.0)'
    assert changed[0][1].startswith('    return max(360.0, frames * 6.0)  # vf-custom:fx-budget-v1')
    ast.parse(out)


def test_budget_values_never_below_native():
    native, patched = load(NATIVE), load(mod.patch_service(NATIVE))
    os.environ.pop('FFLOW_FX_TIMEOUT_SECONDS', None)
    for frames in (0, 1, 24, 40, 60, 61, 100, 149, 150, 400):
        w = [{'start': 0, 'end': frames}]
        assert patched(w) >= native(w)
        assert patched(w) == max(360.0, frames * 6.0)
    assert patched([{'start': 10, 'end': 4}]) == 360.0, 'negative window lengths count as zero'
    assert patched([{'start': 0, 'end': 50}, {'start': 90, 'end': 140}]) == 600.0


def test_env_override_still_wins():
    patched = load(mod.patch_service(NATIVE))
    os.environ['FFLOW_FX_TIMEOUT_SECONDS'] = '45'
    try:
        assert patched([{'start': 0, 'end': 500}]) == 45.0
        os.environ['FFLOW_FX_TIMEOUT_SECONDS'] = 'abc'
        assert patched([{'start': 0, 'end': 10}]) == 360.0
    finally:
        os.environ.pop('FFLOW_FX_TIMEOUT_SECONDS', None)


def test_idempotent():
    once = mod.patch_service(NATIVE)
    assert mod.patch_service(once) == once


def test_fails_closed_when_missing_or_ambiguous():
    moved = NATIVE.replace('    return max(120.0, frames * 3.0)\n', '') + '\n\ndef other():\n    frames = 1\n    return max(120.0, frames * 3.0)\n'
    for text in ('x = 1\n',
                 NATIVE.replace('frames * 3.0', 'frames * 4.0'),
                 NATIVE.replace('def fx_timeout_seconds(windows) -> float:', 'def fx_budget(windows) -> float:'),
                 NATIVE + '\n\ndef again(frames):\n    return max(120.0, frames * 3.0)\n',
                 moved):
        try:
            mod.patch_service(text)
        except RuntimeError as exc:
            assert 'missing or ambiguous' in str(exc), exc
        else:
            raise AssertionError('must fail closed')


def test_duplicate_marker_fails():
    try:
        mod.patch_service(mod.MARKER + '\n' + mod.MARKER + '\n')
    except RuntimeError as exc:
        assert 'duplicated' in str(exc)
    else:
        raise AssertionError('must fail closed')


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print('ok', name)
