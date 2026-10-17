import fs from 'node:fs';
import {patchBundle} from '../node/home-graphics/motion-offload/install.mjs';
import {patchGeomap} from '../node/home-graphics/map-offload/install.mjs';
const [bundle,map]=process.argv.slice(2);
if(!bundle||!map)throw Error('bundle and prepared-map entrypoints required');
const bundleSource=fs.readFileSync(bundle,'utf8');
const patchedBundle=patchBundle(bundleSource,'./vf-custom/home-graphics/motion-offload/binding.mjs');
const mapSource=fs.readFileSync(map,'utf8');
let source=mapSource;
if(!source.includes('import { renderMapOffload }')){
  source=patchGeomap(source,'301dc95c91e370b8df3cf476a0c1ef3e399db2f224623b732ab310ca64128c8b','../../server/dist/vf-custom/home-graphics/map-offload/hook.mjs');
}else if(source.split('return renderMapOffload(renderCartograph,{').length!==2)throw Error('Map hook drift');
// Validate both targets before writing either; never skip an import-present alpha upgrade.
if(patchedBundle!==bundleSource)fs.writeFileSync(bundle,patchedBundle);
if(source!==mapSource)fs.writeFileSync(map,source);
