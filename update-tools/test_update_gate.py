"""Offline gate tests. No Docker daemon, network, or production access."""
import importlib.util
import ast
import json
from pathlib import Path
import subprocess
import sys
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("hook_gate", HERE / "validate-hook-report.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class HookReportTests(unittest.TestCase):
    def good(self):
        return {"fingerprints": {}, "report": dict.fromkeys(gate.REQUIRED_HOOKS, "ok")}

    def test_contract_has_40_distinct_functional_hooks(self):
        self.assertEqual(len(gate.REQUIRED_HOOKS), 40)
        self.assertEqual(len(set(gate.REQUIRED_HOOKS)), 40)
        self.assertNotIn("node.bundle", gate.REQUIRED_HOOKS)
        self.assertIn("fflow.fxOutputSentinel", gate.REQUIRED_HOOKS)
        self.assertIn("node.gpuRenderEvents", gate.REQUIRED_HOOKS)

    def test_contract_matches_staging_declarations_without_importing_installer(self):
        installer = HERE.parent / "apply.py"
        tree = ast.parse(installer.read_text(encoding="utf-8"))
        declared = set()
        for call in ast.walk(tree):
            if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or not call.args:
                continue
            name = call.args[0]
            if not isinstance(name, ast.Constant) or not isinstance(name.value, str):
                continue
            if call.func.id == "note":
                declared.add(name.value)
            elif call.func.id == "wrap":
                declared.add("node." + name.value)
        self.assertEqual(declared - set(gate.OPTIONAL_HOOKS), set(gate.REQUIRED_HOOKS))

    def test_all_required_hooks_pass(self):
        self.assertEqual(gate.validate_hook_report(self.good()), self.good()["report"])

    def test_every_required_hook_individually_missing_fails(self):
        for name in gate.REQUIRED_HOOKS:
            with self.subTest(hook=name):
                payload = self.good()
                del payload["report"][name]
                with self.assertRaisesRegex(gate.HookReportError, "missing.*" + name):
                    gate.validate_hook_report(payload)

    def test_unknown_hook_fails_even_when_ok(self):
        payload = self.good()
        payload["report"]["node.newUnknownHook"] = "ok"
        with self.assertRaisesRegex(gate.HookReportError, "unknown.*node.newUnknownHook"):
            gate.validate_hook_report(payload)

    def test_every_non_exact_ok_status_fails(self):
        for status in (True, False, None, 1, "OK", "ok ", "skipped: missing", {}, []):
            with self.subTest(status=status):
                payload = self.good()
                payload["report"]["node.routes"] = status
                with self.assertRaisesRegex(gate.HookReportError, "node.routes"):
                    gate.validate_hook_report(payload)

    def test_reapply_marker_is_allowed_without_replacing_40_hooks(self):
        payload = self.good()
        payload["report"]["node.bundle"] = "ok"
        self.assertEqual(len(gate.validate_hook_report(payload)), 41)
        del payload["report"]["node.routes"]
        with self.assertRaisesRegex(gate.HookReportError, "missing.*node.routes"):
            gate.validate_hook_report(payload)

    def test_reapply_marker_must_also_be_ok(self):
        payload = self.good()
        payload["report"]["node.bundle"] = "skipped: changed"
        with self.assertRaisesRegex(gate.HookReportError, "node.bundle"):
            gate.validate_hook_report(payload)

    def test_empty_and_wrong_schemas_fail(self):
        for payload in ({}, [], None, {"report": []}, {"report": {}}, {"report": None}):
            with self.subTest(payload=payload):
                with self.assertRaises(gate.HookReportError):
                    gate.validate_hook_report(payload)

    def test_all_problems_are_reported_together(self):
        payload = self.good()
        del payload["report"]["node.routes"]
        payload["report"]["unknown"] = "ok"
        payload["report"]["node.lane"] = "skipped: changed"
        with self.assertRaises(gate.HookReportError) as caught:
            gate.validate_hook_report(payload)
        for text in ("node.routes", "unknown", "node.lane"):
            self.assertIn(text, str(caught.exception))

    def test_duplicate_json_keys_fail_instead_of_last_value_wins(self):
        for raw in ('{"report":{},"report":{}}', '{"report":{"node.routes":"bad","node.routes":"ok"}}'):
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(gate.HookReportError, "duplicate"):
                    gate.parse_hook_report(raw)

    def test_invalid_json_fails(self):
        for raw in ("", "{", '{"report": NaN}'):
            with self.subTest(raw=raw):
                with self.assertRaises(gate.HookReportError):
                    gate.parse_hook_report(raw)

    def test_cli_accepts_stdin_report(self):
        result = subprocess.run([sys.executable, "-B", str(HERE / "validate-hook-report.py"), "-"],
                                input=json.dumps(self.good()), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(json.loads(result.stdout)["ok"])

    def test_cli_rejects_empty_report(self):
        result = subprocess.run([sys.executable, "-B", str(HERE / "validate-hook-report.py"), "-"],
                                input='{"report":{}}', text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)["ok"])

    def test_cli_missing_file_is_failure(self):
        result = subprocess.run([sys.executable, "-B", str(HERE / "validate-hook-report.py"),
                                 str(HERE / "does-not-exist.json")], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
