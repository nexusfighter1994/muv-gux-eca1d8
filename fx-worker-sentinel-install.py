"""Patch the fresh native FX runner only; no restart or live activation commands."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile


MARKER = '# vf-custom:fx-worker-output-sentinel-v2'
LEGACY_MARKER = '# vf-custom:fx-worker-output-sentinel-v1'
FINGERPRINT = 'cc2864e820d26b32a95a0b9a3751b9d4c4aeb3ea2cfd134b872eba9adb43046a'
LEGACY_HELPER_SHA256 = '331882b1fde13c57612f1bb30d3a246b262746ad900dcb81efbda2faeabc381a'
OLD = '    t0 = time.time()\n'
LEGACY_PATCH = '''    # vf-custom:fx-worker-output-sentinel-v1
    from src.core.pc_fx_dir_guard import protect_fx_output as _vf_protect_fx_output
    _vf_protect_fx_output(spec)
    t0 = time.time()
'''
NEW = LEGACY_PATCH.replace(LEGACY_MARKER, MARKER)


def patch_source(text):
    try:
        tree = ast.parse(text)
    except SyntaxError as error:
        raise RuntimeError('Native FX runner source syntax changed') from error
    methods = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == 'run']
    if len(methods) != 1 or methods[0] not in tree.body or not isinstance(methods[0], ast.FunctionDef):
        raise RuntimeError('Native FX run method count/location changed')
    method = methods[0]; lines = text.splitlines(keepends=True)
    raw = ''.join(lines[method.lineno - 1:method.end_lineno])
    body = raw.replace('\r\n', '\n')
    if not body.endswith('\n'): body += '\n'
    present = [(marker, block) for marker, block in ((MARKER, NEW), (LEGACY_MARKER, LEGACY_PATCH))
               if marker in text]
    if present:
        marker, block = present[0]
        if len(present) != 1 or text.count(marker) != 1 or body.count(block) != 1:
            raise RuntimeError('Native FX sentinel marker/patch is incomplete')
        original = body.replace(block, OLD)
    else:
        if body.count(OLD) != 1: raise RuntimeError('Native FX first-operation fingerprint changed')
        original = body
    if hashlib.sha256(original.encode()).hexdigest() != FINGERPRINT:
        raise RuntimeError('Native FX run method fingerprint changed')
    if MARKER in text: return text
    updated = original.replace(OLD, NEW)
    if '\r\n' in raw: updated = updated.replace('\n', '\r\n')
    if not raw.endswith(('\r', '\n')): updated = updated.rstrip('\r\n')
    result = ''.join(lines[:method.lineno - 1]) + updated + ''.join(lines[method.end_lineno:])
    ast.parse(result)
    return result


def install(root, *, apply=False):
    root = Path(root).resolve(strict=True)
    runner = root / 'src' / 'core' / 'fxtransitions' / 'runner.py'
    target = root / 'src' / 'core' / 'pc_fx_dir_guard.py'
    source = Path(__file__).resolve().parent / 'fflow' / 'pc_fx_dir_guard.py'
    for file in (runner, target):
        if file.is_symlink() or not file.resolve().is_relative_to(root):
            raise RuntimeError('Native FX installer target escaped root')
    with runner.open(encoding='utf-8', newline='') as stream: native = stream.read()
    updated = patch_source(native)
    helper = source.read_bytes(); ast.parse(helper)
    existing = target.read_bytes() if target.exists() else None
    if existing is not None and existing != helper:
        if hashlib.sha256(existing.replace(b'\r\n', b'\n')).hexdigest() != LEGACY_HELPER_SHA256:
            raise RuntimeError('Existing native FX helper differs; refusing overwrite')
    plans = []
    if existing != helper: plans.append(('helper', target, helper))
    if updated != native: plans.append(('runner', runner, updated.encode()))
    staged = []
    try:
        if apply:
            for name, file, data in plans:
                descriptor, filename = tempfile.mkstemp(prefix='.fx-sentinel-', suffix='.py', dir=file.parent)
                temporary = Path(filename); staged.append((temporary, file))
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(data); stream.flush(); os.fsync(stream.fileno())
                temporary.chmod(stat.S_IMODE(file.stat().st_mode) if file.exists() else 0o644)
            # Publish the helper before the hook; already-running children remain untouched.
            for temporary, file in staged: os.replace(temporary, file)
    finally:
        for temporary, _ in staged: temporary.unlink(missing_ok=True)
    return {'mode': 'apply' if apply else 'check', 'changed': [name for name, _, _ in plans], 'root': str(root)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='/app/engines/fflow')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true'); mode.add_argument('--check', action='store_true')
    args = parser.parse_args(); print(json.dumps(install(args.root, apply=args.apply)))


if __name__ == '__main__': main()
