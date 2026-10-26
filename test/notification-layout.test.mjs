import test from 'node:test';
import assert from 'node:assert/strict';
import {resetNotification} from '../src/reset-analysis.js';
import {encodeEmbedNotification,notificationPayload} from '../src/notification-payload.js';
import {sendNotification} from '../src/notifications.js';
const post={id:'123',date:'Oct 25, 2026 · 6:06 AM UTC',text:'Synthetic announcement'};
const card={title:'⚠️ 초기화 관련 내용 감지',url:'https://x.com/thsottiaux/status/123',color:0xFEE75C};
for(const status of ['scheduled','in_progress','mentioned'])test(`${status}의 시각 없는 알림은 요약과 제목만 있는 카드로 전송한다`,()=>{
  const payload=notificationPayload(resetNotification(post,{status,reset_type:'banked',summary_ko:'초기화권 안내입니다.',time:null}));
  assert.deepEqual(payload.embeds,[card]);assert.match(payload.content,/저장형 리셋/);assert.ok(payload.content.endsWith('\n- 초기화권 안내입니다.'));assert.doesNotMatch(payload.content,/15:06|시각 미정/);
});
for(const status of ['in_progress','mentioned'])test(`${status}에 과거 time 값이 남아 있어도 예정 시각을 넣지 않는다`,()=>{
  const payload=notificationPayload(resetNotification(post,{status,summary_ko:'안내',time:{timestamp:Date.parse('2026-10-25T08:00Z')}}));
  assert.deepEqual(payload.embeds,[card]);
});
test('이전 v1과 문자열 대기열을 보존하고 v2 본문과 카드를 함께 복원한다',()=>{
  assert.deepEqual(notificationPayload('tibo-embed:v1:'+JSON.stringify({...card,description:'기존 완료 안내'})),{content:'',embeds:[{...card,description:'기존 완료 안내'}]});
  assert.deepEqual(notificationPayload(encodeEmbedNotification(card,'요약')),{content:'요약',embeds:[card]});
  assert.deepEqual(notificationPayload('기존 문자열'),{content:'기존 문자열'});
  for(const payload of [{content:12,embed:card},{content:'x'.repeat(1901),embed:card},{content:'요약',embed:{...card,description:null}},{content:'요약',embed:{...card,url:'https://example.com/'}}])assert.throws(()=>notificationPayload('tibo-embed:v2:'+JSON.stringify(payload)));
  assert.throws(()=>encodeEmbedNotification(card,'x'.repeat(1901)));
});
test('요약의 외부 링크와 Markdown은 실행되지 않고 수정 전송에서도 본문과 카드가 유지된다',async()=>{
  const encoded=resetNotification(post,{status:'in_progress',summary_ko:'[위조](https://example.com/)\n**완료** <@123>'});
  const payload=notificationPayload(encoded);assert.doesNotMatch(payload.content,/example\.com/);assert.ok(payload.content.includes('\\*\\*완료\\*\\*'));assert.ok(payload.content.includes('\\<@123\\>'));
  const originalFetch=globalThis.fetch;let sent;
  try{
    globalThis.fetch=async(url,options)=>{assert.equal(options.method,'PATCH');sent=JSON.parse(options.body);return Response.json({id:'900'});};
    await sendNotification({DISCORD_BOT_TOKEN:'fixture',DISCORD_TEST_CHANNEL_ID:'30'},post.id,encoded,'reset','900');
    assert.deepEqual(sent.embeds,[card]);assert.equal(sent.content,payload.content);assert.deepEqual(sent.allowed_mentions,{parse:[]});assert.equal(sent.flags,0);
  }finally{globalThis.fetch=originalFetch;}
});
