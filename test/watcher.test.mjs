import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {scheduleWatch} from '../src/watcher.js';

let posts=[{id:'100',text:'기존 합성 게시글'}];
let nextPage=null;
let sourceStatus=200;
let discordStatus=200;
const calls=[];
function html(rows,cursor){
  return '<html>'+rows.map(p=>`<div class="timeline-item" data-username="thsottiaux"><a class="tweet-link" href="/thsottiaux/status/${p.id}"></a><div class="tweet-header"><span class="tweet-date"><a title="Oct 25, 2026 · 12:00 PM UTC"></a></span></div><div class="tweet-content">${p.text}</div></div>`).join('')+(cursor?'<div class="show-more"><a href="?cursor=fixture-next">more</a></div>':'')+'</html>';
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
      const body=await request.json();const input=JSON.parse(body.contents[0].parts[0].text);calls.push({kind:'ai',text:input.text});
      const rest=input.text.includes('Rest and reset');
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({status:rest?'unrelated':'scheduled',summary_ko:rest?'휴식에 관한 글입니다.':'Codex 사용량 초기화 예정입니다.',evidence:input.text,time_expression:rest?'':'tomorrow at 9am PT'})}]}}],usageMetadata:{totalTokenCount:100}});
    }
    if(url.hostname==='discord.com'){
      const body=await request.json();calls.push({kind:'discord',body,status:discordStatus,authorization:request.headers.get('Authorization'),path:url.pathname});
      if(discordStatus!==200)return Response.json({retry_after:120},{status:discordStatus});
      return Response.json({id:'message-'+body.nonce});
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
    const sent=calls.filter(c=>c.kind==='discord');assert.equal(sent.length,1);assert.equal(sent[0].body.content,'https://x.com/thsottiaux/status/101');assert.deepEqual(sent[0].body.allowed_mentions,{parse:[]});assert.equal(sent[0].body.enforce_nonce,true);assert.equal(sent[0].body.flags,4);assert.equal(sent[0].authorization,'Bot synthetic-token');assert.equal(calls.filter(c=>c.kind==='ai').length,0);
  });
  await test('중복 Queue 메시지는 이미 보낸 링크를 다시 보내지 않는다',async()=>{
    await queue.send({kind:'watch-post',postId:'101',phase:'link'});await queue.send({kind:'watch-post',postId:'101',phase:'link'});
    posts=[{id:'102',text:'Codex usage limits will reset tomorrow at 9am PT.'},...posts];await poll();await waitFor(async()=>(await row('102'))?.phase==='done');await waitPoll();
    assert.equal(calls.filter(c=>c.kind==='discord'&&c.body.nonce==='l101').length,1);
  });
  await test('초기화 글은 링크 다음에 한국시간 초기화 공지를 발송한다',async()=>{
    const sent=calls.filter(c=>c.kind==='discord'&&c.body.nonce.endsWith('102'));
    assert.equal(sent.length,2);assert.equal(sent[0].body.nonce,'l102');assert.equal(sent[1].body.nonce,'r102');assert.match(sent[1].body.content,/초기화 예정\n한국시간: 2026-10-27 01:00/);
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
  await test('일일 분석 상한에 도달해도 링크는 전송하고 분석은 다음 날로 미룬다',async()=>{
    await db.prepare('UPDATE analysis_budget SET calls=100').run();const before=calls.filter(c=>c.kind==='ai').length;
    posts=[{id:'105',text:'Codex usage limits will reset tomorrow at 9am PT.'},...posts];await poll();await waitFor(async()=>(await row('105'))?.last_error==='daily_analysis_limit');await waitPoll();
    assert.ok((await row('105')).message_id);assert.equal(calls.filter(c=>c.kind==='ai').length,before);
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
}finally{await mf.dispose();}
