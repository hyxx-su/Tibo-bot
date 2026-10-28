import test from 'node:test';
import assert from 'node:assert/strict';
import {resetQuestionIntent,resetQuestionJob,resetQuestionReply} from '../src/reset-reply.js';

test('최근 완료를 묻는 다양한 표현은 오늘 상태로 축소하지 않는다',()=>{
  for(const text of ['최근에 초기화있었냐','최근 리셋 있었어?','요즘 초기화 한 적 있어?','근래 사용량 초기화됐어?','가장 최근 초기화 언제 했어?','마지막 리셋 언제였어?','지난번 리셋 언제였어?']){
    assert.deepEqual(resetQuestionIntent(text),{intent:'history'},text);
  }
});
test('명시한 날짜·미래 예고·출처 질문의 의미는 유지한다',()=>{
  for(const text of ['최근 초기화 예고 언제야?','최근에 초기화 계획 있어?','최근 공지에서 다음 리셋 언제래?','최근 초기화 언제 할까?']){
    assert.notEqual(resetQuestionIntent(text).intent,'history',text);
  }
  assert.deepEqual(resetQuestionIntent('어제 초기화 됐어?'),{intent:'completed',dayOffset:-1});
  assert.deepEqual(resetQuestionIntent('오늘 최근에 초기화 됐어?'),{intent:'completed',dayOffset:0});
  assert.equal(resetQuestionIntent('최근 초기화 완료 원문 링크').intent,'source');
  assert.equal(resetQuestionIntent('최근 컴퓨터 초기화했어?').intent,'help');
});
test('일반 채팅 수신부터 최근 이력 답변까지 자정 전 완료 기록을 보존한다',()=>{
  const now=Date.parse('2026-10-27T00:00:00Z');
  const job=resetQuestionJob({id:'100',guild_id:'200',channel_id:'300',author:{id:'400'},type:0,content:'Tibo야 최근에 초기화있었냐',timestamp:new Date(now).toISOString()},'500',now);
  assert.equal(job.intent,'history');
  const input={state:{baseline_id:'1',last_success:now},pending:false,posts:[],siteResets:[{verification:'verified',missing_count:0,reset_type:'regular',announced_at:'2026-10-26T07:00:00Z',original_url:'https://x.com/thsottiaux/status/100'}]};
  const result=resetQuestionReply(input,now,job);
  assert.match(result,/2026-10-26 16:00/);
  assert.match(result,/정기 리셋 실행 기록/);
  assert.doesNotMatch(result,/오늘.*(?:없|못|미확인)/);
  assert.doesNotMatch(resetQuestionReply({...input,siteResets:[{...input.siteResets[0],reset_type:'banked'}]},now,job),/정기 리셋 실행 기록/);
});

test('최근 질문 60개를 실제 메시지 진입점부터 링크 없는 이력 답변까지 검증한다',async()=>{
  const {recentResetQuestions}=await import('./fixtures/recent-reset-questions.mjs');
  assert.equal(recentResetQuestions.length,60);
  assert.equal(new Set(recentResetQuestions).size,60);
  const now=Date.parse('2026-10-27T00:00:00Z');
  const input={state:{baseline_id:'1',last_success:now},posts:[],siteResets:[{verification:'verified',missing_count:0,reset_type:'regular',announced_at:'2026-10-26T07:00:00Z',original_url:null}]};
  for(const question of recentResetQuestions){
    const job=resetQuestionJob({id:'100',guild_id:'200',channel_id:'300',author:{id:'400'},type:0,content:'Tibo야 '+question,timestamp:new Date(now).toISOString()},'500',now);
    assert.equal(job?.intent,'history',question);
    const answer=resetQuestionReply(input,now,job);
    assert.match(answer,/2026-10-26 16:00/,question);
    assert.doesNotMatch(answer,/실제 계정 반영|https?:|오늘.*(?:없|못|미확인)/,question);
  }
});
test('최근이라는 단어가 있어도 미래·진행·요청을 완료 이력으로 오인하지 않는다',()=>{
  for(const question of ['최근 초기화 예정 있니','요즘 초기화 계획 있어?','근래 리셋 예고 있었어?','최근 다음 리셋 언제래','요새 초기화 언제 할 거야?','최근 초기화 언제 할까','최근 초기화 해줄 수 있어?','요즘 초기화 제발 해줘','요새 초기화 좀 해주라','최근 초기화 내놔','최근 초기화 진행 중이야?','최근 초기화 반영 중이야?','최근 초기화 되는 중이야?','최근 초기화 취소됐어?','최근 초기화 원문 보여줘']){
    assert.notEqual(resetQuestionIntent(question).intent,'history',question);
  }
  assert.deepEqual(resetQuestionIntent('오늘 최근 초기화 있니'),{intent:'status',dayOffset:0});
  assert.deepEqual(resetQuestionIntent('어제 최근 초기화 있었니'),{intent:'status',dayOffset:-1});
});
