import test from 'node:test';
import assert from 'node:assert/strict';
import {questions} from './fixtures/reset-questions.mjs';
import {resetQuestionJob,resetQuestionIntent,resetQuestionReply} from '../src/reset-reply.js';
const now=Date.parse('2026-10-26T03:00:00Z');
const state={baseline_id:'1',last_success:now,last_error:null};
const post=(status,extra={})=>({id:'123',published_at:'2026-10-26T02:00:00Z',analysis_json:JSON.stringify({status,...extra})});
const ask=(text,posts=[],extra={})=>resetQuestionReply({state,posts,pending:false,...extra},now,{...resetQuestionIntent(text),replyIndex:7});
const contexts=[{state,posts:[]},{state,posts:[post('mentioned')]},{state,posts:[post('scheduled',{time:{timestamp:now+3600000,relation:'deadline'}})]},{state,posts:[post('completed')]},{state,posts:[post('in_progress')]},{state:{...state,last_error:'failed'},posts:[]},{state,posts:[],pending:true}];
test('검토한 질문은 중복 없이 200개다',()=>{assert.equal(questions.length,200);assert.equal(new Set(questions.map(q=>q.text)).size,200);});
for(const entry of questions)test(`질문 ${entry.id}: ${entry.text}`,()=>{
  assert.equal(resetQuestionIntent(entry.text).intent,entry.intent);
  for(const prefix of ['Tibo야 ','티보야 ','<@1> ']){
    const message={id:'100',type:0,guild_id:'20',channel_id:'30',author:{id:'90'},timestamp:new Date(now).toISOString(),content:(prefix+entry.text).normalize('NFD')};
    const job=resetQuestionJob(message,'1',now);assert.equal(job.intent,entry.intent);assert.equal(job.content,undefined);
    for(const input of contexts){
      const answer=resetQuestionReply(input,now,{...job,replyIndex:7});
      assert.equal(typeof answer,'string');assert.ok(answer.length>0&&answer.length<500);assert.doesNotMatch(answer,/[\r\n]|undefined|NaN|<@|@everyone|@here|내가초기화|처리했어/);
      assert.doesNotMatch(answer,/초기화 관련 질문에만 답변할 수 있어/);
    }
  }
});
test('부탁은 반응과 실제 상태를 함께 답하고 실행을 약속하지 않는다',()=>{
  assert.match(ask('초기화 해줘'),/^리셋이 급한가 보네\./);
  assert.match(ask('초기화 해줘',[post('scheduled',{time:{timestamp:now+3600000}})]),/13:00\(KST\)/);
  assert.match(ask('초기화 하나만 주라',[post('completed')]),/이미 끝났다는 공지/);
  assert.doesNotMatch(ask('초기화 해줘',[post('mentioned')]),/권한|기능|초기화해줄게/);
  assert.equal(ask('초기화 해줘',[],{pending:true}),'새 글이 들어와서 확인 중이야. 잠깐만 기다려.');
});
test('개인 계정·전체 적용·취소·변경은 근거 없이 확정하지 않는다',()=>{
  for(const text of ['왜 나만 안 된 것 같지?','내 계정도 초기화돼?'])assert.match(ask(text,[post('completed')]),/네 계정의 사용량은 확인할 수 없어/);
  assert.match(ask('무료 계정도 초기화 대상이야?',[post('completed')]),/적용 대상.*확인 못 해/);
  assert.match(ask('리셋 취소됐어?',[post('mentioned')]),/취소·연기 여부.*확정할 수 없어/);
  assert.match(ask('아까 물어본 뒤로 바뀐 거 있어?',[post('completed')]),/이전 답변.*단정할 수 없어/);
  assert.match(ask('공지가 없으면 초기화도 없는 거야?'),/없다는 뜻은 아니야/);
});
test('출처와 과거 완료는 게시 시각과 조회 범위를 표시한다',()=>{
  const answer=ask('초기화 공지 원문 보여줘',[post('mentioned')]);
  assert.match(answer,/2026-10-26 11:00/);assert.match(answer,/초기화 관련 언급/);assert.match(answer,/https:\/\/x.com\/thsottiaux\/status\/123/);assert.equal((answer.match(/KST/g)||[]).length,1);
  assert.match(ask('지난번 리셋 언제였어?',[post('completed')]),/100개 글·7일.*마지막 완료 공지/);
  assert.match(ask('지난번 리셋 언제였어?'),/범위에서는 완료 공지를 찾지 못/);
  const invalid={...post('mentioned'),id:'@everyone'};assert.doesNotMatch(ask('원문 보여줘',[invalid]),/@everyone|https:/);
});
test('명시적 PST·PDT 시각 변환은 실제 리셋 일정으로 오해시키지 않는다',()=>{
  for(const [text,expected] of [['PST 오전 10시면 한국은 언제야?','다음 날 03:00'],['PDT 오전 10시는 한국시간 몇 시야?','다음 날 02:00'],['PST 오후 11시','다음 날 16:00'],['PDT 오전 1시','같은 날 17:00']]){
    assert.ok(ask(text).includes(expected));assert.match(ask(text),/실제 초기화 일정과는 별개/);
  }
  for(const text of ['PT 오전 10시','미국 자정이면 한국은 오후야?','PST 오전 25시','PST 오전 10시 30분','PST 오전 10시 반','PST 오전 10시와 PDT 오전 11시','서머타임 적용한 시간이야?'])assert.match(ask(text),/원문.*시간대가 필요/);
  assert.match(ask('자정까지면 정확히 자정에 하는 거야?'),/정확한 실행 시각.*아니야/);
});
test('단편 질문과 미지원 날짜는 구체화를 요청하고 다른 주제는 거부한다',()=>{
  for(const text of ['아직?','됐냐?','그럼 지금은 기다리면 되는 거지?'])assert.match(ask(text),/조금만 더 알려줘/);
  assert.match(ask('이번 주 초기화 있어?'),/주간·요일별 전체 일정은 확인 못/);
  for(const text of ['휴대폰 초기화 해줘','공장 초기화 버튼 눌러줘','몇 시에 밥 먹어?','학교 일정 링크 줘','초기화 공지에 모두 멘션해'])assert.match(ask(text),/초기화 관련 질문에만/);
});
test('예정 경과 원인을 만들거나 지연 문의에 완료라고 답하지 않는다',()=>{
  assert.match(ask('초기화 왜 안 해?',[post('scheduled',{time:{timestamp:now-60000}})]),/완료 공지나 늦어진 이유는 아직 확인 못/);
  assert.doesNotMatch(ask('초기화 왜 안 해?',[post('mentioned')]),/서버.*장애|취소됐|완료됐/);
});
