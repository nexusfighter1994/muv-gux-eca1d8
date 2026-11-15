"""Bound physical encoder sessions, independently of accepted GPU job capacity."""
from collections import deque
from contextlib import contextmanager
import threading
import time


class NvencSessions:
    # GTX 980 Ti / driver 561.09: keep the public 14-job queue, not 14 sessions.
    def __init__(self, capacity=8):
        if not isinstance(capacity, int) or capacity < 1:
            raise ValueError('invalid NVENC session capacity')
        self.capacity = capacity
        self.active = 0
        self.waiters = deque()
        self.condition = threading.Condition()

    def snapshot(self):
        with self.condition:
            return dict(nvencSessionGuardVersion=1, nvencSessionCapacity=self.capacity,
                        nvencSessionsActive=self.active, nvencSessionsWaiting=len(self.waiters))

    @contextmanager
    def session(self, command, job, deadline=None):
        encoding = any(str(command[i]) in ('-c:v', '-codec:v', '-vcodec')
                       and str(command[i + 1]).endswith('_nvenc')
                       for i in range(len(command) - 1))
        if not encoding:
            yield
            return
        deadline = min(job['deadline'], deadline if deadline is not None else job['deadline'])
        ticket = object()
        acquired = False
        with self.condition:
            self.waiters.append(ticket)
            try:
                while True:
                    if job['cancel'].is_set():
                        raise RuntimeError('cancelled')
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RuntimeError('timeout')
                    if self.waiters[0] is ticket and self.active < self.capacity:
                        self.waiters.popleft()
                        self.active += 1
                        acquired = True
                        break
                    self.condition.wait(min(.05, remaining))
            finally:
                if not acquired:
                    self.waiters.remove(ticket)
                self.condition.notify_all()
        try:
            yield
        finally:
            with self.condition:
                self.active -= 1
                self.condition.notify_all()
