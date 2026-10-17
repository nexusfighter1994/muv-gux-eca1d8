import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT.parent / 'vf-speed-20261002'


def validator(file, function, defaults):
    tree = ast.parse(file.read_text(encoding='utf-8'))
    # Pure config functions only: importing SigLIP would load the model dependencies.
    nodes = [n for n in tree.body if
             (isinstance(n, ast.FunctionDef) and n.name == function) or
             (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == defaults for t in n.targets))]
    namespace = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(file), 'exec'), namespace)
    return namespace[function], namespace[defaults]


class Limits25Tests(unittest.TestCase):
    def assert_bounds(self, function, defaults):
        self.assertEqual(function({}), defaults)
        for key in ('cpuWorkers', 'gpuWorkers', 'siglipConcurrency', 'sceneWorkers'):
            with self.subTest(key=key):
                function({key: 25})
                with self.assertRaises(ValueError):
                    function({key: 26})
                for value in ('25', True, 25.5, -1):
                    with self.assertRaises(ValueError):
                        function({key: value})

    def test_local_ffmpeg_checked_config(self):
        self.assert_bounds(*validator(LOCAL / 'ffmpeg' / 'pc_ffmpeg_protocol.py', 'checked_config', 'DEFAULTS'))

    def test_canonical_fflow_checked_config_without_default_changes(self):
        self.assert_bounds(*validator(ROOT / 'fflow' / 'pc_ffmpeg_protocol.py', 'checked_config', 'DEFAULTS'))

    def test_siglip_validator_including_ignored_scene_bounds(self):
        self.assert_bounds(*validator(LOCAL / 'siglip' / 'service.py', 'validate_config', 'DEFAULT_CONFIG'))

    def test_empty_update_preserves_current_worker_selections(self):
        for file in (ROOT / 'fflow' / 'pc_ffmpeg_protocol.py', LOCAL / 'ffmpeg' / 'pc_ffmpeg_protocol.py'):
            function, defaults = validator(file, 'checked_config', 'DEFAULTS')
            current = {**defaults, 'cpuWorkers': 7, 'gpuWorkers': 4, 'siglipConcurrency': 3}
            self.assertEqual(function({}, current), current)

    def test_canonical_protocol_preserves_parent_nvenc_guard_and_other_unchanged_guards(self):
        source = ROOT / 'fflow' / 'pc_ffmpeg_protocol.py'
        backup = Path(str(source) + '.before-bandwidth-limits25-20261011')
        def other_nodes(file):
            tree = ast.parse(file.read_text(encoding='utf-8'))
            # Input-count/map/filter additions have their own closed-protocol regression.
            tree.body = [n for n in tree.body if not (
                isinstance(n, ast.FunctionDef) and n.name in ('checked_config', 'validate_argv')
                or isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'FILTERS' for t in n.targets))]
            return ast.dump(tree, include_attributes=False)
        self.assertEqual(other_nodes(source), other_nodes(backup))


if __name__ == '__main__':
    unittest.main()
