import test from 'node:test';
import assert from 'node:assert/strict';
import {resetNotification,postNotification} from '../src/reset-analysis.js';
import {encodeEmbedNotification,notificationPayload} from '../src/notification-payload.js';
import {sendNotification} from '../src/notifications.js';
const post={id:'123',date:'Oct 25, 2026 · 6:06 AM UTC',text:'Synthetic announcement'};
const card={title:'⚠️ 초기화 관련 내용 감지',url:'https://x.com/thsottiaux/status/123',color:0xFEE75C};
for(const status of ['scheduled','in_progress','mentioned'])test(`${status}의 시각 미정 알림은 날짜와 KST 줄을 생략한다`,()=>{
  const payload=notificationPayload(resetNotification(post,{status,reset_type:'banked',summary_ko:'초기화권 안내입니다.',time:null,evidence:post.text}));
  assert.equal(payload.embeds,undefined);assert.ok(payload.content.startsWith('**## :warning: 초기화 관련 내용 감지 :warning:**\n**['));assert.ok(payload.content.includes('\n- 초기화권 안내입니다.'));
  assert.doesNotMatch(payload.content,/^# |^-# |시각 미정|15:06/m);assert.ok(payload.content.endsWith('\nhttps://x.com/thsottiaux/status/123'));assert.doesNotMatch(payload.content,/원문 근거|전체 완료 공지로/);
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
  assert.doesNotMatch(payload.content,/원문 근거/);assert.ok(payload.content.includes(card.url));assert.ok(payload.content.endsWith(card.url));assert.ok(payload.content.length<1900);
  assert.equal(notificationPayload(resetNotification(post,{status:'completed',reset_type:'regular',summary_ko:'사용량 초기화 완료 안내'})).embeds,undefined);
});
test('원문 카드의 외부 URL·과대 본문·합산 한도를 거부하고 임의 필드는 전달하지 않는다',()=>{
  const source={author:{name:'Tibo (@thsottiaux)',url:card.url},description:'원문',color:0x1DA1F2,footer:{text:'X'}};
  assert.throws(()=>encodeEmbedNotification(card,'요약',{...source,author:{...source.author,url:'https://evil.invalid'}}));
  assert.throws(()=>encodeEmbedNotification(card,'요약',{...source,description:'x'.repeat(3001)}));
  assert.throws(()=>encodeEmbedNotification({...card,description:'x'.repeat(4000)},'요약',{...source,description:'x'.repeat(3000)}));
  const payload=notificationPayload(encodeEmbedNotification(card,'요약',{...source,image:{url:'https://evil.invalid'}}));assert.equal(payload.embeds[1].image,undefined);
});

for(const status of ['scheduled','in_progress','completed','mentioned','unrelated'])test(`${status} 제목과 하단은 현재 글의 같은 링크이고 요약은 목록이다`,()=>{
  const content=postNotification(post,{status,title_ko:'새 기능 안내',summary_ko:'새 기능을 안내합니다.',reset_type:'banked',time:null});
  const lines=content.split('\n');const offset=status==='unrelated'?0:1;
  assert.equal(lines[0].startsWith('**## :warning:'),status!=='unrelated');
  assert.match(lines[offset],/^\*\*\[.+\]\(<https:\/\/x.com\/thsottiaux\/status\/123>\)\*\*$/);
  assert.equal(lines[offset],'**[새 기능 안내](<https://x.com/thsottiaux/status/123>)**');assert.equal(lines[offset+1],'- 새 기능을 안내합니다.');assert.equal(lines.at(-1),card.url);
  assert.equal(lines.length,offset+3);
});
test('미디어 글과 분석 실패·기존 빈 요약은 내용을 만들어내지 않는다',()=>{
  assert.match(postNotification({...post,text:''},{status:'unrelated',title_ko:'상상한 사진',summary_ko:'상상한 이미지 내용'}),/이미지·미디어 게시글/);
  assert.doesNotMatch(postNotification({...post,text:''},{status:'unrelated',summary_ko:'상상한 이미지 내용'}),/상상한/);
  assert.equal(postNotification(post,{status:'unavailable'}),card.url);
  assert.equal(postNotification(post,{status:'unrelated',summary_ko:''}),card.url);
});
test('제목도 모델이 만든 링크·줄바꿈·멘션을 실행하지 않는다',()=>{
  const content=postNotification(post,{status:'unrelated',title_ko:'[위조](https://evil.invalid)\n<@123>',summary_ko:'요약'});
  assert.doesNotMatch(content,/evil.invalid/);assert.equal(content.split('\n').length,3);assert.ok(content.includes('\\<@123\\>'));
});

test('관련 글 제목에 복수 핵심 소식과 진행 표현을 보존한다',()=>{
  const title='새 모델 출시·사용자 1천만 명 달성과 저장형 초기화권 지급 진행';
  const content=postNotification(post,{status:'in_progress',reset_type:'banked',title_ko:title,bullets:['저장형 초기화권을 지급 중입니다.','새 모델 출시와 사용자 기록을 안내했습니다.']});
  assert.equal(content.split('\n')[1],`**[${title}](<https://x.com/thsottiaux/status/123>)**`);
  assert.doesNotMatch(content,/지급 완료/);
});
test('제목 없는 과거 관련 분석은 상태별 제목으로 호환한다',()=>{
  for(const title_ko of [undefined,'','  '])assert.match(postNotification(post,{status:'in_progress',reset_type:'banked',title_ko,summary_ko:'지급 진행 안내입니다.'}),/\*\*\[저장형 리셋 지급 진행 중\]/);
});
test('관련 글의 생성 제목도 외부 링크·멘션·줄바꿈을 실행하지 않는다',()=>{
  const content=postNotification(post,{status:'mentioned',title_ko:'[가짜](https://evil.invalid)\n<@123>',summary_ko:'관련 언급입니다.'});
  assert.doesNotMatch(content,/evil.invalid/);assert.ok(content.includes('\\<@123\\>'));assert.equal(content.split('\n').length,4);
});
