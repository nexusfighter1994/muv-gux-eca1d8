# Home FFmpeg worker: NVENC utility isolation

These are the Windows Home-worker sources, not a server renderer. Preserve the
existing private token, runtime graphics pointer, transfer limits and configuration.
Install `ffmpeg/pc_ffmpeg_worker.py` beside its existing dependencies in the Home
FFmpeg folder only after authenticated server-side Home admission is disabled and
all owned work is drained. Restart the verified Home parent, qualify health and
restore the exact original server-side Home setting. Never kill live render trees.

An `nvenc_utility_contract_mismatch` with a source-probed utility contract rejects
that output, quarantines utility NVENC for that process lifetime, and executes the
original CPU command once within the original deadline. Regular qualified NVENC
remains available. Other validation failures retain the global fail-closed guard.
Diagnostic receipts are in runtime/gpu-recoveries; `cpuRecoveryPending` is NOT a
success receipt. No quality, codec, timing, audio or capacity changes.

Health adds nvencIsolationVersion=1, nvencUtilityReady and nvencUtilityLastError.
