import crypto from 'node:crypto';
const stockSha='866ba28ec676eb8702daa24a21aa64a75511a0973731d98a72aed891f26e8c8e';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const leaseAnchors=[
  'function RU(){return Jbr.getStore()?.jobId||null}',
  'function mF(e){return e==="fflow"?"ffmpeg":V0i.has(e)?"render":e}',
  'Xl=()=>cbr.getStore()', 'fhe=new $Pr', 'jp=new Map',
  'isJobAborted:Cbi', 'function Cbi(e){return j0.has(e)}',
  'y={lane:i,jobId:e,resourceKey:o,priority:g,boosted:!!b?.boosted,cooldownProbe:!!b?.cooldownProbe,opKey:h.segmentType||null,quality:h.quality||null,signal:a,parked:!1,released:!1}',
  'I.set(i,y);let R=T?()=>T.run(r):r,N=await fhe.run({jobId:e,lanes:k,leases:I},R)',
];
const boundaries=[
  {start:'async function lUn(',end:'async function cUn(',
    sha:'49be43665c45e90c54306e5891ff0921fd5d226b5f6b5bcd4e228c25f5b14d31',
    from:'await t.render({compositionHtml:Pxe(n.html,o)',
    to:'await __vfMotion.render(t.render.bind(t),{jobId:r,licensedJobId:RU(),getScope:()=>fhe.getStore(),lane:mF("frameshift"),checkAbort:()=>jp.get(r)?.checkAbort?.(),isAborted:()=>e.isJobAborted(r),outerSignal:Xl(),duration:o},{compositionHtml:Pxe(n.html,o)'},
  {start:'async function OAe(',end:'function t2n(',
    sha:'206854c8a2d4137435ee374b10855ed81da651fd06ac34e0137375c092675441',
    from:'await e.frameshift.render({compositionHtml:t',
    to:'await __vfMotion.renderOverlay(e.frameshift.render.bind(e.frameshift),{kind:"frameshift-alpha-v1",jobId:fhe.getStore()?.jobId,licensedJobId:RU(),getLicensedJobId:()=>RU(),getScope:()=>fhe.getStore(),lane:mF("frameshift"),checkAbort:()=>jp.get(fhe.getStore()?.jobId)?.checkAbort?.(),isAborted:()=>Me.isJobAborted(fhe.getStore()?.jobId),outerSignal:Xl()},{compositionHtml:t'},
];

export function patchBundle(source,modulePath){
  if(typeof source!=='string'||typeof modulePath!=='string'||!modulePath)throw Error('native boundary changed');
  for(const anchor of leaseAnchors){
    if(source.split(anchor).length===2)continue;
    const owned=anchor.replace('boosted:!!b?.boosted,','boosted:b?.homeScope||!!b?.boosted,');
    if(owned!==anchor&&source.split(anchor).length===1&&source.split(owned).length===2
      &&source.split('/* vf-custom:independent-home-queue-v5 */').length===2)continue;
    throw Error('native lease anchors changed');
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
      throw Error('native renderer boundary/hash changed');
    if(installed&&boundary===boundaries[0]&&!bound)throw Error('opaque Motion hook drift');
    result=result.slice(0,start)+original.replace(boundary.from,boundary.to)+result.slice(end);
  }
  // Installed bundles can contain independent custom hooks; only our exact bodies may change.
  if(installed&&(source.match(/\b__vfMotion\b/g)||[]).length!==1+hookCount)
    throw Error('Motion namespace drift');
  return installed?result:prefix+result;
}
