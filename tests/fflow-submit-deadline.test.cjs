const test=require('node:test');
const assert=require('node:assert/strict');
let policy;
try{policy=require('../node/fflow-submit-deadline.cjs');}catch{}
function fixture(){
  const calls=[];
  const client={endpointSource:()=> 'loopback',request:async function(path,options){calls.push({self:this,path,options});return{data:{job_id:'real-job'}};}};
  assert.ok(policy,'Submission deadline helper missing');
  return{client,calls,handle:policy.install(client)};
}
test('async local composition waits 120s for one native admission with exact inputs',async()=>{
  const{client,calls,handle}=fixture();
  const body={segments:[{source:'original'}],wait_for_results:false},headers={original:'kept'};
  const result=await client.request('/v1/render',{method:'POST',body,headers,licensed:true,operation:'POST /render'});
  assert.equal(result.data.job_id,'real-job');assert.equal(calls.length,1);
  assert.equal(calls[0].options.timeoutMs,120000);assert.equal(calls[0].options.body,body);
  assert.equal(calls[0].options.headers,headers);assert.equal(calls[0].options.licensed,true);
  assert.equal(calls[0].self,client);assert.equal(handle.stats.completed,1);
});
test('explicit short and long deadlines and original signal are preserved',async()=>{
  const{client,calls}=fixture();const signal=new AbortController().signal;
  for(const timeoutMs of [1000,30000,240000])await client.request('/v1/render',{method:'POST',body:{wait_for_results:false},timeoutMs,signal});
  assert.deepEqual(calls.map(c=>c.options.timeoutMs),[1000,30000,240000]);
  assert.ok(calls.every(c=>c.options.signal===signal));
});
test('other endpoints, polling, uploads, sync renders and nonlocal workers are untouched',async()=>{
  const{client,calls}=fixture();
  const rows=[['/v1/render',{method:'GET'}],['/v1/render/sync',{method:'POST',body:{}}],['/v1/upload',{method:'POST',body:{}}],['/v1/jobs/known',{method:'GET'}],['/v1/render',{method:'POST',body:{wait_for_results:true}}]];
  for(const[path,options]of rows){await client.request(path,options);assert.equal(calls.at(-1).options,options);}
  client.endpointSource=()=> 'runpod';const options={method:'POST',body:{wait_for_results:false}};
  await client.request('/v1/render',options);assert.equal(calls.at(-1).options,options);
});
test('ambiguous timeout is never replayed or silently converted to success',async()=>{
  assert.ok(policy);let posts=0;const error=Error('The operation was aborted due to timeout');
  const client={endpointSource:()=> 'loopback',async request(){posts++;throw error;}};
  const handle=policy.install(client);
  await assert.rejects(client.request('/v1/render',{method:'POST',body:{wait_for_results:false}}),e=>e===error);
  assert.equal(posts,1);assert.equal(handle.stats.failed,1);assert.equal(handle.stats.completed,0);
});
test('already cancelled owner submits nothing and install/owned rollback are idempotent',async()=>{
  assert.ok(policy);let posts=0;const original=async()=>{posts++;};
  const client={endpointSource:()=> 'loopback',request:original},handle=policy.install(client);
  assert.equal(policy.install(client),handle);
  const controller=new AbortController();controller.abort(Error('Owner cancelled'));
  await assert.rejects(client.request('/v1/render',{method:'POST',body:{wait_for_results:false},signal:controller.signal}),/Owner cancelled/);
  assert.equal(posts,0);handle.restore();handle.restore();assert.equal(client.request,original);
});
test('real delayed HTTP acknowledgement survives without a second POST',async t=>{
  assert.ok(policy);const http=require('node:http');let posts=0;
  const server=http.createServer((req,res)=>{posts++;req.resume();setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{job_id:'accepted-once'}}));},120);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const client={endpointSource:()=> 'loopback',async request(path,options){return(await fetch('http://127.0.0.1:'+server.address().port+path,{method:options.method,body:JSON.stringify(options.body),signal:AbortSignal.timeout(options.timeoutMs??30)})).json();}};
  const handle=policy.install(client),body={wait_for_results:false};
  assert.equal((await client.request('/v1/render',{method:'POST',body})).data.job_id,'accepted-once');
  assert.equal(posts,1);assert.equal(handle.stats.completed,1);
});
test('in-flight original request keeps its original owner and deadline',async()=>{
  assert.ok(policy);let resolve;const calls=[];
  const client={endpointSource:()=> 'loopback',request(path,options){calls.push(options);if(calls.length===1)return new Promise(r=>resolve=r);return Promise.resolve({data:{job_id:'new'}});}};
  const old={method:'POST',body:{wait_for_results:false}};
  const pending=client.request('/v1/render',old),handle=policy.install(client);
  resolve({data:{job_id:'old'}});assert.equal((await pending).data.job_id,'old');
  assert.equal(calls[0],old);assert.equal(calls[0].timeoutMs,undefined);
  await client.request('/v1/render',old);assert.equal(calls[1].timeoutMs,120000);assert.equal(handle.stats.started,1);
});
test('cold startup installs after the original FFlow resubmitter',()=>{
  const fs=require('node:fs'),source=fs.readFileSync(__dirname+'/../node/custom.mjs','utf8');
  assert.match(source,/import fflowSubmitDeadline from '\.\/fflow-submit-deadline\.cjs'/);
  assert.match(source,/fflowResubmit\.createResubmitter\(client\.request\);\s*fflowSubmitDeadline\.install\(client\)/);
});
