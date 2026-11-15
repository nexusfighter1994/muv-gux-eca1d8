import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('fxb', HERE / 'fx-smart-bake-install.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

NATIVE = ('X;await a("ffmpeg",()=>l(vPs({basePath:t,clipPath:g,pieces:I,totalFrames:C,width:S.width,height:S.height,'
          'encodeArgs:T,outPath:b}),{signal:f,timeoutMs:JUn})),f?.throwIfAborted?.();Y')


def test_patch_routes_only_that_call():
    out = mod.patch_node(NATIVE)
    assert out.count(mod.MARKER) == 1
    assert out.startswith('X;await a("ffmpeg",()=>/* vf-custom:fx-smart-bake-v1 */')
    assert ('.bakeChunk({buildFullArgs:vPs,args:{basePath:t,clipPath:g,pieces:I,totalFrames:C,width:S.width,'
            'height:S.height,encodeArgs:T,outPath:b},ffmpeg:l,options:{signal:f,timeoutMs:JUn}}))') in out
    assert out.endswith(',f?.throwIfAborted?.();Y')


def test_idempotent():
    once = mod.patch_node(NATIVE)
    assert mod.patch_node(once) == once


def test_fails_closed_when_missing_or_ambiguous():
    for text in ('nothing here', NATIVE + NATIVE):
        try:
            mod.patch_node(text)
        except RuntimeError as exc:
            assert 'missing or ambiguous' in str(exc)
        else:
            raise AssertionError('must fail closed')


def test_duplicate_marker_fails():
    try:
        mod.patch_node(mod.MARKER + mod.MARKER)
    except RuntimeError as exc:
        assert 'duplicated' in str(exc)
    else:
        raise AssertionError('must fail closed')


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print('ok', name)
