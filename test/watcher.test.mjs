import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {scheduleWatch} from '../src/watcher.js';

let posts=[{id:'100',text:'기존 합성 게시글'}];
let nextPage=null;
let sourceStatus=200;
let discordStatus=200;
let aiStatus=200;
let threadMode=false;
const calls=[];
function html(rows,cursor){
  return '<html>'+(threadMode?'<div class="thread-line">':'')+rows.map(p=>`<div class="timeline-item" data-username="thsottiaux"><a class="tweet-link" href="/thsottiaux/status/${p.id}"></a><div class="tweet-body"><div class="tweet-header"><span class="tweet-date"><a title="${p.date??'Oct 25, 2026 · 12:00 PM UTC'}"></a></span></div><div class="tweet-content">${p.text}</div>${p.media??''}${p.quote?`<div class="quote"><a class="quote-link" href="/${p.quote.author??'thsottiaux'}/status/${p.quote.id}"></a><a class="username" href="/${p.quote.author??'thsottiaux'}"></a><span class="tweet-date"><a title="Oct 25, 2026 · 3:40 AM UTC"></a></span><div class="quote-text">${p.quote.text}</div></div>`:''}</div></div>`).join('')+(threadMode?'</div>':'')+(cursor?'<div class="show-more"><a href="?cursor=fixture-next">more</a></div>':'')+'</html>';
}
const mf=new Miniflare({
  modules:true,script:await readFile(new URL('../.build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),
  bindings:{WATCH_ENABLED:'true',DISCORD_BOT_TOKEN:'synthetic-token',DISCORD_NOTIFY_CHANNEL_ID:'3',GEMINI_API_KEY:'synthetic-key',RESET_ANALYSIS_DAILY_LIMIT:'100'},
  d1Databases:['DB'],queueProducers:{PROBE_JOBS:'watch-fixture'},queueConsumers:{'watch-fixture':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:2,retryDelay:0}},
  outboundService:async request=>{
    const url=new URL(request.url);
    if(url.hostname==='x.noodl3.net'){
      calls.push({kind:'source',cursor:url.searchParams.get('cursor')});
      if(sourceStatus!==200)return new Response('source unavailable',{status:sourceStatus});
      return new Response(html(url.searchParams.has('cursor')?nextPage:posts,!url.searchParams.has('cursor')&&nextPage));
    }
    if(url.hostname==='generativelanguage.googleapis.com'){
      if(aiStatus!==200)return new Response('unavailable',{status:aiStatus});
      const body=await request.json();const input=JSON.parse(body.contents[0].parts[0].text);calls.push({kind:'ai',text:input.text,context:input.context});
      const rest=input.text.includes('Rest and reset');
      if(input.text==='It is all propagated.'||input.text==='Still propagating.')return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({status:input.text==='It is all propagated.'?'completed':'in_progress',summary_ko:'Tibo가 반영 상태를 안내했습니다.',evidence:input.text,time_expression:'By midnight PST'})}]}}]});
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({status:rest?'unrelated':'scheduled',summary_ko:rest?'휴식에 관한 글입니다.':'초기화 예정입니다.',evidence:input.text,time_expression:rest?'':input.text==='By midnight PST'?input.text:'tomorrow at 9am PT'})}]}}],usageMetadata:{totalTokenCount:100}});
    }
    if(url.hostname==='discord.com'){
      const body=await request.json();calls.push({kind:'discord',body,status:discordStatus,authorization:request.headers.get('Authorization'),path:url.pathname,method:request.method});
      if(discordStatus!==200)return Response.json({retry_after:120},{status:discordStatus});
      return Response.json({id:request.method==='PATCH'?url.pathname.split('/').at(-1):'message-'+body.nonce});
    }
    throw new Error('Unexpected destination');
  },
});
const db=await mf.getD1Database('DB');const queue=await mf.getQueueProducer('PROBE_JOBS');
const schema=await readFile(new URL('../migrations/0001_watch.sql',import.meta.url),'utf8');
await db.batch(schema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
await db.prepare(await readFile(new URL('../migrations/0002_thread_context.sql',import.meta.url),'utf8')).run();
async function waitFor(fn){const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Watch fixture timed out');}
const row=id=>db.prepare('SELECT * FROM watched_posts WHERE id=?').bind(id).first();
const poll=()=>scheduleWatch({WATCH_ENABLED:'true',PROBE_JOBS:queue});
async function waitPoll(){await waitFor(async()=>!(await db.prepare('SELECT poll_lease_until FROM watch_state WHERE id=1').first()).poll_lease_until);}
try{
  await test('첫 실행은 기준점만 저장하고 과거 글을 발송하지 않는다',async()=>{
    await poll();await waitFor(async()=>(await db.prepare('SELECT baseline_id FROM watch_state WHERE id=1').first()).baseline_id==='100');await waitPoll();assert.equal(calls.filter(c=>c.kind==='discord').length,0);
  });
  await test('새 글은 원문 링크만 발송하고 일반 글은 AI를 호출하지 않는다',async()=>{
    posts=[{id:'101',text:'새 합성 게시글'},...posts];await poll();await waitFor(async()=>(await row('101'))?.phase==='done');await waitPoll();
    const sent=calls.filter(c=>c.kind==='discord');assert.equal(sent.length,1);assert.equal(sent[0].body.content,'https://x.com/thsottiaux/status/101');assert.deepEqual(sent[0].body.allowed_mentions,{parse:[]});assert.equal(sent[0].body.enforce_nonce,true);assert.equal((sent[0].body.flags??0)&4,0);assert.equal(sent[0].authorization,'Bot synthetic-token');assert.equal(calls.filter(c=>c.kind==='ai').length,0);
  });
  await test('중복 Queue 메시지는 이미 보낸 링크를 다시 보내지 않는다',async()=>{
    await queue.send({kind:'watch-post',postId:'101',phase:'link'});await queue.send({kind:'watch-post',postId:'101',phase:'link'});
    posts=[{id:'102',text:'Codex usage limits will reset tomorrow at 9am PT.'},...posts];await poll();await waitFor(async()=>(await row('102'))?.phase==='done');await waitPoll();
    assert.equal(calls.filter(c=>c.kind==='discord'&&c.body.nonce==='l101').length,1);
  });
  await test('초기화 글은 한국시간 설명과 링크를 한 메시지로만 발송한다',async()=>{
    const sent=calls.filter(c=>c.kind==='discord'&&c.body.nonce.endsWith('102'));
    assert.equal(sent.length,1);assert.equal(sent[0].body.nonce,'r102');assert.equal((sent[0].body.flags??0)&4,0);assert.match(sent[0].body.content,/# 10월 27일 01:00/);assert.match(sent[0].body.content,/https:\/\/x.com\/thsottiaux\/status\/102$/);
  });
  await test('휴식 의미의 reset에는 링크만 보내고 초기화 공지는 보내지 않는다',async()=>{
    posts=[{id:'103',text:'Day 20. Rest and reset.'},...posts];await poll();await waitFor(async()=>(await row('103'))?.phase==='done');await waitPoll();
    assert.equal(calls.filter(c=>c.kind==='discord'&&c.body.nonce.endsWith('103')).length,1);
  });
  await test('Discord 429 이후 저장된 작업을 재시도하고 동시 발송을 막는다',async()=>{
    discordStatus=429;posts=[{id:'104',text:'재시도 합성 글'},...posts];await poll();await waitFor(async()=>(await row('104'))?.attempts===1);await waitPoll();
    assert.ok((await row('104')).next_attempt>Date.now()+60000);discordStatus=200;await db.prepare("UPDATE watched_posts SET next_attempt=0 WHERE id='104'").run();
    await Promise.all([queue.send({kind:'watch-post',postId:'104',phase:'link'}),queue.send({kind:'watch-post',postId:'104',phase:'link'})]);
    await waitFor(async()=>(await row('104'))?.phase==='done');assert.equal(calls.filter(c=>c.kind==='discord'&&c.body.nonce==='l104'&&c.status===200).length,1);
  });
  await test('일일 분석 상한에서는 별도 링크를 보내지 않고 통합 메시지를 대기한다',async()=>{
    await db.prepare('UPDATE analysis_budget SET calls=100').run();const before=calls.filter(c=>c.kind==='ai').length;
    posts=[{id:'105',text:'Codex usage limits will reset tomorrow at 9am PT.'},...posts];await poll();await waitFor(async()=>(await row('105'))?.last_error==='daily_analysis_limit');await waitPoll();
    assert.equal((await row('105')).message_id,null);assert.equal(calls.filter(c=>c.kind==='discord'&&c.body.nonce.endsWith('105')).length,0);assert.equal(calls.filter(c=>c.kind==='ai').length,before);
  });
  await test('수집원 장애 중에도 이미 저장된 전송 작업을 복구한다',async()=>{
    await db.prepare("INSERT INTO watched_posts (id,body,published_at,phase,discovered_at) VALUES ('106','저장된 합성 글','Oct 25, 2026 · 12:00 PM UTC','link',0)").run();
    sourceStatus=429;await poll();await waitFor(async()=>(await row('106'))?.phase==='done');await waitFor(async()=>(await db.prepare('SELECT last_error FROM watch_state WHERE id=1').first()).last_error==='poll_failed');await waitPoll();sourceStatus=200;
  });
  await test('첫 페이지가 모두 새 글이면 다음 페이지도 수집한다',async()=>{
    posts=[{id:'108',text:'합성 새 글 108'},{id:'107',text:'합성 새 글 107'}];nextPage=[{id:'106',text:'저장된 합성 글'},{id:'105',text:'Codex usage limits will reset tomorrow at 9am PT.'}];
    await poll();await waitFor(async()=>(await row('108'))?.phase==='done'&&(await row('107'))?.phase==='done');await waitFor(()=>calls.some(c=>c.kind==='source'&&c.cursor==='fixture-next'));await waitPoll();
    assert.equal(calls.filter(c=>c.kind==='discord'&&c.body.nonce==='l106').length,1);
  });
  await test('새 시간 답글은 기준점 이전 본문의 reset 문맥으로 분석한다',async()=>{
    await db.prepare('UPDATE analysis_budget SET calls=0').run();nextPage=null;threadMode=true;
    posts=[{id:'99',text:'Day 1/ Rest and reset'},{id:'109',text:'By midnight PST',date:'Oct 25, 2026 · 3:40 AM UTC'}];
    await poll();await waitFor(async()=>(await row('109'))?.phase==='done');await waitPoll();
    const saved=await row('109');assert.equal(JSON.parse(saved.context_json)[0].id,'99');
    const sent=calls.filter(c=>c.kind==='discord'&&c.body.nonce==='r109');assert.equal(sent.length,1);assert.match(sent[0].body.content,/다음 자정까지/);
    assert.equal(calls.filter(c=>c.kind==='discord'&&c.body.nonce==='l99').length,0);
  });
  await test('관리자 재검증은 지정한 실제 글만 저장하고 완료 이력을 유지한다',async()=>{
    threadMode=false;posts=[{id:'98',text:'기준점 이전 지정 글'}];
    await queue.send({kind:'watch-replay',postId:'98'});await waitFor(async()=>(await row('98'))?.phase==='done');
    await queue.send({kind:'watch-replay',postId:'98'});
    posts=[...posts,{id:'97',text:'다음 지정 글'}];await queue.send({kind:'watch-replay',postId:'97'});await waitFor(async()=>(await row('97'))?.phase==='done');
    assert.equal(calls.filter(c=>c.kind==='discord'&&c.body.nonce==='l98').length,1);
  });
  await test('분석 최종 실패 시 별도 초기화 추측 없이 링크 한 건만 보낸다',async()=>{
    aiStatus=503;
    await db.prepare("INSERT INTO watched_posts (id,body,published_at,phase,attempts,discovered_at) VALUES ('110','reset fixture','Oct 25, 2026 · 12:00 PM UTC','analyze',5,0)").run();
    await queue.send({kind:'watch-post',postId:'110',phase:'analyze'});await waitFor(async()=>(await row('110'))?.phase==='done');
    const sent=calls.filter(c=>c.kind==='discord'&&c.body.nonce.endsWith('110'));assert.equal(sent.length,1);assert.equal(sent[0].body.content,'https://x.com/thsottiaux/status/110');aiStatus=200;
  });
  await test('이미지·GIF만 있는 답글과 함께 올라온 일반 글을 모두 한 번씩 전송한다',async()=>{
    const aiBefore=calls.filter(c=>c.kind==='ai').length;
    posts=[{id:'113',text:'',media:'<div class="attachments"><video poster="/pic/gif.jpg"><source src="/video/gif.mp4"></video></div>'},{id:'112',text:'',media:'<div class="attachments"><img src="/pic/image.jpg"></div>'},{id:'111',text:'함께 올라온 일반 글'},{id:'110',text:'기존 글'}];
    await poll();await waitFor(async()=>(await row('113'))?.phase==='done'&&(await row('112'))?.phase==='done'&&(await row('111'))?.phase==='done');await waitPoll();
    await poll();await waitPoll();
    for(const id of ['111','112','113']){
      const sent=calls.filter(c=>c.kind==='discord'&&c.body.nonce==='l'+id);assert.equal(sent.length,1);assert.equal(sent[0].body.content,'https://x.com/thsottiaux/status/'+id);assert.equal((sent[0].body.flags??0)&4,0);
    }
    assert.equal((await row('112')).body,'');assert.equal(calls.filter(c=>c.kind==='ai').length,aiBefore);
  });
  await test('reset 없는 인용 완료 글도 저장된 예고 문맥과 함께 Gemini로 분석해 통합 전송한다',async()=>{
    posts=[{id:'114',text:'It is all propagated.',date:'Oct 25, 2026 · 6:06 AM UTC',quote:{id:'109',text:'By midnight PST'}},...posts];await poll();await waitFor(async()=>(await row('114'))?.phase==='done');await waitPoll();
    const analysis=calls.find(c=>c.kind==='ai'&&c.text==='It is all propagated.');assert.ok(analysis.context.some(p=>p.id==='99'&&p.text.includes('reset')));
    const sent=calls.filter(c=>c.kind==='discord'&&c.body.nonce?.endsWith('114'));assert.equal(sent.length,1);assert.match(sent[0].body.content,/^# 초기화 완료/);assert.match(sent[0].body.content,/기존 예상 · 10월 25일 17:00/);assert.match(sent[0].body.content,/앞서 완료/);assert.match(sent[0].body.content,/status\/114$/);
  });
  await test('진행 중인 인용 공지를 완료 메시지로 보내지 않는다',async()=>{
    posts=[{id:'115',text:'Still propagating.',quote:{id:'109',text:'By midnight PST'}},...posts];await poll();await waitFor(async()=>(await row('115'))?.phase==='done');await waitPoll();const sent=calls.find(c=>c.kind==='discord'&&c.body.nonce==='r115');assert.match(sent.body.content,/초기화 진행 공지/);assert.doesNotMatch(sent.body.content,/초기화 완료/);
  });
  await test('다른 작성자의 인용만으로 Gemini 분석을 시작하지 않는다',async()=>{
    const before=calls.filter(c=>c.kind==='ai').length;posts=[{id:'116',text:'무관한 인용',quote:{id:'109',text:'By midnight PST',author:'someone'}},...posts];await poll();await waitFor(async()=>(await row('116'))?.phase==='done');await waitPoll();assert.equal(calls.filter(c=>c.kind==='ai').length,before);
  });
  await test('관리자 단건 재분석은 기존 링크 메시지를 수정하며 반복 호출로 중복 발송하지 않는다',async()=>{
    posts=[{id:'117',text:'It is all propagated.',date:'Oct 25, 2026 · 6:06 AM UTC'},...posts];await poll();await waitFor(async()=>(await row('117'))?.phase==='done');await waitPoll();
    await db.prepare("UPDATE watched_posts SET message_id='900117' WHERE id='117'").run();posts[0].quote={id:'109',text:'By midnight PST'};
    await queue.send({kind:'watch-reanalyze',postId:'117'});await waitFor(async()=>(await row('117'))?.reset_message_id==='900117');
    assert.equal(calls.filter(c=>c.kind==='discord'&&c.body.nonce==='l117').length,1);const edit=calls.filter(c=>c.kind==='discord'&&c.method==='PATCH');assert.equal(edit.length,1);assert.match(edit[0].body.content,/^# 초기화 완료/);assert.ok(edit[0].path.endsWith('/900117'));
    const before=calls.filter(c=>c.kind==='source').length;await queue.send({kind:'watch-reanalyze',postId:'117'});await poll();await waitFor(()=>calls.filter(c=>c.kind==='source').length>=before+2);await waitPoll();assert.equal(calls.filter(c=>c.kind==='discord'&&c.method==='PATCH').length,1);
  });
}finally{await mf.dispose();}
