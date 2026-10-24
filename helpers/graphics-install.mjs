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
  source=patchGeomap(source,'dcddcaeebe45994a6f01d33c3d3296252273a247acce6435c6af14ce7066bf8f','../../server/dist/vf-custom/home-graphics/map-offload/hook.mjs');
}else if(source.split('return renderMapOffload(renderCartograph,{').length!==2)throw Error('Map hook drift');
// Validate both targets before writing either; never skip an import-present alpha upgrade.
if(patchedBundle!==bundleSource)fs.writeFileSync(bundle,patchedBundle);
if(source!==mapSource)fs.writeFileSync(map,source);
