"""Inspect a locally available candidate image without starting its container.

Requires Python 3.9+, host Node.js, and an explicitly selected Docker context.
No pull, start, run, exec, production mounts, application imports, or network tests.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import uuid


HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("vf_hook_gate", HERE / "validate-hook-report.py")
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

BUNDLE = "/app/server/dist/index.mjs"
PACKAGE = "/app/server/package.json"
CUSTOM = "/app/server/dist/vf-custom"
HOOKS = CUSTOM + "/hooks-build.json"
MODULES = (
    "chunk-stall.mjs", "custom.mjs", "ffmpeg-admission.mjs", "fish-free.mjs",
    "geomap-isolated.cjs", "geomap-worker.mjs", "gpu-render-events.mjs",
    "home-direct.mjs", "home-library-trim.mjs", "home-normalize.mjs", "home-queue.mjs",
    "home-siglip-transport.mjs", "home-siglip.mjs", "image-preparer.cjs", "map-admission.mjs",
    "pc-boost-api.mjs", "pc-transfer-api.mjs", "sourcing-deadline.mjs",
    "stream-compat.mjs", "thumbnail-openlux.mjs", "thumbnail-subject-identity.cjs",
    "bounded-safe-join.cjs", "validate-copy.cjs", "long-assembly.cjs",
    "home-camera.mjs", "home-camera-cli.mjs", "home-scenes.mjs",
    "home-motion-dispatch.cjs",
    "home-motion-recovery-order.cjs",
    "home-chunk-recovery.cjs", "fflow-resubmit.cjs",
)
EXTERNAL_JS = (
    BUNDLE,
    "/app/render/geomap/index.js",
    "/app/render/geomap/geomap-isolated.cjs",
    "/app/render/geomap/geomap-worker.mjs",
    "/app/server/public/assets/pc-boost-settings-20261002.js",
    "/app/server/public/assets/pc-transfer-settings-20261011.js",
    "/app/server/public/assets/vf-custom-tab.js",
    "/app/server/public/assets/vf-custom-page.js",
)
REQUIRED_JS = EXTERNAL_JS + tuple(CUSTOM + "/" + name for name in MODULES)
COPY_SOURCES = ((PACKAGE, False), (CUSTOM, True)) + tuple((path, False) for path in EXTERNAL_JS)
MAX_COPY_BYTES = 128 * 1024 * 1024


class GateError(RuntimeError):
    """Verification could not establish a required condition."""


def run_command(command, data=None):
    # NODE_OPTIONS can preload code even for --check. Coverage can write files.
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith("NODE_")}
    try:
        result = subprocess.run(command, input=data, capture_output=True, env=env,
                                timeout=120, check=False, shell=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GateError(f"cannot complete {command[0]}: {error}") from error
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()[-2000:]
        raise GateError(f"{command[0]} exited {result.returncode}: {detail}")
    return result.stdout


def decode_copy_tar(raw, source, directory=False):
    """Read docker cp's tar in memory; never extract candidate paths onto host."""
    if len(raw) > MAX_COPY_BYTES:
        raise GateError(f"copy exceeds {MAX_COPY_BYTES} bytes: {source}")
    base = PurePosixPath(source)
    files = {}
    seen = set()
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
            for member in tar:
                path = PurePosixPath(member.name)
                if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                        or not path.parts or path.parts[0] != base.name
                        or (not directory and str(path) != base.name)):
                    raise GateError(f"unexpected copy path: {member.name!r}")
                if str(path) in seen:
                    raise GateError(f"duplicate copy path: {member.name!r}")
                seen.add(str(path))
                if member.isdir():
                    if not directory:
                        raise GateError(f"expected regular file: {source}")
                    continue
                if not member.isfile():
                    raise GateError(f"non-regular copy entry: {member.name!r}")
                if directory and str(path) == base.name:
                    raise GateError(f"expected directory: {source}")
                total += member.size
                if total > MAX_COPY_BYTES:
                    raise GateError(f"copy content exceeds limit: {source}")
                stream = tar.extractfile(member)
                content = stream.read()
                if len(content) != member.size:
                    raise GateError(f"truncated copy entry: {member.name!r}")
                files[str(base.parent / path)] = content
    except (tarfile.TarError, OSError) as error:
        raise GateError(f"invalid docker cp archive for {source}: {error}") from error
    if not files:
        raise GateError(f"empty copy: {source}")
    return files


def extract_native_version(raw):
    """Resolve the unique release constant actually returned by native health.

    This deliberately accepts only the reviewed minified structure. Changed or
    ambiguous upstream structures require review, never a package/label fallback.
    """
    text = raw.decode("utf-8")
    routes = list(re.finditer(
        r'\.get\("/api/health",\([\w$]+,(?P<response>[\w$]+)\)=>\{'
        r'(?P=response)\.json\(\{ok:!0,name:"vidforge",version:(?P<symbol>[\w$]+),'
        r'release_version:(?P=symbol)\}\)\}\)', text))
    if len(routes) != 1:
        raise GateError(f"native version health-route anchor must be unique; found {len(routes)}")
    symbol = routes[0].group("symbol")
    name = re.escape(symbol)
    declarations = list(re.finditer(
        r'\bvar ' + name + r',[\w$]+=[\w$]+\(\(\)=>\{'
        + name + r'="(?P<version>20\d{2}\.\d{2}\.\d{2}\.\d+)"\}\);', text))
    assignments = re.findall(r'(?<![\w$.])' + name + r'\s*=(?!=)', text)
    literals = re.findall(r'([\"\x27])(20\d{2}\.\d{2}\.\d{2}\.\d+)\1', text)
    if len(declarations) != 1 or len(assignments) != 1 or len(literals) != 1:
        raise GateError("native version declaration/literal is missing or ambiguous")
    version = declarations[0].group("version")
    if literals[0][1] != version:
        raise GateError("native version declaration and unique release literal disagree")
    return {"native_version": version, "native_version_symbol": symbol,
            "native_version_source": BUNDLE + ":/api/health version+release_version"}


def verify_snapshot(files, expected_version, label_version=None, node="node", runner=run_command):
    result = {"ok": False, "contract": gate.CONTRACT_VERSION,
              "required_hooks": len(gate.REQUIRED_HOOKS), "errors": [], "syntax": [],
              "sha256": {path: hashlib.sha256(content).hexdigest() for path, content in sorted(files.items())}}
    errors = result["errors"]
    if not isinstance(expected_version, str) or not expected_version.strip():
        errors.append("expected native version must be explicitly supplied")
    for path in (PACKAGE, HOOKS) + REQUIRED_JS:
        if path not in files:
            errors.append("missing required file: " + path)
    if HOOKS in files:
        try:
            result["hooks"] = gate.validate_hook_report(gate.parse_hook_report(files[HOOKS]))
        except gate.HookReportError as error:
            errors.append(str(error))
    if PACKAGE in files:
        try:
            package = gate.parse_hook_report(files[PACKAGE])
            version = package.get("version") if isinstance(package, dict) else None
            result["package_version"] = version
            if not isinstance(version, str) or not version:
                errors.append("package.json version metadata is missing or invalid")
        except gate.HookReportError as error:
            errors.append("invalid package.json: " + str(error))
    if BUNDLE in files:
        try:
            result.update(extract_native_version(files[BUNDLE]))
            version = result["native_version"]
            if version != expected_version:
                errors.append(f"native bundle version mismatch: expected {expected_version!r}, got {version!r}")
            if label_version is not None and label_version != version:
                errors.append(f"OCI version label disagrees with native bundle: {label_version!r} != {version!r}")
        except (GateError, UnicodeError) as error:
            errors.append(str(error))
    try:
        version = runner([node, "--version"]).decode("utf-8").strip()
        if not re.fullmatch(r"v\d+\.\d+\.\d+(?:[-+][\w.-]+)?", version):
            raise GateError("unrecognized host Node.js version: " + version)
        result["node_version"] = version
    except (GateError, UnicodeError) as error:
        errors.append(str(error))
        return result
    sources = set(REQUIRED_JS) | {path for path in files
                                 if path.startswith(CUSTOM + "/")
                                 and PurePosixPath(path).suffix in (".js", ".mjs", ".cjs")}
    for path in sorted(sources & files.keys()):
        mode = "commonjs" if path.endswith(".cjs") else "module"
        check = {"path": path, "mode": mode, "ok": False}
        try:
            runner([node, "--check", "--input-type=" + mode], data=files[path])
            check["ok"] = True
        except GateError as error:
            check["error"] = str(error)
            errors.append(f"syntax check failed for {path}: {error}")
        result["syntax"].append(check)
    result["ok"] = not errors
    return result


def inspect_image(image, expected_version, context, node="node", runner=run_command):
    result = {"ok": False, "image_requested": image, "docker_context": context,
              "expected_version": expected_version, "errors": []}
    if not isinstance(expected_version, str) or not expected_version.strip():
        result["errors"].append("expected native version must be explicitly supplied")
        return result
    if not image or image.startswith("-") or any(char.isspace() for char in image) or not context:
        result["errors"].append("supply an image reference and an explicit Docker context")
        return result
    docker = ["docker", "--context", context]
    name = "vf-update-gate-" + uuid.uuid4().hex
    created = False
    try:
        metadata = json.loads(runner(docker + ["image", "inspect", "--", image]))
        if not isinstance(metadata, list) or len(metadata) != 1 or not isinstance(metadata[0], dict):
            raise GateError("Docker did not return exactly one image")
        metadata = metadata[0]
        image_id = metadata.get("Id", "")
        if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            raise GateError("Docker did not return an immutable image ID")
        if metadata.get("Os") != "linux":
            raise GateError("expected a Linux VidForge image")
        config = metadata.get("Config")
        labels = config.get("Labels") if isinstance(config, dict) else None
        if labels is not None and not isinstance(labels, dict):
            raise GateError("invalid image labels")
        label_version = (labels or {}).get("org.opencontainers.image.version")
        result.update(image_id=image_id, architecture=metadata.get("Architecture"),
                      oci_version=label_version, scratch_container=name)
        container_id = runner(docker + ["create", "--pull=never", "--network=none", "--read-only",
                                       "--restart=no", "--name", name, "--entrypoint", "/bin/true", image_id])
        created = True
        if not re.fullmatch(rb"[0-9a-f]{64}\s*", container_id):
            raise GateError("Docker create returned an invalid container ID")
        files = {}
        for source, directory in COPY_SOURCES:
            copied = decode_copy_tar(runner(docker + ["cp", name + ":" + source, "-"]), source, directory)
            if files.keys() & copied.keys():
                raise GateError("overlapping file copies")
            files.update(copied)
        result.update(verify_snapshot(files, expected_version, label_version, node, runner))
    except (GateError, ValueError, UnicodeError, OSError) as error:
        result["errors"].append(str(error))
        result["ok"] = False
    finally:
        if created:
            try:
                runner(docker + ["rm", "--volumes", name])
                result["scratch_removed"] = True
            except GateError as error:
                result["errors"].append(f"scratch cleanup failed ({name}): {error}")
                result["scratch_removed"] = False
                result["ok"] = False
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="already-local image tag, digest, or full ID; never pulled")
    parser.add_argument("--expected-version", required=True, help="exact native app release from bundled /api/health")
    parser.add_argument("--docker-context", required=True, help="explicit isolated builder context")
    parser.add_argument("--node", default="node", help="trusted host Node.js executable")
    parser.add_argument("--report", type=Path, help="new receipt file; existing receipts are not overwritten")
    args = parser.parse_args(argv)
    result = inspect_image(args.image, args.expected_version, args.docker_context, args.node)
    if args.report:
        try:
            with args.report.open("x", encoding="utf-8") as output:
                json.dump(result, output, indent=2)
                output.write("\n")
        except OSError as error:
            result["ok"] = False
            result["errors"].append(f"cannot save new receipt: {error}")
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
