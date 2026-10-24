import crypto from 'node:crypto';
const stockSha='1681d6415fae0d2ab42cfc453b3c383c9484718bde1c48a7673aefd8d5469dec';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const leaseAnchors=[
  'function w8(){return skr.getStore()?.jobId||null}',
  'function YL(e){return e==="fflow"?"ffmpeg":jRi.has(e)?"render":e}',
  'cl=()=>aSr.getStore()', 'S0e=new iQr', 'af=new Map',
  'isJobAborted:SNi', 'function SNi(e){return hb.has(e)}',
  'A={lane:s,jobId:e,resourceKey:i,priority:b,boosted:!!y?.boosted,cooldownProbe:!!y?.cooldownProbe,opKey:m.segmentType||null,quality:m.quality||null,signal:a,parked:!1,released:!1}',
  'R.set(s,A);let N=C?()=>C.run(r):r,M=await S0e.run({jobId:e,lanes:I,leases:R},N)',
];
const boundaries=[
  {start:'async function bYn(',end:'async function yYn(',
    sha:'4638e94e0fad7beb5d5be85e80ddadfbf544dca81e6e84ad0fadc87c835e2816',
    from:'await t.render({compositionHtml:w_e(n.html,o)',
    to:'await __vfMotion.render(t.render.bind(t),{jobId:r,licensedJobId:w8(),getScope:()=>S0e.getStore(),lane:YL("frameshift"),checkAbort:()=>af.get(r)?.checkAbort?.(),isAborted:()=>e.isJobAborted(r),outerSignal:cl(),duration:o},{compositionHtml:w_e(n.html,o)'},
  {start:'async function h1e(',end:'function nBn(',
    sha:'f0803e4b1d719a7bbb8e4c34a2a1302ecc65154601ce93f9feaecbcc6ecdfb87',
    from:'await e.frameshift.render({compositionHtml:tBn(t)',
    to:'await __vfMotion.renderOverlay(e.frameshift.render.bind(e.frameshift),{kind:"frameshift-alpha-v1",jobId:S0e.getStore()?.jobId,licensedJobId:w8(),getLicensedJobId:()=>w8(),getScope:()=>S0e.getStore(),lane:YL("frameshift"),checkAbort:()=>af.get(S0e.getStore()?.jobId)?.checkAbort?.(),isAborted:()=>Oe.isJobAborted(S0e.getStore()?.jobId),outerSignal:cl()},{compositionHtml:tBn(t)'},
];

export function patchBundle(source,modulePath){
  if(typeof source!=='string'||typeof modulePath!=='string'||!modulePath)throw Error('native boundary changed');
  for(const anchor of leaseAnchors){
    if(source.split(anchor).length===2)continue;
    const owned=anchor.replace('boosted:!!y?.boosted,','boosted:y?.homeScope||!!y?.boosted,');
    if(owned!==anchor&&source.split(anchor).length===1&&source.split(owned).length===2
      &&source.split('/* vf-custom:independent-home-queue-k5 */').length===2)continue;
    throw Error('native lease anchors changed: '+anchor);
  }
  const prefix='import*as __vfMotion from '+JSON.stringify(modulePath)+';\n';
  const installed=source.includes('import*as __vfMotion from ');
  if(installed){
    if(source.split(prefix).length!==2||source.split('import*as __vfMotion from ').length!==2)
      throw Error('Motion import boundary changed');
  }else if(hash(source)!==stockSha)throw Error('native version/hash changed');
  let result=source,hookCount=0;
  for(const boundary of boundaries){
    const start=result.indexOf(boundary.start),end=result.indexOf(boundary.end,start);
    if(start<0||end<start||result.split(boundary.start).length!==2||result.split(boundary.end).length!==2)
      throw Error('native boundary changed');
    const body=result.slice(start,end),bound=body.includes(boundary.to);
    if(bound)hookCount++;
    const original=bound?body.replace(boundary.to,boundary.from):body;
    if(hash(original)!==boundary.sha||original.split(boundary.from).length!==2)
      throw Error('native renderer boundary/hash changed: '+boundary.start+' '+hash(original)+' '+boundary.sha+' calls='+original.split(boundary.from).length);
    if(installed&&boundary===boundaries[0]&&!bound)throw Error('opaque Motion hook drift');
    result=result.slice(0,start)+original.replace(boundary.from,boundary.to)+result.slice(end);
  }
  // Installed bundles can contain independent custom hooks; only our exact bodies may change.
  if(installed&&(source.match(/\b__vfMotion\b/g)||[]).length!==1+hookCount)
    throw Error('Motion namespace drift');
  return installed?result:prefix+result;
}
