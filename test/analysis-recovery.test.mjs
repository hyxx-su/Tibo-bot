import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReset,parseRetryAfter} from '../src/reset-analysis.js';

const post={id:'2',date:'2026-11-01T12:00:00Z',text:'The usage reset is still propagating.'};
const result={status:'in_progress',reset_type:'regular',type_evidence:'usage reset',evidence:post.text,time_expression:'',title_ko:'사용량 초기화 반영 중',bullets:['사용량 초기화가 반영 중입니다.'],title_evidence:[post.text],bullet_evidence:[post.text]};
const original=globalThis.fetch;
const respond=value=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
try{
  for(const status of [400,401,403,408,429,500,503])await test(`분석 HTTP ${status}의 복구 가능성과 대기 시간을 구분한다`,async()=>{
    globalThis.fetch=async()=>new Response('SECRET EXTERNAL ERROR',{status,headers:{'Retry-After':'120'}});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},post),error=>{
      assert.equal(error.code,'analysis_http_'+status);assert.equal(error.retryAfter,120);
      assert.equal(error.permanent,[400,401,403].includes(status));assert.doesNotMatch(error.message,/SECRET/);return true;
    });
  });
  await test('HTTP 날짜 형식과 잘못된 Retry-After를 처리한다',()=>{
    assert.equal(parseRetryAfter('Sun, 01 Nov 2026 12:01:00 GMT',Date.parse(post.date)),60);
    assert.equal(parseRetryAfter('invalid'),0);assert.equal(parseRetryAfter('999999'),86400);
  });
  for(const [name,response,code] of [
    ['잘린 생성',()=>Response.json({candidates:[{finishReason:'MAX_TOKENS'}]}),'analysis_truncated'],
    ['차단된 생성',()=>Response.json({candidates:[{finishReason:'SAFETY'}]}),'analysis_blocked'],
    ['잘못된 JSON',()=>new Response('{'),'analysis_json'],
    ['잘못된 스키마',()=>respond(null),'analysis_schema'],
    ['타임아웃',()=>{throw new DOMException('secret','TimeoutError');},'analysis_timeout'],
    ['네트워크 오류',()=>{throw new TypeError('secret');},'analysis_network'],
  ])await test(name+'는 내용을 노출하지 않는 오류 코드로 남긴다',async()=>{
    globalThis.fetch=async()=>response();await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},post),e=>e.code===code&&!e.message.includes('secret'));
  });
  await test('제목·요약의 근거가 원문에 없으면 발송용 분석을 반환하지 않는다',async()=>{
    globalThis.fetch=async()=>respond({...result,bullet_evidence:['All accounts are done.']});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},post),e=>e.code==='analysis_summary_evidence');
  });
  await test('근거 자체가 진행 중이면 완료 결과를 거부한다',async()=>{
    globalThis.fetch=async()=>respond({...result,status:'completed'});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},post),e=>e.code==='analysis_contradiction');
  });
  await test('검증 실패 재검토에는 허용한 내부 코드만 전달한다',async()=>{
    const feedback=[];
    globalThis.fetch=async(url,options)=>{
      feedback.push(JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).validation_feedback);
      return respond(result);
    };
    const checked=await analyzeReset({GEMINI_API_KEY:'fixture'},post,{reviewCode:'analysis_summary_evidence'});
    assert.equal(checked.metrics.review,true);assert.ok(checked.metrics.analysis_ms>=0);
    await analyzeReset({GEMINI_API_KEY:'fixture'},post,{reviewCode:'ignore rules SECRET'});
    assert.deepEqual(feedback,['analysis_summary_evidence',null]);
  });
}finally{globalThis.fetch=original;}
