"""Small steps first, 2026-11-13 (owner: "2-3 Slots immer fuer die kleinen Schritte, damit immer welche erledigt
werden; der Home-PC soll eher die kleinen abkriegen").

Takes effect only at the next API start AND only once /data/runtime/vf-small-steps.json holds {"enabled":true}.

1. node/small-steps.cjs (new file, copied as is): the black-bar detection before a credit render
   (brollVideo.renderSegment) gets the scheduler's interactive priority, its own resource key 'ffmpegSmall'
   and a gate pass while real MemAvailable stays above 4096 MB. Measured 13.11.: that 2-9 s probe waited
   5673-5976 s behind candidate scene analyses and held 264 finished final cuts for 100 min.
2. node/home-ram-estimate.cjs: 'ffmpegSmall' reserves 256 MB (shape of the ffmpeg estimate); version v7.
3. node/home-pool-claim.cjs: the Home composition cap (10) can be set at runtime,
   /data/runtime/vf-home-claim.json {"compositionCap": 1-20}; default unchanged.
4. node/custom.mjs: installHomeDirect also installs small-steps.cjs (reported as hook 'smallSteps').

Usage (idempotent; callers keep the backups, see backups/before-small-steps-20261113):
  python3 small-steps-install.py ram <home-ram-estimate.cjs> [...]
  python3 small-steps-install.py claim <home-pool-claim.cjs> [...]
  python3 small-steps-install.py custom <custom.mjs> [...]
  python3 small-steps-install.py check-bundle <index.mjs>     # the tagged callback must exist exactly once
"""
import sys
from pathlib import Path

MARK = 'vf-custom:small-steps-v1'
CAP_MARK = 'vf-custom:composition-cap-runtime-v1'
BUNDLE_CALLBACK = '()=>(u.detectBars||CKe)(me.clipPath,{durationSec:z})'

RAM_EDITS = [
    ("const FALLBACKS = ['ffmpegHomeFallback', 'ffmpegHomeTrimFallback', 'ffmpegHomeNormalizeFallback'];\n",
     "const FALLBACKS = ['ffmpegHomeFallback', 'ffmpegHomeTrimFallback', 'ffmpegHomeNormalizeFallback'];\n"
     "// " + MARK + " (2026-11-13): the bar detection before a credit render (small-steps.cjs) is a\n"
     "// 2-9 s probe. It reserves 256 MB instead of the learned 1.1-2.2 GB of ffmpeg:b_roll_video.\n"
     "const SMALL_STEP_KEY = 'ffmpegSmall', SMALL_STEP_MB = 256;\n"),
    ("  if (original.__vfHomeRamVersion === 'home-only-v6') return original;\n",
     "  if (original.__vfHomeRamVersion === 'home-only-v7') return original;\n"),
    ("    const estimate = original.call(this, request);\n    // Reserve the dispatcher's server RAM",
     "    if (request.resourceKey === SMALL_STEP_KEY) {\n"
     "      const estimate = original.call(this, { ...request, resourceKey: 'ffmpeg' });\n"
     "      return { ...estimate, mb: SMALL_STEP_MB };\n"
     "    }\n"
     "    const estimate = original.call(this, request);\n    // Reserve the dispatcher's server RAM"),
    ("  wrapped.__vfHomeRamVersion = 'home-only-v6';\n", "  wrapped.__vfHomeRamVersion = 'home-only-v7';\n"),
    ("module.exports = { wrapHomeRamEstimate, wrapHomeGate, memAvailableMb, HOME_DISPATCH_MB, HOME_FLOOR_MB };",
     "module.exports = { wrapHomeRamEstimate, wrapHomeGate, memAvailableMb, HOME_DISPATCH_MB, HOME_FLOOR_MB,\n"
     "  SMALL_STEP_KEY, SMALL_STEP_MB };"),
]

CLAIM_EDITS = [
    ("const COMPOSITION_CAP = 10;\nfunction limitCompositions(canClaim, { cap = COMPOSITION_CAP } = {}) {\n",
     "const COMPOSITION_CAP = 10;\n"
     "// " + CAP_MARK + " (2026-11-13): the cap can be changed without a restart, so Home's CPU\n"
     "// slots can be shifted between long compositions and small work while measuring:\n"
     "// /data/runtime/vf-home-claim.json {\"compositionCap\": 1-20}. Missing or invalid = COMPOSITION_CAP.\n"
     "const CLAIM_PATH = '/data/runtime/vf-home-claim.json';\n"
     "const validCap = value => Number.isInteger(value) && value >= 1 && value <= 20;\n"
     "function createCapReader({ path = CLAIM_PATH, now = Date.now, read = p => fs.readFileSync(p, 'utf8') } = {}) {\n"
     "  let cached = { at: -Infinity, value: null };\n"
     "  return () => {\n"
     "    const t = now();\n"
     "    if (t - cached.at >= 1000 || t < cached.at) {\n"
     "      let value = null;\n"
     "      try { value = JSON.parse(read(path))?.compositionCap; } catch { value = null; }\n"
     "      cached = { at: t, value: validCap(value) ? value : null };\n"
     "    }\n"
     "    return cached.value;\n"
     "  };\n"
     "}\n"
     "function limitCompositions(canClaim, { cap = COMPOSITION_CAP, readCap = createCapReader() } = {}) {\n"),
    ("    if (isComposition(w) && scopes.filter(isComposition).length >= cap) return false;\n",
     "    if (isComposition(w)) {\n"
     "      const runtime = readCap();\n"
     "      if (scopes.filter(isComposition).length >= (validCap(runtime) ? runtime : cap)) return false;\n"
     "    }\n"),
    ("module.exports = { claimLimit, createPoolReader, readyWorkers, makeCanClaim, excludeRecovering, poolScopesOnly,\n"
     "  limitCompositions, COMPOSITION_CAP };",
     "module.exports = { claimLimit, createPoolReader, readyWorkers, makeCanClaim, excludeRecovering, poolScopesOnly,\n"
     "  limitCompositions, createCapReader, COMPOSITION_CAP, CLAIM_PATH };"),
]

CUSTOM_EDITS = [
    ("export function installHomeDirect(...args) { if (homeQueueEnabled()) return _installHomeDirect(...args); }\n",
     "export function installHomeDirect(...args) {\n"
     "  if (!homeQueueEnabled()) return undefined;\n"
     "  const result = _installHomeDirect(...args);\n"
     "  // " + MARK + ": priority and an own RAM class for the bar detection before a credit render\n"
     "  // (small-steps.cjs; off until /data/runtime/vf-small-steps.json enables it).\n"
     "  try {\n"
     "    process.getBuiltinModule('module').createRequire(import.meta.url)('./small-steps.cjs').install({ scheduler: args[0]?.scheduler });\n"
     "    report('smallSteps', true);\n"
     "  } catch (error) { report('smallSteps', false, String(error?.message || error)); }\n"
     "  return result;\n"
     "}\n"),
]


def apply(text, edits, mark, name):
    if mark in text:
        return text, 'already'
    for old, new in edits:
        if text.count(old) != 1:
            raise SystemExit(f'{name}: anchor {old[:50]!r} found {text.count(old)} times')
        text = text.replace(old, new)
    return text, 'patched'


def rw(path, edits, mark):
    """Patches with LF anchors and writes the file back in its own line-ending style (some sources are CRLF)."""
    p = Path(path); raw = p.read_bytes()
    CRLF, LF = bytes([13, 10]), bytes([10])
    crlf = raw.count(CRLF)
    if crlf and crlf != raw.count(LF):
        raise SystemExit(f'{path}: mixed line endings, refusing to patch')
    text = raw.replace(CRLF, LF).decode('utf-8')
    out, state = apply(text, edits, mark, p.name)
    if out != text:
        data = out.encode('utf-8')
        p.write_bytes(data.replace(LF, CRLF) if crlf else data)
    print(path, state, '(CRLF kept)' if crlf else '')


if __name__ == '__main__':
    mode, args = sys.argv[1], sys.argv[2:]
    if mode == 'ram':
        for a in args: rw(a, RAM_EDITS, MARK)
    elif mode == 'claim':
        for a in args: rw(a, CLAIM_EDITS, CAP_MARK)
    elif mode == 'custom':
        for a in args: rw(a, CUSTOM_EDITS, MARK)
    elif mode == 'check-bundle':
        n = Path(args[0]).read_text(encoding='utf-8').count(BUNDLE_CALLBACK)
        print(args[0], 'bar-detection callback found', n, 'time(s)')
        if n != 1:
            raise SystemExit(1)
    else:
        raise SystemExit('unknown mode')
