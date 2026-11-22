"""Home ffmpeg worker: full decode check of each output only as a sample (2026-11-22).

Owner 22.11.: "Vorallem werden die home dinge doppelt geprueft? Wozu? Das braucht doch nur leistung oder?
Wozu pruefen? Brauchen wir das wirklich???"

Every Home render was decoded completely after encoding (`ffmpeg -xerror -i output -f null -`, one thread).
Measured 22.11. 08:45Z over 75 s: 61 of 190 ffmpeg process-seconds on Home were this check (32 %); of the
last 300 failure records none was a defect it had found (cancelled / timeout only). The transfer stays
checked by size and sha256, the server probes every result with ffprobe (streams, duration) and fully
decodes 1 in 20 (/data/runtime/vf-home-verify.json), and the sampled NVENC-vs-CPU SSIM check is unchanged.

Now the Home decode runs for the first 3 jobs after a worker start, for every sampled GPU job (the ones
that also get the CPU reference), and for every Nth job. N comes from runtime/verify-sample.json
{"every": N} (default 20, 1 = every job as before, 0 = never), read at most every 5 s, no restart needed.
"""
import sys
from pathlib import Path

MARK = '# vf-custom:home-decode-sample-v1'

REPLACEMENTS = [
    ("                self.execute_render(job, job['command'])\n"
     "                runner([self.ffmpeg, '-v', 'error', '-xerror', '-threads', '1', '-i', str(output), '-map', '0', '-f', 'null', '-'])\n",
     "                self.execute_render(job, job['command'])\n"
     "                if self.decode_check_due(job):\n"
     "                    runner([self.ffmpeg, '-v', 'error', '-xerror', '-threads', '1', '-i', str(output), '-map', '0', '-f', 'null', '-'])\n"),
    ("    def quality_miss_isolated(self, now=None, window=1800):\n",
     "    " + MARK + " (2026-11-22, owner: \"Wozu pruefen? Brauchen wir das wirklich???\"). The full decode\n"
     "    # of every output was 32 % of Home's ffmpeg process time and had found no defect in the last 300 failure\n"
     "    # records. It now runs for the first 3 jobs, every sampled GPU job and every Nth job\n"
     "    # (runtime/verify-sample.json {\"every\": N}; default 20, 1 = every job, 0 = never; read every 5 s).\n"
     "    DECODE_CHECK_EVERY = 20\n"
     "\n"
     "    def decode_check_every(self, now=None):\n"
     "        now = time.monotonic() if now is None else now\n"
     "        cached = getattr(self, '_decode_check_cache', None)\n"
     "        if cached and now - cached[0] < 5:\n"
     "            return cached[1]\n"
     "        value = self.DECODE_CHECK_EVERY\n"
     "        try:\n"
     "            raw = json.loads((self.root / 'verify-sample.json').read_text(encoding='utf-8')).get('every')\n"
     "            if type(raw) is int and 0 <= raw <= 1000:\n"
     "                value = raw\n"
     "        except (OSError, ValueError, AttributeError):\n"
     "            pass\n"
     "        self._decode_check_cache = (now, value)\n"
     "        return value\n"
     "\n"
     "    def decode_check_due(self, job):\n"
     "        every = self.decode_check_every()\n"
     "        with self.lock:\n"
     "            self._decode_check_seen = getattr(self, '_decode_check_seen', 0) + 1\n"
     "            seen = self._decode_check_seen\n"
     "        if every == 1 or job.get('verify') and job.get('lane') == 'gpu':\n"
     "            return True\n"
     "        if every == 0:\n"
     "            return False\n"
     "        return seen <= 3 or seen % every == 0\n"
     "\n"
     "    def quality_miss_isolated(self, now=None, window=1800):\n"),
]


def patch(path):
    raw = path.read_bytes()
    newline = '\r\n' if b'\r\n' in raw else '\n'
    text = raw.decode('utf-8').replace('\r\n', '\n')
    if MARK in text:
        return 'already patched'
    for old, new in REPLACEMENTS:
        if text.count(old) != 1:
            raise RuntimeError(f'{path.name}: fingerprint missing or ambiguous ({text.count(old)}): {old[:60]!r}')
        text = text.replace(old, new)
    path.write_bytes(text.replace('\n', newline).encode('utf-8'))
    return 'patched'


if __name__ == '__main__':
    print('pc_ffmpeg_worker.py', patch(Path(sys.argv[1]) / 'pc_ffmpeg_worker.py'))
