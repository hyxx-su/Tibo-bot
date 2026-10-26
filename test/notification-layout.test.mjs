import test from 'node:test';
import assert from 'node:assert/strict';
import {resetNotification} from '../src/reset-analysis.js';
import {encodeEmbedNotification,notificationPayload} from '../src/notification-payload.js';
import {sendNotification} from '../src/notifications.js';
const post={id:'123',date:'Oct 25, 2026 · 6:06 AM UTC',text:'Synthetic announcement'};
const card={title:'⚠️ 초기화 관련 내용 감지',url:'https://x.com/thsottiaux/status/123',color:0xFEE75C};
for(const status of ['scheduled','in_progress','mentioned'])test(`${status}의 시각 미정 알림은 날짜와 KST 줄을 생략한다`,()=>{
  const payload=notificationPayload(resetNotification(post,{status,reset_type:'banked',summary_ko:'초기화권 안내입니다.',time:null,evidence:post.text}));
  assert.equal(payload.embeds,undefined);assert.ok(payload.content.startsWith('**:warning: 초기화 관련 내용 감지**\n\n초기화권 안내입니다.'));
  assert.doesNotMatch(payload.content,/^# |^-# |시각 미정|15:06/m);assert.ok(payload.content.includes('\nhttps://x.com/thsottiaux/status/123\n- 원문 근거:'));
});
for(const status of ['in_progress','mentioned'])test(`${status}에 과거 time이 있어도 날짜 줄을 표시하지 않는다`,()=>{
  const payload=notificationPayload(resetNotification(post,{status,summary_ko:'안내',time:{timestamp:Date.parse('2026-10-25T08:00Z')}}));
  assert.equal(payload.embeds,undefined);assert.doesNotMatch(payload.content,/^# |^-# /m);
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
    assert.deepEqual(sent.embeds,[]);assert.equal(sent.content,payload.content);assert.deepEqual(sent.allowed_mentions,{parse:[]});assert.equal(sent.flags,0);
  }finally{globalThis.fetch=originalFetch;}
});
test('유효한 예정 시각만 두 줄로 표시하고 기한을 보존한다',()=>{
  const payload=notificationPayload(resetNotification(post,{status:'scheduled',summary_ko:'초기화 예정',time:{timestamp:Date.parse('2026-10-25T08:00Z'),relation:'deadline'}}));
  assert.match(payload.content,/^# 예정 시각: 10월 25일 17:00까지\n-# 한국시간\(KST\) · 원문 분석/m);assert.equal(payload.embeds,undefined);
});
test('없는 근거를 추가하지 않고 긴 요약도 링크와 상태를 보존한다',()=>{
  const payload=notificationPayload(resetNotification(post,{status:'mentioned',summary_ko:'*'.repeat(600),evidence:'invented'}));
  assert.doesNotMatch(payload.content,/원문 근거/);assert.ok(payload.content.includes(card.url));assert.ok(payload.content.endsWith('전체 완료 공지로 확인된 내용은 아닙니다.'));assert.ok(payload.content.length<1900);
  assert.equal(notificationPayload(resetNotification(post,{status:'completed',reset_type:'regular'})).embeds.length,1);
});
test('원문 카드의 외부 URL·과대 본문·합산 한도를 거부하고 임의 필드는 전달하지 않는다',()=>{
  const source={author:{name:'Tibo (@thsottiaux)',url:card.url},description:'원문',color:0x1DA1F2,footer:{text:'X'}};
  assert.throws(()=>encodeEmbedNotification(card,'요약',{...source,author:{...source.author,url:'https://evil.invalid'}}));
  assert.throws(()=>encodeEmbedNotification(card,'요약',{...source,description:'x'.repeat(3001)}));
  assert.throws(()=>encodeEmbedNotification({...card,description:'x'.repeat(4000)},'요약',{...source,description:'x'.repeat(3000)}));
  const payload=notificationPayload(encodeEmbedNotification(card,'요약',{...source,image:{url:'https://evil.invalid'}}));assert.equal(payload.embeds[1].image,undefined);
});
