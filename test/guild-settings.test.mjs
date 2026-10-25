import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {canSend,configureGuild,recordGuildEvent,sendWelcome,seedLegacyGuild} from '../src/guild-settings.js';
import {queueDeliveries,processDeliveryJob} from '../src/deliveries.js';

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),d1Databases:['DB']});
const db=await mf.getD1Database('DB');
for(const name of ['0001_watch.sql','0003_guild_channels.sql'])await db.batch((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
const queued=[],sent=[];
const env={DB:db,DISCORD_APPLICATION_ID:'1',DISCORD_BOT_TOKEN:'synthetic',DISCORD_TEST_GUILD_ID:'2',DISCORD_NOTIFY_CHANNEL_ID:'3',WATCH_ENABLED:'true',PROBE_JOBS:{async send(job){queued.push(job);}}};
const guild={id:'20',owner_id:'90',system_channel_id:'31'};
const roles=[{id:'20',permissions:'0'},{id:'21',permissions:'19456'},{id:'22',permissions:'32'}];
const bot={user:{id:'1'},roles:['21']};
let admin={user:{id:'90'},roles:['22']},channel={id:'30',guild_id:'20',type:0,position:0,permission_overwrites:[]},failChannel=null;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
  const path=new URL(url).pathname.replace('/api/v10','');
  if(path==='/guilds/20')return Response.json(guild);
  if(path==='/guilds/20/roles')return Response.json(roles);
  if(path==='/guilds/20/members/1')return Response.json(bot);
  if(path==='/guilds/20/members/90')return Response.json(admin);
  if(path==='/channels/30')return Response.json(channel);
  if(path==='/guilds/20/channels')return Response.json([channel,{...channel,id:'31',position:2}]);
  if(/^\/channels\/\d+\/messages/.test(path)){
    const body=JSON.parse(options.body);sent.push({path,body,method:options.method});
    if(path===`/channels/${failChannel}/messages`)return new Response('',{status:403});
    return Response.json({id:String(9000+sent.length)});
  }
  throw new Error('Unexpected fixture destination');
};
const job={guildId:'20',channelId:'30',userId:'90',interactionId:'100'};
const settings=id=>db.prepare('SELECT * FROM guild_settings WHERE guild_id=?').bind(id).first();
async function delivery(postId,guildId){let ack=false;await processDeliveryJob({body:{postId,guildId,deliveryKind:'link'},ack(){ack=true;}},env);assert.equal(ack,true);}
try{
  await test('봇 채널 권한의 역할 합산·개별 덮어쓰기·관리자 우선순위',()=>{
    assert.equal(canSend(guild,roles,bot,channel),true);
    assert.equal(canSend(guild,roles,bot,{...channel,permission_overwrites:[{id:'21',type:0,deny:'2048',allow:'0'}]}),false);
    assert.equal(canSend(guild,roles,bot,{...channel,permission_overwrites:[{id:'20',type:0,deny:'1024',allow:'0'},{id:'21',type:0,deny:'0',allow:'1024'}]}),true);
    assert.equal(canSend(guild,roles,bot,{...channel,permission_overwrites:[{id:'1',type:1,deny:'16384',allow:'0'}]}),false);
    assert.equal(canSend(guild,roles,{user:{id:'90'},roles:[]},{...channel,permission_overwrites:[{id:'90',type:1,deny:'19456',allow:'0'}]}),true);
  });
  await test('기존 서버 알림 설정을 보존하고 재실행으로 덮어쓰지 않는다',async()=>{
    await seedLegacyGuild(env);assert.equal((await settings('2')).channel_id,'3');await db.prepare("UPDATE guild_settings SET channel_id='4' WHERE guild_id='2'").run();await seedLegacyGuild(env);assert.equal((await settings('2')).channel_id,'4');
  });
  await test('새 서버는 채널 선택 전 알림 없이 환영 메뉴를 한 번만 받는다',async()=>{
    await recordGuildEvent(env,'GUILD_CREATE','20');assert.equal((await settings('20')).channel_id,null);
    await Promise.all([sendWelcome(env,'20'),sendWelcome(env,'20')]);await recordGuildEvent(env,'GUILD_CREATE','20');await sendWelcome(env,'20');
    assert.equal(sent.length,1);assert.equal(sent[0].path,'/channels/31/messages');assert.match(sent[0].body.content,/^반가워요! 저는 Tibo봇이에요\./);assert.equal(sent[0].body.components[0].components[0].type,8);assert.deepEqual(sent[0].body.allowed_mentions,{parse:[]});
  });
  await test('서버 관리자 선택은 저장하며 과거 요청이 최신 설정을 되돌리지 않는다',async()=>{
    assert.match(await configureGuild(env,job),/<#30>/);const first=await settings('20');assert.ok(first.activated_at>0);
    await db.prepare("UPDATE guild_settings SET channel_id='31',config_event='200' WHERE guild_id='20'").run();
    assert.match(await configureGuild(env,job),/최근/);assert.equal((await settings('20')).channel_id,'31');
    assert.match(await configureGuild(env,{...job,interactionId:'201'}),/<#30>/);assert.equal((await settings('20')).activated_at,first.activated_at);
  });
  await test('타 서버 채널·음성 채널·봇 권한 부족은 기존 설정을 유지한다',async()=>{
    for(const change of [{guild_id:'99'},{type:2},{permission_overwrites:[{type:1,id:'1',deny:'2048',allow:'0'}]}]){
      const saved=channel;channel={...channel,...change};assert.doesNotMatch(await configureGuild(env,{...job,interactionId:'202'}),/이제/);assert.equal((await settings('20')).config_event,'201');channel=saved;
    }
  });
  await test('Queue 처리 시 관리자 권한이 회수된 사용자를 재검증한다',async()=>{
    const saved=admin;admin={user:{id:'91'},roles:[]};assert.match(await configureGuild(env,{...job,interactionId:'202'}),/서버 관리/);assert.equal((await settings('20')).config_event,'201');admin=saved;
  });
  await test('한 서버의 전송 실패가 다른 서버를 막거나 중복 발송하지 않는다',async()=>{
    const now=Date.now();await queueDeliveries(env,{id:'500',message_id:null,discovered_at:now},'synthetic post','link');failChannel='30';
    await Promise.all([delivery('500','2'),delivery('500','20')]);
    const rows=(await db.prepare("SELECT * FROM post_deliveries WHERE post_id='500' ORDER BY guild_id").all()).results;
    assert.equal(rows.find(r=>r.guild_id==='2').phase,'done');assert.equal(rows.find(r=>r.guild_id==='20').phase,'failed');
    const before=sent.length;await delivery('500','2');assert.equal(sent.length,before);failChannel=null;
  });
  await test('선택 전에 발견한 과거 글은 새 서버에 발송하지 않는다',async()=>{
    await queueDeliveries(env,{id:'501',message_id:null,discovered_at:0},'old post','link');assert.equal(await db.prepare("SELECT * FROM post_deliveries WHERE post_id='501' AND guild_id='20'").first(),null);
  });
  await test('전송 대기 중 채널 변경 시 이전 채널에 보내지 않는다',async()=>{
    await queueDeliveries(env,{id:'502',message_id:null,discovered_at:Date.now()},'pending post','link');await db.prepare("UPDATE guild_settings SET channel_id='31' WHERE guild_id='20'").run();const before=sent.length;await delivery('502','20');assert.equal(sent.length,before);assert.equal((await db.prepare("SELECT phase FROM post_deliveries WHERE post_id='502' AND guild_id='20'").first()).phase,'cancelled');
  });
  await test('일시적인 서버 unavailable은 설정을 유지하고 실제 퇴장만 비활성화한다',async()=>{
    await recordGuildEvent(env,'GUILD_DELETE','20',true);assert.equal((await settings('20')).active,1);await recordGuildEvent(env,'GUILD_DELETE','20');assert.equal((await settings('20')).active,0);assert.equal((await settings('20')).channel_id,null);
    await recordGuildEvent(env,'GUILD_CREATE','20');assert.equal((await settings('20')).active,1);assert.equal((await settings('20')).channel_id,null);assert.equal((await settings('20')).welcome_message_id,null);
  });
}finally{globalThis.fetch=originalFetch;await mf.dispose();}
