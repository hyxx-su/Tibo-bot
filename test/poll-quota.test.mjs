import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import worker from '../src/index.js';
import {pollSiteResets} from '../src/site-reset-watch.js';
import {pendingDeliveries,processDeliveryJob} from '../src/deliveries.js';

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
for(const name of ['0001_watch.sql','0002_thread_context.sql','0003_guild_channels.sql','0006_notification_channels.sql','0004_site_resets.sql','0005_site_reset_verification.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
let writes=0;
// first()도 RETURNING의 실제 D1 meta를 측정한다. 테스트 준비 쓰기는 합산하지 않는다.
const count=result=>{writes+=result.meta.rows_written;return result;};
function measured(statement){return {bind(...values){return measured(statement.bind(...values));},async first(){return count(await statement.all()).results[0]??null;},async all(){return count(await statement.all());},async run(){return count(await statement.run());},statement};}
const measuredDB={prepare(sql){return measured(db.prepare(sql));},async batch(statements){return (await db.batch(statements.map(s=>s.statement))).map(count);}};
const now=Date.now(),date=new Date(now-60000).toISOString();
const feed=Array.from({length:70},(_,i)=>({id:String(100+i),reset_type:'regular',announced_at:date,source:{type:'x_post',author:'thsottiaux',url:`https://x.com/thsottiaux/status/${100+i}`}}));
const jobs=[];let sourceStatus=200,mirrorCalls=0,siteCalls=0;
const env={DB:measuredDB,WATCH_ENABLED:'true',SITE_RESETS_ENABLED:'true',DISCORD_BOT_TOKEN:'synthetic',PROBE_JOBS:{async send(body){jobs.push({body});},async sendBatch(batch){jobs.push(...batch);}}};
const original=globalThis.fetch;
globalThis.fetch=async url=>{
  if(String(url).startsWith('https://codex-resets.com/')){siteCalls++;return sourceStatus===200?Response.json({meta:{api_version:'v1',generated_at:new Date().toISOString()},pagination:{has_more:false},data:feed}):new Response('',{status:sourceStatus});}
  if(String(url).startsWith('https://x.noodl3.net/')){mirrorCalls++;return new Response('',{status:503});}
  throw new Error('Unexpected outbound request');
};
async function poll(){await db.prepare('UPDATE site_reset_state SET next_poll_at=0').run();return pollSiteResets(env);}
try{
  await test('70개 기록이 변하지 않으면 반복 수집당 쓰기는 상태 3회이며 과거 기록은 다시 쓰지 않는다',async()=>{
    await poll();const before=(await db.prepare('SELECT * FROM site_reset_events ORDER BY event_key').all()).results;
    writes=0;for(let i=0;i<10;i++)await poll();
    assert.equal(writes,30);assert.deepEqual((await db.prepare('SELECT * FROM site_reset_events ORDER BY event_key').all()).results,before);assert.equal(jobs.length,0);
  });
  await test('늦게 도착한 원문 분석은 변경된 1개 기록만 갱신하여 승인한다',async()=>{
    await db.prepare("INSERT INTO watched_posts(id,body,published_at,phase,discovered_at,analysis_json) VALUES('100','Usage reset is done.',?,'done',0,?)").bind(date,JSON.stringify({status:'completed',reset_type:'regular',evidence:'Usage reset is done.',type_evidence:'Usage reset'})).run();
    await poll();assert.equal((await db.prepare("SELECT verification FROM site_reset_events WHERE event_key='site:regular:100'").first()).verification,'verified');
    writes=0;await poll();assert.equal(writes,3);
  });
  await test('변하지 않은 기록의 last_seen_at이 오래되어도 최신 정상 스냅샷으로 발송 후보를 판정한다',async()=>{
    await db.prepare("UPDATE site_reset_events SET last_seen_at=0 WHERE event_key='site:regular:100'").run();
    await db.prepare("INSERT INTO post_deliveries(post_id,guild_id,kind,channel_id,content) VALUES('site:regular:100','20','site-reset','30','synthetic')").run();
    const ready=await pendingDeliveries(db,Date.now());assert.equal(ready.length,1);
    await db.prepare('UPDATE site_reset_state SET last_success=?').bind(Date.now()-181000).run();assert.equal((await pendingDeliveries(db,Date.now())).length,0);
    await processDeliveryJob({...ready[0],ack(){}},env);assert.equal((await db.prepare("SELECT phase FROM post_deliveries").first()).phase,'pending');
    await db.prepare('UPDATE site_reset_state SET last_success=?,last_error=?').bind(Date.now(),'site_poll_failed').run();assert.equal((await pendingDeliveries(db,Date.now())).length,0);
    await db.prepare('UPDATE post_deliveries SET next_attempt=0').run();await processDeliveryJob({...ready[0],ack(){}},env);
    await db.prepare('DELETE FROM post_deliveries').run();
  });
  await test('사이트 오류는 마지막 성공 시각과 이벤트를 보존하고 다음 정상 수집에서 회복한다',async()=>{
    const before=(await db.prepare('SELECT last_success FROM site_reset_state').first()).last_success;
    sourceStatus=503;await assert.rejects(poll());assert.equal((await db.prepare('SELECT last_success FROM site_reset_state').first()).last_success,before);
    assert.equal((await db.prepare('SELECT SUM(missing_count) AS count FROM site_reset_events').first()).count,0);
    sourceStatus=200;await poll();assert.equal((await db.prepare('SELECT last_error FROM site_reset_state').first()).last_error,null);
  });
  await test('Cron은 두 수집기를 직접 실행하고 미러 장애에도 사이트 수집을 완료하며 기본 Queue 작업을 만들지 않는다',async()=>{
    jobs.length=0;await db.prepare('UPDATE site_reset_state SET next_poll_at=0').run();
    const beforeSite=siteCalls,beforeMirror=mirrorCalls;
    await worker.scheduled({scheduledTime:Date.now()},env);
    assert.equal(siteCalls,beforeSite+1);assert.equal(mirrorCalls,beforeMirror+1);assert.equal(jobs.length,0);
    assert.equal((await db.prepare('SELECT last_error FROM site_reset_state').first()).last_error,null);
  });
  await test('Cron 직접 실행에서도 저장된 게시글 분석 작업은 Queue로 복구한다',async()=>{
    await db.prepare("INSERT INTO watched_posts(id,body,published_at,phase,discovered_at) VALUES('200','synthetic','2026-01-01T00:00:00Z','analyze',0)").run();
    await worker.scheduled({scheduledTime:Date.now()},env);
    assert.ok(jobs.some(job=>job.body.kind==='watch-post'&&job.body.postId==='200'));
    assert.ok(jobs.every(job=>!['watch-poll','site-reset-poll'].includes(job.body.kind)));
  });
}finally{globalThis.fetch=original;await mf.dispose();}
