"""Pin real Windows process handles so venv descendants are reaped on timeout."""
import ctypes as c
from ctypes import wintypes as w
import time


class Basic(c.Structure):
    _fields_=[('process_time',c.c_int64),('job_time',c.c_int64),('flags',w.DWORD),
              ('min_ws',c.c_size_t),('max_ws',c.c_size_t),('active_limit',w.DWORD),
              ('affinity',c.c_size_t),('priority',w.DWORD),('scheduling',w.DWORD)]

class Counters(c.Structure):
    _fields_=[(name,c.c_uint64) for name in ('read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes')]

class Limits(c.Structure):
    _fields_=[('basic',Basic),('io',Counters),('process_memory',c.c_size_t),('job_memory',c.c_size_t),
              ('peak_process',c.c_size_t),('peak_job',c.c_size_t)]

class Entry(c.Structure):
    _fields_=[('size',w.DWORD),('usage',w.DWORD),('pid',w.DWORD),('heap',c.c_size_t),
              ('module',w.DWORD),('threads',w.DWORD),('parent',w.DWORD),('priority',w.LONG),
              ('flags',w.DWORD),('exe',w.WCHAR*260)]


class WindowsTree:
    def __init__(self):
        self.api=api=c.WinDLL('kernel32',use_last_error=True)
        api.TerminateProcess.argtypes=[w.HANDLE,w.UINT]
        api.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];api.OpenProcess.restype=w.HANDLE
        api.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD]
        api.CloseHandle.argtypes=[w.HANDLE]
        api.CreateToolhelp32Snapshot.argtypes=[w.DWORD,w.DWORD];api.CreateToolhelp32Snapshot.restype=w.HANDLE
        api.Process32FirstW.argtypes=[w.HANDLE,c.POINTER(Entry)]
        api.Process32NextW.argtypes=[w.HANDLE,c.POINTER(Entry)]
        self.processes={}

    def capture(self,root):
        snapshot=self.api.CreateToolhelp32Snapshot(2,0)
        if snapshot==w.HANDLE(-1).value:raise c.WinError(c.get_last_error())
        rows=[]
        try:
            entry=Entry();entry.size=c.sizeof(entry)
            ok=self.api.Process32FirstW(snapshot,c.byref(entry))
            while ok:
                rows.append((entry.pid,entry.parent,entry.exe.lower()))
                ok=self.api.Process32NextW(snapshot,c.byref(entry))
        finally:self.api.CloseHandle(snapshot)
        owned={root}
        for _ in range(8):
            updated=owned|{pid for pid,parent,exe in rows if parent in owned and exe!='conhost.exe'}
            if updated==owned:break
            owned=updated
        for pid in owned-self.processes.keys():
            handle=self.api.OpenProcess(0x101001,False,pid)
            if not handle:
                if c.get_last_error()==87:continue
                raise c.WinError(c.get_last_error())
            self.processes[pid]=handle

    def close(self,root=None):
        try:
            try:
                if root is not None:self.capture(root)
            finally:
                for handle in reversed(list(self.processes.values())):
                    if self.api.WaitForSingleObject(handle,0)==258 and not self.api.TerminateProcess(handle,1):
                        raise c.WinError(c.get_last_error())
            deadline=time.monotonic()+3
            for handle in self.processes.values():
                remaining=max(0,int((deadline-time.monotonic())*1000))
                if self.api.WaitForSingleObject(handle,remaining)!=0:raise RuntimeError('Owned OCR process did not exit')
        finally:
            for handle in self.processes.values():self.api.CloseHandle(handle)
            self.processes.clear()
