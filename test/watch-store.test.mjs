import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {recordPage,readWatchStatus} from '../src/watch-store.js';

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
for(const name of ['0001_watch.sql','0002_thread_context.sql','0003_guild_channels.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
const post=id=>({id:String(id),text:'합성 게시글 '+id,date:'Oct 26, 2026 · 12:00 AM UTC',context:[]});
const row=id=>db.prepare('SELECT * FROM watched_posts WHERE id=?').bind(String(id)).first();
let insertStatements=0;
const measuredDb={
  prepare(sql){if(sql.startsWith('INSERT OR IGNORE INTO watched_posts'))insertStatements++;return db.prepare(sql);},
  batch:statements=>db.batch(statements),
};
async function reset(){
  await db.batch([
    db.prepare('DELETE FROM watched_posts'),db.prepare('DELETE FROM post_deliveries'),
    db.prepare("UPDATE watch_state SET baseline_id='100',high_water_id='100',last_success=NULL,last_error=NULL WHERE id=1"),
  ]);
  insertStatements=0;
}

try{
  await test('최초 수집의 과거 글은 저장이나 발송 작업을 만들지 않는다',async()=>{
    await reset();await db.prepare('UPDATE watch_state SET baseline_id=NULL,high_water_id=NULL WHERE id=1').run();
    const result=await recordPage(measuredDb,[post(100),post(99)],1000);
    assert.deepEqual(result,{baseline:true,added:0,cutoff:'100'});assert.equal(insertStatements,0);assert.equal(await row(99),null);
  });

  await test('기존 글 20개의 반복 수집은 저장 SQL 없이 완료·실패 이력을 보존한다',async()=>{
    await reset();const posts=Array.from({length:20},(_,i)=>post(101+i));
    assert.equal((await recordPage(measuredDb,posts,1000)).added,20);
    await db.prepare("UPDATE watched_posts SET phase='done',message_id='9000' WHERE id='101'").run();
    await db.prepare("UPDATE watched_posts SET phase='failed',attempts=6,last_error='fixture_failure' WHERE id='102'").run();
    const before=await Promise.all([row(101),row(102)]);insertStatements=0;
    assert.equal((await recordPage(measuredDb,posts.map(p=>({...p,text:'변경된 합성 본문'})),2000)).added,0);
    assert.equal(insertStatements,0);assert.deepEqual(await Promise.all([row(101),row(102)]),before);
  });

  await test('최고 ID보다 늦게 나타난 글은 수집하되 최초 기준점 이전 글은 제외한다',async()=>{
    await reset();await recordPage(db,[post(120)],1000);insertStatements=0;
    const result=await recordPage(measuredDb,[post(121),post(120),post(116),post(99)],2000);
    assert.equal(result.added,2);assert.equal(result.cutoff,'120');assert.equal(insertStatements,2);
    assert.equal((await row(116)).phase,'link');assert.equal((await row(121)).phase,'link');assert.equal(await row(99),null);
  });

  await test('한 페이지의 중복 ID는 최초 본문과 문맥을 한 번만 저장한다',async()=>{
    await reset();const original={...post(101),context:[post(99)]};
    assert.equal((await recordPage(measuredDb,[original,{...post(101),text:'중복 카드'}],1000)).added,1);
    assert.equal(insertStatements,1);assert.equal((await row(101)).body,original.text);assert.deepEqual(JSON.parse((await row(101)).context_json),original.context);
  });

  await test('최대 200개 게시글도 ID 목록 조회의 바인딩 한도를 넘지 않는다',async()=>{
    await reset();const posts=Array.from({length:200},(_,i)=>post(101+i));
    assert.equal((await recordPage(measuredDb,posts,1000)).added,200);insertStatements=0;
    assert.equal((await recordPage(measuredDb,posts,2000)).added,0);assert.equal(insertStatements,0);
  });

  await test('저장 전 조회 이후 같은 글이 들어와도 완료 이력을 덮어쓰지 않는다',async()=>{
    await reset();
    const racedDb={prepare:sql=>db.prepare(sql),async batch(statements){
      await db.prepare("INSERT INTO watched_posts(id,body,published_at,phase,discovered_at,message_id) VALUES ('101','먼저 저장된 본문','fixture','done',500,'9001')").run();
      return db.batch(statements);
    }};
    assert.equal((await recordPage(racedDb,[post(101)],1000)).added,0);
    const saved=await row(101);assert.equal(saved.body,'먼저 저장된 본문');assert.equal(saved.phase,'done');assert.equal(saved.message_id,'9001');
  });

  await test('상태 조회는 현재 서버의 실패와 공통 분석 실패만 반영한다',async()=>{
    await reset();await recordPage(db,[post(101)],1000);
    await db.prepare("UPDATE watch_state SET last_success=2000 WHERE id=1").run();
    await db.prepare("INSERT INTO post_deliveries(post_id,guild_id,kind,channel_id,content,phase) VALUES ('101','20','link','30','fixture','failed'),('101','2','link','3','fixture','done')").run();
    const healthy=await readWatchStatus(db,'2');assert.equal(healthy.hasFailures,false);assert.equal(healthy.state.last_success,2000);assert.equal(healthy.counts,undefined);
    assert.equal((await readWatchStatus(db,'20')).hasFailures,true);
    await db.prepare("UPDATE watched_posts SET phase='failed' WHERE id='101'").run();assert.equal((await readWatchStatus(db,'2')).hasFailures,true);
    await db.prepare("UPDATE watched_posts SET phase='done' WHERE id='101'").run();assert.equal((await readWatchStatus(db,'2')).hasFailures,false);
    await db.prepare("UPDATE post_deliveries SET phase='done' WHERE guild_id='20'").run();assert.equal((await readWatchStatus(db,'20')).hasFailures,false);
  });
}finally{await mf.dispose();}
