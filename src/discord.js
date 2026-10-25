import {validId,canManage,channelMenu,configureGuild,seedLegacyGuild} from './guild-settings.js';
import {readLimitedText,discordPlainText} from './input.js';
import {gatewayStatus} from './gateway.js';
import {collectLatestPost} from './collector.js';
import {analyzePost} from './gemini.js';
import {readWatchStatus} from './watch-store.js';
import {statusMessage} from './status-view.js';

const jobKinds = ['discord-collect', 'discord-analyze', 'discord-reply', 'discord-configure'];
const privateReply = content => Response.json({type:4,data:{content,flags:64,allowed_mentions:{parse:[]}}});

function bytesFromHex(value, length) {
  if(typeof value!=='string'||value.length!==length*2||!/^[0-9a-f]+$/i.test(value))return null;
  return Uint8Array.from(value.match(/../g), part=>parseInt(part,16));
}

export async function handleDiscord(request, env) {
  if(request.method!=='POST')return new Response('Method not allowed',{status:405});
  const key=bytesFromHex(env.DISCORD_PUBLIC_KEY,32);
  if(!key)return new Response('Verification is not configured',{status:503});
  const signature=bytesFromHex(request.headers.get('X-Signature-Ed25519'),64);
  const timestamp=request.headers.get('X-Signature-Timestamp');
  if(!signature||!timestamp||!/^\d{1,12}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300)return new Response('Unauthorized',{status:401});
  let raw;
  try{raw=await readLimitedText(request,65536);}catch(error){return new Response('Invalid request body',{status:error.code==='body_too_large'?413:400});}
  const publicKey=await crypto.subtle.importKey('raw',key,{name:'Ed25519'},false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',publicKey,signature,new TextEncoder().encode(timestamp+raw)))return new Response('Unauthorized',{status:401});
  let interaction;
  try{interaction=JSON.parse(raw);}catch{return new Response('Invalid JSON',{status:400});}
  if(!interaction||typeof interaction!=='object'||Array.isArray(interaction))return new Response('Invalid interaction',{status:400});
  if(interaction.type===1)return Response.json({type:1});
  if(interaction.application_id!==env.DISCORD_APPLICATION_ID)return privateReply('이 앱의 명령이 아닙니다.');
  const setup=interaction.type===2&&interaction.data?.name==='알림설정';
  const selection=interaction.type===3&&interaction.data?.custom_id==='tibo:notify-channel';
  if(setup||selection){
    if(!validId(interaction.guild_id)||!interaction.member)return privateReply('서버에서 실행해 주세요.');
    if(!canManage(interaction.member.permissions))return privateReply('알림 설정은 서버 관리 권한이 있는 사용자만 변경할 수 있습니다.');
    const channelId=selection?interaction.data.values?.[0]:interaction.data.options?.find(option=>option.name==='채널')?.value;
    if(setup&&!channelId)return Response.json({type:4,data:{content:'Tibo 메시지를 받을 채널을 선택해 주세요.',components:channelMenu(),flags:64,allowed_mentions:{parse:[]}}});
    if(!validId(channelId)||!validId(interaction.id)||!validId(interaction.member.user?.id)||typeof interaction.token!=='string'||!interaction.token||interaction.token.length>2048)return privateReply('올바른 채널을 선택해 주세요.');
    try{
      await env.PROBE_JOBS.send({kind:'discord-configure',guildId:interaction.guild_id,channelId,userId:interaction.member.user.id,interactionId:interaction.id,interactionToken:interaction.token,expiresAt:Date.now()+14*60*1000});
      return Response.json({type:5,data:{flags:64}});
    }catch{return privateReply('설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');}
  }
  if(interaction.type!==2||interaction.data?.name!=='상태')return privateReply('이 앱은 /알림설정, /상태 명령을 지원합니다.');
  if(!validId(interaction.guild_id)||!interaction.member)return privateReply('서버에서 실행해 주세요.');
  if(interaction.data.name==='상태'){
    if(env.WATCH_ENABLED!=='true')return privateReply('자동 알림이 꺼져 있습니다.');
    try{
      await seedLegacyGuild(env);
      const settings=await env.DB.prepare('SELECT channel_id FROM guild_settings WHERE guild_id=? AND active=1').bind(interaction.guild_id).first();
      const {state,counts}=await readWatchStatus(env.DB);
      const delivery=await env.DB.prepare('SELECT phase,COUNT(*) AS count FROM post_deliveries WHERE guild_id=? GROUP BY phase').bind(interaction.guild_id).all();
      const gateway=await gatewayStatus(env);
      return Response.json({type:4,data:statusMessage({state,counts,delivery:delivery.results,gateway,channelId:settings?.channel_id})});
    }catch{return privateReply('자동 알림 상태를 읽지 못했습니다. 배포 설정을 확인해 주세요.');}
  }

}

async function updateOriginal(env, job, content) {
  // 같은 원본 메시지를 수정하므로 큐가 재전달돼도 후속 메시지가 늘어나지 않는다.
  const response=await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${encodeURIComponent(job.interactionToken)}/messages/@original`,{
    method:'PATCH',redirect:'manual',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),
    body:JSON.stringify({content:Array.from(content).slice(0,1900).join(''),allowed_mentions:{parse:[]}}),
  });
  if(!response.ok&&response.status!==401&&response.status!==404)throw new Error('Discord response status '+response.status);
  await response.body?.cancel();
  return response.ok;
}

export async function processDiscordJob(message, env) {
  const job=message.body;
  if(!jobKinds.includes(job?.kind))return false;
  if(typeof job.interactionToken!=='string'||!Number.isFinite(job.expiresAt)||Date.now()>job.expiresAt){message.ack();return true;}
  try{
    // 무료 Worker의 CPU 제한을 위해 수집·AI 분석·답변을 서로 다른 실행으로 나눈다.
    if(job.kind==='discord-configure'){
      let content;
      try{content=await configureGuild(env,job);}catch(error){if(![403,404].includes(error.status))throw error;content='서버 또는 채널에 접근할 수 없습니다. 봇 권한과 서버 관리 권한을 확인해 주세요. 기존 설정은 유지됩니다.';}
      await updateOriginal(env,job,content);
    }else if(job.kind==='discord-collect'){
      const post=await collectLatestPost(env.NITTER_BASE_URL);
      await env.PROBE_JOBS.send({...job,kind:'discord-analyze',post});
    }else if(job.kind==='discord-analyze'){
      const analysis=await analyzePost(env,job.post);
      await env.PROBE_JOBS.send({...job,kind:'discord-reply',analysis});
    }else{
      const db=await env.DB.prepare('SELECT 1 AS ok').first();
      if(db.ok!==1)throw new Error('D1 verification failed');
      const content=`검증 완료 · Cloudflare에서 실행\n수집: Tibo의 게시글/답글 1개\nGemini: ${job.analysis.category}\n${discordPlainText(job.analysis.summary_ko)}\nD1 연결·Queue 처리 확인\n원문: https://x.com/thsottiaux/status/${job.post.id}\n※ 현재 수집·분석 경로의 단발 검증이며 전체 글 수집이나 다음 초기화 시각을 보장하지 않습니다.`;
      const delivered=await updateOriginal(env,job,content);
      console.log(JSON.stringify({probe:'tibo-bot',event:'discord-result',interactionId:job.interactionId,delivered,postId:job.post.id,category:job.analysis.category,usage:job.analysis.usage}));
    }
    message.ack();
    console.log(JSON.stringify({probe:'tibo-bot',event:'discord-stage',kind:job.kind,interactionId:job.interactionId,action:'ack'}));
  }catch(error){
    // 토큰이 포함될 수 있는 외부 요청 URL과 오류 원문은 로그에 남기지 않는다.
    if(message.attempts<3){message.retry({delaySeconds:30});}
    else{
      try{await updateOriginal(env,job,job.kind==='discord-configure'?(error.setupSaved?'알림 채널 설정은 저장됐지만 확인 메시지를 보내지 못했습니다. /상태로 설정된 채널과 봇 권한을 확인해 주세요.':'채널 설정을 완료하지 못했습니다. 잠시 후 /알림설정으로 다시 시도해 주세요.'):'검증을 완료하지 못했습니다. 수집원 상태 또는 Gemini 무료 한도를 확인해 주세요.');}catch{}
      message.ack();
    }
    console.log(JSON.stringify({probe:'tibo-bot',event:'discord-stage',kind:job.kind,interactionId:job.interactionId,action:message.attempts<3?'retry':'failed'}));
  }
  return true;
}
