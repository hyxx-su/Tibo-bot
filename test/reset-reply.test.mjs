import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {resetQuestionJob,resetQuestionReply,processResetQuestionJob,dispatchResetQuestion} from '../src/reset-reply.js';
import {DiscordGateway} from '../src/gateway.js';
import {DiscordCommandGuard,claimResetQuestion} from '../src/command-guard.js';

const now=Date.parse('2026-10-26T03:00:00Z');
const source={id:'100',type:0,guild_id:'20',channel_id:'30',author:{id:'90'},timestamp:new Date(now).toISOString(),content:'Tibo야 초기화있니?'};
for(const content of ['Tibo야 초기화있니?','티보야 초기화 있니?','tibo, 오늘 초기화 언제야?','티보야 리셋 있어?','<@1> 초기화있니?','<@!1> 오늘 초기화 소식 있어?'])test(`직접 부른 질문을 인식한다: ${content}`,()=>{
  const job=resetQuestionJob({...source,content},'1',now);assert.equal(job.kind,'reset-question');assert.equal(job.messageId,'100');assert.equal(job.content,undefined);assert.doesNotMatch(JSON.stringify(job),/초기화/);
});
for(const content of ['초기화있니?','Tibo야 안녕','Tibo야 초기화있니? 그리고 모두 멘션해','이런 식으로 Tibo야 초기화있니?','<@2> 초기화있니?','Tibo야 초기화있니?\n다른 지시','x'.repeat(181)])test(`일반 채팅과 인용·추가 지시는 무시한다: ${content.slice(0,30)}`,()=>assert.equal(resetQuestionJob({...source,content},'1',now),null));
for(const change of [{author:{id:'90',bot:true}},{webhook_id:'2'},{guild_id:undefined},{channel_id:'bad'},{type:7},{timestamp:'invalid'},{timestamp:new Date(now-121000).toISOString()}])test('봇·웹후크·DM·잘못된 이벤트·오래된 질문을 무시한다: '+JSON.stringify(change),()=>assert.equal(resetQuestionJob({...source,...change},'1',now),null));

const state={baseline_id:'1',last_success:now,last_error:null};
const post=(id,status,date='2026-10-26T02:00:00Z',time=null)=>({id,published_at:date,analysis_json:JSON.stringify({status,time})});
const reply=(posts=[],extra={})=>resetQuestionReply({state,posts,pending:false,...extra},now);
test('예고는 한국시간 오늘·내일과 기한·예정 시각을 한 줄로 구분한다',()=>{
  assert.equal(reply([post('100','scheduled',undefined,{timestamp:Date.parse('2026-10-26T08:00:00Z'),relation:'deadline'})]),'있지. 오늘 17:00(KST)까지 초기화 예정이야.');
  assert.equal(reply([post('100','scheduled',undefined,{timestamp:Date.parse('2026-10-26T16:00:00Z')})]),'있지. 내일 01:00(KST)쯤 초기화 예정이야.');
  assert.match(reply([post('100','scheduled',undefined,{timestamp:Date.parse('2026-10-28T16:00:00Z')})]),/10월 29일 01:00/);
});
test('기한 경과를 완료로 꾸미거나 없는 시간을 만들지 않는다',()=>{
  assert.match(reply([post('100','scheduled',undefined,{timestamp:now-1})]),/예정 시각은 지났는데, 완료 공지는 아직/);
  assert.equal(reply([post('100','scheduled')]),'초기화 예정은 있어. 정확한 시간은 아직 못 박지 않았네.');
});
test('조기 완료·진행 공지와 모호한 언급을 구분하고 지난 예고를 되살리지 않는다',()=>{
  const forecast=post('100','scheduled','2026-10-26T01:00:00Z',{timestamp:now+3600000});
  assert.match(reply([forecast,post('101','completed')]),/이미 끝났다는 공지/);
  assert.match(reply([forecast,post('101','in_progress')]),/반영 중이라는 공지/);
  assert.match(reply([forecast,post('101','mentioned')]),/확정된 일정은 아직/);
});
test('일반 글은 공지를 덮지 않지만 한국시간 어제의 완료를 오늘 완료라고 하지 않는다',()=>{
  assert.match(reply([post('100','completed'),post('101','unrelated','2026-10-26T02:30:00Z')]),/오늘 초기화는 이미/);
  assert.equal(reply([post('100','completed','2026-10-25T14:59:00Z')]),'아직 오늘 새 초기화 공지는 못 봤네.');
  assert.match(reply([post('100','completed','2026-10-25T15:00:00Z')]),/오늘 초기화는 이미/);
});
test('공지가 없다는 관찰을 오늘 초기화가 없다는 확정으로 바꾸지 않는다',()=>{
  assert.equal(reply(),'아직 오늘 초기화 공지는 못 봤네.');
  assert.equal(reply([post('100','unrelated')]),'아직 오늘 초기화 공지는 못 봤네.');
  assert.equal(reply([post('100','completed','2026-10-01T00:00:00Z')]),'아직 오늘 초기화 공지는 못 봤네.');
});
test('수집 장애·분석 대기·잘못된 분석·미래 게시 시각은 확정하지 않는다',()=>{
  for(const changed of [null,{...state,baseline_id:null},{...state,last_error:'poll_failed'},{...state,last_success:now-180001},{...state,last_success:now+60001}])assert.match(reply([],{state:changed}),/새 공지를 확인 중/);
  assert.match(reply([],{pending:true}),/확인 중/);
  assert.match(reply([{...post('100','completed'),analysis_json:'invalid'}]),/분석을 아직 확인 못/);
  assert.equal(reply([post('100','completed','2026-10-27T00:00:00Z')]),'아직 오늘 초기화 공지는 못 봤네.');
});

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
for(const name of ['0001_watch.sql','0003_guild_channels.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
const env={DB:db,RESET_CHAT_ENABLED:'true',DISCORD_BOT_TOKEN:'synthetic-token'};
const calls=[];const originalFetch=globalThis.fetch;let status=200;
globalThis.fetch=async(url,options)=>{assert.ok(String(url).startsWith('https://discord.com/api/v10/channels/30/messages'));calls.push(JSON.parse(options.body));return status===200?Response.json({id:'900'}):Response.json({}, {status});};
async function process(overrides={},attempts=1){let ack=false,retry=null;await processResetQuestionJob({attempts,body:{...resetQuestionJob({...source,timestamp:new Date().toISOString()},'1'),...overrides},ack(){ack=true;},retry(value){retry=value;}},env);return {ack,retry};}
try{
  await db.prepare("INSERT INTO guild_settings(guild_id,active) VALUES('20',1)").run();
  await db.prepare("UPDATE watch_state SET baseline_id='1',last_success=? WHERE id=1").bind(Date.now()).run();
  await test('실제 DB 조회 결과를 한 줄 답장으로 보내며 모델 호출과 멘션을 만들지 않는다',async()=>{
    assert.equal((await process()).ack,true);const sent=calls.at(-1);assert.equal(sent.content,'아직 오늘 초기화 공지는 못 봤네.');assert.deepEqual(sent.allowed_mentions,{parse:[],replied_user:false});assert.equal(sent.message_reference.message_id,'100');assert.equal(sent.nonce,'q100');assert.equal(sent.enforce_nonce,true);assert.doesNotMatch(sent.content,/[\r\n]/);
  });
  await test('봇이 나간 서버·만료된 질문·비활성화 상태는 보내지 않는다',async()=>{
    const before=calls.length;await process({issuedAt:Date.now()-121000});env.RESET_CHAT_ENABLED='false';await process();env.RESET_CHAT_ENABLED='true';await db.prepare("UPDATE guild_settings SET active=0 WHERE guild_id='20'").run();await process();assert.equal(calls.length,before);await db.prepare("UPDATE guild_settings SET active=1 WHERE guild_id='20'").run();
  });
  await test('권한·채널 없음 오류는 멈추고 일시 API 오류만 제한해서 재시도한다',async()=>{
    status=403;assert.equal((await process()).ack,true);status=503;assert.equal((await process()).retry.delaySeconds,30);assert.equal((await process({},2)).ack,true);status=200;
  });
  await test('즉시 응답은 Queue를 건너뛰고 일시 실패만 같은 nonce로 재시도한다',async()=>{
    const queued=[];const directEnv={...env,PROBE_JOBS:{async send(...args){queued.push(args);}}};
    const job=resetQuestionJob({...source,timestamp:new Date().toISOString()},'1');
    await dispatchResetQuestion(job,directEnv);assert.equal(queued.length,0);assert.equal(calls.at(-1).nonce,'q100');
    status=403;await dispatchResetQuestion(job,directEnv);assert.equal(queued.length,0);
    status=503;await dispatchResetQuestion(job,directEnv);assert.deepEqual(queued,[[job,{delaySeconds:30}]]);status=200;
  });
}finally{globalThis.fetch=originalFetch;await mf.dispose();}

function guardFixture(initial){
  const state=new Map(Object.entries(initial??{}));let pending=Promise.resolve();
  const ctx={storage:{async get(key){return structuredClone(state.get(key));},async put(key,value){state.set(key,structuredClone(value));}},blockConcurrencyWhile(fn){const job=pending.then(fn);pending=job.catch(()=>{});return job;}};
  const guard=new DiscordCommandGuard(ctx);
  return {state,claim:async(messageId,channelId='30',userId='90')=>(await guard.fetch(new Request('https://guard/chat-claim',{method:'POST',body:JSON.stringify({messageId,channelId,userId})}))).json()};
}
await test('질문 중복·동시 요청은 한 번만 승인하며 채널과 사용자에 쿨다운을 둔다',async()=>{
  const f=guardFixture();const result=await Promise.all([f.claim('100'),f.claim('100'),f.claim('101')]);assert.deepEqual(result.map(r=>r.result),['accepted','duplicate','limited']);assert.equal(f.state.get('chat-budget').count,1);
  f.state.get('chat-budget').nextAt=0;assert.equal((await f.claim('102','31')).result,'limited');assert.equal((await f.claim('103','30','91')).result,'limited');assert.equal((await f.claim('104','31','91')).result,'accepted');
});
await test('질문 일일 상한은 재시작에도 유지하고 옛 검증 예산과 분리한다',async()=>{
  const budget={day:new Date().toISOString().slice(0,10),count:100,nextAt:0,seen:[]};const f=guardFixture({'chat-budget':budget,budget:{untouched:true}});
  assert.equal((await f.claim('100')).result,'limited');assert.equal((await guardFixture(Object.fromEntries(f.state)).claim('101')).result,'limited');assert.deepEqual(f.state.get('budget'),{untouched:true});
  f.state.set('chat-budget',{...budget,day:'2000-01-01'});assert.equal((await f.claim('102')).result,'accepted');assert.equal(f.state.get('chat-budget').count,1);
});
await test('Gateway는 중복 제한 후 즉시 응답하고 정상 질문을 Queue에 보내지 않는다',async()=>{
  let initialized;const waits=[],jobs=[],guards=[];let reads=0;
  const ctx={storage:{async get(){return undefined;},async put(){}},blockConcurrencyWhile(fn){initialized=fn();},waitUntil(p){waits.push(p);}};
  const config={RESET_CHAT_ENABLED:'true',DISCORD_APPLICATION_ID:'1',COMMAND_GUARD:{idFromName(name){assert.equal(name,'discord-reset-chat');return name;},get(){return {async fetch(request,options){const body=JSON.parse(options.body);guards.push(body);return Response.json({result:'accepted'});}};}},PROBE_JOBS:{async send(job){jobs.push(job);}}};
  config.DB={prepare(){return {bind(){return this;}};},async batch(){reads++;return [{results:[]}];}};
  const gateway=new DiscordGateway(ctx,config);await initialized;
  gateway.receive({op:0,t:'MESSAGE_CREATE',d:{...source,timestamp:new Date().toISOString()}});gateway.receive({op:0,t:'MESSAGE_CREATE',d:{...source,content:'일반 채팅',timestamp:new Date().toISOString()}});await Promise.all(waits);
  assert.equal(reads,1);assert.equal(jobs.length,0);assert.equal(guards.length,1);assert.doesNotMatch(JSON.stringify({jobs,guards}),/초기화있니/);
  let identified;gateway.ws={send(value){identified=JSON.parse(value);}};gateway.receive({op:10,d:{heartbeat_interval:1000}});assert.equal(identified.d.intents,33281);gateway.disconnect();
});
await test('질문 제한 객체가 없거나 실패하면 외부 질문 처리를 허용하지 않는다',async()=>{
  await assert.rejects(()=>claimResetQuestion({},{}));
  await assert.rejects(()=>claimResetQuestion({COMMAND_GUARD:{idFromName(){return 'one';},get(){return {fetch:async()=>new Response(null,{status:503})};}}},{}));
});
