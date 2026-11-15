"""Expose verified Japanese/Korean capabilities without changing provider settings."""
import re

GATE_MARK = '/* vf-custom:voice-ja-ko-gate-v1 */'
SCHEMA_MARK = '/* vf-custom:voice-ja-ko-schema-v1 */'
GATE = re.compile(
    r'function (?P<fn>[\w$]+)\((?P<provider>[\w$]+),(?P<lang>[\w$]+)\)'
    r'\{let (?P<resolved>[\w$]+)=(?P<resolve>[\w$]+)\((?P=lang)\);'
    r'return (?P=resolved)\?(?P<allowed>[\w$]+)\[(?P=provider)==="genaipro"'
    r'\?"genAiPro":(?P=provider)\]\?\.includes\((?P=resolved)\.label\)===!0:!0\}'
)
SCHEMA = re.compile(
    r'function (?P<fn>[\w$]+)\((?P<row>[\w$]+)\)\{if\(!(?P=row)\)return null;'
    r'let (?P<schema>[\w$]+)=\{\};try\{(?P=schema)=JSON\.parse\('
    r'(?P=row)\.schema_json\)\|\|\{\}\}catch\{(?:(?P=schema)=\{\})?\}'
    r'return\{\.\.\.(?P=schema),autoDefaultVoice:'
)


def gate_code(provider, resolved):
    return (GATE_MARK + f'if(({provider}==="fishAudio"||{provider}==="fishaudio"||{provider}==="ai33pro")'
            f'&&["Japanese","Korean"].includes({resolved}?.label))return !0;')


def schema_code(schema):
    return (SCHEMA_MARK + f'if(Array.isArray({schema}.voiceProviders))'
            f'for(const p of {schema}.voiceProviders)'
            'if(p&&(p.id==="fishAudio"||p.id==="ai33pro"))'
            'p.experimentalLanguages=[...new Set([...(Array.isArray(p.experimentalLanguages)'
            '?p.experimentalLanguages:[]),"Japanese","Korean"])];')


def patch_node(text):
    original = text
    marked = GATE_MARK in text or SCHEMA_MARK in text
    if marked:
        if text.count(GATE_MARK) != 1 or text.count(SCHEMA_MARK) != 1:
            raise RuntimeError('Partial or duplicate Japanese/Korean voice patch')
        text = re.sub(re.escape(GATE_MARK) + r'.*?return !0;', '', text, count=1)
        text = re.sub(re.escape(SCHEMA_MARK) + r'.*?"Japanese","Korean"\]\)\];', '', text, count=1)
    gates, schemas = list(GATE.finditer(text)), list(SCHEMA.finditer(text))
    if len(gates) != 1 or len(schemas) != 1:
        raise RuntimeError(f'Voice language fingerprints: gates={len(gates)}, schemas={len(schemas)}')
    gate, schema = gates[0], schemas[0]
    edits = [
        (gate.start() + gate.group().index('return '), gate_code(gate['provider'], gate['resolved'])),
        (schema.start() + schema.group().index('return{...'), schema_code(schema['schema'])),
    ]
    for offset, code in sorted(edits, reverse=True):
        text = text[:offset] + code + text[offset:]
    # Upgrade only the exact previous gate, preserving fail-closed drift checks.
    new_gate = gate_code(gate['provider'], gate['resolved'])
    old_gate = new_gate.replace(f'||{gate["provider"]}==="fishaudio"', '', 1)
    expected = original.replace(old_gate, new_gate, 1)
    if marked and text != expected:
        raise RuntimeError('Japanese/Korean voice patch drift')
    return text
