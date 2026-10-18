# Native camera and scene helpers

Optional Windows Home-PC extension. It uses the existing authenticated blob
transport, transfer limits, graphics leases and CPU/GPU limits. Never expose the
worker publicly or copy someone else's tokens. No parent-worker restart is needed
when a verified release updates only the per-request child code.

## Contracts

- `native-camera-nvenc-v1`: exact original FFlow camera pixel algorithm, then
  H.264 High NVENC p7/hq/QP14, yuv420p, 24 fps, timebase 1/12288, no B frames.
  Only supported plain 1080p camera requests qualify. Treatments stay native.
- `native-scenes-cpu-v1`: original PySceneDetect ContentDetector and shot windows,
  decoded on the CPU. The existing motion transport supplies a CPU lease.
- `native-scenes-gpu-v1`: NVDEC decoding plus the same CPU scene scoring. The map
  transport supplies CPU and GPU leases. This does not re-encode the source video.

Scene support is deliberately limited to H.264 yuv420p at up to 1080p and 80 MiB,
further bounded by configured transfer limits. Full/offline/incompatible workers
return to the counted native server path. The scene attempt reserves 60 seconds
of the original deadline for fallback. No server RAM or concurrency bypass.

## Installation requirements

Use `extract_native.py` and `extract_scenes.py` against the administrator's own
licensed FFlow source. Their pinned hashes fail closed after upstream changes.
Generated `camera_native.py` and `scenes_native.py` are intentionally excluded from
the public package. Do not replace them with approximate implementations.

The qualified Python environment uses Python 3.13, numpy 2.5.1, OpenCV 5.0.0.93,
pydantic 2.12.3 and scenedetect 0.7. Use a driver-compatible FFmpeg with NVENC and
NVDEC; a newer FFmpeg may require a newer NVENC API than the installed driver.
The private release runtime file selects Python, FFmpeg, FFprobe, the blob root
and accepted motion/map contract fingerprints. Do not publish that file.

Install the bridge and Python helpers beside the existing per-job graphics
workers, preserve the existing manifest, then hash every updated worker/helper in
that manifest. The map/motion entry points accept only the explicit new operations.
An absent helper/configuration leaves these operations unavailable, not partly enabled.

Before activation, compare original CPU frame hashes for camera motion, exact
scene timestamps on real sources for CPU and NVDEC, preview hashes and the complete
authenticated server-to-PC-to-server result. The server scene CLI resolves the
job's actual `pipeline_jobs.project_slug` read-only; project directories are NOT
named after job UUIDs. Preview receipts remain inside that project's directory.

The Home Scenes concurrency row distinguishes CPU and GPU-decoded completions
since activation. Native VidForge events also identify `(CPU)` and `(GPU)` scenes.
NVDEC only accelerates decoding; the detector itself still uses CPU processing.
