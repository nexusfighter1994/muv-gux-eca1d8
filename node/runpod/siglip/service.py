"""Isolated FP32 SigLIP rank endpoint; no job queues or network image fetches."""
import argparse
from collections import OrderedDict
from contextlib import contextmanager
import base64
import binascii
import hmac
import io
import json
import math
import os
from pathlib import Path
import threading
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))
from pc_transfer_runtime import TransferLimits
from pc_transfer_limits import DEFAULT_LIMITS, MIB, check_image_size, validate_limits
MODEL_ID = 'google/siglip2-base-patch16-384'
MODEL_REVISION = 'f775b65a79762255128c981547af89addcfe0f88'
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_BODY_BYTES = 64 * 1024 * 1024
# Images per GPU forward (fastest on the GTX 980 Ti: 40 vs 51 ms/image at batch 1); recent text embeddings stay on the GPU.
IMAGE_BATCH = 4
TEXT_CACHE_SIZE = 512
# Text preprocessing exactly like the server engine (VidForge >= 2026.10.08: app/model.py).
TEXT_MODE_SIGLIP2 = 'siglip2'
TEXT_MODE_LEGACY = 'legacy'
TEXT_MODES = (TEXT_MODE_SIGLIP2, TEXT_MODE_LEGACY)


def text_processor_call(query, mode):
    if mode == TEXT_MODE_LEGACY:
        return [query], dict(return_tensors='pt', padding=True, truncation=True, max_length=64)
    return [query.lower()], dict(return_tensors='pt', padding='max_length', truncation=True, max_length=64)


DEFAULT_CONFIG = dict(enabled=True, cpuWorkers=5, gpuWorkers=4,
                      siglipEnabled=True, siglipConcurrency=1)


@contextmanager
def timed_lock(lock, timeout):
    if not lock.acquire(timeout=timeout):
        raise TimeoutError('GPU inference is busy')
    try:
        yield
    finally:
        lock.release()


def validate_config(config):
    if not isinstance(config, dict):
        raise ValueError('Expected object')
    result = DEFAULT_CONFIG.copy()
    if 'sceneWorkers' in config and (type(config['sceneWorkers']) is not int or not 0 <= config['sceneWorkers'] <= 25):
        raise ValueError('Invalid worker count')
    # The server syncs all PC Boost keys (e.g. sceneWorkers for the FFmpeg worker); SigLIP uses its own.
    for key, value in ((k, v) for k, v in config.items() if k in DEFAULT_CONFIG):
        if key in ('enabled', 'siglipEnabled'):
            if type(value) is not bool:
                raise ValueError('Expected boolean')
        else:
            lower, upper = (1 if key == 'siglipConcurrency' else 0), 25
            if type(value) is not int or not lower <= value <= upper:
                raise ValueError('Invalid worker count')
        result[key] = value
    return result


def batch_raw_limit(limits):
    # Match the sender's45MiB raw batch budget; larger images share one bounded batch budget.
    return max(45 * MIB, validate_limits(limits)['siglipMaxImageMb'] * MIB)


def body_limit(limits):
    raw = batch_raw_limit(limits)
    return max(MAX_BODY_BYTES, 4 * ((raw + 2) // 3) + MIB)


def decode_image(encoded, limits=None):
    limits = DEFAULT_LIMITS if limits is None else limits
    try:
        raw = base64.b64decode(encoded, validate=True)
        check_image_size(len(raw), limits)
        with Image.open(io.BytesIO(raw)) as check:
            if check.width * check.height > 40_000_000:
                raise ValueError('Image pixel limit')
            check.verify()
        with Image.open(io.BytesIO(raw)) as source:
            return source.convert('RGB')
    except (OSError, binascii.Error, Image.DecompressionBombError) as exc:
        raise ValueError('Invalid image') from exc


def validate_payload(payload, limits=None):
    limits = validate_limits(DEFAULT_LIMITS if limits is None else limits)
    image_limit = limits['siglipMaxImageMb'] * MIB
    if not isinstance(payload, dict):
        raise ValueError('Expected object')
    query = payload.get('query')
    candidates = payload.get('candidates')
    if not isinstance(query, str) or not query.strip() or len(query) > 500:
        raise ValueError('Invalid query')
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= 200:
        raise ValueError('Invalid candidates')
    seen = set()
    total = 0
    raw_total = 0
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise ValueError('Invalid candidate')
        key, encoded = candidate.get('id'), candidate.get('image_base64')
        if not isinstance(key, str) or not 1 <= len(key) <= 200 or key in seen:
            raise ValueError('Invalid or duplicate candidate id')
        if not isinstance(encoded, str) or not encoded or len(encoded) > 4 * ((image_limit + 2) // 3):
            raise ValueError('Invalid image encoding')
        try:
            raw = base64.b64decode(encoded, validate=True)
            check_image_size(len(raw), limits)
            raw_total += len(raw)
            del raw
        except (ValueError, binascii.Error) as exc:
            raise ValueError('Invalid base64') from exc
        seen.add(key)
        total += len(encoded)
        if total > body_limit(limits) or raw_total > batch_raw_limit(limits):
            raise ValueError('Payload limit')
    texts = lambda key: [q for q in (payload.get(key) or []) if isinstance(q, str) and q.strip()]
    queries, negatives = texts('queries'), texts('negative_queries')
    if len(queries) > 8 or len(negatives) > 8 or any(len(q) > 500 for q in queries + negatives):
        raise ValueError('Invalid extra queries')
    try:
        weight = float(payload.get('negative_weight', 0.5))
    except (TypeError, ValueError):
        weight = 0.5
    mode = payload.get('text_mode', TEXT_MODE_SIGLIP2)
    if mode not in TEXT_MODES:
        raise ValueError('Invalid text mode')
    options = dict(queries=queries, negatives=negatives, weight=weight) if (queries or negatives) else None
    return query, candidates, options, mode


def pooled(output):
    if hasattr(output, 'norm'):
        return output
    for name in ('pooler_output', 'text_embeds', 'image_embeds'):
        value = getattr(output, name, None)
        if value is not None:
            return value
    raise TypeError('No pooled model embedding')


class Ranker:
    def __init__(self, model_path=ROOT / 'model-hub', device='cuda'):
        import torch
        from transformers import AutoModel, AutoProcessor
        self.torch = torch
        self.device = device
        torch.set_num_threads(2)
        if device == 'cuda':
            if not torch.cuda.is_available():
                raise RuntimeError('CUDA not available')
            torch.cuda.set_per_process_memory_fraction(0.32)
            torch.backends.cuda.matmul.allow_tf32 = False
            torch.backends.cudnn.allow_tf32 = False
        self.processor = AutoProcessor.from_pretrained(str(model_path), local_files_only=True)
        self.model = AutoModel.from_pretrained(str(model_path), local_files_only=True,
                                               torch_dtype=torch.float32).eval().to(device)
        self.lock = threading.Lock()
        self.text_cache, self.text_cache_lock = OrderedDict(), threading.Lock()

    def embed_text(self, query, mode):
        text, kwargs = text_processor_call(query, mode)
        inputs = self.processor(text=text, **kwargs).to(self.device)
        embedding = pooled(self.model.get_text_features(**inputs))
        return embedding / embedding.norm(dim=-1, keepdim=True)

    def cached_text(self, text, mode, wait):
        key = (mode, text)
        with self.text_cache_lock:
            hit = self.text_cache.get(key)
            if hit is not None:
                self.text_cache.move_to_end(key)
                return hit
        with timed_lock(self.lock, wait()), self.torch.no_grad():
            value = self.embed_text(text, mode)
        with self.text_cache_lock:
            self.text_cache[key] = value
            while len(self.text_cache) > TEXT_CACHE_SIZE:
                self.text_cache.popitem(last=False)
        return value

    def image_features(self, inputs):
        try:
            return pooled(self.model.get_image_features(**{k: v.to(self.device) for k, v in inputs.items()}))
        except self.torch.cuda.OutOfMemoryError:
            # A batch that does not fit next to NVENC/display falls back to one image at a time.
            self.torch.cuda.empty_cache()
            size = next(iter(inputs.values())).shape[0]
            return self.torch.cat([pooled(self.model.get_image_features(**{k: v[i:i + 1].to(self.device) for k, v in inputs.items()}))
                                   for i in range(size)])

    def rank(self, query, candidates, timeout=120, options=None, mode=TEXT_MODE_SIGLIP2, limits=None):
        started = time.monotonic()
        torch = self.torch
        # The GPU lock is held per batch, so concurrent requests interleave: a request waits at
        # most 75 s for its first GPU turn and must finish inside the sender's 120 s.
        def wait():
            left = min(started + min(timeout, 75), started + timeout - 10) - time.monotonic() if not results else started + timeout - 10 - time.monotonic()
            if left <= 0:
                raise TimeoutError('GPU inference is busy')
            return left
        results = []
        # Same scoring as the server's tasks._score_fields: plain -> primary cosine;
        # extras -> max over positives minus negative_weight * max over negatives.
        positives = [self.cached_text(query, mode, wait)] + ([self.cached_text(q, mode, wait) for q in options['queries']] if options else [])
        negatives = [self.cached_text(q, mode, wait) for q in options['negatives']] if options else []
        positive_texts = torch.cat(positives)
        negative_texts = torch.cat(negatives) if negatives else None
        for start in range(0, len(candidates), IMAGE_BATCH):
            if time.monotonic() - started > timeout:
                raise TimeoutError('Inference budget exhausted')
            chunk = candidates[start:start + IMAGE_BATCH]
            images = []
            try:
                # Decoding and preprocessing run on the CPU outside the GPU lock (parallel across requests).
                for candidate in chunk:
                    images.append(decode_image(candidate['image_base64'], limits))
                inputs = self.processor(images=images, return_tensors='pt')
            finally:
                for image in images:
                    image.close()
            with timed_lock(self.lock, wait()), torch.no_grad():
                embedding = self.image_features(inputs)
                embedding = embedding / embedding.norm(dim=-1, keepdim=True)
                query_matrix = (embedding @ positive_texts.T).cpu().tolist()
                negative_matrix = (embedding @ negative_texts.T).cpu().tolist() if negative_texts is not None else None
                del embedding
            del inputs
            for index, candidate in enumerate(chunk):
                query_scores = [float(v) for v in query_matrix[index]]
                negative_scores = [float(v) for v in negative_matrix[index]] if negative_matrix is not None else []
                if not all(math.isfinite(v) for v in query_scores + negative_scores):
                    raise ValueError('Nonfinite score')
                if options is None:
                    result = dict(id=candidate['id'], score=round(query_scores[0], 6))
                else:
                    positive = max(query_scores)
                    negative = max(negative_scores) if negative_scores else None
                    combined = positive if negative is None else positive - options['weight'] * negative
                    result = dict(id=candidate['id'], score=round(combined, 6), positive_score=round(positive, 6),
                                  negative_score=None if negative is None else round(negative, 6),
                                  query_scores=[round(v, 6) for v in query_scores])
                result.update(rank=None, metadata=candidate.get('metadata', {}), error=None)
                results.append(result)
        results.sort(key=lambda item: item['score'], reverse=True)
        for rank, item in enumerate(results, 1):
            item['rank'] = rank
        return dict(status='completed', query=query, results=results, failed_count=0,
                    model_id=MODEL_ID, model_revision=MODEL_REVISION,
                    processing_seconds=round(time.monotonic() - started, 3))


class State:
    def __init__(self, ranker, token, config=None):
        self.ranker = ranker
        self.token = token
        self.config = DEFAULT_CONFIG.copy() if config is None else validate_config(config)
        self.active = 0
        self.completed = 0
        self.failed = 0
        self.lock = threading.Lock()
        self.transfer_limits = TransferLimits(ROOT / 'runtime' / 'pc-transfer-limits.json')

    def health(self):
        torch = self.ranker.torch
        limits = self.transfer_limits.get()
        return dict(status='ok', ready=True, model_loaded=True, model_id=MODEL_ID, text_modes=list(TEXT_MODES), multi_query=True,
                    transferLimits=limits,
                    transferBodyMaxBytes=body_limit(limits),
                    model_revision=MODEL_REVISION, device=self.ranker.device, dtype='float32',
                    device_name=torch.cuda.get_device_name(0), cuda_available=torch.cuda.is_available(),
                    completed_gpu_tasks=self.completed, failed_gpu_tasks=self.failed,
                    configured_concurrency=self.config['siglipConcurrency'],
                    gpu_inference_concurrency=1, active_tasks=self.active,
                    gpu_allocated_mb=round(torch.cuda.memory_allocated()/1048576, 1),
                    gpu_reserved_mb=round(torch.cuda.memory_reserved()/1048576, 1),
                    gpu_peak_allocated_mb=round(torch.cuda.max_memory_allocated()/1048576, 1))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(150)

    def reply(self, status, payload):
        raw = json.dumps(payload, allow_nan=False).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        self.close_connection = True

    def authorized(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.state.token):
            self.reply(401, {'error': 'Unauthorized'})
            return False
        return True

    def body(self, maximum=16384):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= maximum:
            raise ValueError('Body size limit')
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        if not self.authorized():
            return
        try:
            if self.path == '/health':
                self.reply(200, self.server.state.health())
            elif self.path == '/config':
                self.reply(200, self.server.state.config)
            elif self.path == '/transfer-limits':
                self.reply(200, {'limits': self.server.state.transfer_limits.get()})
            else:
                self.reply(404, {'error': 'Not found'})
        except (ValueError, TypeError):
            self.reply(400, {'error': 'Invalid transfer-limit state'})

    def do_PUT(self):
        if not self.authorized():
            return
        if self.path == '/transfer-limits':
            try:
                self.reply(200, {'limits': self.server.state.transfer_limits.set(self.body())})
            except (ValueError, TypeError):
                self.reply(400, {'error': 'Invalid transfer limits'})
            except OSError:
                self.reply(503, {'error': 'Transfer-limit storage unavailable'})
            return
        if self.path != '/config':
            self.reply(404, {'error': 'Not found'})
            return
        try:
            config = validate_config(self.body())
            with self.server.state.lock:
                self.server.state.config = config
            self.reply(200, config)
        except (ValueError, TypeError):
            self.reply(400, {'error': 'Invalid configuration'})

    def do_POST(self):
        if self.path == '/transfer-limits':
            return self.do_PUT()
        if not self.authorized():
            return
        if self.path == '/config/validate':
            try:
                patch = self.body()
                if not isinstance(patch, dict):
                    raise ValueError('Expected object')
                with self.server.state.lock:
                    proposed = validate_config({**self.server.state.config, **patch})
                self.reply(200, {'valid': True, 'proposed': proposed})
            except (ValueError, TypeError):
                self.reply(400, {'error': 'Invalid configuration'})
            return
        if self.path != '/rank':
            self.reply(404, {'error': 'Not found'})
            return
        state = self.server.state
        with state.lock:
            if not state.config['enabled'] or not state.config['siglipEnabled'] or state.active >= state.config['siglipConcurrency']:
                self.reply(503, {'error': 'Unavailable or busy'})
                return
            state.active += 1
        try:
            limits = state.transfer_limits.get()
            query, candidates, options, mode = validate_payload(self.body(body_limit(limits)), limits)
            result = state.ranker.rank(query, candidates, options=options, mode=mode, limits=limits)
            with state.lock:
                state.completed += 1
            self.reply(200, result)
        except (ValueError, TypeError):
            self.reply(400, {'error': 'Invalid ranking request'})
        except Exception as exc:
            import sys
            print(f'[rank] failed: {type(exc).__name__}: {str(exc)[:200]}', file=sys.stderr, flush=True)
            with state.lock:
                state.failed += 1
            state.ranker.torch.cuda.empty_cache()
            self.reply(503, {'error': 'GPU ranking unavailable; use server fallback'})
        finally:
            with state.lock:
                state.active -= 1


def initial_config(path):
    return None if path is None else validate_config(json.loads(Path(path).read_text(encoding='utf-8')))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18194)
    parser.add_argument('--initial-config-file', type=Path)
    args = parser.parse_args()
    token = (ROOT.parent / 'private' / 'pc-boost-token.txt').read_text().strip()
    if len(token) < 32:
        raise RuntimeError('Missing private token')
    config = initial_config(args.initial_config_file)
    ranker = Ranker()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    server.state = State(ranker, token, config=config)
    print(json.dumps(dict(event='ready', port=args.port, **server.state.health())), flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    main()
