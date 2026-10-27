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
  const input={state:{baseline_id:'1',last_success:now},pending:false,posts:[],siteResets:[{reset_type:'regular',announced_at:'2026-10-26T07:00:00Z',original_url:'https://x.com/thsottiaux/status/100'}]};
  const result=resetQuestionReply(input,now,job);
  assert.match(result,/2026-10-26 16:00/);
  assert.match(result,/정기 리셋 실행 기록/);
  assert.doesNotMatch(result,/오늘.*(?:없|못|미확인)/);
  assert.doesNotMatch(resetQuestionReply({...input,siteResets:[{...input.siteResets[0],reset_type:'banked'}]},now,job),/정기 리셋 실행 기록/);
});
