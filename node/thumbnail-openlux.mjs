export function createThumbnailOpenluxHooks({ getCredential, render, crop, suffix = '', isControlError = () => false, isSensitive = () => false }) {
  const results = new Map();
  const key = args => JSON.stringify([args.jobId || null, args.targetPath]);
  const record = (args, value) => {
    if (args.operation !== 'thumbnail-generate') return;
    if (results.size >= 500) results.delete(results.keys().next().value);
    results.set(key(args), value);
  };
  const terminal = (error, jobId) => error?.noFallback === true || error?.pauseRun === true || isControlError(error, jobId);
  const emit = (args, event) => args.emit?.({ step: 'thumbnails', ...event });

  function wrapCli(original) {
    if (original.vfThumbnailOpenlux) return original;
    async function generate(args) {
      const credential = getCredential();
      if (!credential?.apiKey || !args.refImageLocalPath) return original.call(this, args);
      const result = await original.call(this, {
        ...args,
        emit: event => emit(args, event.message?.startsWith('CLI proxy thumbnail generation failed')
          ? { ...event, message: 'CLI proxy thumbnail generation failed - trying OpenLux GPT Image 2 before Nano Banana.' }
          : event),
      });
      if (result) return result;
      emit(args, { message: 'Generating thumbnail on OpenLux (GPT Image 2).' });
      try {
        await render({
          route: { id: 'openlux', provider: 'openlux', model: 'gpt-image-2', credential },
          prompt: `${args.prompt}${typeof suffix === 'function' ? suffix() : suffix}`, aspectRatio: '16:9',
          referenceImagePaths: [args.refImageLocalPath], destPath: args.targetPath,
          jobId: args.jobId, usageMeta: { category: 'thumbnails', operation: args.operation },
        });
        const cropped = await crop(args.targetPath);
        record(args, { provider: 'openlux', model: 'gpt-image-2' });
        emit(args, {
          message: `Thumbnail ${args.operation === 'thumbnail-edit' ? 'corrected' : 'generated'} on OpenLux (GPT Image 2).`,
          data: { provider: 'openlux', model: 'gpt-image-2', widescreenCrop: cropped?.cropped === true },
        });
        return args.targetPath;
      } catch (error) {
        if (terminal(error, args.jobId)) throw error;
        record(args, { error });
        emit(args, {
          level: 'warn', message: 'OpenLux thumbnail generation failed - continuing with the existing fallback routes.',
          data: { provider: 'openlux', model: 'gpt-image-2', error: String(error?.message || error).slice(0, 500) },
        });
        return null;
      }
    }
    Object.defineProperty(generate, 'vfThumbnailOpenlux', { value: true });
    return generate;
  }

  function wrapGenerate(original) {
    if (original.vfThumbnailOpenlux) return original;
    async function generate(args) {
      const id = key(args);
      try {
        const output = await original.call(this, args);
        const winner = results.get(id);
        return winner?.provider === 'openlux' ? { ...output, ...winner } : output;
      } catch (error) {
        const failure = results.get(id)?.error;
        if (failure && Array.isArray(error?.failures)) {
          error.failures.splice(1, 0, { provider: 'openlux', model: 'gpt-image-2', code: failure.code || null, message: String(failure.message || failure).slice(0, 500), sensitive: isSensitive(failure) });
        }
        throw error;
      } finally {
        results.delete(id);
      }
    }
    Object.defineProperty(generate, 'vfThumbnailOpenlux', { value: true });
    return generate;
  }
  return { wrapCli, wrapGenerate };
}
