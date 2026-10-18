#!/bin/bash
# RunPod pod boot (stock VidForge image): the motion worker starts at once; SigLIP gets CUDA torch
# (same version as the image) and the pinned model in the background, then serves on 127.0.0.1:8081.
# A failed SigLIP setup only leaves SigLIP off: the server checks device/model before using it.
set -u
cd /opt/vf-pod
(
  set -e
  version=$(python3 -c 'import torch;print(torch.__version__.split("+")[0])')
  python3 -m pip install --quiet --no-cache-dir --index-url https://download.pytorch.org/whl/cu128 "torch==${version}"
  python3 -c "from huggingface_hub import snapshot_download; snapshot_download('google/siglip2-base-patch16-384', revision='f775b65a79762255128c981547af89addcfe0f88', local_dir='/opt/vf-pod/siglip/model-hub')"
  exec python3 /opt/vf-pod/siglip/pod_siglip.py
) > /opt/vf-pod/siglip.log 2>&1 &
exec node /opt/vf-pod/pod-worker.mjs
