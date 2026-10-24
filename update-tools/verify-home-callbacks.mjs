import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

export const callbacks = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/home-callbacks-20261020.json', import.meta.url)));
export async function loadClassifiers(directory) {
  const load = name => import(pathToFileURL(path.join(directory, name)));
  const direct = await load('home-direct.mjs'), library = await load('home-library-trim.mjs');
  const motion = (await load('home-motion-dispatch.cjs')).default;
  const siglip = await load('home-siglip.mjs'), media = await load('home-media-callbacks.mjs');
  const camera = await load('home-camera.mjs'), scenes = await load('home-scenes.mjs');
  const hash = s => crypto.createHash('sha256').update(s).digest('hex');
  return {
    normalize: direct.isHomeDirectCallback,
    'library-trim': library.isHomeLibraryTrimCallback,
    'motion-direct': body => motion.renderOnly(body, true),
    'motion-opaque': body => motion.renderOnly(body, false),
    siglip: siglip.isHomeSiglipEmbedCallback,
    media: body => Boolean(media.classifyHomeMediaCallback(body)),
    camera: body => camera.CAMERA_CALLBACK_HASHES.has(hash(body)),
    scenes: body => hash(body) === scenes.SCENE_CALLBACK_HASH,
  };
}
export function verify(bundle, accepts) {
  for (const {family, body, sha256} of callbacks) {
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'), sha256);
    assert.equal(bundle.split(body).length - 1, 1, `Reviewed ${family} callback changed or duplicated`);
    assert.equal(accepts[family](body), true, `${family} would miss Home admission`);
    assert.equal(accepts[family](body + ';otherWork()'), false, `${family} classifier must stay closed`);
  }
  return {homeCallbackContract: '20261020', nativeCallbacks: callbacks.length, ok: true};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [bundlePath, directory] = process.argv.slice(2);
  assert.ok(bundlePath && directory, 'Provide native bundle and installed Home module directory');
  console.log(JSON.stringify(verify(fs.readFileSync(bundlePath, 'utf8'), await loadClassifiers(directory))));
}
