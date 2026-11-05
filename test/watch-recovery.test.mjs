import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {processWatchJob} from '../src/watcher.js';
import {processDeliveryJob} from '../src/deliveries.js';
import {analysisRetryPolicy} from '../src/watch-store.js';

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
for(const name of ['0001_watch.sql','0002_thread_context.sql','0003_guild_channels.sql','0006_notification_channels.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
const jobs=[],calls=[];let failure=0,hold=null,enter=null;
const env={DB:db,WATCH_ENABLED:'true',DISCORD_TEST_GUILD_ID:'2',DISCORD_NOTIFY_CHANNEL_ID:'3',DISCORD_BOT_TOKEN:'fixture',GEMINI_API_KEY:'fixture',PROBE_JOBS:{async send(body,options){jobs.push({body,options});},async sendBatch(batch){jobs.push(...batch);}}};
const original=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if(String(url).includes('generativelanguage.googleapis.com')){
    const input=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);calls.push({kind:'analysis',input});
    if(failure)return new Response('',{status:failure,headers:{'Retry-After':failure===429?'900':'0'}});
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({status:'completed',reset_type:'regular',type_evidence:input.text,evidence:input.text,time_expression:'',title_ko:'사용량 초기화 완료',bullets:['사용량 초기화가 완료됐습니다.'],title_evidence:[input.text],bullet_evidence:[input.text]})}]}}]});
  }
  if(String(url).startsWith('https://discord.com/')){
    calls.push({kind:'discord',method:options.method,content:JSON.parse(options.body).content});
    enter?.();if(hold)await hold;return Response.json({id:'9001'});
  }
  throw new Error('Unexpected destination');
};
const row=()=>db.prepare("SELECT * FROM watched_posts WHERE id='100'").first();
const delivery=()=>db.prepare("SELECT * FROM post_deliveries WHERE post_id='100'").first();
const postJob=phase=>processWatchJob({body:{kind:'watch-post',postId:'100',phase},ack(){}},env);
const send=()=>processDeliveryJob({body:{kind:'watch-delivery',postId:'100',guildId:'2',deliveryKind:'link'},ack(){}},env);
async function reset(){
  await db.batch([db.prepare('DELETE FROM watched_posts'),db.prepare('DELETE FROM post_deliveries'),db.prepare('DELETE FROM analysis_budget'),db.prepare("INSERT OR IGNORE INTO guild_settings(guild_id,channel_id) VALUES('2','3')"),db.prepare("INSERT INTO watched_posts(id,body,published_at,phase,discovered_at) VALUES('100','The usage reset is completed.','2026-11-01T12:00:00Z','link',?)").bind(Date.now())]);
  jobs.length=0;calls.length=0;failure=0;hold=null;enter=null;
}
try{
  await test('정상 게시글은 Queue 재발행 없이 단계별 저장을 완료하고 중복 작업은 분석하지 않는다',async()=>{
    await reset();await Promise.all([postJob('link'),postJob('link')]);
    assert.equal((await row()).phase,'done');assert.equal(calls.filter(c=>c.kind==='analysis').length,1);
    assert.equal(jobs.filter(j=>j.body.kind==='watch-post').length,0);assert.equal((await delivery()).kind,'reset');
  });
  await test('503 장애는 링크를 먼저 보내고 15초 재시도 후 같은 메시지만 수정한다',async()=>{
    await reset();failure=503;await postJob('link');
    assert.equal((await row()).last_error,'analysis_http_503');assert.equal(jobs.find(j=>j.body.kind==='watch-post').options.delaySeconds,15);
    await send();assert.equal((await delivery()).message_id,'9001');
    failure=0;await db.prepare('UPDATE watched_posts SET next_attempt=0').run();await postJob('analyze');await send();
    assert.deepEqual(calls.filter(c=>c.kind==='discord').map(c=>c.method),['POST','PATCH']);
    assert.equal((await delivery()).phase,'done');assert.match((await delivery()).content,/초기화 완료/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM post_deliveries').first()).n,1);
  });
  await test('링크 전송 도중 분석이 완료돼도 새 내용을 완료 처리로 지우지 않는다',async()=>{
    await reset();failure=503;await postJob('link');
    let release;hold=new Promise(resolve=>release=resolve);const entered=new Promise(resolve=>enter=resolve);
    const sending=send();await entered;
    failure=0;await db.prepare('UPDATE watched_posts SET next_attempt=0').run();await postJob('analyze');
    release();await sending;hold=null;enter=null;
    assert.equal((await delivery()).phase,'pending');assert.equal((await delivery()).message_id,'9001');
    await Promise.all([send(),send()]);
    assert.deepEqual(calls.filter(c=>c.kind==='discord').map(c=>c.method),['POST','PATCH']);assert.equal((await delivery()).phase,'done');
  });
  await test('인증 오류는 반복 호출 없이 링크로 종료하고 제한 오류는 제공된 재시각을 따른다',async()=>{
    await reset();failure=403;await postJob('link');assert.equal((await row()).phase,'done');assert.equal(calls.filter(c=>c.kind==='analysis').length,1);
    assert.equal(JSON.parse((await row()).analysis_json).failure_code,'analysis_http_403');
    await reset();failure=429;await postJob('link');assert.equal(jobs.find(j=>j.body.kind==='watch-post').options.delaySeconds,900);
  });
  await test('검증 실패는 한 번만 재검토하고 일시 장애 재시도는 최대 네 번으로 제한한다',()=>{
    assert.equal(analysisRetryPolicy({attempts:0},{code:'analysis_evidence'}).terminal,false);
    assert.equal(analysisRetryPolicy({attempts:1},{code:'analysis_evidence'}).terminal,true);
    assert.deepEqual([0,1,2].map(attempts=>analysisRetryPolicy({attempts},{code:'analysis_http_503'}).delaySeconds),[15,60,180]);
    assert.equal(analysisRetryPolicy({attempts:3},{code:'analysis_http_503'}).terminal,true);
  });
}finally{globalThis.fetch=original;await mf.dispose();}
