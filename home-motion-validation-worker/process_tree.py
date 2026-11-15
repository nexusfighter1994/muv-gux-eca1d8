"""Own each graphics process tree without changing priorities or memory limits."""
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


class BasicLimits(ctypes.Structure):
    _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                ('flags', wintypes.DWORD), ('min_ws', ctypes.c_size_t),
                ('max_ws', ctypes.c_size_t), ('active_limit', wintypes.DWORD),
                ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD),
                ('scheduling', wintypes.DWORD)]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [('basic', BasicLimits), ('io', ctypes.c_uint64 * 6),
                ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]


class Accounting(ctypes.Structure):
    _fields_ = [('times', ctypes.c_int64 * 4), ('page_faults', wintypes.DWORD),
                ('total', wintypes.DWORD), ('active', wintypes.DWORD),
                ('terminated', wintypes.DWORD)]


def kernel():
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    signatures = {
        'CreateJobObjectW': ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        'OpenJobObjectW': ([wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
        'SetInformationJobObject': ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        'QueryInformationJobObject': ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
        'AssignProcessToJobObject': ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        'TerminateJobObject': ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        'GetCurrentProcess': ([], wintypes.HANDLE),
        'CloseHandle': ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (args, result) in signatures.items():
        function = getattr(api, name)
        function.argtypes, function.restype = args, result
    return api


def checked(value):
    if not value:
        raise ctypes.WinError(ctypes.get_last_error())
    return value


class TreeProcess(subprocess.Popen):
    def __init__(self, command, **kwargs):
        self._job = None
        self._api = None
        if os.name == 'nt':
            self._api = kernel()
            name = 'Local\\VFGraphics-' + uuid.uuid4().hex
            self._job = checked(self._api.CreateJobObjectW(None, name))
            limits = ExtendedLimits()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE only.
            try:
                checked(self._api.SetInformationJobObject(self._job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
                # The wrapper joins the job BEFORE spawning the actual renderer.
                command = [sys.executable, '-u', str(Path(__file__).resolve()), '--child', name, *command]
                kwargs['creationflags'] = kwargs.get('creationflags', 0) | subprocess.CREATE_NO_WINDOW
                super().__init__(command, **kwargs)
            except BaseException:
                self._api.CloseHandle(self._job)
                self._job = None
                raise
        else:
            kwargs['start_new_session'] = True
            super().__init__(command, **kwargs)

    def active_count(self):
        if self._api:
            if self._job is None:
                return 0
            info = Accounting()
            checked(self._api.QueryInformationJobObject(self._job, 1, ctypes.byref(info), ctypes.sizeof(info), None))
            return int(info.active)
        try:
            os.killpg(self.pid, 0)
            return 1
        except ProcessLookupError:
            return 0

    def tree_exited(self):
        return self.poll() is not None and self.active_count() == 0

    def terminate_tree(self):
        if self._api:
            if self._job is None:
                return
            # Also covers cancellation before the wrapper has joined its job.
            if self.poll() is None:
                self.kill()
                self.wait(timeout=5)
            checked(self._api.TerminateJobObject(self._job, 1))
        else:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def wait_tree(self, timeout=15):
        deadline = time.monotonic() + timeout
        while True:
            if self.tree_exited():
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(.05)

    def dispose(self):
        if not self.tree_exited():
            raise RuntimeError('process tree still active')
        if self._job is not None:
            checked(self._api.CloseHandle(self._job))
            self._job = None
        for stream in (self.stdin, self.stdout, self.stderr):
            if stream:
                stream.close()


def child(name, command):
    api = kernel()
    handle = checked(api.OpenJobObjectW(0x001F003F, False, name))
    try:
        checked(api.AssignProcessToJobObject(handle, api.GetCurrentProcess()))
    finally:
        # Only the supervising parent retains the lifetime-controlling handle.
        api.CloseHandle(handle)
    process = subprocess.Popen(command, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    return process.wait()


if __name__ == '__main__':
    if os.name != 'nt' or len(sys.argv) < 4 or sys.argv[1] != '--child':
        raise SystemExit(2)
    try:
        raise SystemExit(child(sys.argv[2], sys.argv[3:]))
    except OSError:
        print('graphics process-tree setup failed', file=sys.stderr)
        raise SystemExit(1)
