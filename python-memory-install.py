"""Thin, fail-closed hooks at completed Python work boundaries."""
import ast
from pathlib import Path
import shutil

MARKER = '# vf-custom:python-memory-reclaim-v1'
IMPORT = 'from vf_memory_reclaim import after_task as _vf_after_task\n'
TARGETS = {
    'fflow/src/queue/worker.py': [('Worker', '_process_job')],
    'search/app/services/task_runner.py': [('TaskManager', '_process_task')],
    'siglip/app/tasks.py': [('TaskManager', 'process_task')],
    'siglip/app/api.py': [(None, 'model_unload'), (None, 'ocr_unload')],
}


def patch_source(source, targets):
    tree = ast.parse(source)
    selected = []
    for owner, name in targets:
        parents = [tree] if owner is None else [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == owner]
        matches = [n for parent in parents for n in parent.body if isinstance(n, ast.AsyncFunctionDef) and n.name == name]
        if len(matches) != 1:
            raise ValueError('Missing or ambiguous asynchronous lifecycle: '+str(owner)+'.'+name)
        selected.append(matches[0])
    if MARKER in source:
        if source.count(MARKER) != 1 or source.count(IMPORT) != 1 or any(
            sum(isinstance(d, ast.Name) and d.id == '_vf_after_task' for d in n.decorator_list) != 1 for n in selected
        ):
            raise ValueError('Incomplete memory reclaim hook')
        return source
    if '_vf_after_task' in source or 'vf_memory_reclaim' in source:
        raise ValueError('Unrecognized existing reclaim hook')
    lines = source.splitlines(keepends=True)
    for node in sorted(selected, key=lambda n:n.lineno, reverse=True):
        lines.insert(node.lineno-1, ' '*node.col_offset+'@_vf_after_task\n')
    # Keep module docstrings and __future__ statements in their required positions.
    offset = 0
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str) and offset == 0:
            offset = node.end_lineno
        elif isinstance(node, ast.ImportFrom) and node.module == '__future__':
            offset = node.end_lineno
        else:
            break
    lines.insert(offset, IMPORT)
    result = ''.join(lines).rstrip()+'\n'+MARKER+'\n'
    compile(result, '<memory-reclaim>', 'exec')
    return result


def install(root=Path('/app/engines'), source=None):
    source = Path(source) if source else Path(__file__).parent/'python/memory_reclaim.py'
    prepared = {rel:patch_source((root/rel).read_text(), targets) for rel,targets in TARGETS.items()}
    for engine in ['fflow','search','siglip']:
        shutil.copyfile(source, root/engine/'vf_memory_reclaim.py')
    for rel, content in prepared.items():
        (root/rel).write_text(content)
    return {'python.memoryReclaim':'ok'}


if __name__=='__main__':
    print(install())
