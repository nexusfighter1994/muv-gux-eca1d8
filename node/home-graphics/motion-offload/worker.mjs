import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {KIND as ALPHA_KIND,execute as executeAlpha} from './alpha-worker.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const execFile=promisify(cp.execFile);
export const MAX=32*1024*1024;
export function validate(p,contract){
  if(!Number.isInteger(p.timeoutMs)||p.timeoutMs<1||p.timeoutMs>600000)throw Error('deadline');
  if(p.version!==1||p.contract!==contract||!/^[a-f0-9]{32}$/.test(p.id)||p.fps!==24||p.resolution!=='1920x1080'||!(Number.isInteger(p.workers)&&p.workers>=1&&p.workers<=3)||!['draft','standard','high'].includes(p.quality)||!Number.isFinite(p.duration)||p.duration<=0||p.duration>15)throw Error('contract');
  if(typeof p.compositionHtml!=='string'||Buffer.byteLength(p.compositionHtml)>2*1024*1024||typeof p.renderOnlyHtml!=='string'||Buffer.byteLength(p.renderOnlyHtml)>2*1024*1024||!Array.isArray(p.assets)||p.assets.length>32)throw Error('payload');
  const names=new Set();let total=0;
  for(const a of p.assets){if(!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}$/.test(a.filename)||a.filename.includes('..')||names.has(a.filename)||typeof a.data!=='string')throw Error('asset');names.add(a.filename);const b=Buffer.from(a.data,'base64');total+=b.length;if(hash(b)!==a.sha256||total>MAX)throw Error('asset hash/size');}
  return p;
}
export async function verify(file,p,ffprobe='ffprobe',ffmpeg='ffmpeg',signal){
  const result=JSON.parse((await execFile(ffprobe,['-v','error','-count_frames','-show_streams','-of','json',file],{timeout:30000,windowsHide:true,signal})).stdout);
  const v=result.streams.find(s=>s.codec_type==='video');
  if(!v||result.streams.length!==1||v.codec_name!=='h264'||v.profile!=='High'||v.time_base!=='1/12288'||v.pix_fmt!=='yuv420p'||v.width!==1920||v.height!==1080||v.avg_frame_rate!=='24/1'||Number(v.nb_read_frames)!==Math.ceil(p.duration*24)||Math.abs(Number(v.duration)-Math.ceil(p.duration*24)/24)>.002)throw Error('output contract');
  await execFile(ffmpeg,['-v','error','-xerror','-i',file,'-map','0:v:0','-f','null','-'],{timeout:30000,windowsHide:true,signal});return v;
}
export async function execute(p,config){
  validate(p,config.contract);
  for(const [file,expected]of Object.entries(config.files))if(hash(await fs.readFile(file))!==expected)throw Error('runtime changed');
  const root=await fs.mkdtemp(path.join(process.env.VF_MOTION_JOB_ROOT??os.tmpdir(),'vfmo-'));const output=path.join(root,'result.mp4');
  try{
    const assets=[];for(const a of p.assets){const localPath=path.join(root,a.filename);await fs.writeFile(localPath,Buffer.from(a.data,'base64'));assets.push({filename:a.filename,localPath});}
    // Native library only: no application entrypoint, licensing SDK or permit API.
    process.env.PRODUCER_BROWSER_GPU_MODE='hardware';process.env.PRODUCER_DISABLE_GPU='false';process.env.PRODUCER_HEADLESS_SHELL_PATH=config.browser;
    process.env.HYPERFRAMES_TELEMETRY_DISABLED='1';process.env.HYPERFRAMES_SKIP_SKILLS='1';process.env.CI='1';
    process.env.TEMP=root;process.env.TMP=root;process.env.HOME=root;process.env.USERPROFILE=root;
    for(const name of ['APPDATA','LOCALAPPDATA']){process.env[name]=path.join(root,name);await fs.mkdir(process.env[name]);}
    process.env.PRODUCER_RENDERS_DIR=path.join(root,'renders');
    process.env.HYPERFRAMES_FFMPEG_PATH=config.ffmpeg;process.env.HYPERFRAMES_FFPROBE_PATH=config.ffprobe;
    const original=cp.spawn;
    cp.spawn=function(command,args,options){return /(?:^|[/\\])hyperframes(?:\.cmd)?$/.test(command)?original(process.execPath,[config.cli,...args,...(args[0]==='render'?['--debug']:[])],options):original(command,args,options);};syncBuiltinESMExports();
    const native=await import(pathToFileURL(config.renderModule));
    await native.render({compositionHtml:p.compositionHtml,renderOnlyHtml:p.renderOnlyHtml,assets,fps:p.fps,resolution:p.resolution,workers:p.workers,quality:p.quality,targetPath:output,workDir:root,timeoutMs:p.timeoutMs});
    const probe=await verify(output,p,config.ffprobe,config.ffmpeg);const bytes=await fs.readFile(output);if(bytes.length>MAX)throw Error('output size');
    let backend=null;const scan=async dir=>{for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await scan(f);else if(e.name==='perf-summary.json'){const s=await fs.readFile(f,'utf8');if(/"gpuRenderer"\s*:\s*"d3d11\/nvidia"/.test(s))backend='d3d11/nvidia';}}};await scan(root);
    if(!backend)throw Error('hardware proof missing');
    return {version:1,id:p.id,contract:p.contract,backend,sha256:hash(bytes),data:bytes.toString('base64'),probe};
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
if(typeof import.meta.url==='string'&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){void(async()=>{try{let raw='';for await(const b of process.stdin){raw+=b;if(raw.length>48*1024*1024)throw Error('body size');}const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));const payload=JSON.parse(raw);process.stdout.write(JSON.stringify(await (payload.kind===ALPHA_KIND?executeAlpha:execute)(payload,config)));}catch(error){process.stderr.write(String(error.message).slice(0,2000));process.exitCode=1;}})();}
