"""Image gate uses fake Docker, with real Node syntax checks in separate tests."""
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import unittest
from unittest.mock import patch

import verify_image as image


VERSION = "2026.10.13.7"
IMAGE_ID = "sha256:" + "a" * 64
NATIVE_BUNDLE = (b'var Nk,YJe=P(()=>{Nk="2026.10.13.7"});'
                 b'jr.get("/api/health",(e,t)=>{t.json({ok:!0,name:"vidforge",version:Nk,release_version:Nk})});')


def snapshot():
    files = {name: b"export const valid = 1;" for name in image.REQUIRED_JS}
    for name in files:
        if name.endswith(".cjs"):
            files[name] = b"module.exports = {};"
    files[image.BUNDLE] = NATIVE_BUNDLE
    files[image.PACKAGE] = json.dumps({"version": "1.0.0"}).encode()
    files[image.HOOKS] = json.dumps({"report": dict.fromkeys(image.gate.REQUIRED_HOOKS, "ok")}).encode()
    return files


def archive(source, files):
    output = io.BytesIO()
    parent = str(Path(source).parent).replace("\\", "/")
    with tarfile.open(fileobj=output, mode="w") as tar:
        for path, content in files.items():
            if path == source or path.startswith(source + "/"):
                info = tarfile.TarInfo(path[len(parent) + 1:])
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
    return output.getvalue()


class FakeRunner:
    def __init__(self, files=None, fail=None):
        self.files = snapshot() if files is None else files
        self.fail = fail
        self.calls = []
        self.metadata = {"Id": IMAGE_ID, "Os": "linux", "Architecture": "amd64",
                         "Config": {"Labels": {"org.opencontainers.image.version": VERSION}}}

    def __call__(self, command, data=None):
        self.calls.append((command, data))
        if command[0] != "docker":
            return b"v22.18.0\n" if "--version" in command else b""
        args = command[3:]  # docker --context test-builder ...
        action = args[0]
        if action == self.fail:
            raise image.GateError("simulated " + action + " failure")
        if action == "image":
            return json.dumps([self.metadata]).encode()
        if action == "create":
            return ("b" * 64).encode()
        if action == "cp":
            source = args[1].split(":", 1)[1]
            return archive(source, self.files)
        if action == "rm":
            return b"removed"
        raise AssertionError("Unexpected Docker command: " + repr(command))


class SnapshotTests(unittest.TestCase):
    def verify(self, files=None, **kwargs):
        return image.verify_snapshot(snapshot() if files is None else files,
                                     VERSION, runner=FakeRunner(), **kwargs)

    def test_good_snapshot_has_version_all_hooks_and_all_syntax_checks(self):
        result = self.verify(label_version=VERSION)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["native_version"], VERSION)
        self.assertEqual(result["package_version"], "1.0.0")
        self.assertEqual(result["required_hooks"], 40)
        self.assertEqual(len(result["syntax"]), len(image.REQUIRED_JS))
        self.assertEqual(len(result["sha256"][image.HOOKS]), 64)

    def test_missing_module_fails_even_when_build_report_is_ok(self):
        files = snapshot()
        del files[image.CUSTOM + "/home-queue.mjs"]
        result = self.verify(files)
        self.assertFalse(result["ok"])
        self.assertIn("home-queue.mjs", " ".join(result["errors"]))

    def test_missing_or_invalid_package_metadata_is_fatal(self):
        for package in ({}, {"version": ""}, {"version": None}, []):
            with self.subTest(package=package):
                files = snapshot()
                files[image.PACKAGE] = json.dumps(package).encode()
                self.assertFalse(self.verify(files)["ok"])

    def test_conflicting_version_label_is_fatal(self):
        self.assertFalse(self.verify(label_version="2026.10.08.8")["ok"])

    def test_missing_label_and_placeholder_package_pass_when_native_bundle_matches(self):
        self.assertTrue(self.verify()["ok"])

    def test_native_version_matches_actual_staged_stock_bundle(self):
        default = Path(__file__).resolve().parents[1] / "stock.mjs"
        bundle = Path(os.environ.get('VF_STOCK_BUNDLE', str(default))).read_bytes()
        self.assertEqual(image.extract_native_version(bundle)["native_version"], os.environ.get('VF_EXPECTED_NATIVE_VERSION', '2026.10.19.7'))

    def test_native_version_renamed_symbol_is_supported(self):
        evidence = image.extract_native_version(NATIVE_BUNDLE.replace(b"Nk", b"Native$1"))
        self.assertEqual(evidence["native_version"], VERSION)

    def test_missing_ambiguous_unanchored_or_wrong_bundle_version_fails(self):
        for bundle in (b'const unrelated="2026.10.13.7";', NATIVE_BUNDLE * 2,
                       NATIVE_BUNDLE.replace(b"2026.10.13.7", b"2026.10.08.8"),
                       NATIVE_BUNDLE + b'const other="2026.10.08.8";',
                       NATIVE_BUNDLE.replace(b'"/api/health"', b'"/api/other"'),
                       NATIVE_BUNDLE + b'Nk="2026.10.13.7";'):
            with self.subTest(bundle=bundle):
                files = snapshot()
                files[image.BUNDLE] = bundle
                self.assertFalse(self.verify(files)["ok"])

    def test_duplicate_package_version_is_fatal(self):
        files = snapshot()
        files[image.PACKAGE] = b'{"version":"old","version":"2026.10.13.7"}'
        self.assertFalse(self.verify(files)["ok"])

    def test_missing_and_bad_hook_reports_fail(self):
        for raw in (None, b"{}", b"not-json", b'{"report":{"node.bundle":"ok"}}'):
            with self.subTest(raw=raw):
                files = snapshot()
                if raw is None:
                    del files[image.HOOKS]
                else:
                    files[image.HOOKS] = raw
                self.assertFalse(self.verify(files)["ok"])

    def test_new_custom_js_is_syntax_checked_too(self):
        files = snapshot()
        name = image.CUSTOM + "/additional.mjs"
        files[name] = b"export {};"
        result = self.verify(files)
        self.assertIn(name, [item["path"] for item in result["syntax"]])

    def test_node_unavailable_is_not_skipped(self):
        def fail(command, data=None):
            raise image.GateError("node unavailable")
        result = image.verify_snapshot(snapshot(), VERSION, runner=fail)
        self.assertFalse(result["ok"])
        self.assertIn("node unavailable", " ".join(result["errors"]))

    @unittest.skipUnless(shutil.which("node"), "real Node.js is required for parser tests")
    def test_real_node_checks_syntax_without_executing_source(self):
        files = snapshot()
        files[image.BUNDLE] += b'throw new Error("MUST NOT EXECUTE"); export {};'
        result = image.verify_snapshot(files, VERSION)
        self.assertTrue(result["ok"], result)

    @unittest.skipUnless(shutil.which("node"), "real Node.js is required for parser tests")
    def test_real_node_rejects_invalid_syntax(self):
        files = snapshot()
        files[image.BUNDLE] += b"export const broken = ;"
        result = image.verify_snapshot(files, VERSION)
        self.assertFalse(result["ok"])
        self.assertIn(image.BUNDLE, " ".join(result["errors"]))

    def test_runner_strips_node_preload_and_coverage_environment(self):
        with patch.dict(image.os.environ, {"NODE_OPTIONS": "--require malicious.js",
                                          "NODE_PATH": "unsafe", "NODE_V8_COVERAGE": "unsafe"}):
            with patch.object(image.subprocess, "run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = b""
                image.run_command(["node", "--version"])
                env = run.call_args.kwargs["env"]
                self.assertFalse(any(key.upper().startswith("NODE_") for key in env))
                self.assertFalse(run.call_args.kwargs.get("shell", False))


class DockerTests(unittest.TestCase):
    def inspect(self, runner):
        return image.inspect_image("local/vidforge-custom:20261015-27-upstream", VERSION,
                                   context="test-builder", runner=runner)

    def test_inspection_never_runs_container_or_pulls_and_pins_resolved_id(self):
        runner = FakeRunner()
        result = self.inspect(runner)
        self.assertTrue(result["ok"], result)
        commands = [command for command, _ in runner.calls if command[0] == "docker"]
        self.assertTrue(all(command[3] in {"image", "create", "cp", "rm"} for command in commands))
        create = next(command for command in commands if command[3] == "create")
        for flag in ("--pull=never", "--network=none", "--read-only"):
            self.assertIn(flag, create)
        self.assertEqual(create[-1], IMAGE_ID)
        self.assertEqual(commands[-1][3:5], ["rm", "--volumes"])
        self.assertNotIn("--force", commands[-1])
        self.assertEqual(result["image_id"], IMAGE_ID)

    def test_copy_failure_still_cleans_up_and_fails(self):
        runner = FakeRunner(fail="cp")
        result = self.inspect(runner)
        self.assertFalse(result["ok"])
        self.assertTrue(any(command[3] == "rm" for command, _ in runner.calls))

    def test_cleanup_failure_is_failure_not_green_receipt(self):
        result = self.inspect(FakeRunner(fail="rm"))
        self.assertFalse(result["ok"])
        self.assertIn("cleanup", " ".join(result["errors"]))

    def test_unknown_image_does_not_trigger_pull_or_container_creation(self):
        runner = FakeRunner(fail="image")
        self.assertFalse(self.inspect(runner)["ok"])
        self.assertEqual(len(runner.calls), 1)

    def test_failed_create_does_not_delete_an_unowned_container(self):
        runner = FakeRunner(fail="create")
        self.assertFalse(self.inspect(runner)["ok"])
        self.assertFalse(any(command[3] == "rm" for command, _ in runner.calls))

    def test_invalid_image_id_blocks_create(self):
        runner = FakeRunner()
        runner.metadata["Id"] = "latest"
        self.assertFalse(self.inspect(runner)["ok"])
        self.assertEqual(len(runner.calls), 1)

    def test_empty_expected_version_fails_before_docker(self):
        runner = FakeRunner()
        result = image.inspect_image("candidate", "", context="test-builder", runner=runner)
        self.assertFalse(result["ok"])
        self.assertEqual(runner.calls, [])


class TarTests(unittest.TestCase):
    def test_directory_copy_maps_only_expected_prefix(self):
        files = snapshot()
        actual = image.decode_copy_tar(archive(image.CUSTOM, files), image.CUSTOM, directory=True)
        self.assertEqual(actual, {key: value for key, value in files.items() if key.startswith(image.CUSTOM + "/")})

    def test_links_traversal_duplicates_and_unexpected_names_fail(self):
        for mode in ("symlink", "hardlink", "traversal", "duplicate", "wrong-name"):
            with self.subTest(mode=mode):
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode="w") as tar:
                    name = {"traversal": "../index.mjs", "wrong-name": "other.mjs"}.get(mode, "index.mjs")
                    entry = tarfile.TarInfo(name)
                    if mode in ("symlink", "hardlink"):
                        entry.type = tarfile.SYMTYPE if mode == "symlink" else tarfile.LNKTYPE
                        entry.linkname = "/private"
                    tar.addfile(entry, io.BytesIO())
                    if mode == "duplicate":
                        tar.addfile(entry, io.BytesIO())
                with self.assertRaises(image.GateError):
                    image.decode_copy_tar(stream.getvalue(), image.BUNDLE, directory=False)

    def test_empty_copy_cannot_pass(self):
        with self.assertRaises(image.GateError):
            image.decode_copy_tar(archive(image.BUNDLE, {}), image.BUNDLE, directory=False)


if __name__ == "__main__":
    unittest.main()
