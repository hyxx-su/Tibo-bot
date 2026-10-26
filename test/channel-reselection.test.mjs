import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {recordChannelDeletion,pendingSetupJobs,processGuildJob,configureGuild,seedLegacyGuild,checkNotificationChannel} from '../src/guild-settings.js';
import {queueDeliveries,processDeliveryJob} from '../src/deliveries.js';
import {readWatchStatus} from '../src/watch-store.js';
import {DiscordGateway} from '../src/gateway.js';

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
for(const name of ['0001_watch.sql','0003_guild_channels.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
const queued=[],sent=[];let failQueue=false,sendErrors=new Map(),channels=[],channelsHook=null,guildFailure=0;
const channel=id=>({id,guild_id:'20',type:0,position:Number(id),permission_overwrites:[]});
const env={DB:db,DISCORD_APPLICATION_ID:'1',DISCORD_BOT_TOKEN:'synthetic',DISCORD_TEST_GUILD_ID:'2',DISCORD_NOTIFY_CHANNEL_ID:'3',WATCH_ENABLED:'true',PROBE_JOBS:{async send(job){if(failQueue)throw Error('Synthetic queue failure');queued.push(job);}}};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
  const path=new URL(url).pathname.replace('/api/v10','');
  if(path==='/guilds/20')return guildFailure?Response.json({}, {status:guildFailure}):Response.json({id:'20',owner_id:'90',system_channel_id:'31'});
  if(path==='/guilds/20/roles')return Response.json([{id:'20',permissions:'0'},{id:'21',permissions:'19456'}]);
  if(path==='/guilds/20/members/1')return Response.json({user:{id:'1'},roles:['21']});
  if(path==='/guilds/20/members/90')return Response.json({user:{id:'90'},roles:[]});
  if(path==='/guilds/20/channels'){if(channelsHook)await channelsHook();return Response.json(channels);}
  if(/^\/channels\/\d+$/.test(path)){
    const failure=sendErrors.get(path);
    return failure?Response.json({code:failure.code},{status:failure.status}):Response.json(channel(path.split('/').at(-1)));
  }
  if(/^\/channels\/\d+\/messages/.test(path)){
    sent.push({path,body:JSON.parse(options.body),method:options.method});
    const failure=sendErrors.get(path);
    return failure?Response.json({code:failure.code,message:'Synthetic Discord error'}, {status:failure.status}):Response.json({id:String(9000+sent.length)});
  }
  throw Error('Unexpected fixture destination');
};
const settings=id=>db.prepare('SELECT * FROM guild_settings WHERE guild_id=?').bind(id).first();
async function setup(){
  await db.batch([db.prepare('DELETE FROM post_deliveries'),db.prepare('DELETE FROM guild_settings'),db.prepare("INSERT INTO guild_settings(guild_id,channel_id,config_event,activated_at,welcome_message_id,welcome_channel_id) VALUES('20','30','100',1,'8000','31')")]);
  queued.length=0;sent.length=0;failQueue=false;sendErrors=new Map();channels=[channel('31'),channel('32')];channelsHook=null;guildFailure=0;
}
async function addDelivery(id,guildId='20',channelId='30',phase='pending'){
  await db.prepare('INSERT INTO post_deliveries(post_id,guild_id,kind,channel_id,content,phase) VALUES(?,?,\'link\',?,\'synthetic post\',?)').bind(id,guildId,channelId,phase).run();
}
const phase=id=>db.prepare('SELECT phase FROM post_deliveries WHERE post_id=?').bind(id).first();
async function prompt(kind='guild-channel-reselect'){
  let ack=false,retry=null;
  await processGuildJob({attempts:1,body:{kind,guildId:'20'},ack(){ack=true;},retry(value){retry=value;}},env);
  return {ack,retry};
}
async function deliver(id){let ack=false;await processDeliveryJob({body:{postId:id,guildId:'20',deliveryKind:'link'},ack(){ack=true;}},env);assert.equal(ack,true);}
try{
  await test('선택된 알림 채널만 해제하고 다른 서버와 성공 이력은 보존한다',async()=>{
    await setup();await addDelivery('1');await addDelivery('2','20','30','failed');await addDelivery('3','20','30','done');await addDelivery('4','99','30');await addDelivery('5','20','32','failed');
    await recordChannelDeletion(env,'20','29');await recordChannelDeletion(env,'99','30');assert.equal((await settings('20')).channel_id,'30');assert.equal(queued.length,0);
    await recordChannelDeletion(env,'20','30');
    const row=await settings('20');assert.equal(row.channel_id,null);assert.equal(row.active,1);assert.equal(row.welcome_message_id,null);
    assert.equal((await phase('1')).phase,'cancelled');assert.equal((await phase('2')).phase,'cancelled');assert.equal((await phase('3')).phase,'done');assert.equal((await phase('4')).phase,'pending');assert.equal((await phase('5')).phase,'failed');
    await queueDeliveries(env,{id:'6',message_id:null,discovered_at:Date.now()},'new post','link');assert.equal(await db.prepare("SELECT * FROM post_deliveries WHERE post_id='6' AND guild_id='20'").first(),null);
  });
  await test('중복 삭제·중복 Queue에도 시스템 채널에 재선택 메뉴를 한 번만 보낸다',async()=>{
    await setup();await recordChannelDeletion(env,'20','30');await recordChannelDeletion(env,'20','30');assert.equal(queued.length,1);
    await Promise.all([prompt(),prompt()]);await prompt();assert.equal(sent.length,1);assert.equal(sent[0].path,'/channels/31/messages');
    assert.match(sent[0].body.embeds[0].title,/다시 선택/);assert.equal(sent[0].body.components[0].components[0].type,8);assert.deepEqual(sent[0].body.allowed_mentions,{parse:[]});assert.equal(sent[0].body.enforce_nonce,true);assert.ok(sent[0].body.nonce.length<=25);assert.equal((await settings('20')).channel_id,null);
  });
  await test('재연결로 도착한 기존 환영 작업도 설정 해제 후에는 재선택 안내를 보낸다',async()=>{
    await setup();await recordChannelDeletion(env,'20','30');await prompt('guild-welcome');
    assert.equal(sent.length,1);assert.match(sent[0].body.embeds[0].title,/다시 선택/);assert.equal(sent[0].body.content,undefined);
  });
  await test('비활성 서버와 잘못된 삭제 대상은 안내나 저장 작업을 만들지 않는다',async()=>{
    await setup();await db.prepare("UPDATE guild_settings SET active=0 WHERE guild_id='20'").run();
    for(const [guildId,channelId] of [['20','30'],['invalid','30'],['20','invalid']])await recordChannelDeletion(env,guildId,channelId);
    assert.equal((await settings('20')).channel_id,'30');assert.equal(queued.length,0);
  });
  await test('삭제 이벤트 전에 재설정했거나 안내 처리 전에 선택을 마쳤으면 새 설정을 보존한다',async()=>{
    await setup();await recordChannelDeletion(env,'20','30');
    await configureGuild(env,{guildId:'20',channelId:'32',userId:'90',interactionId:'200'});const before=sent.length;
    await prompt();await recordChannelDeletion(env,'20','30');assert.equal((await settings('20')).channel_id,'32');assert.equal(sent.length,before);
    await queueDeliveries(env,{id:'10',message_id:null,discovered_at:0},'old post','link');assert.equal(await db.prepare("SELECT * FROM post_deliveries WHERE post_id='10' AND guild_id='20'").first(),null);
    await queueDeliveries(env,{id:'11',message_id:null,discovered_at:Date.now()},'new post','link');await deliver('11');assert.equal(sent.at(-1).path,'/channels/32/messages');
  });
  await test('안내 채널을 조회하는 사이 재설정하면 오래된 안내를 보내지 않는다',async()=>{
    await setup();await recordChannelDeletion(env,'20','30');channelsHook=()=>db.prepare("UPDATE guild_settings SET channel_id='32',config_event='200' WHERE guild_id='20'").run();
    await prompt();assert.equal(sent.length,0);assert.equal((await settings('20')).channel_id,'32');
  });
  await test('시스템 채널에 권한이 없으면 전송 가능한 다른 텍스트 채널을 사용한다',async()=>{
    await setup();channels[0].permission_overwrites=[{id:'1',type:1,deny:'2048',allow:'0'}];await recordChannelDeletion(env,'20','30');await prompt();assert.equal(sent.length,1);assert.equal(sent[0].path,'/channels/32/messages');
  });
  await test('채널 조회 후 시스템 채널이 사라지거나 거부되어도 다음 후보에 안내한다',async()=>{
    await setup();await recordChannelDeletion(env,'20','30');sendErrors.set('/channels/31/messages',{status:404,code:10003});await prompt();
    assert.equal(sent.length,2);assert.equal(sent[1].path,'/channels/32/messages');assert.equal(sent[0].body.nonce,sent[1].body.nonce);
  });
  await test('보낼 채널이 없으면 미설정을 유지하고 10분 뒤 안내를 다시 확인한다',async()=>{
    await setup();channels=[];await recordChannelDeletion(env,'20','30');await prompt();
    assert.equal(sent.length,0);assert.equal((await settings('20')).channel_id,null);assert.ok((await settings('20')).welcome_lease_until>Date.now()+590000);
    assert.equal((await pendingSetupJobs(db,Date.now())).length,0);assert.equal((await pendingSetupJobs(db,Date.now()+610000))[0].body.kind,'guild-channel-reselect');
  });
  await test('설정 해제 뒤 Queue 발행 실패도 다음 예약 확인에서 안내를 복구한다',async()=>{
    await setup();await addDelivery('20','20','30','failed');failQueue=true;await assert.rejects(()=>recordChannelDeletion(env,'20','30'));
    assert.equal((await settings('20')).channel_id,null);assert.equal((await phase('20')).phase,'cancelled');assert.equal((await readWatchStatus(db,'20')).hasFailures,false);
    failQueue=false;const jobs=await pendingSetupJobs(db,Date.now());assert.equal(jobs.length,1);await prompt(jobs[0].body.kind);assert.equal(sent.length,1);
  });
  await test('일시적 안내 API 오류는 대기 후 같은 설정의 같은 nonce로 재시도한다',async()=>{
    await setup();await recordChannelDeletion(env,'20','30');sendErrors.set('/channels/31/messages',{status:503});const first=await prompt();assert.equal(first.ack,false);assert.equal(first.retry.delaySeconds,120);const nonce=sent[0].body.nonce;
    assert.equal((await pendingSetupJobs(db,Date.now())).length,0);await db.prepare("UPDATE guild_settings SET welcome_lease_until=0 WHERE guild_id='20'").run();sendErrors.clear();await prompt();assert.equal(sent.at(-1).body.nonce,nonce);
  });
  await test('삭제 이벤트를 놓쳐도 알림 전송의 Unknown Channel 응답으로 재선택을 안내한다',async()=>{
    await setup();await addDelivery('30');sendErrors.set('/channels/30/messages',{status:404,code:10003});await deliver('30');
    assert.equal((await settings('20')).channel_id,null);assert.equal((await phase('30')).phase,'cancelled');assert.equal(queued[0].kind,'guild-channel-reselect');await prompt();assert.equal(sent.at(-1).path,'/channels/31/messages');
  });
  await test('재연결 중 설정된 채널이 이미 사라졌으면 새 글을 기다리지 않고 안내한다',async()=>{
    await setup();sendErrors.set('/channels/30',{status:404,code:10003});await prompt('guild-welcome');
    assert.equal((await settings('20')).channel_id,null);assert.equal(sent.length,1);assert.match(sent[0].body.embeds[0].title,/다시 선택/);
  });
  for(const failure of [{status:403,code:50001},{status:404,code:10008}])await test(`재연결의 불확실한 채널 조회 ${failure.status}는 기존 설정을 해제하지 않는다`,async()=>{
    await setup();sendErrors.set('/channels/30',failure);
    if(failure.status===404)await assert.rejects(()=>checkNotificationChannel(env,'20'));else await checkNotificationChannel(env,'20');
    assert.equal((await settings('20')).channel_id,'30');assert.equal(queued.length,0);
  });
  await test('재연결 중 채널 조회 장애는 설정을 보존하고 안내 작업을 재시도한다',async()=>{
    await setup();sendErrors.set('/channels/30',{status:503});const result=await prompt('guild-welcome');
    assert.equal(result.ack,false);assert.equal(result.retry.delaySeconds,120);assert.equal((await settings('20')).channel_id,'30');assert.equal(sent.length,0);
  });
  for(const failure of [{status:403,code:50001},{status:404,code:10008},{status:404}])await test(`삭제가 확정되지 않은 API 오류 ${failure.status}/${failure.code}로 설정을 해제하지 않는다`,async()=>{
    await setup();await addDelivery('31');sendErrors.set('/channels/30/messages',failure);await deliver('31');assert.equal((await settings('20')).channel_id,'30');assert.equal((await phase('31')).phase,'failed');assert.equal(queued.length,0);
  });
  await test('이전 환경변수의 기본 채널을 삭제 후 다시 자동 등록하지 않는다',async()=>{
    await setup();await seedLegacyGuild(env);await recordChannelDeletion(env,'2','3');await seedLegacyGuild(env);assert.equal((await settings('2')).channel_id,null);
  });
  await test('Gateway의 CHANNEL_DELETE는 guild_id와 채널 id로 실제 저장 설정을 해제한다',async()=>{
    await setup();let ready;
    const ctx={storage:{async get(){return undefined;},async put(){}},blockConcurrencyWhile(fn){ready=fn();},waitUntil(p){return p;}};
    const gateway=new DiscordGateway(ctx,env);await ready;
    gateway.receive({op:0,t:'CHANNEL_DELETE',s:10,d:{id:'30',guild_id:'20'}});await gateway.guildEvents;
    assert.equal((await settings('20')).channel_id,null);assert.equal(queued[0].kind,'guild-channel-reselect');
  });
}finally{globalThis.fetch=originalFetch;await mf.dispose();}
