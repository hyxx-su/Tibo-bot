import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReset} from '../src/reset-analysis.js';
import {resolveQuoteContext} from '../src/watch-store.js';
import {verifySiteReset} from '../src/site-reset-verification.js';

const date='2026-11-01T06:00:00Z';
const post={id:'300',date,text:'Agreed.',context:[{id:'200',author:'someone',relation:'quote',text:'Usage reset tomorrow at 9am PST.',date}]};
const base={status:'unrelated',reset_type:'unknown',type_evidence:'',title_ko:'앞선 제안에 동의',bullets:['Tibo가 인용된 제안에 동의했다.'],evidence:'',time_expression:''};
const originalFetch=globalThis.fetch;
let output=base;
try{
  globalThis.fetch=async(url,options)=>{
    const input=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
    assert.deepEqual(input.context,post.context);
    return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}]});
  };
  await test('요약 요청에 타인 원문과 작성자·관계를 전달한다',async()=>{
    const result=await analyzeReset({GEMINI_API_KEY:'fixture'},post);
    assert.equal(result.status,'unrelated');assert.deepEqual(result.bullets,base.bullets);
  });
  await test('타인 원문만 초기화 근거로 선택한 모델 결과는 거부한다',async()=>{
    output={...base,status:'scheduled',evidence:'Usage reset',time_expression:'tomorrow at 9am PST'};
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},post),/Reset evidence missing/);
  });
  await test('현재 글의 예정 근거가 있어도 타인의 시각을 환산하지 않는다',async()=>{
    output={...base,status:'scheduled',evidence:'We will reset usage.',time_expression:'tomorrow at 9am PST'};
    const result=await analyzeReset({GEMINI_API_KEY:'fixture'},{...post,text:'We will reset usage.'});
    assert.equal(result.time,null);assert.equal(result.time_expression,'');
  });
  await test('완료가 현재 글에 있어도 타인 문장만으로 유형을 확정하지 않는다',async()=>{
    output={...base,status:'completed',reset_type:'regular',evidence:'Finished.',type_evidence:'Usage reset'};
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},{...post,text:'Finished.'}),/Reset type evidence missing/);
  });
}finally{globalThis.fetch=originalFetch;}

test('타인 인용에는 저장된 Tibo 예고 조회를 추가하지 않는다',async()=>{
  const db={prepare(){throw new Error('Unexpected DB read');}};
  assert.deepEqual(await resolveQuoteContext(db,post),post);
});
test('저장 문맥을 보충해도 타인 작성자를 Tibo로 바꾸지 않는다',async()=>{
  let reads=0;
  const db={prepare(){reads++;return {bind(id){assert.equal(id,'200');return {async first(){return {
    context_json:JSON.stringify([{id:'199',author:'someone',text:'A new theme.',date},{id:'198',text:'Legacy Tibo message.',date}]),analysis_json:null,
  };}};}};}};
  const ownQuote={...post,context:[{...post.context[0],author:'thsottiaux'}]};
  const result=await resolveQuoteContext(db,ownQuote);
  assert.equal(reads,1);assert.equal(result.context[1].author,'someone');assert.equal(result.context[2].author,'thsottiaux');
});
test('사이트의 초록색 완료 알림도 타인 문장의 유형 근거를 거부한다',()=>{
  const event={sourceType:'x_post',type:'regular',announcedAt:date};
  const analysis={status:'completed',reset_type:'regular',evidence:'Finished.',type_evidence:'Usage reset'};
  assert.equal(verifySiteReset(event,{...post,text:'Finished.'},analysis).reason,'type_evidence_missing');
  assert.equal(verifySiteReset(event,{...post,text:'Finished.',context:[{...post.context[0],author:'thsottiaux'}]},analysis).verification,'verified');
});
