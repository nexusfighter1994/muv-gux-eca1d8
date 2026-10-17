import fs from 'node:fs';
import crypto from 'node:crypto';
import {validate} from './worker.mjs';
let input='';for await(const b of process.stdin)input+=b;
const p=validate(JSON.parse(input),'transport-test');
if(p.assets.length!==1||p.assets[0].filename!=='hero.png')throw Error('asset transport missing');
if(p.compositionHtml.includes('DELAY')){fs.writeFileSync(process.argv[2]+'.active','started');await new Promise(resolve=>setTimeout(resolve,5000));}
const bytes=fs.readFileSync(process.argv[2]);
process.stdout.write(JSON.stringify({version:1,id:p.id,contract:p.contract,backend:'synthetic-transport-only',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')}));
