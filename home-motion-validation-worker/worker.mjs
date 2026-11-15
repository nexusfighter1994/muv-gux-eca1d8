import fs from 'node:fs/promises';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';

const root=path.resolve(process.argv[3]);
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const payload=JSON.parse(await fs.readFile(path.join(root,'request.json'),'utf8'));
const assets=[];
for(const a of payload.assets){
  if(a.data===undefined){assets.push({filename:a.filename});continue;}
  const data=Buffer.from(a.data,'base64');
  if(crypto.createHash('sha256').update(data).digest('hex')!==a.sha256)throw Error('Asset integrity');
  const localPath=path.join(root,a.filename);await fs.writeFile(localPath,data,{flag:'wx'});
  assets.push({filename:a.filename,localPath});
}
Object.assign(process.env,{
  PRODUCER_HEADLESS_SHELL_PATH:config.browser,HYPERFRAMES_TELEMETRY_DISABLED:'1',HYPERFRAMES_SKIP_SKILLS:'1',CI:'1',
  TEMP:root,TMP:root,HOME:root,USERPROFILE:root,
  HYPERFRAMES_FFMPEG_PATH:config.ffmpeg,HYPERFRAMES_FFPROBE_PATH:config.ffprobe,
  PRODUCER_BROWSER_GPU_MODE:'software',PRODUCER_DISABLE_GPU:'true',
  VIDFORGE_FRAMESHIFT_VALIDATE_REAL_ASSETS:payload.realAssets?'1':'0',
});
for(const key of ['APPDATA','LOCALAPPDATA']){process.env[key]=path.join(root,key);await fs.mkdir(process.env[key]);}
const spawn=cp.spawn;
cp.spawn=function(command,args,options){
  return /(?:^|[/\\])hyperframes(?:\.cmd)?$/.test(command)?spawn(process.execPath,[config.cli,...args],options):spawn(command,args,options);
};
syncBuiltinESMExports();
const native=await import(pathToFileURL(config.renderModule));
const result=await native.validateComposition({compositionHtml:payload.compositionHtml,assets,fps:payload.fps,resolution:payload.resolution});
await fs.writeFile(path.join(root,'result.json'),JSON.stringify({contract:payload.contract,result}),{flag:'wx'});
