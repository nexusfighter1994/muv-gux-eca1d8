"""Home ffmpeg worker: unblock NVENC paths (2026-11-22, owner: "Die gpu soll ruhig im home arbeiten!").

1. pc_ffmpeg_worker.py - vf-custom:utility-trim-no-quarantine-v1
   One `nvenc_utility_contract_mismatch` (20.11. 19:35 local, one clip in 5 days / ~167,000 GPU jobs) set
   `nvenc_utility_error` for the worker's lifetime, so every plain trim ran on x264 from then on: 16,159 CPU
   vs 1,455 NVENC plain trims in 12 h, GPU idle. Owner rule 2026-11-05: NVENC is never switched off for good;
   a miss only re-encodes that clip. Now the utility recipe pauses only while >= 3 mismatches happened within
   10 min and comes back by itself.
2. NOT part of this installer any more: CRF 16-17 for the qp14 recipe (tried 22.11. 08:03-08:05Z, reverted).
   The composer's CRF 16 jobs are multi-pass intermediates with -preset ultrafast; x264 writes them as
   Constrained Baseline, NVENC as High, so the sampled pair check fails with
   nvenc_reference_contract_profile and pauses NVENC for 60 s each time. Final chunks use CRF 18 and
   already qualify. Do not lower the CRF bound without relaxing that profile check for intermediates.
"""
import sys
from pathlib import Path

WORKER_MARK = '# vf-custom:utility-trim-no-quarantine-v1'
WORKER = [
    ("        self.nvenc_utility_error = None\n",
     "        self.nvenc_utility_error = None\n"
     "        self.nvenc_utility_misses = []\n"),
    ("                          nvencUtilityReady=self.nvenc_ready and self.nvenc_utility_error is None,\n",
     "                          nvencUtilityReady=self.nvenc_ready and not self.utility_blocked(),\n"),
    ("                if candidate is None and self.nvenc_utility_error is None:\n",
     "                if candidate is None and not self.utility_blocked():\n"),
    ("                            self.nvenc_utility_error = str(exc)\n",
     "                            self.nvenc_utility_error = str(exc)\n"
     "                            self.nvenc_utility_misses.append(time.monotonic())\n"),
    ("    def quality_miss_isolated(self, now=None, window=1800):\n",
     "    " + WORKER_MARK + " (2026-11-22, owner: \"Die gpu soll ruhig im home arbeiten!\"). One utility\n"
     "    # contract mismatch used to switch the utility-trim NVENC recipe off until the next worker start\n"
     "    # (20.11.: one clip -> 1.5 days of plain trims on x264, GPU idle). The clip is re-encoded on CPU as\n"
     "    # before; the recipe only pauses while UTILITY_MISS_LIMIT mismatches fall into UTILITY_MISS_WINDOW.\n"
     "    UTILITY_MISS_WINDOW = 600\n"
     "    UTILITY_MISS_LIMIT = 3\n"
     "\n"
     "    def utility_blocked(self, now=None):\n"
     "        now = time.monotonic() if now is None else now\n"
     "        with self.lock:\n"
     "            self.nvenc_utility_misses = [t for t in self.nvenc_utility_misses\n"
     "                                         if now - t < self.UTILITY_MISS_WINDOW]\n"
     "            return len(self.nvenc_utility_misses) >= self.UTILITY_MISS_LIMIT\n"
     "\n"
     "    def quality_miss_isolated(self, now=None, window=1800):\n"),
]

def patch(path, mark, replacements):
    raw = path.read_bytes()
    newline = '\r\n' if b'\r\n' in raw else '\n'
    text = raw.decode('utf-8').replace('\r\n', '\n')
    if mark in text:
        return 'already patched'
    for old, new in replacements:
        if text.count(old) != 1:
            raise RuntimeError(f'{path.name}: fingerprint missing or ambiguous ({text.count(old)}): {old[:60]!r}')
        text = text.replace(old, new)
    path.write_bytes(text.replace('\n', newline).encode('utf-8'))
    return 'patched'


if __name__ == '__main__':
    d = Path(sys.argv[1])
    print('pc_ffmpeg_worker.py', patch(d / 'pc_ffmpeg_worker.py', WORKER_MARK, WORKER))
