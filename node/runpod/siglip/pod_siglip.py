"""RunPod launcher for the Home SigLIP rank service (service.py, unchanged copy).

Same model and revision as Home and the server engine; token from the pod environment,
CUDA device, loopback only (the pod worker proxies /siglip/* to it with the pod token).
"""
import json
import os
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import service  # noqa: E402


def main():
    token = os.environ.get('VF_POD_TOKEN', '')
    if len(token) < 32:
        raise RuntimeError('VF_POD_TOKEN missing')
    port = int(os.environ.get('VF_SIGLIP_PORT', '8081'))
    concurrency = max(1, min(25, int(os.environ.get('VF_SIGLIP_CONCURRENCY', '4'))))
    # The server only uses a ranker whose image limit covers its own (server: 100 MiB).
    service.TransferLimits(HERE / 'runtime' / 'pc-transfer-limits.json').set(
        {'ffmpegMaxFileMb': 150, 'ffmpegMaxTotalMb': 150, 'sceneMaxFileMb': 400, 'siglipMaxImageMb': 128})
    ranker = service.Ranker(model_path=HERE / 'model-hub', device=os.environ.get('VF_SIGLIP_DEVICE', 'cuda'))
    config = service.validate_config({'enabled': True, 'siglipEnabled': True, 'siglipConcurrency': concurrency})
    server = ThreadingHTTPServer(('127.0.0.1', port), service.Handler)
    server.daemon_threads = True
    server.state = service.State(ranker, token, config=config)
    print(json.dumps(dict(event='ready', port=port, **server.state.health())), flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    main()
