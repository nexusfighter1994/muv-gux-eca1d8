import importlib.util
import shutil
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('fdt', HERE / 'ffmpeg-default-timeout-install.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# The native shape: spawn helper with the default, the constants, and the second use as a floor.
NATIVE = ('function Z_t(e,t,{timeoutMs:r=J_t,signal:n,chunkIndex:o,onSpawn:i}={}){return r}'
          'var uCi,dJ,P$,J_t,Vge;uCi=1;dJ="FFMPEG_TIMEOUT",P$=3e4,J_t=12e4,Vge=Object.freeze(["-pix_fmt"]);'
          'function q(o){return Math.max(J_t,6e4+Math.ceil(o*8e3))}'
          'export const probe=()=>[Z_t(0,0),Z_t(0,0,{timeoutMs:P$}),q(1),q(100),dJ];')


def test_only_the_default_changes():
    out = mod.patch_node(NATIVE)
    assert out.count(mod.MARKER) == 1
    assert 'J_t=/* vf-custom:ffmpeg-default-timeout-v1 */36e4,Vge=' in out
    assert 'P$=3e4' in out, 'probe timeout untouched'
    assert out.replace(mod.MARKER + '36e4', '12e4') == NATIVE


def test_idempotent():
    once = mod.patch_node(NATIVE)
    assert mod.patch_node(once) == once


def test_fails_closed():
    cases = {
        'missing': 'const x=1;',
        'other value': NATIVE.replace('J_t=12e4', 'J_t=18e4'),
        'ambiguous': NATIVE + ';dJ2="FFMPEG_TIMEOUT",P2=3e4,J2=12e4,x=1',
        'no default use': NATIVE.replace('{timeoutMs:r=J_t,', '{timeoutMs:r,'),
        'two default uses': NATIVE + ';function Z2(e,{timeoutMs:r=J_t,a}={}){}',
    }
    for name, text in cases.items():
        try:
            mod.patch_node(text)
        except RuntimeError:
            continue
        raise AssertionError(f'must fail closed: {name}')


def test_duplicate_marker_fails():
    try:
        mod.patch_node(mod.MARKER + mod.MARKER)
    except RuntimeError as exc:
        assert 'duplicated' in str(exc)
    else:
        raise AssertionError('must fail closed')


def test_patched_code_runs_with_the_new_default():
    node = shutil.which('node')
    if not node:
        print('skip: node not available')
        return
    with tempfile.TemporaryDirectory() as tmp:
        results = {}
        for label, code in (('native', NATIVE), ('patched', mod.patch_node(NATIVE))):
            file = Path(tmp) / f'{label}.mjs'
            file.write_text(code + 'console.log(JSON.stringify(probe()));', encoding='utf-8')
            results[label] = subprocess.run([node, str(file)], capture_output=True, text=True, check=True).stdout.strip()
        assert results['native'] == '[120000,30000,120000,860000,"FFMPEG_TIMEOUT"]', results
        assert results['patched'] == '[360000,30000,360000,860000,"FFMPEG_TIMEOUT"]', results


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print('ok', name)
