"""Single-pass composition for chunks whose only effects are camera moves (zoom/pan), 2026-11-21.

Measured 21.11. (vf-home-offload-timing.jsonl): 217 of 331 queued chunk compositions (66 %) carry a `zoom`
effect and therefore skip the single pass ("segment N uses layers/effects/filters/text/subtitles"). They run
the multi-pass chain: smooth camera render, one prepared-segment encode per segment, concat, audio mix, final
encode. On Home that took 380-820 s per chunk instead of 90-200 s, because every stage moves its intermediate
(prepared segments ~29 MB each from ~8 MB inputs, crf 18 / fast) over the home line in both directions.

This patch lets `_render_single_pass` take such chunks: a segment whose effects are all camera effects is
rendered by the same smooth camera renderer with the same arguments as `_prepare_single_segment`; its
canvas-sized video then enters the single-pass graph in place of the source (no scale step, exactly like the
multi-pass chain feeds it to the prepared-segment filter). Everything after that is the existing single pass.
Any failure still falls back to the multi-pass chain (`_try_single_pass`).

Off by default. Hot switch, read per composition: /data/runtime/vf-single-pass-camera.json {"enabled": true}.
"""

MARKER = '# vf-custom:single-pass-camera-v1'

HELPER = '''

# vf-custom:single-pass-camera-v1 (2026-11-21): hot switch for camera-only (zoom/pan) chunks in the single pass.
def _vf_single_pass_camera_enabled() -> bool:
    try:
        import json as _json
        import os as _os
        path = _os.environ.get("VF_SINGLE_PASS_CAMERA", "/data/runtime/vf-single-pass-camera.json")
        with open(path, encoding="utf-8") as stream:
            value = _json.load(stream)
        return isinstance(value, dict) and value.get("enabled") is True
    except Exception:  # noqa: BLE001 -- missing or broken switch = off
        return False


def _vf_camera_only_effects(segment) -> list:
    """The segment's camera effects when ALL of its effects are camera effects, else []."""
    effects = list(getattr(segment, "effects", None) or [])
    if not effects:
        return []
    camera_effects, other = split_camera_effects(effects)
    return list(camera_effects) if camera_effects and not other else []
'''

REPLACEMENTS = [
    # 1. helper after the single-pass constants
    ('SINGLE_PASS_INPUT_THREADS = 2\n',
     'SINGLE_PASS_INPUT_THREADS = 2\n' + HELPER),
    # 2. eligibility: camera-only effects may use the single pass while the switch is on
    ('            if segment.layers or segment.effects or segment.filters or segment.text_layers or segment.subtitles:\n'
     '                return f"segment {index} uses layers/effects/filters/text/subtitles"\n',
     '            if segment.layers or segment.filters or segment.text_layers or segment.subtitles:\n'
     '                return f"segment {index} uses layers/effects/filters/text/subtitles"\n'
     '            if segment.effects and not (_vf_single_pass_camera_enabled() and _vf_camera_only_effects(segment)):\n'
     '                return f"segment {index} uses layers/effects/filters/text/subtitles"\n'),
    # 3. input: the smooth camera video replaces the source
    ('            source = ctx.sources[segment.source]\n'
     '            is_image = segment.type == "image"\n'
     '            # Many decoders run side by side here; cap each one\'s threads so a\n'
     '            # 10-segment chunk does not start 10 x cores decoder threads.\n'
     '            if is_image:\n'
     '                builder.input(\n',
     '            source = ctx.sources[segment.source]\n'
     '            is_image = segment.type == "image"\n'
     '            # vf-custom:single-pass-camera-v1: same renderer call as _prepare_single_segment (single-layer case).\n'
     '            vf_camera_effects = _vf_camera_only_effects(segment)\n'
     '            vf_camera_path = None\n'
     '            if vf_camera_effects:\n'
     '                ctx.check_cancelled()\n'
     '                vf_camera_path = await self._render_smooth_camera_source(\n'
     '                    ctx=ctx,\n'
     '                    input_path=source.local_path,\n'
     '                    camera_effects=vf_camera_effects,\n'
     '                    duration_frames=int(segment.duration_frames),\n'
     '                    seg_index=index,\n'
     '                    source_is_image=is_image,\n'
     '                    include_audio=bool(source.has_audio and not is_image),\n'
     '                    fit="contain",\n'
     '                    fill=self._segment_fill(segment, source, ctx),\n'
     '                )\n'
     '            # Many decoders run side by side here; cap each one\'s threads so a\n'
     '            # 10-segment chunk does not start 10 x cores decoder threads.\n'
     '            if vf_camera_path is not None:\n'
     '                builder.input(str(vf_camera_path), threads=SINGLE_PASS_INPUT_THREADS)\n'
     '            elif is_image:\n'
     '                builder.input(\n'),
    # 4. video chain: the camera video is already fitted to the canvas
    ('            segment_fill = self._segment_fill(segment, source, ctx)\n'
     '            if segment_fill is not None:\n'
     '                for chain in build_blur_fill_chains(\n'
     '                    f"{index}:v",\n'
     '                    scaled_label,\n',
     '            segment_fill = self._segment_fill(segment, source, ctx)\n'
     '            if vf_camera_path is not None:\n'
     '                # Already fitted to the canvas by the camera renderer; the multi-pass chain feeds it\n'
     '                # to the prepared-segment filter unscaled as well.\n'
     '                scaled_label = f"{index}:v"\n'
     '            elif segment_fill is not None:\n'
     '                for chain in build_blur_fill_chains(\n'
     '                    f"{index}:v",\n'
     '                    scaled_label,\n'),
]


def patch_composer(text):
    if MARKER in text:
        return text
    newline = '\r\n' if '\r\n' in text else '\n'
    body = text.replace('\r\n', '\n')
    for old, new in REPLACEMENTS:
        if body.count(old) != 1:
            raise RuntimeError(f'single-pass-camera fingerprint missing or ambiguous ({body.count(old)}): {old[:70]!r}')
        body = body.replace(old, new)
    return body.replace('\n', newline) if newline != '\n' else body


if __name__ == '__main__':
    import sys
    source = open(sys.argv[1], encoding='utf-8', newline='').read()
    result = patch_composer(source)
    if len(sys.argv) > 2:
        open(sys.argv[2], 'w', encoding='utf-8', newline='').write(result)
    print('patched' if result != source else 'unchanged', len(result) - len(source), 'bytes')
