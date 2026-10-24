import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

const [bundlePath, modulePath] = process.argv.slice(2);
assert.ok(bundlePath && modulePath, 'Provide native bundle and installed Home SigLIP module');
const bundle = fs.readFileSync(bundlePath, 'utf8');
const callbacks = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/siglip-callbacks-20261020.json', import.meta.url)));
const {isHomeSiglipEmbedCallback: accepts} = await import(pathToFileURL(modulePath));
for (const callback of callbacks) {
  assert.equal(bundle.split(callback).length - 1, 1, 'Reviewed native SigLIP callback changed');
  assert.equal(accepts(callback), true, 'Native embedding would miss independent Home admission');
  assert.equal(accepts(callback + ';otherWork()'), false, 'Classifier must remain closed');
}
assert.equal(accepts('()=>(s.ocr||Ixe)({images:[],recognize:!0,maxSide:480})'), false);
console.log(JSON.stringify({siglipCallbackContract: '20261020', nativeCallbacks: callbacks.length, ok: true}));
