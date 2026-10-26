import test from 'node:test';
import assert from 'node:assert/strict';
import {parseResetTime,formatKoreanTime,publishedTimestamp} from '../src/reset-time.js';
import {analyzeReset,resetNotification} from '../src/reset-analysis.js';
import {notificationPayload} from '../src/notification-payload.js';
import {scheduleWatch} from '../src/watcher.js';

const published=Date.parse('2026-10-25T12:00:00Z');
for(const [expression,expected] of [
  ['tomorrow at 9am PT','2026-10-26T16:00:00Z'],
  ['today at 10:30am ET','2026-10-25T14:30:00Z'],
  ['2026-12-01 at 9am PT','2026-12-01T17:00:00Z'],
  ['Oct 26, 2026 at 09:30 UTC','2026-10-26T09:30:00Z'],
  ['2026-10-26T09:00:00+09:00','2026-10-26T00:00:00Z'],
  ['2026-10-26T09:00Z','2026-10-26T09:00:00Z'],
  ['in 2 hours','2026-10-25T14:00:00Z'],
  ['within the next 3 hours','2026-10-25T15:00:00Z'],
  ['within 45 minutes','2026-10-25T12:45:00Z'],
  ['30분 후','2026-10-25T12:30:00Z'],
  ['2026-11-01 at 1:30am PDT','2026-11-01T08:30:00Z'],
])await test(`시간 변환: ${expression}`,()=>assert.equal(new Date(parseResetTime(expression,published).timestamp).toISOString(),new Date(expected).toISOString()));

for(const expression of ['at 9am PT','tomorrow at 9am','2026-02-30 at 9am UTC','2026-11-01 at 1:30am PT','2026-03-08 at 2:30am PT','soon','in 999 hours','2026-10-26T25:00Z','2026-10-26T09:00+14:30','within 0 hours','within 999 hours','within the next 2 to 3 hours','by EOD PST']){
  await test(`불확실하거나 잘못된 시간을 확정하지 않는다: ${expression}`,()=>assert.equal(parseResetTime(expression,published),null));
}
await test('한국시간 날짜 이월을 표시한다',()=>assert.equal(formatKoreanTime(Date.parse('2026-10-26T16:00:00Z')),'2026-10-27 01:00 (한국시간, KST)'));
await test('By midnight PST는 게시 당시 PST 날짜의 다음 자정까지로 해석한다',()=>{
  const time=parseResetTime('By midnight PST',Date.parse('2026-10-25T03:40:00Z'));
  assert.equal(formatKoreanTime(time.timestamp),'2026-10-25 17:00 (한국시간, KST)');assert.equal(time.relation,'deadline');
});
await test('명시된 PST와 서머타임을 따르는 PT를 구분한다',()=>{
  const at=Date.parse('2026-10-25T03:40:00Z');
  assert.equal(parseResetTime('By midnight PST',at).timestamp-parseResetTime('By midnight PT',at).timestamp,3600000);
});
await test('미러 게시 시각의 UTC를 보존한다',()=>assert.equal(publishedTimestamp({date:'Oct 25, 2026 · 12:00 PM UTC'}),published));
await test('비활성화 상태의 예약 실행은 큐를 사용하지 않는다',async()=>{
  let calls=0;const env={PROBE_JOBS:{async send(job){assert.equal(job.kind,'watch-poll');calls++;}}};
  await scheduleWatch(env);assert.equal(calls,0);await scheduleWatch({...env,WATCH_ENABLED:'true'});assert.equal(calls,1);
});

const originalFetch=globalThis.fetch;
const post={id:'123',date:'Oct 25, 2026 · 12:00 PM UTC',text:'Codex usage limits will reset tomorrow at 9am PT.'};
let result={status:'scheduled',summary_ko:'Codex 사용량 한도가 초기화될 예정입니다.',evidence:post.text,time_expression:'tomorrow at 9am PT'};
try{
  globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(result)}]}}]});
  await test('원문의 시간 표현만 변환해 초기화 예정 알림에 넣는다',async()=>{
    const analysis=await analyzeReset({GEMINI_API_KEY:'fixture'},post);
    assert.match(resetNotification(post,analysis),/초기화 예상 시간 감지\*\*\n# 10월 27일 01:00/);
  });
  await test('추론용 응답 조각은 알림과 JSON 해석에 섞지 않는다',async()=>{
    const savedFetch=globalThis.fetch;
    globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{thought:true,text:'internal reasoning is not an announcement'},{text:JSON.stringify(result)}]}}]});
    try{
      const analysis=await analyzeReset({GEMINI_API_KEY:'fixture'},post);
      assert.equal(analysis.status,'scheduled');assert.doesNotMatch(resetNotification(post,analysis),/internal reasoning/);
    }finally{globalThis.fetch=savedFetch;}
  });
  await test('reset 없는 시간 답글과 연결 본문을 함께 분석하고 기한을 표시한다',async()=>{
    const reply={id:'124',date:'Oct 25, 2026 · 3:40 AM UTC',text:'By midnight PST',context:[{id:'123',date:'Oct 25, 2026 · 3:39 AM UTC',text:'Day 20/ Rest and reset'}]};
    const saved=result;result={status:'scheduled',summary_ko:'스레드 문맥상 자정까지 초기화 예정으로 해석됩니다.',evidence:reply.context[0].text,time_expression:reply.text};
    const analysis=await analyzeReset({GEMINI_API_KEY:'fixture'},reply);const message=resetNotification(reply,analysis);
    assert.equal(message,'**:warning: 초기화 예상 시간 감지**\n# 10월 25일 17:00\n-# 한국시간(KST) · 추정\n\n게시글과 연결된 스레드의 내용을 분석한 결과, PST 기준 다음 자정까지 초기화될 가능성이 있습니다.\n\nhttps://x.com/thsottiaux/status/124');result=saved;
  });
  await test('모델이 만든 원문 밖 시각은 버린다',async()=>{
    result={...result,time_expression:'2026-10-30 at 10am UTC'};
    const analysis=await analyzeReset({GEMINI_API_KEY:'fixture'},post);assert.equal(analysis.time,null);assert.match(resetNotification(post,analysis),/초기화 시각 미정/);
  });
  await test('상대 기한은 게시 시각에서 계산하고 실행 시각처럼 안내하지 않는다',async()=>{
    const saved=result;
    const current={...post,text:'Codex usage resets within the next 3 hours.'};
    result={status:'scheduled',summary_ko:'초기화 예정입니다.',evidence:current.text,time_expression:'within the next 3 hours'};
    const analysis=await analyzeReset({GEMINI_API_KEY:'fixture'},current);
    assert.equal(analysis.time.timestamp,published+3*3600000);
    assert.equal(analysis.time.relation,'deadline');
    assert.match(resetNotification(current,analysis),/위 한국시간까지/);result=saved;
  });
  for(const status of ['mentioned','unrelated'])await test(`${status} 결과에 모델이 시간을 끼워 넣어도 예정 시각으로 쓰지 않는다`,async()=>{
    const saved=result;result={status,summary_ko:'초기화가 확정되지 않았습니다.',evidence:post.text,time_expression:'tomorrow at 9am PT'};
    const analysis=await analyzeReset({GEMINI_API_KEY:'fixture'},post);
    assert.equal(analysis.time,null);assert.equal(analysis.time_expression,'');result=saved;
  });
  await test('원문에 없는 근거로 초기화 공지를 발송하지 않는다',async()=>{
    result={...result,evidence:'Invented announcement'};
    await assert.rejects(()=>analyzeReset({GEMINI_API_KEY:'fixture'},post),/evidence/);
  });
  await test('인용의 게시 날짜가 없으면 새 글 날짜를 대신 써서 기한을 만들지 않는다',async()=>{
    const saved=result;result={status:'scheduled',summary_ko:'초기화 예정 안내입니다.',evidence:'A reset is planned.',time_expression:'By midnight PST'};
    const analysis=await analyzeReset({GEMINI_API_KEY:'fixture'},{...post,text:'A reset is planned.',context:[{id:'1',text:'By midnight PST',date:null}]});assert.equal(analysis.time,null);result=saved;
  });
  await test('완료 판단은 현재 글에 근거해야 하며 인용 속 완료 문구만으로 확정하지 않는다',async()=>{
    const saved=result;result={status:'completed',summary_ko:'완료 안내입니다.',evidence:'Earlier reset completed.',time_expression:''};
    await assert.rejects(()=>analyzeReset({GEMINI_API_KEY:'fixture'},{...post,text:'Not yet.',context:[{id:'1',text:'Earlier reset completed.',date:post.date}]}),/Current post evidence/);result=saved;
  });
  await test('진행 공지를 완료로 표시하거나 인용한 과거 기한을 현재 시각으로 표시하지 않는다',async()=>{
    const saved=result;result={status:'in_progress',summary_ko:'Tibo가 초기화 반영 진행 중이라고 안내했습니다.',evidence:'Still propagating.',time_expression:'By midnight PST'};
    const current={id:'125',date:'Oct 25, 2026 · 6:06 AM UTC',text:'Still propagating.',context:[{id:'124',text:'By midnight PST',date:'Oct 25, 2026 · 3:40 AM UTC'}]};
    const analysis=await analyzeReset({GEMINI_API_KEY:'fixture'},current);assert.equal(analysis.time,null);const content=resetNotification(current,analysis);assert.match(content,/초기화 진행 공지 감지/);assert.match(content,/# 10월 25일 15:06/);assert.doesNotMatch(content,/초기화 완료|17:00/);result=saved;
  });
  await test('완료 공지와 무관한 글을 예정으로 표시하지 않는다',()=>{
    assert.equal(notificationPayload(resetNotification(post,{status:'completed',reset_type:'regular',summary_ko:'초기화 완료'})).embeds[0].color,0x57F287);
    assert.equal(resetNotification(post,{status:'unrelated'}),null);
  });
}finally{globalThis.fetch=originalFetch;}


await test('정기 완료는 본문 없이 초록색 임베드에 유형과 발표 시각을 표시한다',()=>{
  const current={id:'200',date:'Oct 25, 2026 · 6:06 AM UTC'};
  const payload=notificationPayload(resetNotification(current,{status:'completed',reset_type:'regular',previousExpectedAt:Date.parse('2026-10-25T08:00:00Z')}));
  assert.equal(payload.content,'');assert.equal(payload.embeds.length,1);const embed=payload.embeds[0];
  assert.equal(embed.title,'🔄 Codex 사용량 리셋 감지');assert.equal(embed.color,0x57F287);
  assert.equal(embed.description.split('\n').length,4);assert.match(embed.description,/정기 리셋 \(regular\)/);assert.match(embed.description,/발표 시각: 2026-10-25 15:06 KST/);
  assert.doesNotMatch(embed.description,/17:00|앞서 완료|codex-resets/);
});
await test('유형 없는 기존 분석과 잘못된 게시 날짜는 추측하지 않는다',()=>{
  const embed=notificationPayload(resetNotification({id:'200',date:'invalid'},{status:'completed'})).embeds[0];
  assert.equal(embed.color,0xFEE75C);assert.match(embed.description,/유형 미확인/);assert.match(embed.description,/발표 시각: 확인되지 않음/);assert.doesNotMatch(embed.description,/사용량이 초기화되었습니다/);
});

await test('PST 저녁의 tomorrow before 10am은 UTC 날짜가 아닌 PST 다음 날을 기준으로 변환한다',()=>{
  const time=parseResetTime('tomorrow before 10am PST',Date.parse('2026-10-23T04:48:00Z'));
  assert.equal(formatKoreanTime(time.timestamp),'2026-10-24 03:00 (한국시간, KST)');
});
