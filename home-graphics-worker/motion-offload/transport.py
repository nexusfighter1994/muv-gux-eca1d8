"""Optional routes for the existing bearer-authenticated18191 Handler, not auto-installed."""
import base64, hashlib, json, subprocess, threading, re, os, time, tempfile
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
        self.quarantined = False
        self.quarantine_directory = None

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
        with self.lock:identifiers=list(self.jobs)
        for identifier in identifiers:self.cancel(identifier)

    def cancel(self, identifier):
        with self.lock:
            if self.quarantined:raise RuntimeError('termination unconfirmed')
            self.cancelled[identifier] = time.monotonic()+610
            process = self.jobs.get(identifier)
            if process and process.poll() is None:
                try:
                    if os.name == 'nt':
                        result = subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=10)
                        # taskkill also "fails" when the job exited on its own in the meantime.
                        if result.returncode and process.poll() is None: raise RuntimeError('kill rejected')
                    else:
                        import signal
                        os.killpg(process.pid, signal.SIGKILL)
                    # A killed browser tree can need more than 2 s to release the job process.
                    process.wait(timeout=15)
                except Exception:
                    # Quarantine (slot stays held) only while the job process is PROVEN alive.
                    if process.poll() is None:
                        self.quarantined=True
                        raise RuntimeError('termination unconfirmed')
            return {'terminated': True}

    def render(self, data):
        identifier = data.get('id', '') if isinstance(data, dict) else ''
        if not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{32}', identifier) or data.get('contract') != self.contract:
            raise ValueError('contract')
        raw = self.input_bytes(data)
        _, max_response = self.output_limits(data)
        if self.quarantined or not self.slot.acquire(False):
            raise RuntimeError('motion busy')
        release = None
        directory = None
        try:
            # Mandatory lease from the EXISTING worker budget; never add a parallel one.
            release = self.acquire_gpu()
            if not callable(release):
                raise RuntimeError('shared worker budget unavailable')
            directory = tempfile.TemporaryDirectory(prefix='vfmo-job-')
            environment = dict(os.environ, VF_MOTION_JOB_ROOT=directory.name)
            with self.lock:
                self.cancelled = {k:v for k,v in self.cancelled.items() if v>time.monotonic()}
                if identifier in self.cancelled or len(self.cancelled)>2048:
                    raise RuntimeError('cancelled or replay')
                process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, start_new_session=os.name != 'nt',
                                           env=environment,
                                           creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0)
                self.jobs[identifier] = process
            try:
                output, diagnostic = process.communicate(raw, timeout=min(600, max(1, data.get('timeoutMs', 600000)/1000))+5)
                if process.returncode or len(output) > max_response:
                    raise RuntimeError('native motion failed: '+diagnostic[-2000:].decode(errors='replace'))
                result = self.validate_result(data, json.loads(output))
                with self.lock:
                    if self.quarantined or identifier in self.cancelled:
                        raise RuntimeError('cancelled or replay')
                return result
            except subprocess.TimeoutExpired:
                self.cancel(identifier)
                process.communicate(timeout=10)
                raise RuntimeError('native motion deadline')
            finally:
                with self.lock:
                    if not self.quarantined:self.jobs.pop(identifier, None)
                    self.cancelled[identifier] = time.monotonic()+610
        finally:
            if directory and self.quarantined:
                # Retain the TemporaryDirectory finalizer until process death is proven.
                self.quarantine_directory = directory
            try:
                if directory and not self.quarantined:
                    directory.cleanup()
            finally:
                try:
                    if release and not self.quarantined:
                        release()
                finally:
                    if not self.quarantined:self.slot.release()

def dispatch_motion(handler, service, data):
    """Call AFTER existing auth/body-size parsing; returns whether a route matched."""
    if handler.path == '/motion/health' and handler.command == 'GET':
        handler.respond(200, {'version': 1, 'contract': service.contract, 'slots': getattr(service, 'slots', 1),
                              'kinds': list(service.kinds)})
    elif handler.path == '/motion/render' and handler.command == 'POST':
        handler.respond(200, service.render(data))
    elif re.fullmatch('/motion/[a-f0-9]{32}', handler.path) and handler.command == 'DELETE':
        handler.respond(200, service.cancel(handler.path.rsplit('/', 1)[1]))
    else:
        return False
    return True
