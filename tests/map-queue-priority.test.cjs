const test=require('node:test');
const assert=require('node:assert/strict');
const {sortWaitingMaps}=require('../node/map-queue-priority.cjs');
const row=(jobId,segmentId)=>({jobId,segmentId,state:'queued',cancelled:false});
const jobs=new Map([['near',{priority:'4|01|old'}],['far',{priority:'4|10|new'}]]);
test('last maps of a near-complete video precede lower-priority maps',()=>{
 const far=row('far','f'),near=row('near','n'),q=[far,near];
 assert.equal(sortWaitingMaps(q,jobs),2);assert.deepEqual(q,[near,far]);
});
test('stable order and identities, no callback or deadline changes',()=>{
 const a=row('near','a'),b=row('near','b'),f=row('far','f');
 a.fn=()=>{throw Error('must not invoke')};a.deadlineTimer={};const deadline=a.deadlineTimer;
 const q=[f,a,b];sortWaitingMaps(q,jobs);assert.deepEqual(q,[a,b,f]);
 assert.equal(a.deadlineTimer,deadline);assert.equal(sortWaitingMaps(q,jobs),0);
});
test('active, cancelled and unknown entries are untouched',()=>{
 const active={...row('far','active'),state:'active'},cancelled={...row('near','c'),cancelled:true},unknown=row('unknown','u');
 const f=row('far','f'),n=row('near','n'),q=[active,f,unknown,cancelled,n];
 sortWaitingMaps(q,jobs);assert.deepEqual(q,[active,n,unknown,cancelled,f]);
});
test('native round robin among different jobs remains intact',()=>{
 const q=[row('far','f'),row('near','n1'),row('near','n2')];sortWaitingMaps(q,jobs);
 const choose=last=>q.findIndex(x=>x.jobId!==last);
 assert.equal(q[choose('far')].jobId,'near');assert.equal(q[choose('near')].jobId,'far');
});
test('invalid snapshots do nothing',()=>{
 assert.equal(sortWaitingMaps(null,jobs),0);const q=[row('far','f'),row('near','n')];
 assert.equal(sortWaitingMaps(q,{}),0);assert.equal(q[0].jobId,'far');
});
