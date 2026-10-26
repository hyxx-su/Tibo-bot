import test from 'node:test';
import assert from 'node:assert/strict';
import {serverCountDescription,syncBotProfile,maintainBotProfile} from '../src/bot-profile.js';

const env={DISCORD_BOT_TOKEN:'synthetic',DISCORD_APPLICATION_ID:'123',PROFILE_SYNC_ENABLED:'true'};
const originalFetch=globalThis.fetch;
let requests=[],pages=[],description='',failure=null,appId='123';
globalThis.fetch=async(url,options={})=>{
  const path=new URL(url).pathname.replace('/api/v10','');
  requests.push({url,method:options.method??'GET',body:options.body?JSON.parse(options.body):null});
  if(failure===path)return Response.json({message:'synthetic failure'},{status:503});
  if(path==='/users/@me/guilds')return Response.json(pages.shift());
  if(path==='/applications/@me'){
    if(options.method==='PATCH')description=JSON.parse(options.body).description;
    return Response.json({id:appId,description,approximate_guild_count:999});
  }
  throw new Error('Unexpected request');
};
const reset=()=>{requests=[];pages=[];description='';failure=null;appId='123';};
try{
  await test('기존 소개는 보존하고 서버 수 줄만 교체하며 중복 추가하지 않는다',()=>{
    assert.equal(serverCountDescription('안녕하세요!\n현재 2개 서버에서 운영 중입니다.',4),'안녕하세요!\n현재 4개 서버에서 운영 중입니다.');
    assert.equal(serverCountDescription('',0),'현재 0개 서버에서 운영 중입니다.');
    assert.throws(()=>serverCountDescription('가'.repeat(400),4));
    assert.throws(()=>serverCountDescription('',-1));
  });
  await test('대략적 통계 대신 전체 페이지의 실제 서버 수를 반영한다',async()=>{
    reset();pages=[Array.from({length:200},(_,i)=>({id:String(i+1)})),[{id:'201'},{id:'202'}]];
    const result=await syncBotProfile(env);
    assert.deepEqual(result,{count:202,updated:true});
    assert.match(requests[1].url,/after=200$/);
    assert.equal(description,'현재 202개 서버에서 운영 중입니다.');
    assert.deepEqual(requests.at(-1).body,{description});
  });
  await test('서버 탈퇴는 감소한 숫자로 반영하고 동일한 설명은 다시 쓰지 않는다',async()=>{
    reset();description='소개\n현재 4개 서버에서 운영 중입니다.';pages=[[{id:'1'}]];
    assert.equal((await syncBotProfile(env)).count,1);
    assert.equal(description,'소개\n현재 1개 서버에서 운영 중입니다.');
    requests=[];pages=[[{id:'1'}]];
    assert.deepEqual(await syncBotProfile(env),{count:1,updated:false});
    assert.equal(requests.some(r=>r.method==='PATCH'),false);
  });
  await test('부분 조회·잘못된 목록·다른 앱·API 오류에서는 설명을 수정하지 않는다',async()=>{
    const invalidPages=[null,[{id:'not-id'}],Array(201).fill({id:'1'})];
    for(const page of invalidPages){reset();pages=[page];await assert.rejects(()=>syncBotProfile(env));assert.equal(requests.some(r=>r.method==='PATCH'),false);}
    reset();pages=Array.from({length:10},(_,p)=>Array.from({length:200},(_,i)=>({id:String(p*200+i+1)})));
    await assert.rejects(()=>syncBotProfile(env),/incomplete/);assert.equal(requests.some(r=>r.method==='PATCH'),false);
    reset();pages=[Array.from({length:200},(_,i)=>({id:String(i+1)})),[{id:'1'}]];
    await assert.rejects(()=>syncBotProfile(env));assert.equal(requests.some(r=>r.method==='PATCH'),false);
    reset();pages=[[]];appId='456';await assert.rejects(()=>syncBotProfile(env),/mismatch/);
    reset();failure='/users/@me/guilds';await assert.rejects(()=>syncBotProfile(env));assert.equal(requests.some(r=>r.method==='PATCH'),false);
  });
  await test('활성화된 5분 주기만 실행하고 실패는 다른 예약 작업으로 전파하지 않는다',async()=>{
    reset();await maintainBotProfile({...env,PROFILE_SYNC_ENABLED:'false'},0);await maintainBotProfile(env,60000);await maintainBotProfile(env,undefined);
    assert.equal(requests.length,0);
    pages=[[]];await maintainBotProfile(env,300000);assert.equal(description,'현재 0개 서버에서 운영 중입니다.');
    failure='/users/@me/guilds';await assert.doesNotReject(()=>maintainBotProfile(env,600000));
  });
}finally{globalThis.fetch=originalFetch;}
