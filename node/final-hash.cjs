'use strict';
const nativeFs=require('node:fs'),crypto=require('node:crypto');
const path=require('node:path');
const BLOCK_BYTES=1024*1024,VERSION='final-hash-cooperative-v3';

function createCooperativeReadFs(fs,{now=()=>performance.now()}={}){
  let turnStarted=now();
  return {...fs,read(fd,buffer,offset,length,position,callback){
    let error=null,bytes=0;
    try{bytes=fs.readSync(fd,buffer,offset,length,position)}catch(e){error=e}
    // A final hash gets a short CPU turn, not one delayed event-loop turn per block.
    const yieldTurn=now()-turnStarted>=16;
    const schedule=yieldTurn?setImmediate:queueMicrotask;
    schedule(()=>{if(yieldTurn)turnStarted=now();callback(error,bytes,buffer)});
  }};
}

function createFinalHasher(original,{fs=nativeFs,onlyFinalFiles=false}={}){
  if(original.finalHashVersion===VERSION)return original;
  function hashFile(file){
    if(onlyFinalFiles&&!/^\/data\/projects\/([^/]+)\/\1\.mp4$/.test(String(file)))return Reflect.apply(original,this,arguments);
    return hash(file);
  }
  async function hash(file){
    const hash=crypto.createHash('sha256');
    await new Promise((resolve,reject)=>{
      const stream=fs.createReadStream(file,{highWaterMark:BLOCK_BYTES,fs:createCooperativeReadFs(fs)});
      stream.on('data',bytes=>hash.update(bytes));
      stream.once('error',reject);stream.once('end',resolve);
    });
    return hash.digest('hex');
  }
  Object.defineProperties(hashFile,{finalHashVersion:{value:VERSION},originalFinalHasher:{value:original}});
  return hashFile;
}

function promoteFinalHashStream(stream,expectedPath,{checkpoint=false}={}){
  // Only the already-running native final hash may change its next read size.
  const final=/^\/data\/projects\/([^/]+)\/\1\.mp4$/.test(expectedPath||'');
  const chunk=checkpoint&&typeof expectedPath==='string'&&path.posix.normalize(expectedPath)===expectedPath
    &&/^\/data\/projects\/[^/]+\/chunks\/chunk_\d+(?:[./].*)?\.mp4$/.test(expectedPath);
  if(!(final||chunk)
    ||stream?.path!==expectedPath||stream.constructor?.name!=='ReadStream'
    ||stream.destroyed||stream.readableFlowing!==true
    ||![65536,BLOCK_BYTES].includes(stream._readableState?.highWaterMark))return false;
  const listeners=stream.listeners('data');
  if(listeners.length!==1||!['i=>t.update(i)','bytes=>hash.update(bytes)'].includes(String(listeners[0])))return false;
  const fsKey=Object.getOwnPropertySymbols(stream).find(s=>s.description==='kFs');
  if(!fsKey||typeof stream[fsKey]?.readSync!=='function'||stream[fsKey].finalHashCooperative==='time16-v1')return false;
  stream[fsKey]=Object.assign(createCooperativeReadFs(stream[fsKey]),{finalHashCooperative:'time16-v1'});
  stream._readableState.highWaterMark=BLOCK_BYTES;
  return true;
}
module.exports={createFinalHasher,promoteFinalHashStream,createCooperativeReadFs,BLOCK_BYTES};
