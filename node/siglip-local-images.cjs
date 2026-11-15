'use strict';
const fs=require('node:fs'),path=require('node:path');
const stats={local:0,bytes:0,http:0};
const types={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};

// Only the native, loopback FFlow image store is eligible. Bytes and the
// caller's streaming transfer/buffer accounting remain unchanged.
function createLocalImageFetch({trusted,fetcher=fetch,
  mediaDir=process.env.FFLOW_STORAGE_DIR||path.join(process.env.DATA_DIR||'/data','engines','fflow','media'),
  enabled=process.env.VIDFORGE_FFLOW_LOCAL_STAGING!=='0'}={}){
  let base;try{base=new URL(trusted);}catch{}
  const local=enabled&&base?.protocol==='http:'&&base.hostname==='127.0.0.1'&&!base.username&&!base.password&&base.pathname==='/'&&!base.search;
  return async function(input,options={}){
    options.signal?.throwIfAborted();let handle,response;
    try{
      const target=new URL(input),raw=String(input).split('://')[1]?.split('/').slice(1).join('/');
      const parts=raw?.split('/');
      if(local&&String(options.method||'GET').toUpperCase()==='GET'&&target.origin===base.origin&&!target.username&&!target.password&&!target.search&&!target.hash&&
        parts?.[0]==='v1'&&parts[1]==='download'&&['outputs','inputs'].includes(parts[2])&&parts.length>=4&&
        parts.slice(3).every(p=>/^[a-zA-Z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..')&&types[path.extname(target.pathname).toLowerCase()]){
        const media=await fs.promises.realpath(mediaDir),root=path.join(media,parts[2]);
        if(await fs.promises.realpath(root)!==root)throw Error('Local image root scope');
        const file=path.join(root,...parts.slice(3)),real=await fs.promises.realpath(file);
        if(real!==file||!real.startsWith(root+path.sep))throw Error('Local image path scope');
        handle=await fs.promises.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
        const before=await handle.stat();if(!before.isFile()||before.size<1)throw Error('Local image type');
        options.signal?.throwIfAborted();
        const owned=handle;let position=0,closed=false;
        const close=async()=>{if(!closed){closed=true;await owned.close();}};
        const stream=new ReadableStream({
          async pull(controller){
            try{
              options.signal?.throwIfAborted();
              if(position===before.size){
                const after=await owned.stat();
                if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('Local image changed during transfer');
                await close();controller.close();return;
              }
              const buffer=Buffer.allocUnsafe(Math.min(65536,before.size-position));
              const {bytesRead}=await owned.read(buffer,0,buffer.length,position);
              options.signal?.throwIfAborted();if(!bytesRead)throw Error('Local image truncated');
              position+=bytesRead;stats.bytes+=bytesRead;controller.enqueue(buffer.subarray(0,bytesRead));
            }catch(error){await close();controller.error(error);}
          },async cancel(){await close();}
        },{highWaterMark:0});
        response=new Response(stream,{headers:{'content-type':types[path.extname(target.pathname).toLowerCase()],'content-length':String(before.size)}});
        handle=null;stats.local++;
      }
    }catch(error){options.signal?.throwIfAborted();}
    finally{if(handle)await handle.close();}
    if(response)return response;
    stats.http++;return fetcher(input,options);
  };
}
module.exports={createLocalImageFetch,stats};
