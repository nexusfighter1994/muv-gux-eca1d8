const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ID = 'openaiImages';
const MODEL = 'gpt-image-2';
// vf-custom:openai-images-v2 (2026-11-13): OpenAI rejects background "transparent" on gpt-image-2
// ("Transparent background is not supported for this model"; 622 such failures in 48 h, each one
// fell back to fal). gpt-image-2.5-flare supports it natively, so transparent requests use that model.
const TRANSPARENT_MODEL = 'gpt-image-2.5-flare';
const VERSION = 'openai-images-v2';
const BASE = 'https://api.openai.com/v1';
const IMAGE_LIMIT = 20 * 1024 * 1024;

function failure(message, terminal = false) {
  return Object.assign(Error(message), { provider: ID, code: 'openai_image_contract', noRetry: true, ...(terminal ? { noFallback: true } : {}) });
}

function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function wrapImageRoutes(original, { getCredential, order, enabled = () => true }) {
  return function (model, options = {}) {
    const rows = original.call(this, model, options);
    if (!enabled()) return rows;
    const pipeline = options.referenceImagePaths?.length || options.referenceImageUrls?.length ? 'refedits' : 'images';
    const credential = getCredential(ID, pipeline);
    if (!credential?.apiKey) return rows;
    return order(pipeline, [...rows.filter(row => row.id !== ID), { id: ID, provider: ID, model: MODEL, credential }]);
  };
}

function wrapThumbnailRoutes(original, { getCredential, order, readModel, enabled = () => true, openluxEnabled = () => true }) {
  return function (options) {
    const rows = original.call(this, options);
    if (!enabled()) return rows;
    const extra = [];
    for (const id of [ID, 'openlux']) {
      if (id === 'openlux' && !openluxEnabled()) continue;
      const credential = getCredential(id, 'thumbnails');
      if (!credential?.apiKey) continue;
      extra.push({ id, provider: id, model: id === ID ? MODEL : readModel?.('thumbnails', id) || MODEL, credential });
    }
    return order('thumbnails', [...rows.filter(row => !extra.some(item => item.id === row.id)), ...extra]);
  };
}

function createOpenAIImagesRenderer({ request, download, recordUsage, emit = () => {} }) {
  if (typeof request !== 'function' || typeof download !== 'function' || typeof recordUsage !== 'function') throw Error('Native image dependencies required');
  return async function render(args) {
    const { route, prompt, aspectRatio = '16:9', destPath, jobId = null, usageMeta = {}, signal } = args;
    if (route?.provider !== ID || (route.model !== MODEL && route.model !== TRANSPARENT_MODEL)) throw failure('Direct OpenAI images only supports gpt-image-2 and gpt-image-2.5-flare');
    const model = args.background === 'transparent' ? TRANSPARENT_MODEL : route.model;
    const key = route.credential?.apiKey;
    if (!key) throw failure('OpenAI Images credential is not configured');
    signal?.throwIfAborted();
    const paths = args.referenceImagePaths || [], urls = args.referenceImageUrls || [];
    if (!Array.isArray(paths) || !Array.isArray(urls) || paths.length + urls.length > 16) throw failure('OpenAI Images accepts at most16 reference images');
    // Thumbnail Studio also puts its avatar HTTPS reference in the paths array.
    const local = paths.filter(value => !/^https?:\/\//i.test(value));
    const remote = [...paths.filter(value => /^https?:\/\//i.test(value)), ...urls];
    const quality = args.variant || args.quality || 'high';
    if (!['low', 'medium', 'high', 'auto'].includes(quality)) throw failure('Invalid gpt-image-2 quality');
    const size = aspectRatio === '9:16' ? '1024x1536' : aspectRatio === '1:1' ? '1024x1024' : '1536x1024';
    const extension = path.extname(destPath).toLowerCase();
    const outputFormat = args.outputFormat || (['.jpg', '.jpeg'].includes(extension) ? 'jpeg' : extension === '.webp' ? 'webp' : 'png');
    if (!['png', 'jpeg', 'webp'].includes(outputFormat)) throw failure('Unsupported OpenAI image output format');
    if (args.background === 'transparent' && outputFormat === 'jpeg') throw failure('Transparent images require PNG or WebP');
    const parent = path.resolve(path.dirname(destPath));
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, '.openai-images-'));
    let submitted = false, received = false;
    try {
      const references = [...local];
      for (let i = 0; i < remote.length; i++) {
        if (new URL(remote[i]).protocol !== 'https:') throw failure('Reference URLs must use HTTPS');
        const target = path.join(directory, 'reference-' + i);
        await download(remote[i], target, { provider: ID, maxBytes: IMAGE_LIMIT, ...(signal ? { signal } : {}) });
        references.push(target);
      }
      const fields = { model, prompt, n: 1, size, quality, output_format: outputFormat, ...(args.background ? { background: args.background } : {}) };
      const options = {
        method: 'POST', headers: { Authorization: 'Bearer ' + key, 'X-Client-Request-Id': randomUUID() },
        provider: ID, logBody: false, timeoutMs: 300000, maxResponseBytes: 80 * 1024 * 1024, ...(signal ? { signal } : {}),
      };
      if (references.length) {
        const form = new FormData();
        for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
        for (const reference of references) {
          const stat = await fs.stat(reference);
          if (!stat.isFile() || stat.size < 1 || stat.size > IMAGE_LIMIT) throw failure('Reference image size/type is invalid');
          const bytes = await fs.readFile(reference), type = imageType(bytes);
          if (!type) throw failure('Reference image must be PNG, JPEG or WebP');
          form.append('image[]', new Blob([bytes], { type }), path.basename(reference));
        }
        options.form = form;
      } else options.json = fields;
      signal?.throwIfAborted();
      submitted = true;
      const result = await request(BASE + '/images/' + (references.length ? 'edits' : 'generations'), options);
      received = true;
      recordUsage({ jobId, provider: ID, model, unit: 'images', quantity: 1, variant: quality,
        meta: { ...usageMeta, endpoint: references.length ? 'edits' : 'generations', referenceCount: references.length,
          openaiUsage: result?.usage || null, costSource: 'configured-image-rate' } });
      if (result?.data?.length !== 1 || typeof result.data[0]?.b64_json !== 'string') throw failure('OpenAI completed without one image', true);
      const bytes = Buffer.from(result.data[0].b64_json, 'base64'), type = imageType(bytes);
      if (!type || bytes.length < 100 || bytes.length > 60 * 1024 * 1024 || type !== 'image/' + outputFormat) throw failure('Invalid OpenAI image output', true);
      const staged = path.join(directory, 'result.' + outputFormat);
      await fs.writeFile(staged, bytes, { flag: 'wx' });
      signal?.throwIfAborted();
      await fs.rename(staged, destPath);
      emit({ jobId, step: usageMeta.category === 'thumbnails' ? 'thumbnails' : 'image_generation',
        message: 'Image completed on OpenAI directly (' + model + ').',
        data: { provider: ID, model, operation: usageMeta.operation || null, referenceCount: references.length, quality } });
      return { provider: ID, model };
    } catch (error) {
      if (typeof error.message === 'string') error.message = error.message.split(key).join('[redacted]');
      if (received || submitted && !Number.isFinite(Number(error?.detail?.status || /^http_(\d+)$/.exec(error?.code || '')?.[1]))) {
        error.noFallback = true;
        error.noRetry = true;
      }
      throw error;
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  };
}

module.exports = { ID, MODEL, TRANSPARENT_MODEL, VERSION, createOpenAIImagesRenderer, wrapImageRoutes, wrapThumbnailRoutes };
