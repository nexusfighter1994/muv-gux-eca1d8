"""Extract only the pinned upstream still-camera math, never the application/SDK."""
import ast
import hashlib
from pathlib import Path
import sys

SOURCE_SHA256 = '260174a4753b2f470c7940404237ce902a749e28234a431322c132db4e2159bf'
NAMES = {'Presentation', 'TRACK_KEYS', 'TRACK_DEFAULTS', 'MAX_TRACK_FRAMES',
         'CameraPathCard', 'CameraPathBackdrop', 'CameraPath', '_hex_bgr', '_rounded_mask',
         '_Sprite', 'build_sprite', '_Backdrop', 'camera_matrix', '_interp_flag',
         'CameraPathRenderer', 'decode_still'}
HEADER = '''from __future__ import annotations
import math
from pathlib import Path
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field, field_validator, model_validator
import cv2
import numpy as np
FFmpegError = RuntimeError
class CameraPathTreatment(BaseModel):
    pass
def _cv2(): return cv2
def _np(): return np
'''

def extract(source):
    if hashlib.sha256(source.encode()).hexdigest() != SOURCE_SHA256:
        raise ValueError('Native camera version changed; qualification required')
    tree = ast.parse(source)
    selected, found = [], set()
    for node in tree.body:
        names = {node.name} if isinstance(node, (ast.FunctionDef, ast.ClassDef)) else set()
        if isinstance(node, ast.Assign):
            names = {x.id for x in node.targets if isinstance(x, ast.Name)}
        if names & NAMES:
            selected.append(ast.get_source_segment(source, node))
            found |= names & NAMES
    if found != NAMES: raise ValueError('Incomplete native camera extraction')
    return HEADER + '\n\n'.join(selected) + '\n'

if __name__ == '__main__':
    Path(sys.argv[2]).write_text(extract(Path(sys.argv[1]).read_text(encoding='utf-8')), encoding='utf-8')
