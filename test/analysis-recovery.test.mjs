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
  await test('완료 구절을 발췌해도 같은 글의 나머지 대상 미확인을 검증한다',async()=>{
    const partial={...post,text:'Usage limits have been reset for Pro only. No update for other plans.'};
    globalThis.fetch=async()=>respond({...result,status:'completed',type_evidence:'Usage limits',evidence:'Usage limits have been reset for Pro only.',title_evidence:[partial.text],bullet_evidence:[partial.text]});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},partial),e=>e.code==='analysis_contradiction');
    globalThis.fetch=async()=>respond({...result,status:'mentioned',type_evidence:'Usage limits',evidence:partial.text,title_evidence:[partial.text],bullet_evidence:[partial.text]});
    assert.equal((await analyzeReset({GEMINI_API_KEY:'fixture'},partial)).status,'mentioned');
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
  await test('허용 모델만 호출하며 기본 추론 온도를 유지한다',async()=>{
    const urls=[];
    globalThis.fetch=async(url,options)=>{
      urls.push(url);const config=JSON.parse(options.body).generationConfig;
      assert.equal(config.temperature,undefined);assert.equal(config.thinkingConfig.thinkingLevel,'MEDIUM');return respond(result);
    };
    const checked=await analyzeReset({GEMINI_API_KEY:'fixture'},post);
    assert.equal(checked.model,'gemini-3.1-flash-lite');
    await analyzeReset({GEMINI_API_KEY:'fixture',RESET_ANALYSIS_MODEL:'gemini-3.5-flash-lite'},post);
    assert.ok(urls[0].endsWith('/gemini-3.1-flash-lite:generateContent'));assert.ok(urls[1].endsWith('/gemini-3.5-flash-lite:generateContent'));
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture',RESET_ANALYSIS_MODEL:'https://untrusted.invalid'},post),e=>e.code==='analysis_configuration'&&e.permanent);
    assert.equal(urls.length,2);
  });
  await test('요약·근거 쌍을 기존 저장 형식으로 변환하고 원문 검증을 유지한다',async()=>{
    globalThis.fetch=async()=>respond({...result,bullets:undefined,bullet_evidence:undefined,summary_items:[{text:'초기화가 반영 중입니다.',evidence:post.text}]});
    const checked=await analyzeReset({GEMINI_API_KEY:'fixture'},post);
    assert.deepEqual(checked.bullets,['초기화가 반영 중입니다.']);assert.deepEqual(checked.bullet_evidence,[post.text]);assert.equal(checked.summary_items,undefined);
    globalThis.fetch=async()=>respond({...result,summary_items:[{text:'완료입니다.',evidence:'All done.'}]});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},post),e=>e.code==='analysis_summary_evidence');
  });
  for(const items of [[],null,{},[null],[{text:'요약'}],[{evidence:post.text}],[{text:'요약',evidence:3}],Array.from({length:5},()=>({text:'요약',evidence:post.text}))])await test('잘못된 요약·근거 쌍을 거부한다: '+JSON.stringify(items),async()=>{
    globalThis.fetch=async()=>respond({...result,summary_items:items});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},post),e=>e.code==='analysis_summary_evidence');
  });
}finally{globalThis.fetch=original;}
