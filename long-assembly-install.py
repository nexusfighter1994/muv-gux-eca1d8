"""Reviewed upstream function adapter; never import the application to install it."""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARKER = '/* vf-custom:long-assembly */'
HASH_MARKER = '/* vf-custom:final-hash-block-v1 */'
ARTIFACT_HASH_MARKER = '/* vf-custom:artifact-hash-cooperative-v2 */'


def patch_final_artifact_hash(text):
    if ARTIFACT_HASH_MARKER in text:
        return text
    names = re.findall(r'sha256:await ([\w$]+)\([\w$]+\),durationSec:', text)
    if len(names) != 1 or text.count('async function ' + names[0] + '(') != 1:
        raise RuntimeError('Reviewed final artifact hasher changed or ambiguous')
    name = names[0]
    if not re.search(r'async function ' + re.escape(name) + r'\([\w$]+\)\{let [\w$]+=[\w$]+\.createHash\("sha256"\);return await new Promise\(', text):
        raise RuntimeError('Reviewed artifact SHA256 body drifted')
    legacy = f'\n/* vf-custom:final-artifact-hash-v1 */;{name}=__vfCustom.createFinalHasher({name},{{onlyFinalFiles:true}});\n'
    hook = f'\n{ARTIFACT_HASH_MARKER};{name}=__vfCustom.createFinalHasher({name});\n'
    if '/* vf-custom:final-artifact-hash-v1 */' in text:
        if text.count(legacy) != 1:
            raise RuntimeError('Reviewed legacy artifact hash hook drifted')
        return text.replace(legacy, hook, 1)
    return text + hook


def patch_final_hash(text):
    if HASH_MARKER in text:
        return text
    signature = (r'async function ([\w$]+)\((\w+)\)\{let (\w+)=(\w+)\.createHash\("sha256"\);'
                 r'return await new Promise\(\((\w+),(\w+)\)=>\{let (\w+)=(\w+)\.createReadStream\(\2\);'
                 r'\7\.on\("data",(\w+)=>\3\.update\(\9\)\),\7\.once\("error",\6\),'
                 r'\7\.once\("end",\5\)\}\),\3\.digest\("hex"\)\}')
    matches = list(re.finditer(signature, text))
    if len(matches) > 1:
        finishing = re.findall(r'sha256:[\w$]+\?[\w$]+\.sha256:await ([\w$]+)\(', text)
        matches = [m for m in matches if finishing == [m.group(1)]]
    if len(matches) != 1:
        raise RuntimeError('Reviewed final SHA256 stream changed or ambiguous')
    name = matches[0].group(1)
    return text + f'\n{HASH_MARKER};{name}=__vfCustom.createFinalHasher({name});\n'


def patch_node(text):
    text = patch_final_artifact_hash(patch_final_hash(text))
    if MARKER in text:
        return text
    contract = json.loads((HERE / 'long-assembly-contract.json').read_text())
    original = contract['transition']
    if text.count(original) != 1 or original.count(contract['oldGuard']) != 1:
        raise RuntimeError('Reviewed long-assembly native function changed')
    if text.count(contract['safeSignature']) != 1:
        raise RuntimeError('Reviewed safe-join signature changed')
    replacement = original.replace(contract['oldGuard'], contract['newGuard'])
    text = text.replace(original, replacement)
    return text + '\n' + MARKER + ';(()=>{Fgn=__vfCustom.createLongSafeJoin(Fgn,{probe:(a,o)=>GAt(a,o),run:(a,o)=>it(a,o)});__vfCustom.report("longAssembly",true)})();\n'
