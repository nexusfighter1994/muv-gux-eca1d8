import crypto from 'node:crypto';
export function patchGeomap(source,expectedSha256='5888cec395cbdc56de2c65001e9289ae7b0bcc0c0983233b89a19ba7551a9395',hookPath){
  if(crypto.createHash('sha256').update(source).digest('hex')!==expectedSha256)throw Error('GeoMap source hash changed');
  const anchor='return renderCartograph({\n      params: preparedParams,';
  if(source.split(anchor).length!==2||!source.includes('await preprocessRenderParams(validated, mapboxToken)'))throw Error('Prepared Cartograph boundary changed');
  return `import { renderMapOffload } from ${JSON.stringify(hookPath)};\n`+source.replace(anchor,'return renderMapOffload(renderCartograph,{\n      params: preparedParams,');
}
