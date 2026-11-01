import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {processWatchJob} from '../src/watcher.js';
import {pollSiteResets} from '../src/site-reset-watch.js';
import {processDeliveryJob} from '../src/deliveries.js';
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
for(const name of ['0001_watch.sql','0002_thread_context.sql','0003_guild_channels.sql','0004_site_resets.sql','0005_site_reset_verification.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
const date=new Date(Date.now()-60000).toISOString(),text='Banked 2/3';
const old={status:'in_progress',reset_type:'banked',type_evidence:text,evidence:text,title_ko:'지급 2단계 진행',summary_ko:'배포 2단계가 진행 중이다.',time_expression:''};
const fresh={...old,status:'completed',title_ko:'저장형 리셋 지급 안내 (2/3)',bullets:['저장형 리셋 지급을 2/3으로 안내했다.']};
const jobs=[],sent=[];let apiCalls=0,apiStatus=200,feed=[],onAnalyze=null;
const env={DB:db,WATCH_ENABLED:'true',SITE_RESETS_ENABLED:'true',DISCORD_BOT_TOKEN:'synthetic',GEMINI_API_KEY:'synthetic',PROBE_JOBS:{async send(body){jobs.push({body});},async sendBatch(batch){jobs.push(...batch);}}};
const original=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://generativelanguage.googleapis.com/')){
    apiCalls++;if(onAnalyze)await onAnalyze();assert.equal(JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).text,text);
    return apiStatus===200?Response.json({candidates:[{content:{parts:[{text:JSON.stringify(fresh)}]}}]}):new Response('',{status:apiStatus});
  }
  if(String(url).startsWith('https://codex-resets.com/'))return Response.json({meta:{api_version:'v1',generated_at:new Date().toISOString()},pagination:{has_more:false},data:feed});
  assert.match(String(url),/^https:\/\/discord.com\/api\/v10\/channels\//);sent.push({method:options.method,payload:JSON.parse(options.body)});return Response.json({id:'900'});
};
const source=id=>({id,reset_type:'banked',announced_at:date,source:{type:'x_post',author:'thsottiaux',url:`https://x.com/thsottiaux/status/${id}`}});
async function poll(){await db.prepare('UPDATE site_reset_state SET next_poll_at=0').run();await pollSiteResets(env);}
const review=(id='200')=>processWatchJob({body:{kind:'watch-reanalyze',postId:id,reviewBanked:true},attempts:1,ack(){},retry(){throw new Error('Unexpected retry');}},env);
async function drain(){for(const job of jobs.splice(0))await processDeliveryJob({...job,ack(){}},env);}
try{
  await db.prepare("INSERT INTO guild_settings(guild_id,channel_id) VALUES('20','30')").run();
  await db.prepare("INSERT INTO watched_posts(id,body,published_at,phase,discovered_at,analysis_json) VALUES('200',?,?,'done',0,?)").bind(text,date,JSON.stringify(old)).run();
  await db.prepare("INSERT INTO post_deliveries(post_id,guild_id,kind,channel_id,content,message_id,phase) VALUES('200','20','reset','30','old','900','done')").run();
  feed=[source('100')];await poll();feed.push(source('200'));await poll();jobs.length=0;
  await test('오분석한 짧은 banked 글은 새 원문 분석 후 기존 X 메시지를 수정하고 사이트 카드를 한 번 발송한다',async()=>{
    assert.equal((await db.prepare("SELECT verification_reason FROM site_reset_events WHERE event_key='site:banked:200'").first()).verification_reason,'completion_unconfirmed');
    await review();await drain();assert.equal(apiCalls,1);assert.equal(sent.length,1);assert.equal(sent[0].method,'PATCH');assert.doesNotMatch(sent[0].payload.content,/단계/);
    await poll();await drain();assert.equal(sent.length,2);assert.equal(sent[1].method,'POST');assert.match(sent[1].payload.embeds[0].description,/저장형 리셋 \(banked\)/);
    assert.equal((await db.prepare("SELECT verification FROM site_reset_events WHERE event_key='site:banked:200'").first()).verification,'verified');
    await review();await poll();await drain();assert.equal(apiCalls,1);assert.equal(sent.length,2);
  });
  await test('API 실패는 기존 분석·메시지를 보존하고 관리자 작업을 지연 재시도한다',async()=>{
    await db.prepare("INSERT INTO watched_posts(id,body,published_at,phase,discovered_at,analysis_json) VALUES('201',?,?,'done',0,?)").bind(text,date,JSON.stringify(old)).run();
    apiStatus=503;let delay;
    await processWatchJob({body:{kind:'watch-reanalyze',postId:'201',reviewBanked:true},attempts:1,ack(){assert.fail('retry required');},retry(options){delay=options.delaySeconds;}},env);
    assert.equal(delay,600);assert.equal((await db.prepare("SELECT analysis_json FROM watched_posts WHERE id='201'").first()).analysis_json,JSON.stringify(old));assert.equal(sent.length,2);apiStatus=200;
  });
  await test('완료·질문·부정·배포 중·다른 유형·처리 중인 글은 좁은 복구 대상에서 제외한다',async()=>{
    const before=apiCalls;
    for(const [body,status,type,phase] of [['Banked 2/3?','mentioned','banked','done'],['Not banked 2/3','mentioned','banked','done'],['Banking 2/3','in_progress','banked','done'],[text,'completed','banked','done'],[text,'scheduled','banked','done'],[text,'unrelated','unknown','done'],[text,'in_progress','regular','done'],[text,'in_progress','banked','analyze']]){
      await db.prepare("UPDATE watched_posts SET body=?,analysis_json=?,phase=? WHERE id='201'").bind(body,JSON.stringify({...old,status,reset_type:type}),phase).run();await review('201');
    }
    assert.equal(apiCalls,before);assert.equal(sent.length,2);
  });
  await test('재분석 요청 도중 바뀐 분석은 덮어쓰지 않고 기존 발송도 다시 열지 않는다',async()=>{
    await db.prepare("INSERT INTO watched_posts(id,body,published_at,phase,discovered_at,analysis_json) VALUES('202',?,?,'done',0,?)").bind(text,date,JSON.stringify(old)).run();
    await db.prepare("INSERT INTO post_deliveries(post_id,guild_id,kind,channel_id,content,message_id,phase) VALUES('202','20','reset','30','keep','901','done')").run();
    const changed=JSON.stringify({...old,status:'mentioned',summary_ko:'다른 검토 결과'});
    onAnalyze=()=>db.prepare("UPDATE watched_posts SET analysis_json=? WHERE id='202'").bind(changed).run();
    await review('202');onAnalyze=null;
    assert.equal((await db.prepare("SELECT analysis_json FROM watched_posts WHERE id='202'").first()).analysis_json,changed);
    assert.deepEqual(await db.prepare("SELECT content,phase FROM post_deliveries WHERE post_id='202'").first(),{content:'keep',phase:'done'});
  });
}finally{globalThis.fetch=original;await mf.dispose();}
