import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createServerPermits} from '../node/home-queue.mjs';
import {wrapHomeNormalizeExec} from '../node/home-normalize.mjs';
import * as direct from '../node/home-direct.mjs';
const {guardHomeDirectCallback,isHomeDirectCallback,markPendingHomeCandidates}=direct;

test('only exact native callbacks release a historical candidate quota',()=>{
  const scope={candidate:true,kind:'video-normalize'};
  assert.equal(direct.confirmHomeCandidate(scope,'()=>unknown()'),false);
  assert.equal(scope.candidate,true);
  assert.equal(direct.confirmHomeCandidate(scope,'()=>u('+recipe+')'),true);
  assert.equal(scope.candidate,false);
});

const recipe='["-y","-i",e,"-vf",h,"-map","0:v:0","-map","0:a?","-c:v","libx264",...TL(),"-pix_fmt","yuv420p","-r","24","-c:a","aac","-b:a","192k","-t",p.toFixed(3),"-movflags","+faststart",t],{timeoutMs:18e4}';
test('exact credit and crop callbacks are recognized before optional Home execution',()=>{
  assert.equal(isHomeDirectCallback('()=>u('+recipe+')'),true);
  assert.equal(isHomeDirectCallback('()=>s('+recipe.replace('"-vf",h','"-vf",r').replace('p.toFixed','l.toFixed')+')'),true);
  for(const value of ['()=>C.run("fflow scenes/detect",fn)','()=>unknown()', '()=>u('+recipe.replace('"24"','"30"')+')'])
    assert.equal(isHomeDirectCallback(value),false);
});
test('unknown historical candidates require an actual counted native recovery',async()=>{
  const calls=[],scope={kind:'video-normalize',nonce:'n'};
  const callback=()=>{calls.push('run');return 42;};
  const guarded=guardHomeDirectCallback(callback,scope,async(s,fn)=>{assert.equal(s,scope);calls.push('permit');return fn();},
    undefined,(s,fn)=>{assert.equal(s,scope);calls.push('native-context');return fn();});
  assert.deepEqual(calls,[]);assert.equal(await guarded(),42);assert.deepEqual(calls,['permit','native-context','run']);
});
test('other Home scopes and unknown queue families remain untouched',()=>{
  const fn=()=>1;assert.equal(guardHomeDirectCallback(fn,{kind:'composition'},()=>{}),fn);
  const rows=[{resourceKey:'ffmpeg',opKey:'b_roll_video'},{resourceKey:'ffmpeg',opKey:'b_roll_image'},
    {resourceKey:'ffmpeg',opKey:'b_roll_video',homeKind:'video-trim'},{resourceKey:'render',opKey:'b_roll_video'}];
  assert.equal(markPendingHomeCandidates({waiters:rows}),1);
  assert.equal(rows[0].homeKind,'video-normalize-candidate');assert.equal(rows[1].homeKind,undefined);
  assert.equal(rows[2].homeKind,'video-trim');assert.equal(rows[3].homeKind,undefined);
  assert.equal(markPendingHomeCandidates({waiters:rows}),0);
});

test('a missing or throwing memory sampler cannot run an unknown Home candidate uncounted',async()=>{
  assert.equal(typeof direct.installHomeDirect,'function');
  for(const factory of [()=>null,()=>{throw Error('sampling failure');}]){
    let sampler=factory;const order=[];
    const scope={kind:'video-normalize',nonce:'n'};
    const scheduler={run(){}};
    direct.installHomeDirect({scheduler,getSlotMeasurer:()=>sampler,setSlotMeasurer:v=>sampler=v,
      getContext:()=>({leases:new Map([['ffmpeg',{boosted:scope}]])}),
      runRecovery:async(s,fn)=>{order.push('counted');return fn();},
      runNativeContext:(s,fn)=>{assert.equal(s,scope);order.push('native-context');return fn();}});
    const measure=sampler({resourceKey:'ffmpegHome'});
    assert.equal(await measure.run(()=>{order.push('ran');return 9;}),9);
    assert.deepEqual(order,['counted','native-context','ran']);measure.finish({success:true});
  }
});

test('new exact credit callbacks receive Home metadata without changing other operation options',async()=>{
  assert.equal(typeof direct.installHomeDirect,'function');
  let received,sampler=()=>null;
  const scheduler={run(...args){received=args;return 7;}};
  direct.installHomeDirect({scheduler,getSlotMeasurer:()=>sampler,setSlotMeasurer:v=>sampler=v,
    getContext:()=>null,runRecovery:()=>{throw Error('unexpected');},
    runNativeContext:()=>{throw Error('unexpected native context');}});
  const callback='()=>u('+recipe+')',signal=new AbortController().signal;
  assert.equal(scheduler.run('job','ffmpeg',callback,{signal,segmentType:'b_roll_video'}),7);
  assert.equal(received[3].homeKind,'video-normalize');assert.equal(received[3].signal,signal);
  scheduler.run('job','ffmpeg',()=>1,{operation:'unrelated'});
  assert.deepEqual(received[3],{operation:'unrelated'});
});

test('native context is required before installing or running an unknown candidate',()=>{
  const scheduler={run(){}},originalRun=scheduler.run;
  let mutations=0;
  assert.throws(()=>direct.installHomeDirect({scheduler,getSlotMeasurer:()=>null,
    setSlotMeasurer:()=>mutations++,getContext:()=>null,runRecovery:()=>{}}),/runNativeContext/);
  assert.equal(mutations,0);assert.equal(scheduler.run,originalRun);
  assert.throws(()=>guardHomeDirectCallback(()=>1,{kind:'video-normalize'},()=>{}),/runNativeContext/);
});

test('exact callbacks do not enter recovery or native context',()=>{
  const callback='()=>u('+recipe+')';
  const unexpected=()=>{throw Error('unexpected recovery');};
  assert.equal(guardHomeDirectCallback(callback,{kind:'video-normalize'},unexpected,undefined,unexpected),callback);
});

function parentNativeContext(mBe){
  return (scope,fn)=>{
    const c=mBe.getStore(),old=c?.leases?.get('ffmpeg');
    if(!c||old?.boosted?.nonce!==scope.nonce)throw Error('Native recovery scope mismatch');
    const leases=new Map(c.leases);
    leases.set('ffmpeg',{...old,boosted:false});
    return mBe.run({...c,leases},fn);
  };
}

test('parent nonce bridge accepts equivalent scopes and isolates only the boosted lease',async()=>{
  const mBe=new AsyncLocalStorage(),scope={kind:'video-normalize',nonce:'n',jobId:'job'};
  const signal=new AbortController().signal,old={boosted:scope,signal,original:true};
  const other={unchanged:true},c={lanes:new Set(['ffmpeg','siglip']),jobId:'job',
    leases:new Map([['ffmpeg',old],['siglip',other]])};
  const bridge=parentNativeContext(mBe);
  await mBe.run(c,async()=>{
    const result=await bridge({...scope},async()=>{
      await new Promise(resolve=>setImmediate(resolve));
      const current=mBe.getStore();
      assert.notEqual(current,c);assert.notEqual(current.leases,c.leases);
      assert.equal(current.lanes,c.lanes);assert.ok(current.lanes.has('ffmpeg'));
      assert.equal(current.jobId,c.jobId);assert.equal(current.leases.get('siglip'),other);
      assert.notEqual(current.leases.get('ffmpeg'),old);
      assert.deepEqual(current.leases.get('ffmpeg'),{...old,boosted:false});
      return 42;
    });
    assert.equal(result,42);assert.equal(mBe.getStore(),c);
    assert.equal(c.leases.get('ffmpeg'),old);assert.equal(old.boosted,scope);
  });
  assert.equal(mBe.getStore(),undefined);
});

test('parent nonce bridge rejects absent context or mismatched nonce before executing',()=>{
  const mBe=new AsyncLocalStorage(),bridge=parentNativeContext(mBe),scope={nonce:'valid'};
  const callback=()=>assert.fail('a mismatched scope must not execute');
  assert.throws(()=>bridge(scope,callback),/Native recovery scope mismatch/);
  for(const old of [undefined,{boosted:false},{boosted:{nonce:'other'}}]){
    const c={lanes:new Set(['ffmpeg']),leases:new Map(old?[['ffmpeg',old]]:[])};
    mBe.run(c,()=>{
      assert.throws(()=>bridge(scope,callback),/Native recovery scope mismatch/);
      assert.equal(mBe.getStore(),c);assert.equal(c.leases.get('ffmpeg'),old);
    });
  }
});

function deferred(){
  let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};
}

async function waitFor(predicate,label,signal){
  const deadline=Date.now()+2000;
  while(!predicate()){
    if(signal?.aborted)throw signal.reason;
    assert.ok(Date.now()<deadline,label);
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  if(signal?.aborted)throw signal.reason;
}

// Real permit and exec wrappers reproduce the two-outer/two-inner recovery deadlock.
function concurrentFixture(t,{cliResult={offloaded:false},contextFailure,holdAfterExec=false}={}){
  const storage=new AsyncLocalStorage(),active=new Set(),ids=[],jobs=[],tasks=[];
  const stats={maxActive:0,cli:0,native:0,afterExec:0,contexts:0,sampled:0,finished:0};
  const permits=createServerPermits({validScope:()=>true,newId:()=>String(ids.length+1),
    run:async(jobId,fn)=>{
      assert.ok(!active.has(jobId));active.add(jobId);
      stats.maxActive=Math.max(stats.maxActive,active.size);
      try{return await fn();}finally{active.delete(jobId);}
    }});
  const runRecovery=async(scope,fn,signal)=>{
    const id=permits.create(scope);ids.push(id);
    try{
      await waitFor(()=>permits.get(id)?.state==='active','counted native permit unavailable',signal);
      return await fn();
    }finally{permits.close(id);}
  };
  const exec=wrapHomeNormalizeExec(async(binary,args,options)=>{
    const context=storage.getStore(),job=jobs.find(j=>j.scope.jobId===context.jobId);
    assert.ok(active.has(job.scope.jobId),'outer counted permit must still be active');
    assert.equal(context.leases.get('ffmpeg').boosted,false);
    assert.equal(context.leases.get('ffmpeg').signal,job.controller.signal);
    assert.equal(context.leases.get('siglip'),job.context.leases.get('siglip'));
    assert.equal(context.lanes,job.context.lanes);
    assert.equal(context.tag,job.context.tag);
    assert.deepEqual(options,{signal:job.controller.signal});
    assert.deepEqual(args,['unknown-original-argv']);
    stats.native++;
    await job.release.promise;
    assert.ok(active.has(job.scope.jobId),'permit cannot release before native cleanup');
    if(options.signal.aborted)throw options.signal.reason;
    return {stdout:job.scope.jobId};
  },{getContext:()=>storage.getStore(),getBinary:()=>'/ffmpeg',runRecovery,
    runCli:async()=>{stats.cli++;if(cliResult instanceof Error)throw cliResult;return cliResult;}});
  let sampler=()=>({run(fn){stats.sampled++;return fn();},finish(){stats.finished++;}});
  const scheduler={run(jobId,resource,fn){
    assert.ok(storage.getStore().lanes.has(resource),'the already-counted FFmpeg lane must be retained');
    return fn();
  }};
  const nativeContext=parentNativeContext(storage);
  direct.installHomeDirect({scheduler,getSlotMeasurer:()=>sampler,setSlotMeasurer:fn=>sampler=fn,
    getContext:()=>storage.getStore(),runRecovery,runNativeContext:(scope,fn)=>{
      assert.ok(active.has(scope.jobId),'native context must be entered only after counted admission');
      stats.contexts++;
      if(contextFailure)return contextFailure();
      return nativeContext(scope,fn);
    }});
  function start(){
    const scope={kind:'video-normalize',nonce:'nonce-'+jobs.length,jobId:'job-'+jobs.length};
    const controller=new AbortController(),lease={boosted:scope,signal:controller.signal};
    const context={jobId:scope.jobId,tag:{original:true},lanes:new Set(['ffmpeg','siglip']),
      leases:new Map([['ffmpeg',lease],['siglip',{other:true}]])};
    const job={scope,controller,context,lease,release:deferred(),tail:deferred()};jobs.push(job);
    const task=storage.run(context,async()=>{
      const sample=sampler({resourceKey:'ffmpegHome'});
      try{
        return await sample.run(async()=>{
          const result=await scheduler.run(scope.jobId,'ffmpeg',
            ()=>exec('/ffmpeg',['unknown-original-argv'],{signal:controller.signal}));
          stats.afterExec++;
          if(holdAfterExec)await job.tail.promise;
          assert.ok(active.has(scope.jobId),'counted permit must cover the entire callback');
          assert.equal(storage.getStore().leases.get('ffmpeg').boosted,false);
          return result;
        });
      }finally{
        assert.equal(storage.getStore(),context);
        assert.equal(context.leases.get('ffmpeg'),lease);assert.equal(lease.boosted,scope);
        sample.finish();
      }
    });
    job.result=task.then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
    tasks.push(job.result);return job;
  }
  t.after(async()=>{
    for(const job of jobs){job.controller.abort();job.release.resolve();job.tail.resolve();}
    for(const id of ids)permits.close(id);
    await Promise.all(tasks);
  });
  return {start,stats,active,ids,permits,storage};
}

for(const [name,cliResult] of [['unsupported',{offloaded:false}],['unavailable',new Error('PC disconnected')]]){
  test('two unknown callbacks retain counted permits without nested recovery when Home is '+name,async t=>{
    const f=concurrentFixture(t,{cliResult}),a=f.start(),b=f.start();
    await waitFor(()=>f.stats.native===2,'both callbacks must reach native execution without nested recovery');
    assert.equal(f.ids.length,2);assert.equal(f.stats.cli,0);assert.equal(f.stats.contexts,2);
    assert.equal(f.stats.maxActive,2);assert.equal(f.active.size,2);
    for(const id of f.ids)assert.equal(f.permits.get(id).state,'active');
    a.release.resolve();assert.deepEqual(await a.result,{status:'fulfilled',value:{stdout:a.scope.jobId}});
    await waitFor(()=>f.active.size===1,'first permit must release');
    assert.ok(f.active.has(b.scope.jobId));
    b.release.resolve();assert.deepEqual(await b.result,{status:'fulfilled',value:{stdout:b.scope.jobId}});
    await waitFor(()=>f.active.size===0,'all permits must release');
    for(const id of f.ids)assert.equal(f.permits.get(id),null);
    assert.equal(f.stats.sampled,2);assert.equal(f.stats.finished,2);
    assert.equal(f.storage.getStore(),undefined);
  });
}

test('both outer permits remain counted during asynchronous callback work after FFmpeg returns',async t=>{
  const f=concurrentFixture(t,{holdAfterExec:true}),a=f.start(),b=f.start();
  await waitFor(()=>f.stats.native===2,'both native calls must start');
  a.release.resolve();b.release.resolve();
  await waitFor(()=>f.stats.afterExec===2,'both native calls must finish');
  assert.equal(f.active.size,2);assert.equal(f.ids.length,2);assert.equal(f.stats.finished,0);
  for(const id of f.ids)assert.equal(f.permits.get(id).state,'active');
  a.tail.resolve();b.tail.resolve();
  for(const result of await Promise.all([a.result,b.result]))assert.equal(result.status,'fulfilled');
  await waitFor(()=>f.active.size===0,'callback completion must release permits');
  for(const id of f.ids)assert.equal(f.permits.get(id),null);
});

test('cancelling one concurrent callback holds its permit through cleanup and releases both afterwards',async t=>{
  const f=concurrentFixture(t),a=f.start(),b=f.start();
  await waitFor(()=>f.stats.native===2,'both native callbacks must start');
  const reason=Object.assign(Error('requested cancellation'),{name:'AbortError'});
  a.controller.abort(reason);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.active.size,2);assert.equal(f.ids.length,2);
  for(const id of f.ids)assert.equal(f.permits.get(id).state,'active');
  a.release.resolve();assert.deepEqual(await a.result,{status:'rejected',reason});
  await waitFor(()=>f.active.size===1,'cancelled permit must release after cleanup');
  assert.ok(f.active.has(b.scope.jobId));
  b.release.resolve();assert.equal((await b.result).status,'fulfilled');
  await waitFor(()=>f.active.size===0,'remaining permit must release');
  for(const id of f.ids)assert.equal(f.permits.get(id),null);
  assert.equal(f.stats.cli,0);assert.equal(f.stats.finished,2);
});

test('cancellation waiting behind two counted callbacks does not leak or execute a queued callback',async t=>{
  const f=concurrentFixture(t),a=f.start(),b=f.start();
  await waitFor(()=>f.stats.native===2,'both native callbacks must start');
  const c=f.start();assert.equal(f.permits.get(f.ids[2]).state,'queued');
  const reason=Object.assign(Error('cancel queued callback'),{name:'AbortError'});
  c.controller.abort(reason);assert.deepEqual(await c.result,{status:'rejected',reason});
  assert.equal(f.permits.get(f.ids[2]),null);assert.equal(f.stats.contexts,2);assert.equal(f.active.size,2);
  a.release.resolve();b.release.resolve();await Promise.all([a.result,b.result]);
  await waitFor(()=>f.active.size===0,'all active permits must release');
  assert.equal(f.stats.native,2);assert.equal(f.stats.maxActive,2);
  for(const id of f.ids)assert.equal(f.permits.get(id),null);
});

for(const asyncFailure of [false,true]){
  test('native context '+(asyncFailure?'rejection':'throw')+' releases the counted permit',async t=>{
    const reason=Error('native context unavailable');
    const f=concurrentFixture(t,{contextFailure:()=>{if(asyncFailure)return Promise.reject(reason);throw reason;}});
    const a=f.start(),b=f.start();
    assert.deepEqual(await a.result,{status:'rejected',reason});
    assert.deepEqual(await b.result,{status:'rejected',reason});
    await waitFor(()=>f.active.size===0,'failed context permits must release');
    for(const id of f.ids)assert.equal(f.permits.get(id),null);
    assert.equal(f.ids.length,2);assert.equal(f.stats.native,0);assert.equal(f.stats.cli,0);
  });
}
