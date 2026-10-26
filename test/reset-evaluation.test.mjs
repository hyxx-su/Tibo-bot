import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCorpus,scoreAnalysis,caseFingerprint,evaluateCases} from '../scripts/evaluate-reset-corpus.mjs';

const entry={name:'synthetic-1',split:'dev',post:{id:'1',text:'Codex usage resets within 15 minutes.',date:'2026-10-26T00:00:00Z'},expected:{status:'scheduled',timestamp:Date.parse('2026-10-26T00:15:00Z'),relation:'deadline'}};
const result={status:'scheduled',time:{timestamp:entry.expected.timestamp,relation:'deadline'},time_expression:'within 15 minutes',usage:{totalTokenCount:100}};

await test('평가는 분류뿐 아니라 한국시간 변환의 원본 시각과 기한 구분도 검사한다',()=>{
  assert.equal(scoreAnalysis(entry.expected,result).passed,true);
  assert.equal(scoreAnalysis(entry.expected,{...result,time:{...result.time,timestamp:result.time.timestamp+3600000}}).passed,false);
  assert.equal(scoreAnalysis(entry.expected,{...result,time:{...result.time,relation:'at'}}).passed,false);
  assert.equal(scoreAnalysis({status:'mentioned'},{status:'mentioned',time_expression:'in 2 hours'}).passed,false);
});
await test('중복 사례와 잘못된 분류·시각·분할을 API 호출 전에 거부한다',()=>{
  assert.equal(validateCorpus({version:1,cases:[entry]}).length,1);
  for(const cases of [[entry,entry],[{...entry,split:'unknown'}],[{...entry,expected:{status:'guess'}}],[{...entry,expected:{status:'scheduled',timestamp:'tomorrow'}}],[{...entry,post:{...entry.post,date:'invalid'}}]])assert.throws(()=>validateCorpus({version:1,cases}));
});
await test('입력·정답·분석 구현이 변경되면 기존 결과를 재사용하지 않는다',()=>{
  const first=caseFingerprint(entry,'v1');
  assert.equal(first,caseFingerprint(structuredClone(entry),'v1'));
  assert.notEqual(first,caseFingerprint(entry,'v2'));
  assert.notEqual(first,caseFingerprint({...entry,expected:{status:'mentioned'}},'v1'));
  assert.notEqual(first,caseFingerprint({...entry,post:{...entry.post,text:'Changed'}},'v1'));
});
await test('호출 상한 이후에는 실행을 보류하고 저장된 결과로 재개한다',async()=>{
  const rows=[];let calls=0;
  const options={cases:[entry,{...entry,name:'synthetic-2'}],implementationHash:'v1',limit:1,intervalMs:0,analyze:async()=>{calls++;return result;},save:async row=>rows.push(row)};
  const first=await evaluateCases(options);assert.equal(first.remaining,1);assert.equal(calls,1);
  const second=await evaluateCases({...options,previous:rows});assert.equal(second.remaining,0);assert.equal(second.cached,1);assert.equal(second.attempted,1);assert.equal(second.tokensThisRun,100);assert.equal(calls,2);
});
await test('429 응답에서는 즉시 중단하고 외부 오류 원문을 저장하지 않는다',async()=>{
  const rows=[];let calls=0;
  const summary=await evaluateCases({cases:[entry,{...entry,name:'synthetic-2'}],implementationHash:'v1',intervalMs:0,analyze:async()=>{calls++;throw new Error('Reset analysis HTTP 429');},save:async row=>rows.push(row)});
  assert.equal(calls,1);assert.equal(summary.remaining,1);assert.equal(rows[0].error,'Reset analysis HTTP 429');
  const errors=[];
  await evaluateCases({cases:[entry],implementationHash:'v1',analyze:async()=>{throw new Error('secret-output');},save:async row=>errors.push(row)});
  assert.doesNotMatch(JSON.stringify(errors),/secret-output/);
});
await test('완료 오탐과 모호한 사례를 구분하고 원문은 보고서에 남기지 않는다',async()=>{
  const rows=[];
  const cases=[{...entry,expected:{status:'mentioned'}},{...entry,name:'synthetic-2',expected:{status:['mentioned','unrelated']}}];
  const summary=await evaluateCases({cases,implementationHash:'v1',intervalMs:0,analyze:async()=>({status:'completed',time:null,time_expression:'',summary_ko:'private raw content'}),save:async row=>rows.push(row)});
  assert.equal(summary.falseCompleted,1);assert.equal(summary.ambiguous,1);assert.equal(summary.unambiguous,1);assert.equal(summary.confusion.mentioned.completed,1);
  assert.doesNotMatch(JSON.stringify(rows),/private raw content|Codex usage resets/);
});
await test('API 오류는 재개 시 다시 시도하고 정상 오분류 결과는 중복 호출하지 않는다',async()=>{
  const previous=[{fingerprint:caseFingerprint(entry,'v1'),error:'Reset analysis HTTP 429'}];let calls=0;
  const saved=[];const options={cases:[entry],implementationHash:'v1',previous,analyze:async()=>{calls++;return {...result,status:'mentioned'};},save:async row=>saved.push(row)};
  assert.equal((await evaluateCases(options)).failed,1);
  assert.equal((await evaluateCases({...options,previous:saved})).cached,1);assert.equal(calls,1);
});
