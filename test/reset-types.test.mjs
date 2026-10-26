import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReset,resetNotification} from '../src/reset-analysis.js';
import {notificationPayload,encodeEmbedNotification} from '../src/notification-payload.js';
import {resetQuestionReply} from '../src/reset-reply.js';
import {sendNotification} from '../src/notifications.js';
const date='Oct 26, 2026 · 5:00 AM UTC',now=Date.parse('2026-10-26T06:00:00Z');
const texts={regular:'Codex usage limits have been reset for everyone.',banked:'A banked reset has been added to every account. Use it later.'};
const originalFetch=globalThis.fetch;
try{
  for(const type of ['regular','banked'])await test(`${type}의 유형과 완료 근거를 저장하고 구분된 X 요약으로 보낸다`,async()=>{
    const post={id:'123',date,text:texts[type]};const result={status:'completed',reset_type:type,type_evidence:post.text,evidence:post.text,time_expression:'',summary_ko:type==='banked'?'저장형 리셋이 지급됐습니다.':'사용량이 초기화됐습니다.'};
    globalThis.fetch=async(url,options)=>{
      const schema=JSON.parse(options.body).generationConfig.responseSchema;assert.ok(schema.required.includes('reset_type'));assert.ok(schema.required.includes('type_evidence'));
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(result)}]}}]});
    };
    const analysis=await analyzeReset({GEMINI_API_KEY:'synthetic'},post);assert.equal(analysis.reset_type,type);assert.equal(analysis.type_evidence,post.text);
    const serialized=resetNotification(post,analysis),payload=notificationPayload(serialized);
    assert.equal(payload.embeds,undefined);assert.match(payload.content,type==='banked'?/저장형 리셋 지급 완료 안내/:/초기화 완료 안내/);
    assert.ok(payload.content.includes('- '+result.summary_ko));
    if(type==='banked')assert.doesNotMatch(payload.content,/사용량이 초기화되었습니다/);
    let sent;globalThis.fetch=async(url,options)=>{sent=JSON.parse(options.body);return Response.json({id:'900'});};
    await sendNotification({DISCORD_BOT_TOKEN:'synthetic',DISCORD_TEST_CHANNEL_ID:'30'},'123',serialized,'reset','800');
    assert.equal(sent.content,payload.content);assert.deepEqual(sent.embeds,[]);assert.deepEqual(sent.allowed_mentions,{parse:[]});assert.equal(sent.flags,0);
  });
  await test('없는 유형 근거와 잘못된 유형은 거부하고 생략된 구버전 유형은 unknown으로 보존한다',async()=>{
    let result={status:'completed',reset_type:'banked',type_evidence:'invented',evidence:texts.regular,summary_ko:'안내',time_expression:''};
    globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(result)}]}}]});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},{id:'123',date,text:texts.regular}),/type evidence/);
    result.reset_type='bad';await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},{id:'123',date,text:texts.regular}),/Invalid reset type/);
    delete result.reset_type;delete result.type_evidence;assert.equal((await analyzeReset({GEMINI_API_KEY:'synthetic'},{id:'123',date,text:texts.regular})).reset_type,'unknown');
  });
  await test('유형은 연결 문맥으로 해석해도 완료 근거는 현재 글에서 확인한다',async()=>{
    const post={id:'123',date,text:'All distributed.',context:[{id:'122',date,text:texts.banked}]};
    const result={status:'completed',reset_type:'banked',type_evidence:texts.banked,evidence:post.text,summary_ko:'저장형 지급 완료',time_expression:''};
    globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(result)}]}}]});
    assert.equal((await analyzeReset({GEMINI_API_KEY:'synthetic'},post)).reset_type,'banked');
    result.evidence=texts.banked;await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},post),/Current post evidence/);
  });
}finally{globalThis.fetch=originalFetch;}
for(const status of ['scheduled','in_progress','completed','mentioned'])test(`저장형 ${status}를 현재 사용량 완료로 답하지 않는다`,()=>{
  const analysis={reset_type:'banked',status,summary_ko:'저장형 리셋 지급 안내',time:{timestamp:now+3600000,relation:'deadline'}};
  const answer=resetQuestionReply({state:{baseline_id:'1',last_success:now},posts:[{id:'123',published_at:date,analysis_json:JSON.stringify(analysis)}]},now,{intent:'status'});
  assert.match(answer,/저장형 리셋/);
  const source=resetQuestionReply({state:{baseline_id:'1',last_success:now},posts:[{id:'123',published_at:date,analysis_json:JSON.stringify(analysis)}]},now,{intent:'source'});assert.match(source,/저장형 리셋/);assert.doesNotMatch(answer,/오늘 초기화는 이미 끝|사용량이 초기화되었습니다/);
  if(status==='scheduled'){assert.match(answer,/16:00\(KST\)까지/);assert.match(resetNotification({id:'123',date,text:'Later'},analysis),/저장형 리셋 지급/);}
});
test('저장형 지급은 마지막 사용량 초기화 완료 이력에 포함하지 않는다',()=>{
  const posts=[{id:'123',published_at:date,analysis_json:JSON.stringify({status:'completed',reset_type:'banked'})}];
  assert.match(resetQuestionReply({state:{baseline_id:'1',last_success:now},posts},now,{intent:'history'}),/완료 공지를 찾지 못/);
});
test('일반 문자열과 기존 대기열은 보존하고 잘못된 임베드는 거부한다',()=>{
  assert.deepEqual(notificationPayload('https://x.com/thsottiaux/status/123'),{content:'https://x.com/thsottiaux/status/123'});
  assert.throws(()=>notificationPayload('tibo-embed:v1:{bad'));
  assert.throws(()=>encodeEmbedNotification({title:'x',description:'x',color:0,url:'https://example.com/'}));
  assert.throws(()=>encodeEmbedNotification({title:'x',description:'x'.repeat(4097),color:0,url:'https://x.com/thsottiaux/status/123'}));
});
