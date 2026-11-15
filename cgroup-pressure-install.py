"""Correct file-cache pressure accounting without changing admission thresholds."""
import re

MARKER = '/* vf-custom:cgroup-pressure-accounting-v1 */'


def patch_node(text):
    if MARKER in text:
        if text.count(MARKER) != 1 or text.count('__vfPressure.accountCgroupPressure(') != 1:
            raise RuntimeError('Cgroup pressure hook is incomplete or duplicated')
        return text
    pattern = re.compile(
        r'function (?P<fn>[\w$]+)\(\)\{let (?P<current>[\w$]+)=[\w$]+\(\);'
        r'if\((?P=current)==null\)return null;let (?P<inactive>[\w$]+)=0;try\{'
        r'let (?P<raw>[\w$]+)=[\w$]+\.readFileSync\([\w$]+\|\|[\w$]+,"utf8"\),'
        r'(?P<parsed>[\w$]+)=Number\((?P=raw)\.match\(/\^inactive_file\\s\+\(\\d\+\)\$/m\)\?\.\[1\]\);'
        r'Number\.isFinite\((?P=parsed)\)&&(?P=parsed)>=0&&\((?P=inactive)=(?P=parsed)\)'
        r'\}catch\{\}return Math\.max\(0,(?P=current)-(?P=inactive)\)/(?P<unit>[\w$]+)\}'
    )
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise RuntimeError('Native cgroup pressure boundary missing or ambiguous')
    match = matches[0]
    old = match.group(0)
    replacement = old.replace('}catch{}',
        f';return __vfPressure.accountCgroupPressure({match["current"]},{match["raw"]},'
        f'Math.max(0,{match["current"]}-{match["inactive"]}))/{match["unit"]}'
        '}catch{}', 1)
    result = text[:match.start()] + replacement + text[match.end():]
    return ('import __vfPressure from "./vf-custom/cgroup-pressure.cjs";\n' + result +
            f'\n{MARKER};__vfCustom.report("cgroupPressureAccounting",true);\n')
