import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReset,postNotification} from '../src/reset-analysis.js';
import {notificationPayload} from '../src/notification-payload.js';
const post={id:'123',text:'The editor is faster. A new theme is available.',date:'2026-10-26T07:00:00Z'};
const base={status:'unrelated',reset_type:'unknown',type_evidence:'',title_ko:'에디터 성능과 테마 개선',evidence:'',time_expression:'',bullets:['에디터 속도를 개선했습니다.','새 테마를 추가했습니다.']};
const originalFetch=globalThis.fetch;
try{
  await test('한 번의 모델 요청에서 핵심 항목을 받아 기존 요약 필드와 함께 제공한다',async()=>{
    let calls=0;
    globalThis.fetch=async(url,options)=>{
      calls++;const schema=JSON.parse(options.body).generationConfig.responseSchema;
      assert.equal(schema.properties.bullets.type,'ARRAY');assert.equal(schema.properties.bullets.maxItems,4);assert.equal(schema.properties.bullets.minItems,1);
      assert.ok(schema.required.includes('bullets'));assert.equal(schema.properties.summary_ko,undefined);
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(base)}]}}]});
    };
    const result=await analyzeReset({GEMINI_API_KEY:'fixture'},post);
    assert.equal(calls,1);assert.deepEqual(result.bullets,base.bullets);assert.equal(result.summary_ko,base.bullets[0]);
    assert.equal(postNotification(post,result),'**[에디터 성능과 테마 개선](<https://x.com/thsottiaux/status/123>)**\n- 에디터 속도를 개선했습니다.\n- 새 테마를 추가했습니다.\nhttps://x.com/thsottiaux/status/123');
  });
  for(const bullets of [null,{},[],[''],['  '],[12],['a','b','c','d','e'],['x'.repeat(181)]])await test(`잘못된 요약 배열은 알림 전 검증한다: ${JSON.stringify(bullets).slice(0,50)}`,async()=>{
    globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify({...base,bullets})}]}}]});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'fixture'},post),/Invalid summary bullets/);
  });
  await test('중복 항목을 제거하고 한 항목짜리 글을 억지로 늘리지 않는다',async()=>{
    globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify({...base,bullets:['좋습니다.',' 좋습니다. ','좋습니다.']})}]}}]});
    const result=await analyzeReset({GEMINI_API_KEY:'fixture'},post);assert.deepEqual(result.bullets,['좋습니다.']);
    assert.equal(postNotification(post,result).split('\n').filter(line=>line.startsWith('- ')).length,1);
  });
  await test('항목 없는 이전 분석도 기존 한 문장으로 읽는다',async()=>{
    const legacy={...base,summary_ko:'기존 한 문장 요약입니다.'};delete legacy.bullets;
    globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(legacy)}]}}]});
    const result=await analyzeReset({GEMINI_API_KEY:'fixture'},post);assert.match(postNotification(post,result),/\n- 기존 한 문장 요약입니다.\n/);
  });
}finally{globalThis.fetch=originalFetch;}
test('여러 항목의 서식과 링크를 보호하고 원문 URL을 길이 제한 안에 보존한다',()=>{
  const summary={...base,bullets:['*'.repeat(180),'_'.repeat(180),'~'.repeat(180),'['.repeat(180)],title_ko:'*'.repeat(60)};
  const content=postNotification(post,summary);assert.ok(content.length<1900);assert.equal(notificationPayload(content).content,content);assert.ok(content.endsWith('/123'));
  const unsafe=postNotification(post,{...base,bullets:['[가짜](https://evil.invalid)\n<@123>','**위조**']});
  assert.doesNotMatch(unsafe,/evil.invalid/);assert.ok(unsafe.includes('\\<@123\\>'));assert.ok(unsafe.includes('\\*\\*위조\\*\\*'));assert.equal(unsafe.split('\n').length,4);
});
test('여러 항목에도 관련 경고와 검증된 예정 시각만 한 번 표시한다',()=>{
  const content=postNotification(post,{...base,status:'scheduled',title_ko:'저장형 리셋 지급 예정',reset_type:'banked',bullets:['저장형 초기화권을 지급할 예정입니다.','유료 계정이 대상입니다.'],time:{timestamp:Date.parse('2026-10-27T08:00:00Z'),relation:'deadline'}});
  assert.ok(content.startsWith('**## :warning: 초기화 관련 내용 감지 :warning:**'));assert.match(content,/저장형 리셋 지급 예정/);assert.match(content,/10월 27일 17:00까지/);assert.equal(content.split('\n').filter(line=>line.startsWith('- ')).length,2);
});
