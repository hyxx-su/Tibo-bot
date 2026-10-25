import {readLimitedText} from './input.js';

export const validId=value=>typeof value==='string'&&/^\d{1,20}$/.test(value);
export const canManage=permissions=>typeof permissions==='string'&&/^\d{1,30}$/.test(permissions)&&(BigInt(permissions)&40n)!==0n;
export const channelMenu=()=>[{type:1,components:[{type:8,custom_id:'tibo:notify-channel',channel_types:[0,5],placeholder:'Tibo 메시지를 받을 채널을 선택하세요',min_values:1,max_values:1}]}];
export const welcomeContent='반가워요! 저는 Tibo봇이에요.\nTibo의 새 글과 초기화 안내를 받을 채널을 선택해 주세요.\n서버 관리자는 아래 메뉴 또는 `/알림설정`으로 설정할 수 있어요.';

export async function discordApi(env,path,options={}) {
  const response=await fetch('https://discord.com/api/v10'+path,{...options,redirect:'manual',headers:{Authorization:'Bot '+env.DISCORD_BOT_TOKEN,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok){await response.body?.cancel();const error=new Error('Discord API failed');error.status=response.status;throw error;}
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
  if(validId(env.DISCORD_TEST_GUILD_ID)&&validId(channel))await env.DB.prepare('INSERT OR IGNORE INTO guild_settings (guild_id,channel_id,activated_at) VALUES (?,?,0)').bind(env.DISCORD_TEST_GUILD_ID,channel).run();
}

export async function configureGuild(env,job) {
  if(![job.guildId,job.channelId,job.userId,job.interactionId].every(validId))return '올바른 서버와 채널을 선택해 주세요.';
  const [guild,roles,member,bot,channel]=await Promise.all([
    discordApi(env,`/guilds/${job.guildId}`),discordApi(env,`/guilds/${job.guildId}/roles`),discordApi(env,`/guilds/${job.guildId}/members/${job.userId}`),
    discordApi(env,`/guilds/${job.guildId}/members/${env.DISCORD_APPLICATION_ID}`),discordApi(env,`/channels/${job.channelId}`),
  ]);
  if((memberPermissions(guild,roles,member)&40n)===0n)return '알림 설정은 서버 관리 권한이 있는 사용자만 변경할 수 있습니다.';
  if(channel.guild_id!==job.guildId||![0,5].includes(channel.type))return '이 서버의 텍스트 채널을 선택해 주세요.';
  if(!canSend(guild,roles,bot,channel))return '선택한 채널에서 봇의 채널 보기·메시지 보내기·링크 임베드 권한을 허용해 주세요. 기존 설정은 유지됩니다.';
  // 오래된 메뉴 요청·Queue 재전달이 최신 선택을 덮어쓰지 않게 interaction ID 순서를 보존한다.
  const now=Date.now();
  const saved=await env.DB.prepare(`INSERT INTO guild_settings (guild_id,channel_id,active,activated_at,config_event) VALUES (?,?,1,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,active=1,
    activated_at=CASE WHEN guild_settings.channel_id IS NULL OR guild_settings.active=0 THEN excluded.activated_at ELSE guild_settings.activated_at END,
    config_event=excluded.config_event WHERE CAST(guild_settings.config_event AS INTEGER)<=CAST(excluded.config_event AS INTEGER) RETURNING channel_id`).bind(job.guildId,job.channelId,now,job.interactionId).first();
  return saved?`이제 <#${saved.channel_id}>에서 Tibo의 새 글과 초기화 안내를 보내드릴게요!\n다른 채널로 바꾸려면 /알림설정을 사용해 주세요.`:'더 최근의 채널 설정이 있어 이 요청은 적용하지 않았습니다. /알림설정으로 확인해 주세요.';
}

export async function recordGuildEvent(env,type,guildId,unavailable=false) {
  if(!validId(guildId)||unavailable)return;
  if(type==='GUILD_DELETE'){
    await env.DB.prepare('UPDATE guild_settings SET active=0,channel_id=NULL,welcome_message_id=NULL,welcome_channel_id=NULL WHERE guild_id=?').bind(guildId).run();return;
  }
  await seedLegacyGuild(env);
  await env.DB.prepare('INSERT INTO guild_settings (guild_id) VALUES (?) ON CONFLICT(guild_id) DO UPDATE SET active=1').bind(guildId).run();
  await env.PROBE_JOBS.send({kind:'guild-welcome',guildId});
}

export async function sendWelcome(env,guildId) {
  if(!validId(guildId))return;
  const now=Date.now();
  const row=await env.DB.prepare('UPDATE guild_settings SET welcome_lease_until=? WHERE guild_id=? AND active=1 AND welcome_message_id IS NULL AND welcome_lease_until<=? RETURNING *').bind(now+90000,guildId,now).first();
  if(!row)return;
  try{
    const [guild,roles,bot,channels]=await Promise.all([discordApi(env,`/guilds/${guildId}`),discordApi(env,`/guilds/${guildId}/roles`),discordApi(env,`/guilds/${guildId}/members/${env.DISCORD_APPLICATION_ID}`),discordApi(env,`/guilds/${guildId}/channels`)]);
    const eligible=channels.filter(c=>[0,5].includes(c.type)&&canSend(guild,roles,bot,c)).sort((a,b)=>(a.position??0)-(b.position??0));
    const channel=eligible.find(c=>c.id===guild.system_channel_id)??eligible[0];
    if(!channel)return;
    const message=await discordApi(env,`/channels/${channel.id}/messages`,{method:'POST',body:JSON.stringify({content:welcomeContent,components:channelMenu(),allowed_mentions:{parse:[]},nonce:'w'+guildId,enforce_nonce:true})});
    await env.DB.prepare('UPDATE guild_settings SET welcome_message_id=?,welcome_channel_id=? WHERE guild_id=? AND active=1').bind(message.id,channel.id,guildId).run();
  }finally{await env.DB.prepare('UPDATE guild_settings SET welcome_lease_until=0 WHERE guild_id=?').bind(guildId).run();}
}

export async function processGuildJob(message,env) {
  if(message.body?.kind!=='guild-welcome')return false;
  try{await sendWelcome(env,message.body.guildId);message.ack();}
  catch{if(message.attempts<3)message.retry({delaySeconds:120});else message.ack();console.log(JSON.stringify({service:'tibo-bot',event:'welcome-failed'}));}
  return true;
}
