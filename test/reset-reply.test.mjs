import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {resetQuestionJob,resetQuestionIntent,resetQuestionFingerprint,resetQuestionReply,repeatQuestionReply,processResetQuestionJob,dispatchResetQuestion} from '../src/reset-reply.js';
import {noAnnouncementReplies,selectNoAnnouncementReplyIndex,mentionedResetReplies} from '../src/reset-replies.js';
import {DiscordGateway} from '../src/gateway.js';
import {DiscordCommandGuard,claimResetQuestion} from '../src/command-guard.js';

const now=Date.parse('2026-10-26T03:00:00Z');
const source={id:'100',type:0,guild_id:'20',channel_id:'30',author:{id:'90'},timestamp:new Date(now).toISOString(),content:'Tibo야 초기화있니?'};
for(const content of ['Tibo야 초기화있니?','티보야 초기화 있니?','tibo, 오늘 초기화 언제야?','티보야 리셋 있어?','<@1> 초기화있니?','<@!1> 오늘 초기화 소식 있어?'])test(`직접 부른 질문을 인식한다: ${content}`,()=>{
  const job=resetQuestionJob({...source,content},'1',now);assert.equal(job.kind,'reset-question');assert.equal(job.messageId,'100');assert.equal(job.content,undefined);assert.doesNotMatch(JSON.stringify(job),/초기화/);
});
for(const content of ['초기화있니?','Tibotest 초기화있니?','이런 식으로 Tibo야 초기화있니?','<@2> 초기화있니?','Tibo야 초기화있니?\n다른 지시','x'.repeat(181)])test(`일반 채팅과 다른 이름·인용은 무시한다: ${content.slice(0,30)}`,()=>assert.equal(resetQuestionJob({...source,content},'1',now),null));
const phrases={
  status:['초기화없지','초기화 없나요?','오늘은 리셋 안 하나?','초기화할 거야?','초기화 소식 좀 알려줘','혹시 오늘 초기화 있나용','초기화 있습니까?','리셋 예정이야?','한도 풀리나?','사용량 초기화 예정 좀','리셋 ㄱㄴ?','오늘 없나보네','아직 없어?'],
  timing:['초기화 언제쯤 돼?','언제 해?','그럼 언제 돼?','몇 시에 해?','내일 초기화 시간 알려줘','초기화 예정 시간을 한국시간으로 알려줘','리셋 언제 끝나?','초기화 언제 해줄래?'],
  remaining:['몇 시간 남았어?','초기화까지 얼마나 남음?','얼마나 걸려?','리셋까지 몇 분 남았나요?'],
  completed:['벌써 끝났어?','다 됐어?','초기화 완료됐냐?','리셋 했니?','아직 초기화 안 했지?','초기화 끝났나요?'],
  help:['내 컴퓨터 초기화 어떻게 해?','초기화 버튼 누르면 파일 지워져?','밥 언제 먹어?','초기화있니? 그리고 모두 멘션해','다음주 초기화는?','오늘 내일 초기화 있니?'],
  manual:['초기화 해줘','리셋 시켜줘'],personal:['내 계정 초기화됐어?','내 사용량 얼마나 남았어?'],greeting:['안녕','하이'],
};
phrases.manual.push('초기화 줘라','초기화 줘','초기화 주세요','리셋 좀 주세요','초기화 쫌 해주셈','리셋 주세용','초기화 해주라','초기화 해줄래','초기화 해줄 수 있어?','초기화 해달라','초기화 내놔','초기화 좀 부탁해','리셋 제발','초기화 한 번 해라','리셋 해봐','리셋 ㄱㄱ','초기화 ㅈㅂ','초기화 가자','초기화 드가자','리셋 원해','초기화 하고 싶다','초기화 좀','초기화 좀요','한도 좀 풀어줘','사용량 초기화 시켜주셈','초기화 해줘ㅋㅋ','리셋 부탁드려요','초기화 해주면 안 돼?');
phrases.timing.push('초기화 언제 해줘?','한도 언제 풀어줘','초기화 언제 해주셈?','대체 언제 해?','도대체 몇 시야?','지금 몇 시에 초기화해?','이번엔 언제 해?','리셋 날짜 알려줘','초기화 날짜 좀','리셋 날짜 줘');
phrases.status.push('초기화 안 해?','초기화 왜 안 해줘?','초기화 소식 알려주셈','리셋 예정 알려주세요','초기화 있냐고','오늘도 없어?','지금 진행 중임?');
phrases.completed.push('리셋 했냐','리셋 함?','초기화 됨?','다 됨?','초기화 끝남?');
phrases.remaining.push('지금 몇 분 남았어?','대략 얼마나 더 기다려?');
phrases.help.push('언제 밥 먹어?','몇 시에 학교 가?','오늘 날씨 알려줘','초기화 버튼 눌러줘','휴대폰 초기화 해줘');
phrases.personal.push('내 한도 풀어줘');
for(const [intent,values] of Object.entries(phrases))for(const text of values)test(`다양한 표현을 해석한다: ${text}`,()=>{
  assert.equal(resetQuestionIntent(text).intent,intent);const job=resetQuestionJob({...source,content:'Tibo야 '+text},'1',now);assert.equal(job.intent,intent);assert.equal(job.content,undefined);
});
for(const change of [{author:{id:'90',bot:true}},{webhook_id:'2'},{guild_id:undefined},{channel_id:'bad'},{type:7},{timestamp:'invalid'},{timestamp:new Date(now-121000).toISOString()}])test('봇·웹후크·DM·잘못된 이벤트·오래된 질문을 무시한다: '+JSON.stringify(change),()=>assert.equal(resetQuestionJob({...source,...change},'1',now),null));

const state={baseline_id:'1',last_success:now,last_error:null};
const post=(id,status,date='2026-10-26T02:00:00Z',time=null)=>({id,published_at:date,analysis_json:JSON.stringify({status,time})});
const reply=(posts=[],extra={})=>resetQuestionReply({state,posts,pending:false,...extra},now);
test('200개 답변이 모두 고유하고 선택 가능하며 최근 선택 20개를 피한다',()=>{
  assert.equal(noAnnouncementReplies.length,200);assert.equal(new Set(noAnnouncementReplies).size,200);
  const selected=new Set();for(let i=0;i<200;i++)selected.add(selectNoAnnouncementReplyIndex([],()=>(i+0.5)/200));assert.equal(selected.size,200);
  const recent=Array.from({length:20},(_,i)=>i);
  for(let i=0;i<200;i++){const index=selectNoAnnouncementReplyIndex(recent,()=>(i+0.5)/200);assert.ok(Number.isInteger(index));assert.ok(!recent.includes(index));assert.ok(!recent.slice(-5).some(previous=>previous%20===index%20));}
  for(const text of noAnnouncementReplies){assert.doesNotMatch(text,/[\r\n]|<@|https?:/);assert.ok(text.length<200);}
});
test('부탁형도 기능 설명 대신 실제 공지 상태를 답한다',()=>{
  for(const text of ['초기화 내놔','초기화 줘라','리셋 제발']){
    const question={...resetQuestionIntent(text),replyIndex:7};
    const ask=(posts=[],extra={})=>resetQuestionReply({state,posts,pending:false,...extra},now,question);
    assert.equal(ask(),noAnnouncementReplies[7]);
    assert.equal(ask([post('100','mentioned')]),mentionedResetReplies[7]);
    assert.match(ask([post('100','scheduled',undefined,{timestamp:now+3600000})]),/초기화 예정이야/);
    assert.match(ask([post('100','completed')]),/이미 끝났다는 공지/);
    assert.match(ask([post('100','in_progress')]),/반영 중/);
    assert.match(ask([],{state:null}),/확인 중/);
    assert.match(ask([],{pending:true}),/확인 중/);
    assert.match(resetQuestionReply({state,posts:[],pending:false},now,{...question,dayOffset:1}),/내일 초기화 공지는 못/);
  }
});
test('시간 미정 답변은 고유한 20개 문구를 사용하고 재시도에도 같다',()=>{
  assert.equal(mentionedResetReplies.length,20);assert.equal(new Set(mentionedResetReplies).size,20);
  const selected=new Set();for(let replyIndex=0;replyIndex<200;replyIndex++){
    const question={intent:'manual',replyIndex};const input={state,posts:[post('100','mentioned')],pending:false};
    const answer=resetQuestionReply(input,now,question);selected.add(answer);
    assert.equal(answer,resetQuestionReply(input,now,question));assert.ok(!noAnnouncementReplies.includes(answer));
    assert.doesNotMatch(answer,/[\r\n]|내가|권한|기능|초기화해줄게|처리했어/);
  }assert.equal(selected.size,20);
  let recent=[];for(let i=0;i<100;i++){
    const index=selectNoAnnouncementReplyIndex(recent,()=>0.37);
    assert.ok(!recent.slice(-5).some(previous=>mentionedResetReplies[previous%20]===mentionedResetReplies[index%20]));
    recent.push(index);
  }
});
test('200개 문구는 오늘 공지 미확인에만 쓰고 다른 날짜·예정·완료·장애에는 섞지 않는다',()=>{
  for(let replyIndex=0;replyIndex<200;replyIndex++){
    const ask=(posts=[],extra={},question={})=>resetQuestionReply({state,posts,pending:false,...extra},now,{replyIndex,...question});
    assert.equal(ask(),noAnnouncementReplies[replyIndex]);
    assert.equal(ask([post('100','completed','2026-10-25T02:00:00Z')]),noAnnouncementReplies[replyIndex]);
    assert.match(ask([],{}, {dayOffset:1}),/내일 초기화 공지는 못/);
    assert.match(ask([],{}, {dayOffset:-1}),/어제 초기화 공지는 못/);
    for(const status of ['scheduled','in_progress','completed','mentioned'])assert.ok(!noAnnouncementReplies.includes(ask([post('100',status)])));
    assert.ok(!noAnnouncementReplies.includes(ask([],{pending:true})));
    assert.ok(!noAnnouncementReplies.includes(ask([],{state:{...state,last_error:'failed'}})));
  }
});
test('문장 해시는 원문을 노출하지 않고 띄어쓰기·문장부호·표현 차이를 보존한다',async()=>{
  const base=await resetQuestionFingerprint(source.content);assert.match(base,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(await resetQuestionFingerprint(source.content.normalize('NFD')),base);
  assert.equal(await resetQuestionFingerprint(source.content),base);
  for(const content of ['Tibo야 초기화 있니?','Tibo야 초기화있니','Tibo야 언제 해?','Tibo야 초기화있니? '])assert.notEqual(await resetQuestionFingerprint(content),base);
});
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
  assert.match(reply([forecast,post('101','mentioned')]),/언제인지는 아직/);
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
test('오늘·내일·어제를 구분하고 이후 완료 공지가 과거 예정을 되살리지 않게 한다',()=>{
  const forecast=post('100','scheduled','2026-10-26T01:00:00Z',{timestamp:Date.parse('2026-10-26T16:00:00Z'),relation:'deadline'});
  const scoped=(posts,dayOffset,intent='status')=>resetQuestionReply({state,posts,pending:false},now,{dayOffset,intent});
  assert.match(scoped([forecast],1),/내일 01:00/);assert.match(scoped([forecast],0),/오늘 초기화 공지는 못/);
  assert.match(scoped([forecast,post('101','completed')],1),/내일 초기화 공지는 못/);
  assert.match(scoped([post('100','completed','2026-10-25T02:00:00Z'),post('101','completed')],-1),/^어제 초기화는 이미/);
  assert.match(scoped([post('100','scheduled')],1),/내일 일정인지는 아직 확인 못/);
});
test('남은 시간은 공지 기한과 구분하며 완료 질문에 예정을 완료로 답하지 않는다',()=>{
  const posts=[post('100','scheduled',undefined,{timestamp:now+3660000,relation:'deadline'})];
  const ask=intent=>resetQuestionReply({state,posts,pending:false},now,{intent});
  assert.match(ask('remaining'),/공지한 기한까지 1시간 1분 남았어/);assert.match(ask('completed'),/아직 확인된 건 예고/);
});
test('반복 질문에도 현재 상태를 답하고 안내·인사·직접 실행 한계를 구분한다',()=>{
  assert.match(repeatQuestionReply(reply(),1),/공지는 못 봤네.*아까도 물어봤지/);
  assert.equal(repeatQuestionReply(reply([post('100','completed')]),2),reply([post('100','completed')]));
  assert.equal(repeatQuestionReply('답',0),'답');assert.doesNotMatch(repeatQuestionReply('답',3),/\n/);
  for(const intent of ['help','greeting','manual','personal'])assert.equal(typeof resetQuestionReply({},now,{intent}),'string');
  assert.equal(repeatQuestionReply('답',1),'답 아까도 물어봤지? 😏');
  for(const count of [0,2,3,100,1000,-1,1.5,undefined])assert.equal(repeatQuestionReply('답',count),'답');
  assert.match(resetQuestionReply({},now,{intent:'personal'}),/네 계정의 사용량은 확인할 수 없어/);
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
  await test('선택한 문구는 재시도에도 유지되며 다른 사람이 같은 말을 해도 재질문 문구가 없다',async()=>{
    const f=guardFixture();const phrase=await resetQuestionFingerprint(source.content);
    const first=await f.claim('401','30','90','20',phrase);await process({messageId:'401',...first});const original=calls.at(-1).content;
    assert.equal(original,noAnnouncementReplies[first.replyIndex]);
    await process({messageId:'401',...first},2);assert.equal(calls.at(-1).content,original);
    const other=await f.claim('402','30','91','20',phrase);await process({messageId:'402',userId:'91',...other});assert.equal(calls.at(-1).content,noAnnouncementReplies[other.replyIndex]);assert.notEqual(other.replyIndex,first.replyIndex);
    const repeated=await f.claim('403','30','90','20',phrase);await process({messageId:'403',...repeated});assert.equal(calls.at(-1).content,noAnnouncementReplies[repeated.replyIndex]+' 아까도 물어봤지? 😏');
    const third=await f.claim('405','30','90','20',phrase);assert.equal(third.repeatCount,2);await process({messageId:'405',...third});assert.equal(calls.at(-1).content,noAnnouncementReplies[third.replyIndex]);
    const changed=await f.claim('404','30','90','20',await resetQuestionFingerprint('Tibo야 언제 해?'));await process({messageId:'404',...changed});assert.equal(calls.at(-1).content,noAnnouncementReplies[changed.replyIndex]);
    const before=calls.length;await process({replyIndex:200});await process({replyIndex:-1});assert.equal(calls.length,before);
  });
  await test('인사와 일반 대화에는 재질문 문구 없이 초기화 질문 안내만 보낸다',async()=>{
    for(const text of ['반갑다','안녕','점심 뭐 먹을까?']){
      const question=resetQuestionIntent(text);await process({...question,repeatCount:3});
      assert.equal(calls.at(-1).content,'초기화 관련 질문에만 답변할 수 있어. 초기화 일정이나 진행 상태가 궁금하면 물어봐!');
    }
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
  return {state,claim:async(messageId,channelId='30',userId='90',guildId='20',questionHash='a'.repeat(43))=>(await guard.fetch(new Request('https://guard/chat-claim',{method:'POST',body:JSON.stringify({messageId,guildId,channelId,userId,questionHash})}))).json()};
}
await test('같은 메시지만 중복 억제하고 연속 재질문은 답하며 사용자·채널·서버를 구분한다',async()=>{
  const f=guardFixture();const result=await Promise.all([f.claim('100'),f.claim('100'),f.claim('101')]);assert.deepEqual(result.map(r=>r.result),['accepted','duplicate','accepted']);assert.equal(result[2].repeatCount,1);
  assert.equal((await f.claim('102','31')).repeatCount,0);assert.equal((await f.claim('103','30','91')).repeatCount,0);assert.equal((await f.claim('104','30','90','21')).repeatCount,0);
  assert.equal((await guardFixture(Object.fromEntries(f.state)).claim('105')).repeatCount,2);
});
await test('동일 사용자·동일 문장만 재질문이며 다른 문장은 다른 날짜를 물어도 구분한다',async()=>{
  const f=guardFixture();const a=await resetQuestionFingerprint('Tibo야 초기화있니?'),b=await resetQuestionFingerprint('Tibo야 내일 초기화있니?');
  assert.equal((await f.claim('100','30','90','20',a)).repeatCount,0);
  assert.equal((await f.claim('101','30','91','20',a)).repeatCount,0);
  assert.equal((await f.claim('102','30','90','20',b)).repeatCount,0);
  assert.equal((await f.claim('103','30','90','20',a)).repeatCount,1);
  assert.equal((await f.claim('104','30','91','20',a)).repeatCount,1);
  const restarted=guardFixture(Object.fromEntries(f.state));assert.equal((await restarted.claim('105','30','90','20',b)).repeatCount,1);
  assert.doesNotMatch(JSON.stringify(Object.fromEntries(f.state)),/초기화|Tibo/);
});
await test('재시작 후에도 채널의 최근 문구를 피하고 기존 해시 없는 기록은 재질문에 포함하지 않는다',async()=>{
  const f=guardFixture();const first=await f.claim('100');delete f.state.get('chat-budget').seen[0].phrase;
  const restarted=guardFixture(Object.fromEntries(f.state));const next=await restarted.claim('101');assert.equal(next.repeatCount,0);assert.notEqual(next.replyIndex,first.replyIndex);
  const recent=[first.replyIndex,next.replyIndex];
  for(let i=0;i<40;i++){
    for(const entry of restarted.state.get('chat-budget').seen)entry.acceptedAt=Date.now()-20000;
    const result=await restarted.claim(String(200+i),'30',String(300+i));assert.equal(result.result,'accepted');assert.ok(!recent.slice(-20).includes(result.replyIndex));recent.push(result.replyIndex);
  }
});
test('최대 길이 식별자와 해시를 가진 500개 기록도 저장 값 크기 상한 안에 든다',()=>{
  const record={id:'1'.repeat(20),guildId:'1'.repeat(20),channelId:'1'.repeat(20),userId:'1'.repeat(20),acceptedAt:Date.now(),expiresAt:Date.now()+600000,phrase:'a'.repeat(43),choice:199};
  assert.ok(Buffer.byteLength(JSON.stringify({day:'2026-10-26',count:1000,nextAt:Date.now(),seen:Array(500).fill(record)}))<128*1024);
});
await test('5분 이후는 새 질문이며 10초 과다 호출과 하루 상한만 제한한다',async()=>{
  const f=guardFixture();await f.claim('100');f.state.get('chat-budget').seen[0].acceptedAt=Date.now()-300001;assert.equal((await f.claim('101')).repeatCount,0);
  for(let i=0;i<7;i++)assert.equal((await f.claim(String(200+i))).result,'accepted');assert.equal((await f.claim('300')).result,'limited');
  assert.equal((await f.claim('301','30','91')).result,'accepted');
});
await test('질문 일일 상한은 재시작에도 유지하고 옛 검증 예산과 분리한다',async()=>{
  const budget={day:new Date().toISOString().slice(0,10),count:1000,nextAt:0,seen:[]};const f=guardFixture({'chat-budget':budget,budget:{untouched:true}});
  assert.equal((await f.claim('100')).result,'limited');assert.equal((await guardFixture(Object.fromEntries(f.state)).claim('101')).result,'limited');assert.deepEqual(f.state.get('budget'),{untouched:true});
  f.state.set('chat-budget',{...budget,day:'2000-01-01'});assert.equal((await f.claim('102')).result,'accepted');assert.equal(f.state.get('chat-budget').count,1);
});
await test('채널 과다 호출과 여러 서버의 기록 크기를 제한하고 만료 기록은 비운다',async()=>{
  const f=guardFixture();for(let i=0;i<30;i++)assert.equal((await f.claim(String(100+i),'30',String(200+i))).result,'accepted');assert.equal((await f.claim('999','30','999')).result,'limited');
  const seen=Array.from({length:500},(_,i)=>({id:String(i),guildId:'20',channelId:'30',userId:'90',acceptedAt:Date.now()-20000,expiresAt:Date.now()+10000}));
  const full=guardFixture({'chat-budget':{day:new Date().toISOString().slice(0,10),count:500,seen}});assert.equal((await full.claim('999','31','91')).result,'limited');
  full.state.get('chat-budget').seen.forEach(entry=>entry.expiresAt=Date.now()-1);assert.equal((await full.claim('999','31','91')).result,'accepted');
});
await test('Gateway는 중복 제한 후 즉시 응답하고 정상 질문을 Queue에 보내지 않는다',async()=>{
  let initialized;const waits=[],jobs=[],guards=[];let reads=0;
  const ctx={storage:{async get(){return undefined;},async put(){}},blockConcurrencyWhile(fn){initialized=fn();},waitUntil(p){waits.push(p);}};
  const config={RESET_CHAT_ENABLED:'true',DISCORD_APPLICATION_ID:'1',COMMAND_GUARD:{idFromName(name){assert.equal(name,'discord-reset-chat');return name;},get(){return {async fetch(request,options){const body=JSON.parse(options.body);guards.push(body);return Response.json({result:'accepted'});}};}},PROBE_JOBS:{async send(job){jobs.push(job);}}};
  config.DB={prepare(){return {bind(){return this;}};},async batch(){reads++;return [{results:[]}];}};
  const gateway=new DiscordGateway(ctx,config);await initialized;
  gateway.receive({op:0,t:'MESSAGE_CREATE',d:{...source,timestamp:new Date().toISOString()}});gateway.receive({op:0,t:'MESSAGE_CREATE',d:{...source,content:'일반 채팅',timestamp:new Date().toISOString()}});await Promise.all(waits);
  assert.equal(reads,1);assert.equal(jobs.length,0);assert.equal(guards.length,1);assert.equal(guards[0].questionHash,await resetQuestionFingerprint(source.content));assert.doesNotMatch(JSON.stringify({jobs,guards}),/초기화있니/);
  let identified;gateway.ws={send(value){identified=JSON.parse(value);}};gateway.receive({op:10,d:{heartbeat_interval:1000}});assert.equal(identified.d.intents,33281);gateway.disconnect();
});
await test('질문 제한 객체가 없거나 실패하면 외부 질문 처리를 허용하지 않는다',async()=>{
  await assert.rejects(()=>claimResetQuestion({},{}));
  await assert.rejects(()=>claimResetQuestion({COMMAND_GUARD:{idFromName(){return 'one';},get(){return {fetch:async()=>new Response(null,{status:503})};}}},{}));
});
