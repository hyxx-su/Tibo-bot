import test from 'node:test';
import assert from 'node:assert/strict';
import {parseResetTime,formatKoreanTime,publishedTimestamp} from '../src/reset-time.js';
import {analyzeReset,hasResetKeyword,resetNotification} from '../src/reset-analysis.js';
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
  ['30분 후','2026-10-25T12:30:00Z'],
  ['2026-11-01 at 1:30am PDT','2026-11-01T08:30:00Z'],
])await test(`시간 변환: ${expression}`,()=>assert.equal(new Date(parseResetTime(expression,published).timestamp).toISOString(),new Date(expected).toISOString()));

for(const expression of ['at 9am PT','tomorrow at 9am','2026-02-30 at 9am UTC','2026-11-01 at 1:30am PT','2026-03-08 at 2:30am PT','soon','in 999 hours','2026-10-26T25:00Z','2026-10-26T09:00+14:30']){
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
await test('reset 변형과 한국어 초기화를 분석 대상으로 선택한다',()=>{
  for(const text of ['reset','resets','resetting','초기화'])assert.equal(hasResetKeyword(text),true);
  assert.equal(hasResetKeyword('preset settings'),false);
});
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
  await test('원문에 없는 근거로 초기화 공지를 발송하지 않는다',async()=>{
    result={...result,evidence:'Invented announcement'};
    await assert.rejects(()=>analyzeReset({GEMINI_API_KEY:'fixture'},post),/evidence/);
  });
  await test('완료 공지와 무관한 글을 예정으로 표시하지 않는다',()=>{
    assert.match(resetNotification(post,{status:'completed',summary_ko:'초기화 완료'}),/^\*\*:warning: 초기화 완료 공지 감지/);
    assert.equal(resetNotification(post,{status:'unrelated'}),null);
  });
}finally{globalThis.fetch=originalFetch;}
