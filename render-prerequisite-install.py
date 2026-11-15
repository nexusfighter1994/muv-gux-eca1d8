"""Thin native fallback-control adapter; authorization validation stays untouched."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARKER = '/* vf-custom:render-prerequisite-v1 */'


def patch_node(text):
    contracts = json.loads((HERE / 'tests/fixtures/render-prerequisite-native.json').read_text())
    normalized = text.replace('\r\n', '\n')
    for name in ('axn', 'nc', 'Wxo', 'Kir'):
        original = contracts[name].replace('\r\n', '\n')
        if normalized.count(original) != 1:
            raise RuntimeError('Unreviewed native render prerequisite control: ' + name)
    if MARKER in text:
        return text
    return text + '\n' + MARKER + ''';(()=>{
const h=process.getBuiltinModule('module').createRequire(import.meta.url)('./vf-custom/render-prerequisite.cjs');
const c=h.install({axn,nc,Wxo},{enabled:()=>__vfCustom.modEnabled('renderPrerequisite')});
axn=c.axn;nc=c.nc;Wxo=c.Wxo;__vfCustom.report('renderPrerequisite',true);
})();\n'''
