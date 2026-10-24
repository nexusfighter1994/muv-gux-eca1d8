"""Optional routes for the existing bearer-authenticated18191 Handler, not auto-installed."""
import base64, hashlib, json, subprocess, threading, re, os, time, tempfile
from collections import OrderedDict
from process_tree import TreeProcess
MAX_BODY = 48 * 1024 * 1024
MAX_ARTIFACT = 32 * 1024 * 1024
MAX_OUTPUT = 128 * 1024 * 1024
MAX_RESPONSE = 176 * 1024 * 1024
ALPHA_KIND = 'frameshift-alpha-v1'
# Motion renders on the PC's CPU (alpha-worker.mjs RENDER_BACKEND).
RENDER_BACKEND = 'software/cpu'
# Upper bound of parallel graphics jobs on the PC (motion and maps share this gate; each
# also takes a lease from the existing worker budget). The server decides how many it
# actually offers (PC Boost setting motionSlots, 1..8).
GRAPHICS_SLOTS = 8


class GraphicsGate:
    """Counting, non-blocking gate for parallel graphics jobs; locked() = any slot held."""
    def __init__(self, slots):
        self.slots, self._used, self._lock = slots, 0, threading.Lock()

    def acquire(self, blocking=False):
        with self._lock:
            if self._used >= self.slots:
                return False
            self._used += 1
            return True

    def release(self):
        with self._lock:
            if self._used <= 0:
                raise RuntimeError('release unlocked graphics gate')
            self._used -= 1

    def locked(self):
        with self._lock:
            return self._used > 0
OPAQUE_KIND = 'frameshift-opaque-v1'


def artifact_bytes(value, maximum):
    if not isinstance(value, str) or len(value) > 4 * ((maximum + 2) // 3):
        raise ValueError('artifact size/encoding')
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, UnicodeError) as error:
        raise ValueError('artifact size/encoding') from error
    if len(decoded) > maximum:
        raise ValueError('artifact size')
    return decoded

class MotionService:
    def __init__(self, command, contract, acquire_gpu, *, kinds=None,
                 max_output_bytes=None, max_response_bytes=None, transfer_limits=None):
        self.command, self.contract, self.acquire_gpu = command, contract, acquire_gpu
        if kinds is None:
            kinds = [OPAQUE_KIND]
        if (not isinstance(kinds, list) or not all(isinstance(k, str) for k in kinds)
                or len(kinds) != len(set(kinds)) or any(k not in (OPAQUE_KIND, ALPHA_KIND) for k in kinds)):
            raise ValueError('motion capability kinds')
        self.kinds = tuple(dict.fromkeys([OPAQUE_KIND] + kinds))
        if ALPHA_KIND in self.kinds:
            if (type(max_output_bytes) is not int or not 0 < max_output_bytes <= MAX_OUTPUT
                    or type(max_response_bytes) is not int or not 0 < max_response_bytes <= MAX_RESPONSE):
                raise ValueError('alpha capability output caps required')
        elif max_output_bytes is not None or max_response_bytes is not None:
            raise ValueError('alpha capability required for output caps')
        self.max_output_bytes = max_output_bytes
        self.max_response_bytes = max_response_bytes
        self.transfer_limits = transfer_limits
        self.slots = GRAPHICS_SLOTS
        self.slot, self.lock, self.jobs = GraphicsGate(GRAPHICS_SLOTS), threading.Lock(), {}
        self.cancelled = {}
        self.completed = OrderedDict()
        self.records = {}
        self.recovered = 0
        self.cleanup_errors = 0
        self._reaper = None
        self._closing = False

    @property
    def quarantined(self):
        with self.lock:
            return any(r['quarantined'] for r in self.records.values())

    def health(self):
        with self.lock:
            return {'recoveryVersion': 2, 'quarantinedJobs': sum(r['quarantined'] for r in self.records.values()),
                    'activeJobs': sum(not r['finished'] for r in self.records.values()),
                    'recoveredJobs': self.recovered, 'cleanupErrors': self.cleanup_errors}

    @staticmethod
    def _dead(record):
        process = record['process']
        try:
            return process is None or process.tree_exited()
        except OSError:
            return False

    def _release_record(self, record):
        if not record['finished'] or not self._dead(record):
            return False
        with self.lock:
            if self.records.get(record['id']) is not record:
                return False
            self.records.pop(record['id'])
            self.jobs.pop(record['id'], None)
            self.completed[record['id']] = time.monotonic() + 610
            while len(self.completed) > 4096:
                self.completed.popitem(last=False)
            self.recovered += int(record['quarantined'])
        try:
            if record['process']:
                record['process'].dispose()
        finally:
            try:
                if record['release']:
                    record['release']()
            finally:
                self.slot.release()
        if record['directory']:
            try:
                record['directory'].cleanup()
            except OSError:
                with self.lock:
                    self.cleanup_errors += 1
        return True

    def _retain(self, record):
        with self.lock:
            if self.records.get(record['id']) is not record:
                return
            record['quarantined'] = True
            if self._reaper is None or not self._reaper.is_alive():
                self._reaper = threading.Thread(target=self._recover_loop, daemon=True,
                                                name='graphics-lease-recovery')
                self._reaper.start()

    def _recover_loop(self):
        while True:
            time.sleep(.5)
            self.reap_quarantined()
            with self.lock:
                if not any(r['quarantined'] for r in self.records.values()):
                    self._reaper = None
                    return

    def reap_quarantined(self):
        with self.lock:
            records = [r for r in self.records.values() if r['quarantined'] and r['finished']]
        for record in records:
            with record['termination_lock']:
                if not self._release_record(record) and time.monotonic() >= record['retry_at']:
                    record['retry_at'] = time.monotonic() + 5
                    try:
                        record['process'].terminate_tree()
                    except (OSError, RuntimeError, subprocess.TimeoutExpired):
                        pass
                    self._release_record(record)

    def output_limits(self, data):
        kind = data.get('kind') if isinstance(data, dict) else None
        if kind is not None and kind not in self.kinds:
            raise ValueError('unsupported motion kind')
        if kind == ALPHA_KIND:
            if data.get('version') != 1 or data.get('format') != 'mov' or data.get('workers') not in (1, 2, 3):
                raise ValueError('alpha protocol/format')
            return self.max_output_bytes, self.max_response_bytes
        if isinstance(data, dict) and data.get('format') not in (None, 'mp4'):
            raise ValueError('opaque protocol/format')
        return MAX_ARTIFACT, MAX_BODY

    def input_bytes(self, data):
        self.output_limits(data)
        raw = json.dumps(data).encode()
        if len(raw) > MAX_BODY:
            raise ValueError('input body cap')
        assets = data.get('assets', [])
        if not isinstance(assets, list):
            raise ValueError('input assets')
        limits = self.transfer_limits() if self.transfer_limits else None
        total = 0
        for asset in assets:
            if not isinstance(asset, dict):
                raise ValueError('input asset')
            try:
                size = len(artifact_bytes(asset.get('data'), MAX_ARTIFACT))
            except ValueError as error:
                raise ValueError('input asset size/encoding') from error
            total += size
            if total > MAX_ARTIFACT:
                raise ValueError('input assets cap')
            if limits and (size > limits['ffmpegMaxFileMb'] * 1024 ** 2
                           or total > limits['ffmpegMaxTotalMb'] * 1024 ** 2):
                raise ValueError('custom input cap')
        return raw

    def validate_result(self, data, result):
        maximum, _ = self.output_limits(data)
        if not isinstance(result, dict):
            raise ValueError('output protocol')
        alpha = data.get('kind') == ALPHA_KIND
        kind = result.get('kind')
        if kind is not None and kind != (data.get('kind') or self.kinds[0]):
            raise ValueError('output kind mismatch')
        probe = result.get('probe') or {}
        if not isinstance(probe, dict):
            raise ValueError('output codec protocol')
        if alpha:
            if (result.get('version') != 1 or result.get('id') != data['id']
                    or result.get('contract') != self.contract or kind != ALPHA_KIND
                    or result.get('format') != 'mov' or result.get('backend') != RENDER_BACKEND
                    or probe.get('codec') != 'prores' or probe.get('profile') != '4444'
                    or probe.get('pixFmt') not in ('yuva444p10le', 'yuva444p12le')):
                raise ValueError('alpha output protocol/codec')
        elif (result.get('format') not in (None, 'mp4')
              or probe.get('codec', probe.get('codec_name', 'h264')) != 'h264'):
            raise ValueError('opaque output protocol/codec')
        if 'data' in result:
            decoded = artifact_bytes(result['data'], maximum)
            size = len(decoded)
            if self.transfer_limits:
                limits = self.transfer_limits()
                if size > min(limits['ffmpegMaxFileMb'], limits['ffmpegMaxTotalMb']) * 1024 ** 2:
                    raise ValueError('custom output cap')
            if alpha and (not size or hashlib.sha256(decoded).hexdigest() != result.get('sha256')):
                raise ValueError('alpha artifact receipt')
        elif alpha:
            raise ValueError('alpha artifact missing')
        return result

    def close(self):
        with self.lock:
            self._closing = True
            identifiers = list(self.jobs)
        for identifier in identifiers:
            try:
                self.cancel(identifier)
            except RuntimeError:
                pass

    def cancel(self, identifier):
        with self.lock:
            self.cancelled[identifier] = time.monotonic()+610
            record = self.records.get(identifier)
        if record and record['process']:
            with record['termination_lock']:
                try:
                    if not self._dead(record):
                        record['process'].terminate_tree()
                        deadline = time.monotonic() + 2
                        while not self._dead(record) and time.monotonic() < deadline:
                            time.sleep(.05)
                except (OSError, RuntimeError, subprocess.TimeoutExpired):
                    pass
                if not self._dead(record):
                    self._retain(record)
                    raise RuntimeError('termination unconfirmed for this job')
        return {'terminated': True}

    def render(self, data):
        identifier = data.get('id', '') if isinstance(data, dict) else ''
        if not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{32}', identifier) or data.get('contract') != self.contract:
            raise ValueError('contract')
        raw = self.input_bytes(data)
        _, max_response = self.output_limits(data)
        if not self.slot.acquire(False):
            raise RuntimeError('motion busy')
        record = {'id': identifier, 'release': None, 'directory': None, 'process': None,
                  'finished': False, 'quarantined': False, 'retry_at': time.monotonic() + 5,
                  'termination_lock': threading.Lock()}
        with self.lock:
            self.cancelled = {k:v for k,v in self.cancelled.items() if v>time.monotonic()}
            while self.completed and next(iter(self.completed.values())) <= time.monotonic():
                self.completed.popitem(last=False)
            if (self._closing or identifier in self.records or identifier in self.cancelled
                    or identifier in self.completed or len(self.cancelled)>2048):
                self.slot.release()
                raise RuntimeError('cancelled or replay')
            self.records[identifier] = record
        try:
            # Mandatory lease from the EXISTING worker budget; never add a parallel one.
            record['release'] = self.acquire_gpu()
            if not callable(record['release']):
                raise RuntimeError('shared worker budget unavailable')
            directory = record['directory'] = tempfile.TemporaryDirectory(prefix='vfmo-job-')
            environment = dict(os.environ, VF_MOTION_JOB_ROOT=directory.name)
            with self.lock:
                if identifier in self.cancelled or len(self.cancelled)>2048:
                    raise RuntimeError('cancelled or replay')
                process = TreeProcess(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, start_new_session=os.name != 'nt',
                                           env=environment,
                                           creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0)
                self.jobs[identifier] = process
                record['process'] = process
            try:
                output, diagnostic = process.communicate(raw, timeout=min(600, max(1, data.get('timeoutMs', 600000)/1000))+5)
                if process.returncode or len(output) > max_response:
                    raise RuntimeError('native motion failed: '+diagnostic[-2000:].decode(errors='replace'))
                result = self.validate_result(data, json.loads(output))
                with self.lock:
                    if identifier in self.cancelled:
                        raise RuntimeError('cancelled or replay')
                return result
            except subprocess.TimeoutExpired:
                self.cancel(identifier)
                process.communicate(timeout=10)
                raise RuntimeError('native motion deadline')
        finally:
            with record['termination_lock']:
                # Successful roots can still leave browser/FFmpeg grandchildren behind.
                # Only this record's real process tree controls its leases.
                try:
                    if not self._dead(record):
                        record['process'].terminate_tree()
                except (OSError, RuntimeError, subprocess.TimeoutExpired):
                    pass
                record['finished'] = True
                if not self._release_record(record):
                    self._retain(record)

def dispatch_motion(handler, service, data):
    """Call AFTER existing auth/body-size parsing; returns whether a route matched."""
    if handler.path == '/motion/health' and handler.command == 'GET':
        handler.respond(200, {'version': 1, 'contract': service.contract, 'slots': getattr(service, 'slots', 1),
                              'kinds': list(service.kinds), **service.health()})
    elif handler.path == '/motion/render' and handler.command == 'POST':
        handler.respond(200, service.render(data))
    elif re.fullmatch('/motion/[a-f0-9]{32}', handler.path) and handler.command == 'DELETE':
        handler.respond(200, service.cancel(handler.path.rsplit('/', 1)[1]))
    else:
        return False
    return True
