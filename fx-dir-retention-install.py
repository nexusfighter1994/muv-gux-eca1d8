"""Guarded native temp-directory retention patch; check-only unless explicitly applied."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile


MARKER = '# vf-custom:fx-dir-retention-v2'
LEGACY_MARKER = '# vf-custom:fx-dir-retention-v1'
CONTRACTS = {
    'local': ('LocalStorage', '629a1e319f94ccea16f1812f73359c8797f4a61a03c2b0d5dab3006ced0a791e'),
    'minio': ('MinioClient', '0cf7148a1a5b8e03f4fd294ae1c94e531beafa29f745e0c5691511b29a4bb7b8'),
}
OLD = '''            for item in list(temp_dir.rglob("*")):
                if item.is_dir() and not any(item.iterdir()):
                    try:
                        item.rmdir()
                    except Exception:
                        pass
'''
LEGACY_PATCH = '''            for item in list(temp_dir.rglob("*")):
                if item.is_dir() and not any(item.iterdir()):
                    try:
                        # vf-custom:fx-dir-retention-v1
                        if temp_file_last_touched(item.stat()) < cutoff_time:
                            item.rmdir()
                    except Exception:
                        pass
'''
NEW = '''            for item in list(temp_dir.rglob("*")):
                if item.is_dir() and not any(item.iterdir()):
                    try:
                        # vf-custom:fx-dir-retention-v2
                        from src.core.mod_flags import mod_enabled as _vf_mod_enabled
                        if _vf_mod_enabled('fxRetention') and temp_file_last_touched(item.stat()) < cutoff_time:
                            item.rmdir()
                    except Exception:
                        pass
'''


def patch_source(text, backend):
    if backend not in CONTRACTS:
        raise RuntimeError('Unknown native storage backend')
    class_name, fingerprint = CONTRACTS[backend]
    try:
        tree = ast.parse(text)
    except SyntaxError as error:
        raise RuntimeError(f'Native {backend} source syntax changed') from error
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name]
    methods = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
               and n.name == 'cleanup_old_files']
    if len(classes) != 1 or len(methods) != 1 or methods[0] not in classes[0].body:
        raise RuntimeError(f'Native {backend} cleanup method count/class changed')
    method = methods[0]
    lines = text.splitlines(keepends=True)
    body = ''.join(lines[method.lineno - 1:method.end_lineno]).replace('\r\n', '\n')
    if not body.endswith('\n'):
        body += '\n'
    present = [(marker, block) for marker, block in ((MARKER, NEW), (LEGACY_MARKER, LEGACY_PATCH))
               if marker in text]
    if present:
        marker, block = present[0]
        if len(present) != 1 or text.count(marker) != 1 or body.count(block) != 1:
            raise RuntimeError(f'Native {backend} retention marker/patch is incomplete')
        original = body.replace(block, OLD)
    else:
        if body.count(OLD) != 1:
            raise RuntimeError(f'Native {backend} empty-directory fingerprint changed')
        original = body
    if hashlib.sha256(original.encode('utf-8')).hexdigest() != fingerprint:
        raise RuntimeError(f'Native {backend} cleanup method fingerprint changed')
    if MARKER in text:
        return text
    updated = original.replace(OLD, NEW)
    ending = '\r\n' if '\r\n' in ''.join(lines[method.lineno - 1:method.end_lineno]) else '\n'
    if ending != '\n':
        updated = updated.replace('\n', ending)
    if not lines[method.end_lineno - 1].endswith(('\n', '\r')):
        updated = updated.rstrip('\r\n')
    result = ''.join(lines[:method.lineno - 1]) + updated + ''.join(lines[method.end_lineno:])
    ast.parse(result)
    return result


def install(root, *, apply=False):
    root = Path(root).resolve(strict=True)
    plans = []
    # Validate both complete native contracts before staging or replacing either file.
    for backend in CONTRACTS:
        file = root / 'src' / 'storage' / (backend + '.py')
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(root):
            raise RuntimeError(f'Unsafe native {backend} source path')
        with file.open(encoding='utf-8', newline='') as stream:
            source = stream.read()
        updated = patch_source(source, backend)
        if updated != source:
            plans.append((backend, file, updated))
    staged = []
    try:
        if apply:
            for backend, file, updated in plans:
                descriptor, name = tempfile.mkstemp(prefix='.fx-dir-retention-', suffix='.py', dir=file.parent)
                temporary = Path(name)
                staged.append((temporary, file))
                with os.fdopen(descriptor, 'w', encoding='utf-8', newline='') as stream:
                    stream.write(updated)
                    stream.flush()
                    os.fsync(stream.fileno())
                temporary.chmod(stat.S_IMODE(file.stat().st_mode))
            for temporary, file in staged:
                os.replace(temporary, file)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
    return {'mode': 'apply' if apply else 'check', 'root': str(root),
            'changed': [backend for backend, _, _ in plans], 'marker': MARKER}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='/app/engines/fflow')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    print(json.dumps(install(args.root, apply=args.apply)))


if __name__ == '__main__':
    main()
