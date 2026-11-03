import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {configureGuild,recordGuildEvent,sendWelcome,pendingSetupJobs,recordChannelDeletion} from '../src/guild-settings.js';
import {queueDeliveries,processDeliveryJob} from '../src/deliveries.js';
import {statusMessage} from '../src/status-view.js';
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
async function migrate(name){await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
for(const name of ['0001_watch.sql','0003_guild_channels.sql','0004_site_resets.sql','0005_site_reset_verification.sql'])await migrate(name);
await db.prepare("INSERT INTO guild_settings(guild_id,channel_id,activated_at,config_event) VALUES('20','30',100,'10')").run();
await migrate('0006_notification_channels.sql');
const messages=[],jobs=[];let noChannels=false,denied=false,admin=true;
const channel=id=>({id,guild_id:'20',type:0,position:Number(id),permission_overwrites:denied?[{id:'1',type:1,deny:'2048',allow:'0'}]:[]});
const env={DB:db,DISCORD_APPLICATION_ID:'1',DISCORD_BOT_TOKEN:'fixture',WATCH_ENABLED:'true',SITE_RESETS_ENABLED:'true',PROBE_JOBS:{async send(body){jobs.push(body);}}};
const original=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname.replace('/api/v10','');
 if(path==='/guilds/20')return Response.json({id:'20',owner_id:'90',system_channel_id:'31'});
 if(path==='/guilds/20/roles')return Response.json([{id:'20',permissions:'0'},{id:'21',permissions:'19456'}]);
 if(path==='/guilds/20/members/1')return Response.json({user:{id:'1'},roles:['21']});
 if(path==='/guilds/20/members/90')return Response.json({user:{id:admin?'90':'91'},roles:[]});
 if(path==='/guilds/20/channels')return Response.json(noChannels?[]:[channel('30'),channel('31')]);
 if(/^\/channels\/\d+$/.test(path))return Response.json(channel(path.split('/').at(-1)));
 if(/^\/channels\/\d+\/messages/.test(path)){messages.push({path,method:options.method,body:JSON.parse(options.body)});return Response.json({id:String(9000+messages.length)});}
 throw new Error('Unexpected fixture destination');
};
let id=100;
const config=(notificationType,channelId,disable=false,interactionId=String(++id))=>configureGuild(env,{guildId:'20',userId:'90',interactionId,notificationType,channelId,disable});
const settings=()=>db.prepare("SELECT * FROM guild_settings WHERE guild_id='20'").first();
async function add(postId,kind,discovered=Date.now()){
 if(kind==='site-reset'){
  await db.prepare("INSERT OR REPLACE INTO site_reset_events(event_key,source_id,reset_type,announced_at,original_url,content,discovered_at,phase,verification) VALUES(?,?,'regular',?,'https://x.com/thsottiaux/status/1','test',?,'pending','verified')").bind(postId,postId,new Date().toISOString(),discovered).run();
  await db.prepare('UPDATE site_reset_state SET last_success=?,last_error=NULL').bind(Date.now()).run();
 }else await db.prepare("INSERT OR IGNORE INTO watched_posts(id,body,published_at,phase,discovered_at) VALUES(?,'test',?,'done',?)").bind(postId,new Date().toISOString(),discovered).run();
 await queueDeliveries(env,{id:postId,message_id:null,discovered_at:discovered},'test',kind);
}
async function deliver(postId,deliveryKind){await processDeliveryJob({body:{postId,guildId:'20',deliveryKind},ack(){}},env);}
try{
 await test('기존 서버의 채널·활성화 시각·요청 순서를 두 종류에 그대로 복사한다',async()=>{
  const row=await settings();assert.equal(row.reset_channel_id,'30');assert.equal(row.reset_activated_at,100);assert.equal(row.reset_config_event,'10');assert.equal(row.setup_complete,1);
 });
 await test('초기화 관련 X 글도 게시글 채널로, 검증된 사이트 카드는 리셋 채널로 보낸다',async()=>{
  await config('posts','30');await config('resets','31');
  for(const [postId,kind,target] of [['500','link','30'],['501','reset','30'],['site:regular:502','site-reset','31']]){
   await add(postId,kind);await deliver(postId,kind);assert.equal(messages.at(-1).path,`/channels/${target}/messages`);
  }
 });
 await test('한 종류를 꺼도 다른 종류는 계속 보내고 환영·재선택이 꺼진 설정을 복원하지 않는다',async()=>{
  const before=messages.length;await config('posts',null,true);assert.equal(messages.length,before);
  await add('503','link');assert.equal(await db.prepare("SELECT 1 FROM post_deliveries WHERE post_id='503'").first(),null);
  await add('site:regular:504','site-reset');await deliver('site:regular:504','site-reset');assert.equal(messages.at(-1).path,'/channels/31/messages');
  await recordGuildEvent(env,'GUILD_CREATE','20');await sendWelcome(env,'20');assert.equal((await settings()).channel_id,null);assert.equal((await settings()).reset_channel_id,'31');assert.equal((await pendingSetupJobs(db,Date.now())).length,0);
 });
 await test('둘 다 끈 상태는 유지되고 상태 화면에 꺼짐으로 표시한다',async()=>{
  await config('resets',null,true);const before=messages.length;await sendWelcome(env,'20');assert.equal(messages.length,before);assert.equal((await pendingSetupJobs(db,Date.now())).length,0);
  const row=await settings();const view=statusMessage({state:{},gateway:{status:'online'},channelId:row.channel_id,resetChannelId:row.reset_channel_id,setupComplete:true});assert.match(view.embeds[0].title,/꺼져/);
 });
 await test('다시 켜면 꺼진 동안의 글을 발송하지 않으며 같은 채널 재활성화도 오래된 대기 작업을 취소한다',async()=>{
  await config('posts','30');const activated=(await settings()).activated_at;
  await add('505','link',activated-1);assert.equal(await db.prepare("SELECT 1 FROM post_deliveries WHERE post_id='505'").first(),null);
  await add('506','link');await config('posts',null,true);assert.equal((await db.prepare("SELECT phase FROM post_deliveries WHERE post_id='506'").first()).phase,'cancelled');
  await config('posts','30');const before=messages.length;await deliver('506','link');assert.equal(messages.length,before);
 });
 await test('종류별 요청 순서는 독립적이고 오래된 같은 종류 요청은 덮어쓰지 않는다',async()=>{
  await config('posts','30',false,'500');await config('resets','31',false,'400');assert.equal((await settings()).reset_channel_id,'31');
  assert.match(await config('posts',null,true,'499'),/최근/);assert.equal((await settings()).channel_id,'30');
  assert.match(await config('both','32',false,'450'),/최근/);assert.equal((await settings()).reset_channel_id,'31');
 });
 await test('삭제된 종류만 중단하고 다른 종류는 유지하며 안내가 자동 재설정하지 않는다',async()=>{
  await recordChannelDeletion(env,'20','31');await sendWelcome(env,'20',true);const row=await settings();assert.equal(row.channel_id,'30');assert.equal(row.reset_channel_id,null);assert.match(messages.at(-1).body.embeds[0].description,/다른 채널의 알림은 유지/);
  await add('507','reset');await deliver('507','reset');assert.equal(messages.at(-1).path,'/channels/30/messages');
 });
 await test('같은 채널을 공유한 두 알림은 채널 삭제 때 함께 중단한다',async()=>{
  await config('both','30',false,'501');await recordChannelDeletion(env,'20','30');const row=await settings();assert.equal(row.channel_id,null);assert.equal(row.reset_channel_id,null);
 });
 await test('관리자 권한 회수와 채널 권한 부족은 종류별 설정도 변경하지 못한다',async()=>{
  const before=await settings();admin=false;assert.match(await config('resets',null,true,'600'),/서버 관리/);admin=true;
  denied=true;assert.match(await config('posts','30',false,'601'),/권한/);denied=false;assert.deepEqual(await settings(),before);
 });
 await test('신규 초대는 시스템 채널에 두 종류를 자동 설정하며 재접속 시 변경하지 않는다',async()=>{
  await recordGuildEvent(env,'GUILD_DELETE','20');await recordGuildEvent(env,'GUILD_CREATE','20');await sendWelcome(env,'20');let row=await settings();assert.equal(row.channel_id,'31');assert.equal(row.reset_channel_id,'31');assert.ok(row.activated_at>0);
  const before=messages.length;await recordGuildEvent(env,'GUILD_CREATE','20');await sendWelcome(env,'20');assert.equal(messages.length,before);
 });
 await test('전송 가능한 채널이 없는 새 서버는 선택을 추측하지 않고 재시도한다',async()=>{
  await recordGuildEvent(env,'GUILD_DELETE','20');await recordGuildEvent(env,'GUILD_CREATE','20');noChannels=true;const before=messages.length;await sendWelcome(env,'20');assert.equal(messages.length,before);assert.equal((await settings()).setup_complete,0);assert.equal((await settings()).channel_id,null);noChannels=false;
 });
}finally{globalThis.fetch=original;await mf.dispose();}
