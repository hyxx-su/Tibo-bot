import {readLimitedText} from './input.js';

export const validId=value=>typeof value==='string'&&/^\d{1,20}$/.test(value);
export const canManage=permissions=>typeof permissions==='string'&&/^\d{1,30}$/.test(permissions)&&(BigInt(permissions)&40n)!==0n;
export const notificationTypes=['posts','resets','both'];
export const notificationLabel=type=>type==='posts'?'Tibo 게시글':type==='resets'?'리셋 확인':'게시글·리셋 확인';
export const channelMenu=()=>['posts','resets'].flatMap(type=>[
  {type:1,components:[{type:8,custom_id:`tibo:channel:${type}`,channel_types:[0,5],placeholder:`${notificationLabel(type)} 알림을 받을 채널`,min_values:1,max_values:1}]},
  {type:1,components:[{type:2,style:2,custom_id:`tibo:off:${type}`,label:`${notificationLabel(type)} 알림 끄기`}]},
]);
export const channelSettingsContent=row=>`알림 종류별로 채널을 선택하거나 끌 수 있어요.\n게시글에는 초기화 예정·진행 안내도 포함됩니다.\n\nTibo 게시글: ${row?.channel_id?`<#${row.channel_id}>`:'꺼짐'}\n리셋 확인: ${row?.reset_channel_id?`<#${row.reset_channel_id}>`:'꺼짐'}`;
export const welcomeContent='반가워요! 저는 Tibo봇이에요.\n이제부터 이 채널에서 Tibo 게시글과 리셋 확인 알림을 보내드릴게요.\n서버 관리자는 아래 메뉴 또는 `/채널`에서 종류별로 채널을 바꾸거나 알림을 끌 수 있어요.';
const needsSetup='(setup_complete=0 OR reselect_needed=1)';

export async function discordApi(env,path,options={}) {
  const response=await fetch('https://discord.com/api/v10'+path,{...options,redirect:'manual',headers:{Authorization:'Bot '+env.DISCORD_BOT_TOKEN,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok){
    const error=new Error('Discord API failed');error.status=response.status;
    if(response.status===429){
      const data=await readLimitedText(response,16384).then(JSON.parse).catch(()=>({}));
      const delays=[data?.retry_after,response.headers.get('Retry-After')].map(Number).filter(value=>Number.isFinite(value)&&value>0);
      // 더 긴 대기 지시를 우선하며 응답 원문이나 토큰은 오류에 담지 않는다.
      error.retryAfter=delays.length?Math.ceil(Math.max(...delays)):60;
    }else if(response.status===404){
      const data=await readLimitedText(response,16384).then(JSON.parse).catch(()=>({}));
      if(data.code===10003)error.discordCode=10003;
    }else await response.body?.cancel();
    throw error;
  }
  return JSON.parse(await readLimitedText(response,1048576));
}

export function memberPermissions(guild,roles,member) {
  if(guild.owner_id===member.user?.id)return 8n;
  return roles.filter(role=>role.id===guild.id||member.roles?.includes(role.id)).reduce((bits,role)=>bits|BigInt(role.permissions),0n);
}

export function canSend(guild,roles,member,channel) {
  let permissions=memberPermissions(guild,roles,member);
  if(permissions&8n)return true;
  const overwrites=channel.permission_overwrites??[];
  const everyone=overwrites.find(o=>o.type===0&&o.id===guild.id);
  if(everyone)permissions=(permissions&~BigInt(everyone.deny))|BigInt(everyone.allow);
  let allow=0n,deny=0n;
  for(const o of overwrites)if(o.type===0&&member.roles?.includes(o.id)){allow|=BigInt(o.allow);deny|=BigInt(o.deny);}
  permissions=(permissions&~deny)|allow;
  const own=overwrites.find(o=>o.type===1&&o.id===member.user?.id);
  if(own)permissions=(permissions&~BigInt(own.deny))|BigInt(own.allow);
  return (permissions&19456n)===19456n; // VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS
}

export async function seedLegacyGuild(env) {
  const channel=env.DISCORD_NOTIFY_CHANNEL_ID??env.DISCORD_TEST_CHANNEL_ID;
  if(validId(env.DISCORD_TEST_GUILD_ID)&&validId(channel))await env.DB.prepare('INSERT OR IGNORE INTO guild_settings (guild_id,channel_id,reset_channel_id,setup_complete) VALUES (?,?,?,1)').bind(env.DISCORD_TEST_GUILD_ID,channel,channel).run();
}

export async function configureGuild(env,job) {
  const type=job.notificationType??'both',off=job.disable===true;
  if(!notificationTypes.includes(type)||![job.guildId,job.userId,job.interactionId].every(validId)||(!off&&!validId(job.channelId)))return '올바른 서버와 알림 종류·채널을 선택해 주세요.';
  const [guild,roles,member,bot,channel]=await Promise.all([
    discordApi(env,`/guilds/${job.guildId}`),discordApi(env,`/guilds/${job.guildId}/roles`),discordApi(env,`/guilds/${job.guildId}/members/${job.userId}`),
    off?null:discordApi(env,`/guilds/${job.guildId}/members/${env.DISCORD_APPLICATION_ID}`),off?null:discordApi(env,`/channels/${job.channelId}`),
  ]);
  if((memberPermissions(guild,roles,member)&40n)===0n)return '알림 설정은 서버 관리 권한이 있는 사용자만 변경할 수 있습니다.';
  if(!off&&(channel.guild_id!==job.guildId||![0,5].includes(channel.type)))return '이 서버의 텍스트 채널을 선택해 주세요.';
  if(!off&&!canSend(guild,roles,bot,channel))return '선택한 채널에서 봇의 채널 보기·메시지 보내기·링크 임베드 권한을 허용해 주세요. 기존 설정은 유지됩니다.';
  const now=Date.now(),channelId=off?null:job.channelId;
  const types=type==='both'?['posts','resets']:[type];
  // 종류별 요청 순서를 비교한다. 한 종류의 새 요청이 다른 종류의 설정을 막지 않는다.
  const assignments=[],guards=[],values=[];
  for(const kind of types){
    const prefix=kind==='posts'?'':'reset_',col=kind==='posts'?'channel_id':'reset_channel_id';
    assignments.push(`${prefix}activated_at=CASE WHEN ${col} IS NULL OR active=0 THEN ? ELSE ${prefix}activated_at END`,`${col}=?`,`${prefix}config_event=?`);
    values.push(now,channelId,job.interactionId);
    guards.push(`CAST(${prefix}config_event AS INTEGER)<=CAST(? AS INTEGER)`);
  }
  const cancellations=types.map(kind=>{
    const prefix=kind==='posts'?'':'reset_',col=kind==='posts'?'channel_id':'reset_channel_id';
    const kinds=kind==='posts'?"('link','reset')":"('site-reset')";
    return env.DB.prepare(`UPDATE post_deliveries SET phase='cancelled',lease_until=0,claim_token=NULL
      WHERE guild_id=? AND kind IN ${kinds} AND phase IN ('pending','failed') AND channel_id IS NOT ?
      AND EXISTS(SELECT 1 FROM guild_settings WHERE guild_id=? AND ${prefix}config_event=? AND ${col} IS ?)`)
      .bind(job.guildId,channelId,job.guildId,job.interactionId,channelId);
  });
  const results=await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO guild_settings(guild_id) VALUES(?)').bind(job.guildId),
    env.DB.prepare(`UPDATE guild_settings SET ${assignments.join(',')},active=1,setup_complete=1,reselect_needed=0 WHERE guild_id=? AND ${guards.join(' AND ')} RETURNING *`).bind(...values,job.guildId,...types.map(()=>job.interactionId)),
    ...cancellations,
  ]);
  const saved=results[1].results[0];
  if(!saved)return '더 최근의 채널 설정이 있어 이 요청은 적용하지 않았습니다. /채널으로 확인해 주세요.';
  const label=notificationLabel(type);
  if(off)return `${label} 알림을 껐어요. 다시 받으려면 /채널에서 채널을 선택해 주세요.`;
  try{
    await discordApi(env,`/channels/${channelId}/messages`,{method:'POST',body:JSON.stringify({
      embeds:[{title:'✅ 알림 채널 설정 완료',description:`이제부터 이 채널에서 ${label} 알림을 보내드릴게요.`,color:0x57F287}],
      allowed_mentions:{parse:[]},nonce:'c'+job.interactionId,enforce_nonce:true,
    })});
  }catch(error){
    if([403,404].includes(error.status))return `${label} 알림 채널은 <#${channelId}>로 저장됐지만, 해당 채널에 확인 메시지를 보내지 못했습니다. 봇의 채널 보기·메시지 보내기·링크 임베드 권한을 확인해 주세요.`;
    error.setupSaved=true;throw error;
  }
  return `이제 <#${channelId}>에서 ${label} 알림을 보내드릴게요!\n다른 채널로 바꾸거나 끄려면 /채널을 사용해 주세요.`;
}

export async function recordGuildEvent(env,type,guildId,unavailable=false) {
  if(!validId(guildId)||unavailable)return;
  if(type==='GUILD_DELETE'){
    await env.DB.prepare('UPDATE guild_settings SET active=0,channel_id=NULL,reset_channel_id=NULL,setup_complete=0,reselect_needed=0,welcome_message_id=NULL,welcome_channel_id=NULL WHERE guild_id=?').bind(guildId).run();return;
  }
  await seedLegacyGuild(env);
  await env.DB.prepare('INSERT INTO guild_settings (guild_id) VALUES (?) ON CONFLICT(guild_id) DO UPDATE SET active=1').bind(guildId).run();
  await env.PROBE_JOBS.send({kind:'guild-welcome',guildId});
}

export async function recordChannelDeletion(env,guildId,channelId) {
  if(!validId(guildId)||!validId(channelId))return;
  // 삭제된 목적지에 해당하는 종류만 중단한다. 다른 채널의 구독은 유지한다.
  const [changed]=await env.DB.batch([
    env.DB.prepare(`UPDATE guild_settings SET
      channel_id=CASE WHEN channel_id=? THEN NULL ELSE channel_id END,
      reset_channel_id=CASE WHEN reset_channel_id=? THEN NULL ELSE reset_channel_id END,
      reselect_needed=1,welcome_message_id=NULL,welcome_lease_until=0
      WHERE guild_id=? AND (channel_id=? OR reset_channel_id=?) AND active=1 RETURNING guild_id`).bind(channelId,channelId,guildId,channelId,channelId),
    env.DB.prepare(`UPDATE post_deliveries SET phase='cancelled',lease_until=0,claim_token=NULL
      WHERE guild_id=? AND channel_id=? AND phase IN ('pending','failed') AND kind!='site-correction'
      AND EXISTS(SELECT 1 FROM guild_settings WHERE guild_id=? AND active=1 AND reselect_needed=1)`).bind(guildId,channelId,guildId),
  ]);
  if(!changed.results.length)return;
  await env.PROBE_JOBS.send({kind:'guild-channel-reselect',guildId});
}

export async function pendingSetupJobs(db,now) {
  const {results}=await db.prepare(`SELECT guild_id,reselect_needed FROM guild_settings
    WHERE active=1 AND ${needsSetup} AND welcome_message_id IS NULL AND welcome_lease_until<=? ORDER BY welcome_lease_until,guild_id LIMIT 10`).bind(now).all();
  return results.map(row=>({body:{kind:row.reselect_needed?'guild-channel-reselect':'guild-welcome',guildId:row.guild_id}}));
}

export async function checkNotificationChannel(env,guildId) {
  if(!validId(guildId))return;
  const row=await env.DB.prepare('SELECT channel_id,reset_channel_id FROM guild_settings WHERE guild_id=? AND active=1').bind(guildId).first();
  for(const channelId of new Set([row?.channel_id,row?.reset_channel_id].filter(validId))){
    try{await discordApi(env,`/channels/${channelId}`);}
    catch(error){
      if(error.discordCode===10003)await recordChannelDeletion(env,guildId,channelId);
      else if(error.status!==403)throw error;
    }
  }
}

export async function sendWelcome(env,guildId,reselect=false) {
  if(!validId(guildId))return;
  const now=Date.now(),lease=now+90000;
  const row=await env.DB.prepare(`UPDATE guild_settings SET welcome_lease_until=? WHERE guild_id=? AND active=1 AND ${needsSetup} AND welcome_message_id IS NULL AND welcome_lease_until<=? RETURNING *`).bind(lease,guildId,now).first();
  if(!row)return;
  // 재연결의 환영 작업이 먼저 도착해도 이전 설정이 있으면 재선택 안내를 유지한다.
  reselect=Boolean(row.reselect_needed);
  let retryAt=0;
  try{
    const [guild,roles,bot,channels]=await Promise.all([discordApi(env,`/guilds/${guildId}`),discordApi(env,`/guilds/${guildId}/roles`),discordApi(env,`/guilds/${guildId}/members/${env.DISCORD_APPLICATION_ID}`),discordApi(env,`/guilds/${guildId}/channels`)]);
    const eligible=channels.filter(c=>[0,5].includes(c.type)&&canSend(guild,roles,bot,c)).sort((a,b)=>(a.position??0)-(b.position??0));
    eligible.sort((a,b)=>Number(b.id===guild.system_channel_id)-Number(a.id===guild.system_channel_id));
    const nonce=reselect?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`setup:${guildId}:${row.config_event}:${row.reset_config_event}:${row.activated_at}:${row.reset_activated_at}`))),b=>b.toString(16).padStart(2,'0')).join('').slice(0,24):'w'+guildId;
    for(const channel of eligible){
      const current=await env.DB.prepare(`SELECT guild_id FROM guild_settings WHERE guild_id=? AND active=1 AND ${needsSetup} AND welcome_message_id IS NULL AND welcome_lease_until=?`).bind(guildId,lease).first();
      if(!current)return;
      try{
        const message=await discordApi(env,`/channels/${channel.id}/messages`,{method:'POST',body:JSON.stringify({
          ...(reselect?{embeds:[{title:'알림 채널을 다시 선택해 주세요',description:'삭제된 채널의 알림만 일시 중지했어요. 다른 채널의 알림은 유지됩니다.\n서버 관리자는 아래에서 새 채널을 선택하거나 `/채널`을 사용해 주세요.',color:0xFEE75C}]}:{content:welcomeContent}),
          components:channelMenu(),allowed_mentions:{parse:[]},nonce,enforce_nonce:true,
        })});
        // 신규 서버만 두 종류를 기본 채널에 연결한다. 재선택 안내는 사용자의 꺼짐 설정을 켜지 않는다.
        await env.DB.prepare(`UPDATE guild_settings SET welcome_message_id=?,welcome_channel_id=?,
          channel_id=CASE WHEN setup_complete=0 AND reselect_needed=0 THEN ? ELSE channel_id END,
          reset_channel_id=CASE WHEN setup_complete=0 AND reselect_needed=0 THEN ? ELSE reset_channel_id END,
          activated_at=CASE WHEN setup_complete=0 AND reselect_needed=0 THEN ? ELSE activated_at END,
          reset_activated_at=CASE WHEN setup_complete=0 AND reselect_needed=0 THEN ? ELSE reset_activated_at END,setup_complete=1
          WHERE guild_id=? AND active=1 AND ${needsSetup} AND welcome_lease_until=?`).bind(message.id,channel.id,channel.id,channel.id,now,now,guildId,lease).run();
        return;
      }catch(error){if(![403,404].includes(error.status))throw error;}
    }
    retryAt=Date.now()+600000;
  }catch(error){retryAt=Date.now()+120000;throw error;}
  finally{await env.DB.prepare('UPDATE guild_settings SET welcome_lease_until=? WHERE guild_id=? AND welcome_lease_until=?').bind(retryAt,guildId,lease).run();}
}

export async function processGuildJob(message,env) {
  if(!['guild-welcome','guild-channel-reselect'].includes(message.body?.kind))return false;
  try{
    if(message.body.kind==='guild-welcome')await checkNotificationChannel(env,message.body.guildId);
    await sendWelcome(env,message.body.guildId,message.body.kind==='guild-channel-reselect');message.ack();
  }
  catch{if(message.attempts<3)message.retry({delaySeconds:120});else message.ack();console.log(JSON.stringify({service:'tibo-bot',event:'welcome-failed'}));}
  return true;
}
