"""Restart pack 2026-11-12 (owner: "A, wenn mal ein paar Videos fertig sind den Neustart machen").

Takes effect only at the next API start. Three text patches:

1. index.mjs (bundle): SigLIP rank deadlines of the current build
     thumbnail rank  deadlineTs:Date.now()+3e4   -> +9e4   (30 s -> 90 s)
     shot rank       deadlineTs:Date.now()+12e4  -> +24e4  (120 s -> 240 s)
   On 12.11. ranks that the Home GPU finished late were thrown away at exactly 30 s / 120 s (12 % at
   concurrency 20), recomputed natively and the segment searched again. The runSeparate budget stays 300 s.
2. vf-custom/home-siglip.mjs: isHomeSiglipEmbedCallback matches callbacks by exact source text, so the two
   patched callbacks are ADDED to its list (the old ones stay: the module works with either bundle).
3. vf-custom/home-motion-dispatch.cjs: the RAM-budget estimate of a Home motion render 1024 -> 256 MB
   (new ESTIMATE_MB; STAGING_MB stays 1024 for the real-MemAvailable guard). It reserved 1024 MB of the
   server RAM budget although it renders on the Home PC; measured 12.11.: its dispatcher
   (pc_scene_graphics_cli.py) holds 41 MB RSS (16 processes, max 46 MB). 8-9 scopes kept ~8-9 GB of the
   51 GB budget and the native ffmpeg lane ran 7-12 of 16 slots with 600-1400 queued.

Usage:
  python3 restart-pack-install.py bundle <index.mjs> <home-siglip.mjs>     # patch a bundle file in place
  python3 restart-pack-install.py siglip <home-siglip.mjs> [...]
  python3 restart-pack-install.py motion <home-motion-dispatch.cjs> [...]
  python3 restart-pack-install.py motion-test <home-motion-dispatch.test.cjs> [...]
Idempotent. Callers keep the backups (see /opt/aufsetzen/vf-custom/backups/before-restart-pack-20261112).
"""
import sys
from pathlib import Path

MOTION_MARK = 'vf-custom:motion-staging-256-v1'
MOTION_OLD = "const STAGING_MB = 1024, FLOOR_MB = 4096, MAX_RECOVERING = 2;\n"
MOTION_NEW = (MOTION_OLD +
              "// " + MOTION_MARK + " (2026-11-12): the RAM-budget estimate of a Home motion render is 256 MB, not\n"
              "// STAGING_MB. Its server side is the dispatcher CLI (41 MB RSS measured, max 46 MB); 1024 MB per scope\n"
              "// kept 8-9 GB of the budget. STAGING_MB still guards real MemAvailable when admitting new scopes.\n"
              "const ESTIMATE_MB = 256;\n")
MOTION_USE_OLD = "return request.resourceKey==='motionHome'?{...result,mb:STAGING_MB}:result;"
MOTION_USE_NEW = "return request.resourceKey==='motionHome'?{...result,mb:ESTIMATE_MB}:result;"
SIGLIP_MARK = 'vf-custom:siglip-rank-deadlines-v1'


def callbacks(siglip_text):
    """The two current-build embedAndRank callbacks as home-siglip.mjs lists them, with their new forms."""
    found = {}
    for line in siglip_text.split('\n'):
        s = line.strip()
        if not (s.startswith("'()=>(s.embedAndRank||I9)(") and s.endswith("',")):
            continue
        body = s[1:-2]
        if body.endswith('deadlineTs:Date.now()+3e4})'):
            found['thumb'] = (line, body, body[:-len('+3e4})')] + '+9e4})')
        elif body.endswith('deadlineTs:Date.now()+12e4})'):
            found['shot'] = (line, body, body[:-len('+12e4})')] + '+24e4})')
    if set(found) != {'thumb', 'shot'}:
        raise SystemExit(f'home-siglip.mjs: expected the two I9 callbacks, found {sorted(found)}')
    return found


def patch_siglip(text):
    if SIGLIP_MARK in text:
        return text, 'already'
    out = text
    for key, (line, old, new) in callbacks(text).items():
        if out.count(line + '\n') != 1:
            raise SystemExit(f'home-siglip.mjs: matcher line for {key} not unique')
        indent = line[:len(line) - len(line.lstrip())]
        out = out.replace(line + '\n', line + '\n' + indent + "'" + new + "', // " + SIGLIP_MARK + '\n')
    return out, 'patched'


def patch_bundle(text, siglip_text):
    cbs = callbacks(siglip_text)
    state = []
    for key, (_, old, new) in cbs.items():
        n_old, n_new = text.count(old), text.count(new)
        if n_new == 1 and n_old == 0:
            state.append('already'); continue
        if n_old != 1 or n_new != 0:
            raise SystemExit(f'bundle: {key} callback old {n_old} / new {n_new}, expected 1 / 0')
        text = text.replace(old, new); state.append('patched')
    return text, '/'.join(state)


def patch_motion(text):
    if MOTION_MARK in text:
        return text, 'already'
    if text.count(MOTION_OLD) != 1 or text.count(MOTION_USE_OLD) != 1:
        raise SystemExit(f'home-motion-dispatch.cjs: anchors found {text.count(MOTION_OLD)} / {text.count(MOTION_USE_OLD)} times')
    return text.replace(MOTION_OLD, MOTION_NEW).replace(MOTION_USE_OLD, MOTION_USE_NEW), 'patched'


def patch_motion_test(text):
    if MOTION_MARK in text:
        return text, 'already'
    edits = [("assert.equal(wrapped({resourceKey:'motionHome'}).mb,1024);", "assert.equal(wrapped({resourceKey:'motionHome'}).mb,256); // " + MOTION_MARK),
             ("assert.deepEqual(seenEstimates,[1024,3000]);", "assert.deepEqual(seenEstimates,[256,3000]);")]
    for old, new in edits:
        if text.count(old) != 1:
            raise SystemExit(f'motion test: anchor {old[:40]!r} found {text.count(old)} times')
        text = text.replace(old, new)
    return text, 'patched'


def rw(path, fn, *extra):
    p = Path(path); raw = p.read_bytes(); text = raw.decode('utf-8')
    out, state = fn(text, *extra)
    if out != text:
        p.write_bytes(out.encode('utf-8'))
    print(path, state)


if __name__ == '__main__':
    mode, args = sys.argv[1], sys.argv[2:]
    if mode == 'bundle':
        rw(args[0], patch_bundle, Path(args[1]).read_text(encoding='utf-8'))
    elif mode == 'siglip':
        for a in args: rw(a, patch_siglip)
    elif mode == 'motion':
        for a in args: rw(a, patch_motion)
    elif mode == 'motion-test':
        for a in args: rw(a, patch_motion_test)
    else:
        raise SystemExit('unknown mode')
