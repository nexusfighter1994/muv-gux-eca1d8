'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const {CALLBACKS}=require('../node/home-ocr.cjs');
const bundle=fs.readFileSync(process.argv[2]||'/app/server/dist/index.mjs','utf8');
for(const callback of CALLBACKS)assert.equal(bundle.split(callback).length-1,1,'Reviewed native OCR callback changed');
const nativeRoot=process.argv[3]||'/app/engines/siglip/app';
for(const file of ['ocr.py','image_io.py','schemas.py','concurrency.py']){
  assert.equal(fs.readFileSync(path.join(nativeRoot,file),'utf8').replace(/\r\n/g,'\n'),
    fs.readFileSync(path.join(__dirname,'../home-ocr-worker/native/app',file),'utf8').replace(/\r\n/g,'\n'),'Native OCR source changed: '+file);
}
console.log(JSON.stringify({homeOcrContract:'native-v1-20261029',callbacks:CALLBACKS.length,nativeFiles:4,ok:true}));
