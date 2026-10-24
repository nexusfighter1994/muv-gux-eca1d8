"""Fail-closed vf-custom build gate; stdlib only, no network or application imports.

Import with importlib/runpy, or run: python validate-hook-report.py hooks-build.json
The contract is reviewed independently of candidate output. Never learn it from
the candidate being checked: that would accept a hook disappearing upstream.
"""
import argparse
import json
from pathlib import Path
import sys


CONTRACT_VERSION = "vf-custom-41-20261023"
REQUIRED_HOOKS = (
    "fflow.ffmpegOffload",
    "fflow.nativeFxDirectoryProtection",
    "fflow.homeQueue",
    "fflow.sceneOffload",
    "fflow.slotCleanup",
    "fflow.tempDirectoryRetention",
    "node.ai33SttEnvelope",
    "node.autoRetry",
    "node.engineRetry",
    "node.engineSync",
    "node.etaDisplay",
    "node.fallbacks",
    "node.ffmpegAdmission",
    "node.fishFreeModel",
    "node.geomapIsolation",
    "node.gpuRenderEvents",
    "node.homeQueue",
    "node.chunkPollRecovery",
    "node.homeMap",
    "node.homeMotion",
    "node.lane",
    "node.mapAdmission",
    "node.marketGuard",
    "node.maxActiveGate",
    "node.maxActiveRestart",
    "node.restage",
    "node.routes",
    "node.sheetBatch",
    "node.siglipPc",
    "node.sourcingDeadline",
    "node.streamCompat",
    "node.longAssembly",
    "node.surplusFirst",
    "node.surplusRetries",
    "node.surplusWait",
    "node.thumbnailOpenlux",
    "node.thumbnailIdentity",
    "node.wake",
    "node.workerTarget",
    "ui.inject",
    "render.infographicTimeline",
)
OPTIONAL_HOOKS = ("node.bundle",)  # Informational already-patched marker only.


class HookReportError(ValueError):
    """Missing, unknown, malformed, or unsuccessful build evidence."""


def validate_hook_report(payload):
    """Return the full report unchanged, or raise with every contract violation."""
    if not isinstance(payload, dict) or not isinstance(payload.get("report"), dict):
        raise HookReportError("hooks-build.json must contain a report object")
    report = payload["report"]
    required = set(REQUIRED_HOOKS)
    known = required | set(OPTIONAL_HOOKS)
    errors = []
    missing = sorted(required - report.keys())
    if missing:
        errors.append("missing required hooks: " + ", ".join(missing))
    unknown = sorted((str(name) for name in report if name not in known))
    if unknown:
        errors.append("unknown hooks (contract review required): " + ", ".join(unknown))
    for name, status in report.items():
        if not isinstance(status, str) or status != "ok":
            errors.append(f"hook {name} must be exactly 'ok', got {status!r}")
    if errors:
        raise HookReportError("; ".join(errors))
    return report


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise HookReportError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value):
    raise HookReportError(f"invalid JSON constant: {value}")


def parse_hook_report(raw):
    """Strict JSON decoding: duplicate keys must never hide a failed hook."""
    try:
        return json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (ValueError, UnicodeError) as error:
        raise HookReportError(str(error)) from error


def validate_hook_report_file(path):
    """Build-time entry point. Missing/unreadable evidence is always fatal."""
    try:
        raw = Path(path).read_bytes()
    except OSError as error:
        raise HookReportError(f"cannot read hook report: {error}") from error
    return validate_hook_report(parse_hook_report(raw))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", help="hooks-build.json path, or - for stdin")
    args = parser.parse_args(argv)
    result = {"ok": False, "contract": CONTRACT_VERSION, "required_hooks": len(REQUIRED_HOOKS)}
    try:
        report = (validate_hook_report(parse_hook_report(sys.stdin.buffer.read()))
                  if args.report == "-" else validate_hook_report_file(args.report))
        result.update(ok=True, present_required_hooks=len(REQUIRED_HOOKS),
                      optional_hooks=sorted(set(report) & set(OPTIONAL_HOOKS)))
    except (HookReportError, OSError) as error:
        result["error"] = str(error)
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
