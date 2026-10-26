import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {parseSiteResets,collectSiteResets,siteResetNotification} from '../src/site-reset-source.js';
import {pollSiteResets,scheduleSiteResets,processSiteResetJob} from '../src/site-reset-watch.js';
import {notificationPayload} from '../src/notification-payload.js';
import {processDeliveryJob,pendingDeliveries} from '../src/deliveries.js';

const now=Date.now();
const row=(id,type='regular')=>({id,reset_type:type,announced_at:new Date(now-3600000).toISOString(),source:{type:'x_post',author:'thsottiaux',url:`https://x.com/thsottiaux/status/${id}`}});
const snapshot=(rows=[row('100')],extra={})=>({data:rows,meta:{api_version:'v1',generated_at:new Date(now).toISOString()},pagination:{has_more:false,next_cursor:null},...extra});
const originalFetch=globalThis.fetch;
for(const type of ['regular','banked'])test(`${type} 사이트 기록을 별도 초록색 카드로 변환한다`,()=>{
  const event=parseSiteResets(snapshot([{...row('100',type),announced_at:'2026-10-26T07:00:00Z'}]),Math.max(now,Date.parse('2026-10-26T07:00Z'))).events[0];
  const payload=notificationPayload(siteResetNotification(event));assert.equal(payload.content,'');assert.equal(payload.embeds.length,1);
  const embed=payload.embeds[0];assert.equal(embed.color,0x57F287);assert.equal(embed.title,'🔄 Codex 사용량 리셋 감지');assert.equal(embed.description.split('\n').length,4);assert.ok(embed.description.includes(`(${type})`));assert.match(embed.description,/발표 시각: 2026-10-26 16:00 KST/);assert.match(embed.description,/출처: https:\/\/codex-resets.com\//);
});
test('관측 기록의 원문이 없으면 X 링크를 만들지 않는다',()=>{
  const event=parseSiteResets(snapshot([{...row('observed-100'),source:{type:'observed'}}]),now).events[0];
  const embed=notificationPayload(siteResetNotification(event)).embeds[0];assert.equal(embed.url,'https://codex-resets.com/');assert.match(embed.description,/원문: 제공되지 않음/);
});
for(const change of [
  {reset_type:'unknown'},{id:'bad;sql'},{announced_at:'invalid'},{announced_at:new Date(now+600000).toISOString()},
  {source:{type:'x_post',author:'other',url:'https://x.com/thsottiaux/status/100'}},
  {source:{type:'observed',url:'https://evil.invalid/'}},{source:{type:'x_post',author:'thsottiaux'}},{status:'scheduled'}
])test('잘못된 사이트 항목을 완료 기록으로 사용하지 않는다: '+JSON.stringify(change),()=>assert.throws(()=>parseSiteResets(snapshot([{...row('100'),...change}]),now)));
test('오래된 응답·버전 변경·잘못된 커서를 거부한다',()=>{
  assert.throws(()=>parseSiteResets(snapshot([],{meta:{api_version:'v1',generated_at:new Date(now-3600000).toISOString()}}),now));
  assert.throws(()=>parseSiteResets(snapshot([],{meta:{api_version:'v2',generated_at:new Date(now).toISOString()}}),now));
  assert.throws(()=>parseSiteResets(snapshot([],{pagination:{has_more:true,next_cursor:'https://evil.invalid'}}),now));
});
try{
  await test('페이지 누락 없이 수집하고 같은 원문 observed-ID와 X-ID는 한 건으로 합친다',async()=>{
    const urls=[];globalThis.fetch=async(url,options)=>{
      urls.push(String(url));assert.equal(options.redirect,'manual');assert.match(options.headers['User-Agent'],/github.com\/hyxx-su\/Tibo-bot/);
      return Response.json(urls.length===1?snapshot([{...row('observed-100'),source:{type:'observed',url:row('100').source.url}}],{pagination:{has_more:true,next_cursor:'page2'}}):snapshot([row('100'),row('99')]));
    };
    const events=await collectSiteResets(now);assert.equal(events.length,2);assert.ok(urls[1].includes('cursor=page2'));assert.equal(events.filter(e=>e.key==='site:regular:100').length,1);
  });
  await test('429 Retry-After와 날짜 형식 지연을 보존한다',async()=>{
    for(const retry of ['120',new Date(now+180000).toUTCString()]){
      globalThis.fetch=async()=>new Response('',{status:429,headers:{'Retry-After':retry}});
      await assert.rejects(collectSiteResets(now),e=>e.retryAfter>=120);
    }
  });
  await test('리다이렉트·과대 응답·끝없는 페이지는 상태 저장 전에 거부한다',async()=>{
    globalThis.fetch=async()=>Response.json(snapshot([]));await assert.rejects(collectSiteResets(now),/Empty/);
    globalThis.fetch=async()=>new Response('',{status:302,headers:{Location:'https://evil.invalid'}});await assert.rejects(collectSiteResets(now));
    globalThis.fetch=async()=>new Response('x'.repeat(1024*1024+1));await assert.rejects(collectSiteResets(now));
    globalThis.fetch=async()=>Response.json(snapshot([row('100')],{pagination:{has_more:true,next_cursor:'same'}}));await assert.rejects(collectSiteResets(now),/Repeated/);
  });
}finally{globalThis.fetch=originalFetch;}

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
for(const name of ['0001_watch.sql','0003_guild_channels.sql','0004_site_resets.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
const jobs=[],sent=[];let feed=[row('100')],siteStatus=200,siteCalls=0,discordStatus=200,queueFailure=false;
const env={DB:db,WATCH_ENABLED:'true',SITE_RESETS_ENABLED:'true',DISCORD_TEST_GUILD_ID:'2',DISCORD_NOTIFY_CHANNEL_ID:'3',DISCORD_BOT_TOKEN:'fixture',PROBE_JOBS:{async send(job){jobs.push({body:job});},async sendBatch(batch){if(queueFailure)throw Error('Queue unavailable');jobs.push(...batch);}}};
const state=()=>db.prepare('SELECT * FROM site_reset_state WHERE id=1').first();
const release=()=>db.prepare('UPDATE site_reset_state SET next_poll_at=0').run();
async function deliverAll(){const batch=jobs.splice(0);for(const job of batch)await processDeliveryJob({...job,ack(){}},env);}
globalThis.fetch=async(url,options)=>{
  if(new URL(url).hostname==='codex-resets.com'){
    siteCalls++;if(siteStatus!==200)return new Response('',{status:siteStatus,headers:{'Retry-After':'180'}});
    return Response.json(snapshot(feed));
  }
  if(new URL(url).hostname==='discord.com'){
    const body=JSON.parse(options.body);sent.push({url:String(url),body,status:discordStatus});
    return discordStatus===200?Response.json({id:String(9000+sent.length)}):Response.json({retry_after:120},{status:discordStatus});
  }
  throw Error('Unexpected request');
};
try{
  await test('새 사이트 기능은 명시적으로 활성화한 경우에만 예약·처리한다',async()=>{
    await scheduleSiteResets({...env,SITE_RESETS_ENABLED:'false'});assert.equal(jobs.length,0);
    await scheduleSiteResets(env);assert.equal(jobs.pop().body.kind,'site-reset-poll');
    let ack=false;assert.equal(await processSiteResetJob({body:{kind:'other'},ack(){}},env),false);
    await processSiteResetJob({body:{kind:'site-reset-poll'},ack(){ack=true;}},{...env,SITE_RESETS_ENABLED:'false'});assert.ok(ack);assert.equal(siteCalls,0);
  });
  await test('처음 수집한 과거 기록은 기준점만 저장하고 재실행도 발송하지 않는다',async()=>{
    await pollSiteResets(env,now);assert.ok((await state()).initialized_at);assert.equal((await db.prepare('SELECT phase FROM site_reset_events').first()).phase,'baseline');assert.equal(jobs.length,0);assert.equal(sent.length,0);
    const calls=siteCalls;await pollSiteResets(env,now+1000);assert.equal(siteCalls,calls);await release();await pollSiteResets(env,now);assert.equal(jobs.length,0);
  });
  await test('동시에 수집해도 신규 regular·banked만 서버별 한 번 발송하고 X 이력을 보존한다',async()=>{
    await db.prepare("INSERT INTO guild_settings(guild_id,channel_id,activated_at) VALUES ('4','5',0)").run();
    await db.prepare("INSERT INTO watched_posts(id,body,published_at,phase,discovered_at,reset_message_id) VALUES ('101','fixture','date','done',0,'8000')").run();
    feed=[row('101'),row('102','banked'),...feed];await release();const before=siteCalls;
    await Promise.all([pollSiteResets(env,now),pollSiteResets(env,now)]);assert.equal(siteCalls,before+1);assert.equal(jobs.length,4);
    await Promise.all([deliverAll(),deliverAll()]);assert.equal(sent.length,4);assert.ok(sent.every(s=>s.body.content===''&&s.body.embeds[0].color===0x57F287));assert.equal(new Set(sent.map(s=>s.body.nonce)).size,4);assert.ok(sent.every(s=>s.body.nonce.length<=25));
    assert.equal((await db.prepare("SELECT reset_message_id FROM watched_posts WHERE id='101'").first()).reset_message_id,'8000');
    await release();await pollSiteResets(env,now);await deliverAll();assert.equal(sent.length,4);
  });
  await test('원문 ID 재표현과 시각 수정은 기존 사이트 알림을 중복 발송하지 않는다',async()=>{
    feed=[{...row('observed-101'),source:{type:'observed',url:row('101').source.url},announced_at:new Date(now-10000).toISOString()},...feed];await release();await pollSiteResets(env,now);await deliverAll();assert.equal(sent.length,4);
  });
  await test('Queue 발행 실패 후 저장한 대기 작업을 사이트 장애 중에도 복구한다',async()=>{
    feed=[row('103'),...feed];queueFailure=true;await release();await assert.rejects(pollSiteResets(env,now));assert.equal((await db.prepare("SELECT phase FROM site_reset_events WHERE event_key='site:regular:103'").first()).phase,'queued');
    queueFailure=false;siteStatus=503;await release();await assert.rejects(pollSiteResets(env,now));await deliverAll();assert.equal(sent.length,6);assert.ok((await state()).last_error);
    siteStatus=200;
  });
  await test('429 응답은 다음 수집을 늦추고 Discord 429는 성공 서버를 재전송하지 않는다',async()=>{
    siteStatus=429;await release();await assert.rejects(pollSiteResets(env,now));assert.ok((await state()).next_poll_at>=now+180000);siteStatus=200;
    feed=[row('104'),...feed];await release();await pollSiteResets(env,now);
    const batch=jobs.splice(0);await processDeliveryJob({...batch[0],ack(){}},env);discordStatus=429;await processDeliveryJob({...batch[1],ack(){}},env);discordStatus=200;
    const failed=await db.prepare("SELECT * FROM post_deliveries WHERE post_id='site:regular:104' AND phase='pending'").first();assert.ok(failed.next_attempt>Date.now()+60000);
    await db.prepare("UPDATE post_deliveries SET next_attempt=0 WHERE post_id='site:regular:104' AND phase='pending'").run();await release();await pollSiteResets(env,now);await deliverAll();
    assert.equal(sent.filter(s=>s.status===200&&s.body.embeds[0].url.endsWith('/104')).length,2);
  });
  await test('사이트 감시를 중지하면 쌓인 사이트 알림 대신 X 알림을 복구한다',async()=>{
    await db.batch(Array.from({length:12},(_,i)=>db.prepare("INSERT INTO post_deliveries(post_id,guild_id,kind,channel_id,content) VALUES (?,'2','site-reset','3','fixture')").bind('paused:'+i)));
    await db.prepare("INSERT INTO post_deliveries(post_id,guild_id,kind,channel_id,content) VALUES ('999','2','link','3','https://x.com/thsottiaux/status/999')").run();
    const active=await pendingDeliveries(db,Date.now(),false);
    assert.deepEqual(active.map(job=>job.body.deliveryKind),['link']);
    const before=sent.length;
    await processDeliveryJob({body:{kind:'watch-delivery',postId:'paused:0',guildId:'2',deliveryKind:'site-reset'},ack(){}},{...env,SITE_RESETS_ENABLED:'false'});
    assert.equal(sent.length,before);
    assert.equal((await db.prepare("SELECT phase FROM post_deliveries WHERE post_id='paused:0'").first()).phase,'pending');
    assert.ok((await pendingDeliveries(db,Date.now(),true)).some(job=>job.body.deliveryKind==='site-reset'));
  });
}finally{globalThis.fetch=originalFetch;await mf.dispose();}
