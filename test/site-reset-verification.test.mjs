import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {verifySiteReset} from '../src/site-reset-verification.js';
import {pollSiteResets} from '../src/site-reset-watch.js';
import {processDeliveryJob} from '../src/deliveries.js';
import {sendNotification} from '../src/notifications.js';
import {resetQuestionReply} from '../src/reset-reply.js';
const now=Date.now(),date=new Date(now-60000).toISOString();
const completed={status:'completed',reset_type:'regular',evidence:'It is done.',type_evidence:'Usage reset'};
const post={id:'200',text:'It is done.',date,context:[{id:'199',text:'Usage reset planned.'}]};
const event={type:'regular',sourceType:'x_post',announcedAt:date};
test('완료와 유형의 원문 근거가 일치하는 regular·banked만 승인한다',()=>{
  for(const type of ['regular','banked'])assert.equal(verifySiteReset({...event,type},post,{...completed,reset_type:type}).verification,'verified');
});
test('출시 오탐·관측만 있는 기록·미완료·위조 근거·시각 불일치를 완료로 쓰지 않는다',()=>{
  assert.equal(verifySiteReset(event,{...post,text:'A website has landed'},{status:'unrelated'}).verification,'rejected');
  for(const status of ['scheduled','mentioned','in_progress','unavailable'])assert.equal(verifySiteReset(event,post,{...completed,status}).verification,'pending');
  for(const [e,p,a] of [[{...event,sourceType:'observed'},post,completed],[event,null,completed],[event,post,null],[event,post,{...completed,reset_type:'banked'}],[event,post,{...completed,evidence:'fabricated'}],[event,post,{...completed,type_evidence:'invented'}],[{...event,announcedAt:new Date(now+60000).toISOString()},post,completed]])assert.notEqual(verifySiteReset(e,p,a).verification,'verified');
});
test('검증되지 않은 사이트 기록은 채팅 완료·최근 이력 답변에서 제외한다',()=>{
  for(const verification of [undefined,'pending','rejected','retracted'])for(const intent of ['status','history']){
    const answer=resetQuestionReply({state:{baseline_id:'1',last_success:now},posts:[],siteResets:[{verification,missing_count:0,reset_type:'regular',announced_at:date,original_url:'https://x.com/thsottiaux/status/200'}]},now,{intent});
    assert.doesNotMatch(answer,/실행된 기록|마지막 정기 리셋 실행 기록/);
  }
});

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
for(const name of ['0001_watch.sql','0002_thread_context.sql','0003_guild_channels.sql','0004_site_resets.sql','0005_site_reset_verification.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
const row=(id,type='regular')=>({id,reset_type:type,announced_at:date,source:{type:'x_post',author:'thsottiaux',url:`https://x.com/thsottiaux/status/${id}`}});
const jobs=[],sent=[];let feed=[row('100')],status=200,discordStatus=200;
const env={DB:db,WATCH_ENABLED:'true',SITE_RESETS_ENABLED:'true',DISCORD_BOT_TOKEN:'synthetic',PROBE_JOBS:{async sendBatch(batch){jobs.push(...batch);}}};
const original=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://codex-resets.com/'))return status===200?Response.json({meta:{api_version:'v1',generated_at:new Date().toISOString()},pagination:{has_more:false},data:feed}):new Response('',{status});
  assert.match(String(url),/^https:\/\/discord.com\/api\/v10\/channels\//);
  const payload=JSON.parse(options.body);sent.push({url:String(url),method:options.method,payload});
  return discordStatus===200?Response.json({id:String(url).match(/\/messages\/(\d+)$/)?.[1]??String(9000+sent.length)}):Response.json({code:10008},{status:discordStatus});
};
async function poll(){await db.prepare('UPDATE site_reset_state SET next_poll_at=0').run();await pollSiteResets(env);}
async function deliver(){for(const job of jobs.splice(0))await processDeliveryJob({...job,ack(){}},env);}
async function save(id,analysis=completed,text='It is done.'){
  await db.prepare("INSERT OR REPLACE INTO watched_posts(id,body,published_at,phase,discovered_at,context_json,analysis_json) VALUES (?,?,?,'done',0,?,?)").bind(id,text,date,JSON.stringify(post.context),JSON.stringify(analysis)).run();
}
const record=id=>db.prepare('SELECT * FROM site_reset_events WHERE event_key=?').bind('site:regular:'+id).first();
try{
  await db.prepare("INSERT INTO guild_settings(guild_id,channel_id) VALUES('20','30')").run();
  await test('초기 기준점은 재발송하지 않으며 검증 대기 글은 분석 완료 후 한 번만 발송한다',async()=>{
    await save('100');await poll();await deliver();assert.equal(sent.length,0);
    feed.unshift(row('200'));await poll();await deliver();assert.equal(sent.length,0);assert.equal((await record('200')).verification,'pending');
    await save('200');await poll();await deliver();assert.equal(sent.length,1);assert.equal((await record('200')).verification,'verified');
    await poll();await deliver();assert.equal(sent.length,1);
  });
  await test('사이트의 무관한 출시 글과 observed 예정 글은 완료 알림을 만들지 않는다',async()=>{
    await save('201',{status:'unrelated'},'A website has landed');await save('202',{...completed,status:'scheduled'});
    feed.push(row('201'),{...row('202'),source:{...row('202').source,type:'observed'}});await poll();await deliver();assert.equal(sent.length,1);
    assert.equal((await record('201')).verification,'rejected');assert.equal((await record('202')).verification,'pending');
  });
  await test('발송 대기 이후 검증이 취소되면 오래된 Queue 작업도 전송하지 않는다',async()=>{
    await save('203');feed.push(row('203'));await poll();
    await db.prepare("UPDATE site_reset_events SET verification='pending' WHERE event_key='site:regular:203'").run();await deliver();assert.equal(sent.length,1);
    await db.prepare("UPDATE post_deliveries SET next_attempt=0 WHERE post_id='site:regular:203'").run();await poll();await deliver();assert.equal(sent.length,2);
  });
  await test('일시 누락·사이트 장애에는 철회하지 않으며 정상 목록에서 3회 누락되면 기존 메시지를 정정한다',async()=>{
    feed=feed.filter(r=>r.id!=='200');await poll();await deliver();assert.equal((await record('200')).missing_count,1);assert.equal(sent.length,2);
    status=503;await assert.rejects(poll());assert.equal((await record('200')).missing_count,1);status=200;
    await poll();await deliver();assert.equal(sent.length,2);await poll();await deliver();assert.equal(sent.length,3);
    assert.equal((await record('200')).verification,'retracted');assert.equal(sent.at(-1).method,'PATCH');assert.match(sent.at(-1).url,/\/9001$/);assert.match(sent.at(-1).payload.embeds[0].title,/정정/);
    feed.push(row('200'));await poll();await deliver();assert.equal(sent.length,3);assert.equal((await record('200')).verification,'retracted');
  });
  await test('기존에 보낸 오탐은 원문과 대조하여 정정하고 재실행해도 중복 정정하지 않는다',async()=>{
    await db.prepare("INSERT INTO post_deliveries(post_id,guild_id,kind,channel_id,content,message_id,phase) VALUES('site:regular:201','20','site-reset','30','old','8001','done')").run();
    await poll();await deliver();assert.equal(sent.length,4);assert.match(sent.at(-1).url,/\/8001$/);assert.match(sent.at(-1).payload.embeds[0].description,/무관/);
    await poll();await deliver();assert.equal(sent.length,4);
  });
  await test('이미 승인한 발표 시각 변경도 기존 완료 카드를 정정한다',async()=>{
    feed=feed.map(r=>r.id==='203'?{...r,announced_at:new Date(now-30000).toISOString()}:r);await poll();await deliver();assert.equal(sent.length,5);assert.equal((await record('203')).verification,'retracted');
  });
  await test('사이트 장애 중에도 저장된 정정은 재시도하며 삭제된 메시지를 새로 게시하지 않는다',async()=>{
    await db.prepare("INSERT INTO post_deliveries(post_id,guild_id,kind,channel_id,content,message_id) SELECT post_id,'21',kind,channel_id,content,'8002' FROM post_deliveries WHERE post_id='site:regular:201' AND kind='site-correction' AND guild_id='20'").run();
    status=503;await assert.rejects(poll());discordStatus=404;const before=sent.length;await deliver();assert.equal(sent.length,before+1);assert.equal(sent.at(-1).method,'PATCH');assert.equal((await db.prepare("SELECT phase FROM post_deliveries WHERE guild_id='21'").first()).phase,'failed');status=200;discordStatus=200;
    await assert.rejects(sendNotification(env,'site:regular:201','text','site-correction',null,'30'),/existing message/);
  });
}finally{globalThis.fetch=original;await mf.dispose();}
