import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {resetQuestionReply,processResetQuestionJob} from '../src/reset-reply.js';

const now=Date.parse('2026-10-26T13:00:00Z');
const state={baseline_id:'1',last_success:now,last_error:null};
const post=(id,status,at='2026-10-26T08:00:00Z',extra={})=>({id,published_at:at,analysis_json:JSON.stringify({status,reset_type:'regular',...extra})});
const event=(type='regular',at='2026-10-26T07:00:00Z',id='100')=>({verification:'verified',missing_count:0,reset_type:type,announced_at:at,original_url:`https://x.com/thsottiaux/status/${id}`});
const answer=(posts=[],siteResets=[event()],question={},time=now)=>resetQuestionReply({state:{...state,last_success:time},posts,siteResets,pending:false},time,question);

test('단순 언급 뒤에도 같은 날 사이트 정기 리셋 실행 사실과 발표 시각을 답한다',()=>{
  assert.equal(answer([post('101','mentioned')]),'오늘 정기 리셋이 실행된 기록이 있어. 사이트 발표 시각은 16:00(KST)야.');
  assert.match(answer([post('101','mentioned')],[event()],{intent:'completed',dayOffset:0}),/정기 리셋이 실행된 기록/);
});
test('같은 원문의 예정 분류와 충돌하면 사이트 완료를 사용하지 않고 예고를 유지한다',()=>{
  const forecast=post('100','scheduled',undefined,{time:{timestamp:now+3600000}});
  assert.match(answer([forecast]),/초기화 예정이야/);
  assert.match(answer([{...forecast,id:'102'}]),/초기화 예정이야/);
  assert.match(answer([post('102','in_progress')]),/반영 중이라는 공지/);
  assert.match(answer([post('102','unavailable')]),/분석을 아직 확인 못/);
});
test('새 예고 뒤의 취소 관련 언급으로 오래된 완료나 예고를 되살리지 않는다',()=>{
  const posts=[post('103','mentioned','2026-10-26T09:00:00Z'),post('102','scheduled')];
  assert.doesNotMatch(answer(posts),/실행된 기록|초기화 예정이야/);
});
test('X 완료 뒤의 단순 언급도 완료 사실을 지우지 않는다',()=>{
  assert.match(answer([post('101','mentioned'),post('100','completed','2026-10-26T07:00:00Z')],[]),/이미 끝났다는 공지/);
});
test('저장형 지급은 사용량 즉시 초기화와 구별한다',()=>{
  const text=answer([post('101','mentioned')],[event('banked')]);
  assert.match(text,/저장형 리셋 지급 기록/);assert.match(text,/즉시 초기화와는 달라/);assert.doesNotMatch(text,/정기 리셋이 실행/);
});
test('한국시간 날짜가 바뀌면 전날 기록을 오늘 완료로 답하지 않는다',()=>{
  const tomorrow=Date.parse('2026-10-26T15:01:00Z');
  assert.doesNotMatch(answer([],[event()],{},tomorrow),/오늘 정기 리셋이 실행/);
  assert.match(answer([],[event()],{dayOffset:-1},tomorrow),/^어제 정기 리셋이 실행/);
  assert.doesNotMatch(answer([],[event()],{dayOffset:1}),/실행된 기록/);
});
test('어제 완료 뒤의 단순 언급도 어제 완료 질문을 가리지 않는다',()=>{
  assert.match(answer([post('101','mentioned')],[event()],{dayOffset:-1},Date.parse('2026-10-26T15:01:00Z')),/^어제 정기 리셋이 실행/);
});
test('사이트의 출처·이력 응답은 발표 시각을 실제 계정 반영 시각으로 설명하지 않는다',()=>{
  assert.match(answer([],[event()],{intent:'history'}),/사이트 발표 시각.*16:00/);
  for(const text of [answer([],[event()],{intent:'history'}),answer([post('101','completed')],[],{intent:'history'})])assert.doesNotMatch(text,/실제 계정 반영 시각|https?:/);
  assert.match(answer([],[event()],{intent:'source'}),/사이트 실행 기록의 발표 시각.*codex-resets/);
});
test('잘못된 유형·미래·오래된 기록·외부 URL은 완료 근거로 사용하지 않는다',()=>{
  for(const record of [event('unknown'),event('regular','2026-10-27T07:00:00Z'),event('regular','2026-10-01T07:00:00Z'),{...event(),original_url:'https://example.com/100'}])assert.doesNotMatch(answer([],[record]),/실행된 기록/);
  assert.match(answer([],[{...event(),original_url:null}]),/실행된 기록/);
});
test('수집 오류와 분석 대기 중에는 완료만 보고 현재 상태를 확정하지 않는다',()=>{
  assert.match(resetQuestionReply({state:{...state,last_error:'failed'},posts:[],siteResets:[event()]},now),/확인 중/);
  assert.match(resetQuestionReply({state,posts:[],siteResets:[event()],pending:true},now),/확인 중/);
});

test('기존 DB의 기준점 기록도 채팅에서 읽으며 추가 외부 조회 없이 답장한다',async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
  const originalFetch=globalThis.fetch;
  try{
    const db=await mf.getD1Database('DB');
    for(const name of ['0001_watch.sql','0003_guild_channels.sql','0004_site_resets.sql','0005_site_reset_verification.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    await db.prepare("INSERT INTO guild_settings(guild_id,active) VALUES('20',1)").run();
    await db.prepare("UPDATE watch_state SET baseline_id='1',last_success=? WHERE id=1").bind(Date.now()).run();
    await db.prepare("INSERT INTO site_reset_events(event_key,source_id,reset_type,announced_at,original_url,content,discovered_at,phase,verification) VALUES('site:regular:100','100','regular',?,NULL,'synthetic',?,'baseline','verified')").bind(new Date().toISOString(),Date.now()).run();
    const sent=[],batches=[];
    globalThis.fetch=async(url,options)=>{assert.equal(url,'https://discord.com/api/v10/channels/30/messages');sent.push(JSON.parse(options.body));return Response.json({id:'999'});};
    const env={DB:{prepare:sql=>db.prepare(sql),batch:queries=>{batches.push(queries.length);return db.batch(queries);}},WATCH_ENABLED:'true',SITE_RESETS_ENABLED:'true',RESET_CHAT_ENABLED:'true',DISCORD_BOT_TOKEN:'synthetic'};
    async function send(intent='status'){
      let ack=false;
      await processResetQuestionJob({body:{kind:'reset-question',guildId:'20',channelId:'30',userId:'40',messageId:'50',issuedAt:Date.now(),intent},attempts:1,ack(){ack=true;},retry(){assert.fail('Unexpected retry');}},env);
      assert.equal(ack,true);
    }
    await send();assert.match(sent.at(-1).content,/정기 리셋이 실행된 기록/);assert.equal(batches.at(-1),5);assert.deepEqual(sent.at(-1).allowed_mentions,{parse:[],replied_user:false});
    await send('help');assert.equal(batches.at(-1),1);
    env.SITE_RESETS_ENABLED='false';await send();assert.equal(batches.at(-1),4);assert.doesNotMatch(sent.at(-1).content,/실행된 기록/);
    assert.equal((await db.prepare('SELECT phase FROM site_reset_events').first()).phase,'baseline');
  }finally{globalThis.fetch=originalFetch;await mf.dispose();}
});
