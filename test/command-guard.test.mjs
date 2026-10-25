import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscordCommandGuard,claimVerification} from '../src/command-guard.js';

function fixture(state){
  let stored=state;let pending=Promise.resolve();
  const ctx={storage:{async get(){return structuredClone(stored);},async put(key,value){stored=structuredClone(value);}},blockConcurrencyWhile(fn){const job=pending.then(fn);pending=job.catch(()=>{});return job;}};
  const guard=new DiscordCommandGuard(ctx);
  return {guard,state:()=>stored,claim:async id=>(await guard.fetch(new Request('https://test/claim',{method:'POST',body:JSON.stringify({id})}))).json()};
}
await test('동시 요청에도 한 건만 승인하고 같은 ID는 중복으로 처리한다',async()=>{
  const f=fixture();const results=await Promise.all([f.claim('1'),f.claim('1'),f.claim('2')]);assert.deepEqual(results.map(r=>r.result),['accepted','duplicate','limited']);assert.equal(f.state().count,1);
});
await test('분당 제한이 끝나도 하루 20회 상한을 유지한다',async()=>{
  const f=fixture({day:new Date().toISOString().slice(0,10),count:20,nextAt:0,seen:[]});assert.equal((await f.claim('1')).result,'limited');
});
await test('UTC 날짜가 바뀌면 상한을 초기화하고 만료된 ID를 정리한다',async()=>{
  const f=fixture({day:'2000-01-01',count:20,nextAt:0,seen:[{id:'1',expiresAt:0}]});assert.equal((await f.claim('1')).result,'accepted');assert.equal(f.state().count,1);assert.equal(f.state().seen.length,1);
});
await test('호출 제한 저장소가 없거나 실패하면 검증을 허용하지 않는다',async()=>{
  await assert.rejects(()=>claimVerification({},'1'));
  await assert.rejects(()=>claimVerification({COMMAND_GUARD:{idFromName(){return 'one';},get(){return {fetch:async()=>new Response('unavailable',{status:503})};}}},'1'));
});
