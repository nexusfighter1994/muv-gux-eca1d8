import assert from 'node:assert/strict';
import test from 'node:test';
import {wrapMapAdmissionCheck,wrapMapWaiterChoice} from '../node/map-admission.mjs';

function fixture({active=2,map=true,earlierReason='resource',reason='reservation',cancelled=false}={}){
  const waiter={jobId:'map',resourceKey:'geomap',priority:'2'};
  const state={lane:{activeTotal:active,waiters:[{jobId:'older',resourceKey:'frameshift',priority:'1'},...(map?[waiter]:[])]},activeMap:{jobId:'map',phase:'scheduler_wait',cancelled}};
  const original=(_lane,id)=>id==='older'?earlierReason:reason;
  return {state,waiter,check:wrapMapAdmissionCheck(original,()=>state)};
}

test('a serialized ready map can use one of three idle counted slots beside two capped Frameshift renders',()=>{
  const {check}=fixture();assert.equal(check('render','map',5,'geomap','2'),null);
});
test('the map chooser scans past a resource-capped Frameshift head without replacing a selected task',()=>{
  const {state,waiter,check}=fixture();
  const choose=wrapMapWaiterChoice(()=>({waiter:null,reason:'resource'}),check);
  assert.equal(choose('render',state.lane,5).waiter,waiter);
  const selected={waiter:{jobId:'native'},reason:null};
  assert.equal(wrapMapWaiterChoice(()=>selected,check)('render',state.lane,5),selected);
});
test('higher-priority ready or reservation-only work keeps priority over a partially idle map',()=>{
  for(const earlierReason of [null,'reservation']){
    const {check}=fixture({earlierReason});assert.equal(check('render','map',5,'geomap','2'),'reservation');
  }
});
test('full capacity and invalid or unregistered map state never borrow a slot',()=>{
  for(const options of [{active:5},{active:6},{active:-1},{active:NaN},{map:false},{cancelled:true}]){
    const {check}=fixture(options);assert.equal(check('render','map',5,'geomap','2'),'reservation');
  }
  const {check}=fixture();assert.equal(check('render','map',NaN,'geomap','2'),'reservation');
});
test('native resource, memory-admission boundary and cooldown denials are not overridden',()=>{
  for(const reason of ['resource','lane','cooldown','memory']){
    const {check}=fixture({reason});assert.equal(check('render','map',5,'geomap','2'),reason);
  }
});
test('only the current serial map in scheduler_wait qualifies',()=>{
  for(const change of [{jobId:'other'},{phase:'map_init'},{cancelled:true}]){
    const {state,check}=fixture();Object.assign(state.activeMap,change);
    assert.equal(check('render','map',5,'geomap','2'),'reservation');
  }
});
