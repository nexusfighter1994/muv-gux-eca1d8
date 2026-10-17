import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const canonical = path.dirname(here);
const [baseRoot, releaseRoot] = process.argv.slice(2);
if (!baseRoot || !releaseRoot || path.resolve(baseRoot) === path.resolve(releaseRoot)) throw Error('new absolute release required');
for (const value of [baseRoot, releaseRoot]) if (!path.isAbsolute(value)) throw Error('absolute release paths required');
await fs.access(releaseRoot).then(() => { throw Error('release already exists'); }, e => { if (e.code !== 'ENOENT') throw e; });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const prior = JSON.parse(await fs.readFile(path.join(baseRoot, 'motion-offload/runtime.json'), 'utf8'));
for (const [file, expected] of Object.entries(prior.files)) {
  if (sha(await fs.readFile(file)) !== expected) throw Error('old release integrity mismatch');
}
const mutableCache = file => file.split(/[\\/]/).includes('__pycache__') || /\.py[co]$/i.test(file);
await fs.cp(baseRoot, releaseRoot, {recursive: true, dereference: false, force: false, errorOnExist: true,
  filter: file => !mutableCache(file)});
for (const name of ['worker.mjs', 'alpha-worker.mjs', 'alpha-hook.mjs', 'hook.mjs', 'binding.mjs']) {
  await fs.copyFile(path.join(canonical, 'node/home-graphics/motion-offload', name), path.join(releaseRoot, 'motion-offload', name));
}
for (const name of ['transport.py', 'adapter.py']) await fs.copyFile(path.join(here, 'motion-offload', name), path.join(releaseRoot, 'motion-offload', name));
await fs.copyFile(path.join(here, 'shared-graphics-worker/graphics_bootstrap.py'), path.join(releaseRoot, 'shared-graphics-worker/graphics_bootstrap.py'));
await fs.copyFile(path.join(baseRoot, 'shared-graphics-worker/worker.patched.py'), path.join(releaseRoot, 'shared-graphics-worker/worker.patched.py'));
for (const name of ['worker.mjs', 'service.py', 'runtime.json']) await fs.copyFile(path.join(baseRoot, 'map-offload', name), path.join(releaseRoot, 'map-offload', name));
const files = {};
const generated = new Set(['runtime.json', 'release.json', 'map-runtime.json', 'motion-offload/runtime.json', 'map-offload/runtime.json']);
async function walk(dir) {
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (mutableCache(file)) continue;
    if (entry.isSymbolicLink()) throw Error('mutable link in release');
    if (entry.isDirectory()) await walk(file);
    else if (!generated.has(path.relative(releaseRoot, file).split(path.sep).join('/'))) files[file] = sha(await fs.readFile(file));
  }
}
await walk(releaseRoot);
const contract = sha(JSON.stringify(files));
const config = {...prior, contract, files, kinds: ['frameshift-alpha-v1'], maxOutputBytes: 128 * 1024 * 1024, maxResponseBytes: 176 * 1024 * 1024};
for (const name of ['node', 'renderModule', 'cli', 'browser', 'ffmpeg', 'ffprobe']) config[name] = path.join(releaseRoot, path.relative(baseRoot, prior[name]));
const mapConfig = JSON.parse(await fs.readFile(path.join(baseRoot, 'map-offload/runtime.json'), 'utf8'));
mapConfig.files = files;
mapConfig.node = config.node;
await fs.writeFile(path.join(releaseRoot, 'motion-offload/runtime.json'), JSON.stringify(config, null, 2));
await fs.writeFile(path.join(releaseRoot, 'map-offload/runtime.json'), JSON.stringify(mapConfig, null, 2));
await fs.writeFile(path.join(releaseRoot, 'runtime.json'), JSON.stringify(config, null, 2));
await fs.writeFile(path.join(releaseRoot, 'map-runtime.json'), JSON.stringify(mapConfig, null, 2));
await fs.writeFile(path.join(releaseRoot, 'release.json'), JSON.stringify({version: 1, contract, base: baseRoot, files}, null, 2));
console.log(JSON.stringify({contract, pinnedFiles: Object.keys(files).length, release: releaseRoot}));
