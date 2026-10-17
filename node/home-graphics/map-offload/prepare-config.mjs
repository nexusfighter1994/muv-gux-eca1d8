import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),runtime=path.resolve(here,'../map-runtime');
const files={};
async function add(file){files[file]=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');}
async function walk(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())await walk(file);else await add(file);}}
await walk(path.join(runtime,'cartograph-gpu'));
for(const file of ['cartograph-gpu-backend.cjs','map-render-child.mjs','render-child-supervisor.mjs','render-artifact.mjs','package-lock.json','node_modules/skia-canvas/lib/skia.node'])await add(path.join(runtime,file));
await add(path.join(here,'worker.mjs'));
await fs.writeFile(path.join(here,'runtime.json'),JSON.stringify({contract:'vf27-cartograph-vulkan-v1',node:process.execPath,files},null,2));
console.log(`Map runtime pinned: ${Object.keys(files).length} files`);
