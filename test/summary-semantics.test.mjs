import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisInput,analyzeReset,summaryReviewTargets} from '../src/reset-analysis.js';
const date='2026-11-01T06:00:00Z';
const post={id:'2',date,text:'Nova is eternal.',context:[{id:'1',author:'reader',relation:'thread',text:'Please release a new model.'}]};
const base={status:'unrelated',reset_type:'unknown',type_evidence:'',title_ko:'Nova에 대한 언급',summary_items:[{text:'Nova는 영원하다.',evidence:'Nova is eternal.'}],title_evidence:['Nova is eternal.'],evidence:'',time_expression:''};
const envelope=(value,usage={promptTokenCount:100,candidatesTokenCount:50,thoughtsTokenCount:20,totalTokenCount:170})=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:usage});

test('문맥 없는 글의 빈 필드와 수집 부가정보를 보내지 않는다',()=>{
  assert.deepEqual(analysisInput({...post,context:[],hasMedia:true,repost:false}),{id:'2',author:'thsottiaux',date,text:post.text});
});
test('작성자·인용 관계·날짜가 다른 문맥은 보존하고 동일 자료만 제거한다',()=>{
  const source={id:'1',author:'reader',date,text:'My announcement.',relation:'quote',via:'2'};
  const context=analysisInput({...post,context:[source,{...source,hasMedia:true},{...source,relation:'thread'},{...source,author:'another'},{...source,text:'Updated announcement.'}]}).context;
  assert.equal(context.length,4);assert.deepEqual(context[0],source);
});
test('단순 칭찬만으로 모든 답글을 추가 검토하지 않는다',()=>{
  assert.deepEqual(summaryReviewTargets({...post,text:'Nice work!'}, {title_ko:'잘했어!',bullets:['상대의 작업을 칭찬했다.']}),[]);
});
test('짧은 답글의 말뜻 대신 반응 게시라고만 쓴 제목은 검토한다',()=>{
  assert.deepEqual(summaryReviewTargets({text:'Sounds like bliss'},{title_ko:'댓글에 대한 반응 게시',bullets:['좋게 들린다는 반응이다.']}).map(target=>target.field),['title_ko']);
});
test('짧은 반응 대신 문맥의 과거 질문을 요약하면 현재 말뜻을 복원한다',()=>{
  const result={title_ko:'더없이 좋게 들리네',bullets:['Tibo가 모델 외 개선점을 요청했다.']};
  assert.deepEqual(summaryReviewTargets({text:'Sounds like bliss'},result).map(target=>target.field),['bullet_0']);
  assert.equal(summaryReviewTargets({...post,text:'Nova forever'},{title_ko:'Nova는 영원하다',bullets:['새로운 모델이 필요하다는 글에 답했다.']})[0].field,'bullet_0');
});
test('경력 발표 작성자와 축하 대상을 혼동하기 쉬운 경우만 주체 재검토한다',()=>{
  const current={...post,text:'Congrats to Morgan',context:[{author:'casey',text:'I am joining Example Labs.',relation:'thread'}]};
  assert.deepEqual(summaryReviewTargets(current,{title_ko:'Morgan에게 축하 인사',bullets:['Morgan의 Example Labs 합류를 축하했다.']}).map(target=>target.field),['bullet_0']);
});
test('경력 문맥이 있어도 답변이 명시적인 축하 인사뿐이면 추가 검토하지 않는다',()=>{
  const current={...post,text:'Congrats to Morgan',context:[{author:'casey',text:'I am joining Example Labs.',relation:'thread'}]};
  assert.deepEqual(summaryReviewTargets(current,{title_ko:'Morgan에게 축하 인사',bullets:['Tibo가 Morgan에게 축하를 전했다.']}),[]);
});
test('불확실성과 제외 조건이 사라진 필드만 선택한다',()=>{
  const uncertain=summaryReviewTargets({...post,text:'Might be.'},{title_ko:'그렇다고 확인',bullets:['그럴 수도 있다고 답했다.']});
  assert.deepEqual(uncertain.map(t=>t.field),['title_ko']);
  const excluded=summaryReviewTargets({...post,text:'How can we improve Codex? Try not to say model.'},{title_ko:'Codex 모델 개선 의견 요청',bullets:['모델 외에 개선할 점을 요청했다.']});
  assert.deepEqual(excluded.map(t=>t.field),['title_ko']);
  assert.deepEqual(summaryReviewTargets({...post,text:'How can we improve Codex? Try not to say model.'},{title_ko:'Codex 개선 의견 요청',bullets:['모델 관련 개선 답변은 배제해 달라고 요청했다.']}),[]);
});
test('제품명 오역과 구호의 사용 의사 확대를 재검토한다',()=>{
  assert.equal(summaryReviewTargets({...post,text:'Improve Codex, not the model.'},{title_ko:'코드 개선 제안',bullets:[]})[0].codes[0],'product_identity');
  const result=summaryReviewTargets({...post,text:'Nova forever'},{title_ko:'Nova 영원히 언급',bullets:['Nova를 영원히 유지하겠다는 뜻이다.']});
  assert.equal(result.length,2);assert.ok(result.every(target=>target.codes.includes('slogan_intent')));
});
test('원문에 실제 사용 의사나 출시 계획 부재가 있으면 의심 표현으로 오인하지 않는다',()=>{
  assert.deepEqual(summaryReviewTargets({text:'I will use Nova forever.'},{title_ko:'Nova를 영원히 사용할 계획',bullets:['Nova를 영원히 사용할 것이라고 밝혔다.']}),[]);
  assert.deepEqual(summaryReviewTargets({text:'We have no plans to launch. No release date has been announced.'},{title_ko:'출시 계획 없음',bullets:[]}),[]);
  assert.equal(summaryReviewTargets({text:'We are not launching tomorrow. No release date has been announced.'},{title_ko:'새 모델 출시 및 출시일 발표 계획 없음',bullets:[]})[0].codes[0],'unannounced_plan');
});
test('문맥 없는 불특정 캐릭터를 작성자 자신으로 바꾸면 검토한다',()=>{
  const targets=summaryReviewTargets({text:'Lore accurate character.'},{title_ko:'설정에 충실한 캐릭터',bullets:['자신이 설정과 잘 맞는 캐릭터라고 말했다.']});
  assert.deepEqual(targets.map(target=>target.field),['bullet_0']);
  assert.deepEqual(summaryReviewTargets({text:'I am playing myself.'},{title_ko:'자신을 연기함',bullets:[]}),[]);
});
test('정확한 상대 시각을 기한으로 바꾼 필드만 재검토한다',()=>{
  const result={title_ko:'2시간 내 초기화',bullets:['2시간 후 초기화한다.'],time_expression:'in 2 hours'};
  assert.deepEqual(summaryReviewTargets({text:'Usage will reset in 2 hours.'},result).map(target=>target.field),['title_ko']);
  assert.deepEqual(summaryReviewTargets({text:'Usage will reset within 2 hours.'},{...result,time_expression:'within 2 hours'}),[]);
});
const original=globalThis.fetch;
try{
  await test('의심 제목만 수정하며 초기화 판별과 정상 요약은 유지하고 두 호출 사용량을 합산한다',async()=>{
    const requests=[];let reservations=0;
    globalThis.fetch=async(url,options)=>{
      const body=JSON.parse(options.body);requests.push(body);
      return requests.length===1?envelope(base):envelope({replacements:[{field:'title_ko',text:'Nova는 영원하다',evidence:post.text}]});
    };
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},post,{reserveReview:async()=>{reservations++;return true;}});
    assert.equal(result.title_ko,'Nova는 영원하다');assert.deepEqual(result.bullets,['Nova는 영원하다.']);assert.equal(result.status,'unrelated');
    assert.equal(result.metrics.calls,2);assert.equal(reservations,1);assert.equal(result.usage.totalTokenCount,340);
    assert.equal(result.usage.promptTokenCount,200);assert.equal(result.usage.thoughtsTokenCount,40);
    const repair=JSON.parse(requests[1].contents[0].parts[0].text);
    assert.deepEqual(Object.keys(repair.draft),['title_ko']);assert.equal(requests[1].generationConfig.responseSchema.properties.status,undefined);
  });
  await test('부분 검토의 서로 다른 작성자 근거를 합성하지 않고 각각 검증해 보존한다',async()=>{
    const current={id:'2',date,text:'Congrats to Morgan',context:[{author:'casey',text:'I am joining Example Labs.'}]};let calls=0;
    const repaired='Example Labs 입사를 발표한 casey의 글에 Tibo는 Morgan에게 축하를 전했다.';
    globalThis.fetch=async()=>++calls===1?envelope({...base,title_ko:'축하 인사',title_evidence:[current.text],summary_items:[{text:'Morgan의 입사를 축하했다.',evidence:current.text}]}):envelope({replacements:[{field:'bullet_0',text:repaired,evidence:[current.context[0].text,current.text]}]});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.deepEqual(result.summary_review_evidence,[{text:repaired,quotes:[current.context[0].text,current.text]}]);
    assert.deepEqual(result.summary_evidence,[{text:repaired,quotes:[current.context[0].text,current.text]}]);
    assert.equal(typeof result.bullet_evidence[0],'string');assert.equal(result.metrics.calls,2);
  });
  await test('최초 요약부터 현재 답글과 상대 질문의 근거를 각각 검증한다',async()=>{
    const current={id:'2',date,text:'Might be.',context:[{author:'reader',text:'Is a new model arriving tomorrow?'}]};
    const value={...base,title_ko:'새 모델 출시 가능성',title_evidence:[current.text],summary_items:[{text:'내일 새 모델이 나오는지 묻자 그럴 수도 있다고 답했다.',evidence:[current.context[0].text,current.text]}]};
    globalThis.fetch=async()=>envelope(value);
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.equal(result.metrics.calls,1);assert.deepEqual(result.summary_evidence[0].quotes,[current.context[0].text,current.text]);assert.equal(typeof result.bullet_evidence[0],'string');
    globalThis.fetch=async()=>envelope({...value,summary_items:[{...value.summary_items[0],evidence:[current.text,'Invented source.']}]});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},current),e=>e.code==='analysis_summary_evidence');
  });
  for(const [text,title,bullet,expected] of [
    ['Nova forever','Nova에 대한 언급','Nova를 계속 사용하겠다는 의사다.',/영원히/],
    ['Might be.','그렇다고 확인','새 모델이 출시된다고 확정했다.',/수도/],
    ['Sounds like bliss','댓글에 대한 반응 게시','모델 외 개선점을 요청했다.',/좋게/],
  ])await test(`완결된 짧은 표현의 오류는 추가 AI 없이 교정: ${text}`,async()=>{
    let calls=0;globalThis.fetch=async()=>{calls++;return envelope({...base,title_ko:title,title_evidence:[text],summary_items:[{text:bullet,evidence:[text]}]});};
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},{id:'2',date,text});
    assert.match(result.title_ko,expected);assert.match(result.summary_ko,expected);assert.equal(calls,1);assert.equal(result.metrics.summary_review,false);
  });
  await test('짧은 표현의 정상 문맥 요약은 직접 번역으로 덮어쓰지 않는다',async()=>{
    const current={id:'2',date,text:'Might be.',context:[{author:'reader',text:'Will a new model arrive tomorrow?'}]};
    const summary='내일 새 모델이 나오는지 묻는 질문에 그럴 수도 있다고 답했다.';
    globalThis.fetch=async()=>envelope({...base,title_ko:'새 모델 출시 가능성',title_evidence:[current.text],summary_items:[{text:summary,evidence:[current.context[0].text,current.text]}]});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);assert.equal(result.summary_ko,summary);assert.equal(result.metrics.calls,1);
  });
  for(const [text,title] of [['That tracks.','말이 되네'],['Exactly!','바로 그거야'],['Lore accurate character.','원래 설정에 충실한 캐릭터']])await test(`문맥 없는 관용 표현 제목: ${text}`,async()=>{
    globalThis.fetch=async()=>envelope({...base,title_ko:'동의의 글',title_evidence:[text],summary_items:[{text:'원문의 의미를 설명합니다.',evidence:text}]});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},{id:'2',date,text});assert.equal(result.title_ko,title);assert.equal(result.metrics.calls,1);
  });
  await test('명시적 사용량 초기화 질문에서만 누락 근거를 보완한다',async()=>{
    const current={id:'2',date,text:'Has the Codex usage reset finished yet?'};
    globalThis.fetch=async()=>envelope({...base,status:'mentioned',title_ko:'사용량 초기화 완료 여부 질문',title_evidence:[current.text],summary_items:[{text:'사용량 초기화가 끝났는지 물었다.',evidence:current.text}],evidence:''});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.equal(result.status,'mentioned');assert.equal(result.evidence,current.text);assert.equal(result.metrics.calls,1);
    const unrelated={...current,text:'Is the device reset finished yet?'};
    globalThis.fetch=async()=>envelope({...base,status:'mentioned',title_ko:'기기 초기화 질문',title_evidence:[unrelated.text],summary_items:[{text:'기기 초기화가 끝났는지 물었다.',evidence:unrelated.text}],evidence:''});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},unrelated),error=>error.code==='analysis_evidence');
  });
  await test('관용 표현 사전의 상속 속성을 제목으로 사용하지 않는다',async()=>{
    const text='constructor';
    globalThis.fetch=async()=>envelope({...base,title_ko:'constructor',title_evidence:[text],summary_items:[{text:'constructor라고 썼다.',evidence:text}]});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},{id:'2',date,text});
    assert.equal(result.title_ko,'constructor');assert.equal(result.metrics.calls,1);
  });
  await test('명시적 축하 대상의 소유격 오역을 교정하고 짧은 반응은 한 항목만 유지한다',async()=>{
    const current={id:'2',date,text:'Congrats to Morgan'};
    globalThis.fetch=async()=>envelope({...base,title_ko:'Morgan의 축하 메시지',title_evidence:[current.text],summary_items:[{text:'Morgan에게 축하를 전했다.',evidence:current.text},{text:'축하 메시지를 남겼다.',evidence:current.text}]});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.equal(result.title_ko,'Morgan에게 축하 인사');assert.deepEqual(result.bullets,['Morgan에게 축하를 전했다.']);assert.equal(result.metrics.calls,1);
  });
  await test('타인만 있는 문맥의 출처 질문은 자신의 초기화 공지로 사용하지 않는다',async()=>{
    const current={id:'2',date,text:'Where did you see that?',context:[{author:'reader',text:'All usage counters have been reset!'}]};
    globalThis.fetch=async()=>envelope({...base,status:'mentioned',title_ko:'초기화 주장 출처 질문',title_evidence:[current.text],summary_items:[{text:'상대에게 주장을 어디서 보았는지 물었다.',evidence:current.text}],evidence:current.text});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.equal(result.status,'unrelated');assert.equal(result.reset_type,'unknown');assert.equal(result.metrics.calls,1);
    const own=await analyzeReset({GEMINI_API_KEY:'synthetic'},{...current,context:[{...current.context[0],author:'thsottiaux'}]});
    assert.equal(own.status,'mentioned');
  });
  await test('감사 인사만 있는 답글에 과거 초기화 완료를 복사하지 않는다',async()=>{
    const current={id:'2',date,text:'Thanks!',context:[{text:'The usage reset is complete.'}]};
    globalThis.fetch=async()=>envelope({...base,status:'completed',reset_type:'regular',type_evidence:'usage reset',title_ko:'초기화 완료',title_evidence:[current.text],summary_items:[{text:'초기화가 완료되었다.',evidence:current.text}],evidence:current.text});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.equal(result.status,'unrelated');assert.equal(result.title_ko,'고마워!');assert.equal(result.summary_ko,'고맙다는 인사를 전했다.');assert.equal(result.metrics.calls,1);
    const explicit=await analyzeReset({GEMINI_API_KEY:'synthetic'},{...current,text:'Thanks! The usage reset is complete.'});
    assert.equal(explicit.status,'completed');
  });
  await test('저장형 지급의 분수 표기를 총수량이나 지급 단계로 확대하지 않는다',async()=>{
    const current={id:'2',date,text:'Banked 2/3'};
    globalThis.fetch=async()=>envelope({...base,status:'completed',reset_type:'banked',type_evidence:'Banked',title_ko:'초기화권 3개 중 2번째 지급',title_evidence:[current.text],summary_items:[{text:'총 3개 중 2번째 지급을 마쳤다.',evidence:[current.text]}],evidence:current.text});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.equal(result.status,'completed');assert.match(result.title_ko,/2\/3/);assert.doesNotMatch(result.summary_ko,/총|개|번째|단계|절반/);assert.equal(result.metrics.calls,1);
    assert.deepEqual(result.summary_evidence[0],{text:result.summary_ko,quotes:[current.text]});
  });
  await test('명사형 초기화 언급의 누락 근거를 보완하되 실행 상태를 주장한 문장은 검토한다',async()=>{
    const current={id:'2',date,text:'We are working on improvements, and reset. Enjoy!'};let calls=0;
    globalThis.fetch=async()=>++calls===1?envelope({...base,status:'mentioned',title_ko:'개선 작업과 초기화 언급',title_evidence:[current.text],summary_items:[{text:'개선 작업과 초기화가 진행 중이다.',evidence:current.text}],evidence:''}):envelope({replacements:[{field:'bullet_0',text:'개선 작업을 하고 있으며 초기화도 언급했다.',evidence:current.text}]});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.equal(result.status,'mentioned');assert.equal(result.evidence,current.text);assert.equal(result.metrics.calls,2);assert.equal(result.summary_ko,'개선 작업을 하고 있으며 초기화도 언급했다.');
  });
  await test('사용량 초기화 취소의 누락 근거만 원문으로 보완하고 실행 공지로 바꾸지 않는다',async()=>{
    const current={id:'2',date,text:'The planned Codex usage reset is cancelled. There is no new date.'};
    globalThis.fetch=async()=>envelope({...base,status:'mentioned',title_ko:'사용량 초기화 계획 취소',title_evidence:[current.text],summary_items:[{text:'초기화 계획을 취소했으며 새 날짜는 없다.',evidence:[current.text]}],evidence:''});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.equal(result.evidence,current.text);assert.equal(result.status,'mentioned');assert.equal(result.time,null);assert.equal(result.metrics.calls,1);
  });
  await test('중복 제거 뒤 요약과 근거의 인덱스가 어긋나지 않는다',async()=>{
    const current={...post,text:'First fact. Second fact.'};
    globalThis.fetch=async()=>envelope({...base,title_ko:'두 가지 소식',title_evidence:['First fact.'],summary_items:[{text:'첫 사실입니다.',evidence:'First fact.'},{text:'첫 사실입니다.',evidence:'First fact.'},{text:'두 번째 사실입니다.',evidence:'Second fact.'}]});
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.deepEqual(result.bullets,['첫 사실입니다.','두 번째 사실입니다.']);assert.deepEqual(result.bullet_evidence,['First fact.','Second fact.']);
  });
  await test('같은 원문의 순서가 확인되는 생략 인용만 복원한다',async()=>{
    const first='The editor is released.',last='The API stays unchanged.',current={id:'2',date,text:first+' It supports Linux. '+last};
    const value={...base,title_ko:'에디터 출시 및 API 유지',title_evidence:[first],summary_items:[{text:'에디터를 출시했고 API는 유지된다.',evidence:first+'... '+last}]};
    globalThis.fetch=async()=>envelope(value);
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.deepEqual(result.bullet_evidence,[current.text]);assert.equal(result.metrics.calls,1);
    globalThis.fetch=async()=>envelope({...value,summary_items:[{text:'에디터를 출시했고 API는 유지된다.',evidence:first+' '+last}]});
    const sentences=await analyzeReset({GEMINI_API_KEY:'synthetic'},current);
    assert.deepEqual(sentences.bullet_evidence,[current.text]);
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},{...current,text:first,context:[{author:'reader',text:last}]}),e=>e.code==='analysis_summary_evidence');
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},{...current,text:last+' '+first}),e=>e.code==='analysis_summary_evidence');
  });
  await test('기본 분석이 지연되면 추가 검토를 시작하거나 일일 예산을 쓰지 않는다',async()=>{
    const originalNow=Date.now;let clock=100000,calls=0,reserved=0;Date.now=()=>clock;
    try{
      globalThis.fetch=async()=>{calls++;clock+=44500;return envelope(base);};
      await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},post,{reserveReview:async()=>{reserved++;return true;}}),error=>error.code==='analysis_timeout');
      assert.equal(calls,1);assert.equal(reserved,0);
    }finally{Date.now=originalNow;}
  });
  await test('재검토 타임아웃은 전체 45초 예산의 남은 시간으로 제한한다',async()=>{
    const originalNow=Date.now,originalTimeout=AbortSignal.timeout;let clock=100000,calls=0;const timeouts=[];
    Date.now=()=>clock;AbortSignal.timeout=ms=>{timeouts.push(ms);return originalTimeout(ms);};
    try{
      globalThis.fetch=async()=>{if(++calls===1){clock+=30000;return envelope(base);}return envelope({replacements:[{field:'title_ko',text:'Nova는 영원하다',evidence:post.text}]});};
      const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},post);assert.equal(result.metrics.calls,2);assert.deepEqual(timeouts,[45000,15000]);
    }finally{Date.now=originalNow;AbortSignal.timeout=originalTimeout;}
  });
  await test('검토 예산이 없으면 추가 호출하거나 의심 제목을 반환하지 않는다',async()=>{
    let calls=0;globalThis.fetch=async()=>{calls++;return envelope(base);};
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},post,{reserveReview:async()=>false}),e=>e.code==='analysis_summary'&&e.retryAfter===3600);assert.equal(calls,1);
  });
  for(const [name,replacements] of [
    ['요청하지 않은 필드',[{field:'status',text:'completed',evidence:post.text}]],
    ['원문 밖 근거',[{field:'title_ko',text:'Nova는 영원하다',evidence:'Made up.'}]],
    ['계속 남은 의미 오류',[{field:'title_ko',text:'Nova에 대한 언급',evidence:post.text}]],
    ['없는 필드',[]],
    ['null 항목',[null]],
    ['중복 필드',[{field:'title_ko',text:'Nova는 영원하다',evidence:post.text},{field:'title_ko',text:'Nova는 영원하다',evidence:post.text}]],
  ])await test(`잘못된 부분 수정 거부: ${name}`,async()=>{
    let calls=0;globalThis.fetch=async()=>++calls===1?envelope(base):envelope({replacements});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},post),e=>/^analysis_summary/.test(e.code));assert.equal(calls,2);
  });
  await test('부분 검토 503은 외부 응답 본문을 노출하지 않고 기존 재시도로 전달한다',async()=>{
    let calls=0;globalThis.fetch=async()=>++calls===1?envelope(base):new Response('sensitive provider detail',{status:503,headers:{'retry-after':'30'}});
    await assert.rejects(analyzeReset({GEMINI_API_KEY:'synthetic'},post),e=>e.code==='analysis_http_503'&&e.calls===2&&e.retryAfter===30&&!e.message.includes('sensitive'));assert.equal(calls,2);
  });
  await test('정상 결과는 한 호출로 끝난다',async()=>{
    let calls=0;globalThis.fetch=async()=>{calls++;return envelope({...base,title_ko:'Nova는 영원하다'});};
    const result=await analyzeReset({GEMINI_API_KEY:'synthetic'},post);assert.equal(calls,1);assert.equal(result.metrics.summary_review,false);
  });
  await test('일반 글은 상태 정의를 유지하고 사례집만 줄이며 문맥 단서와 재검토에서는 복원한다',async()=>{
    const prompts=[];
    globalThis.fetch=async(url,options)=>{prompts.push(JSON.parse(options.body).systemInstruction.parts[0].text);return envelope({...base,title_ko:'Nova는 영원하다'});};
    await analyzeReset({GEMINI_API_KEY:'synthetic'},post);
    await analyzeReset({GEMINI_API_KEY:'synthetic'},{...post,context:[{text:'Usage allowances have been restored.'}]});
    await analyzeReset({GEMINI_API_KEY:'synthetic'},post,{reviewCode:'analysis_summary'});
    assert.ok(prompts.every(prompt=>prompt.includes('상태 정의')&&prompt.includes('OUTPUT EVIDENCE')));
    assert.ok(!prompts[0].includes('문맥 해석 예시'));assert.ok(prompts[1].includes('문맥 해석 예시'));assert.ok(prompts[2].includes('문맥 해석 예시'));
  });
}finally{globalThis.fetch=original;}
