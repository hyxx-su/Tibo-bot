import {collectLatestPost} from './collector.js';
import {analyzePost} from './gemini.js';
import {readWatchStatus} from './watch-store.js';
import {formatKoreanTime} from './reset-time.js';

const jobKinds = ['discord-collect', 'discord-analyze', 'discord-reply'];
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
  if(!signature||!timestamp||!/^\d+$/.test(timestamp))return new Response('Unauthorized',{status:401});
  const raw=await request.text();
  if(raw.length>65536)return new Response('Payload too large',{status:413});
  const publicKey=await crypto.subtle.importKey('raw',key,{name:'Ed25519'},false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',publicKey,signature,new TextEncoder().encode(timestamp+raw)))return new Response('Unauthorized',{status:401});
  let interaction;
  try{interaction=JSON.parse(raw);}catch{return new Response('Invalid JSON',{status:400});}
  if(!interaction||typeof interaction!=='object'||Array.isArray(interaction))return new Response('Invalid interaction',{status:400});
  if(interaction.type===1)return Response.json({type:1});
  if(interaction.type!==2||!['검증','상태'].includes(interaction.data?.name))return privateReply('이 앱은 /검증, /상태 명령을 지원합니다.');
  if(interaction.application_id!==env.DISCORD_APPLICATION_ID||interaction.guild_id!==env.DISCORD_TEST_GUILD_ID||interaction.channel_id!==env.DISCORD_TEST_CHANNEL_ID)return privateReply('설정된 서버와 채널에서 실행해 주세요.');
  if(interaction.data.name==='상태'){
    if(env.WATCH_ENABLED!=='true')return privateReply('자동 알림이 꺼져 있습니다.');
    try{
      const {state,counts}=await readWatchStatus(env.DB);
      const last=state?.last_success?formatKoreanTime(state.last_success):'아직 없음';
      const count=phase=>counts.find(row=>row.phase===phase)?.count??0;
      return privateReply(`자동 확인: 1분 주기\n알림 채널: <#${env.DISCORD_NOTIFY_CHANNEL_ID??env.DISCORD_TEST_CHANNEL_ID}>\n기준점: ${state?.baseline_id?'설정됨':'첫 수집 대기'}\n마지막 수집 성공: ${last}\n대기: ${count('link')+count('analyze')+count('reset')} · 완료: ${count('done')} · 실패: ${count('failed')}\n수집 상태: ${state?.last_error?'최근 오류 있음':'정상'}\n※ 미러의 갱신 지연과 수집 누락이 있을 수 있습니다.`);
    }catch{return privateReply('자동 알림 상태를 읽지 못했습니다. 배포 설정을 확인해 주세요.');}
  }
  if(typeof interaction.token!=='string'||!interaction.token||typeof interaction.id!=='string')return new Response('Invalid interaction',{status:400});
  try{
    // 분석을 기다리기 전에 작업을 큐에 보관하고 Discord에 지연 응답을 알린다.
    await env.PROBE_JOBS.send({kind:'discord-collect',interactionToken:interaction.token,interactionId:interaction.id,expiresAt:Date.now()+14*60*1000});
    return Response.json({type:5,data:{flags:64}});
  }catch{
    return privateReply('검증 작업을 큐에 넣지 못했습니다. 잠시 후 다시 실행해 주세요.');
  }
}

async function updateOriginal(env, job, content) {
  // 같은 원본 메시지를 수정하므로 큐가 재전달돼도 후속 메시지가 늘어나지 않는다.
  const response=await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${encodeURIComponent(job.interactionToken)}/messages/@original`,{
    method:'PATCH',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),
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
    if(job.kind==='discord-collect'){
      const post=await collectLatestPost(env.NITTER_BASE_URL);
      await env.PROBE_JOBS.send({...job,kind:'discord-analyze',post});
    }else if(job.kind==='discord-analyze'){
      const analysis=await analyzePost(env,job.post);
      await env.PROBE_JOBS.send({...job,kind:'discord-reply',analysis});
    }else{
      const db=await env.DB.prepare('SELECT 1 AS ok').first();
      if(db.ok!==1)throw new Error('D1 verification failed');
      const content=`검증 완료 · Cloudflare에서 실행\n수집: Tibo의 게시글/답글 1개\nGemini: ${job.analysis.category}\n${job.analysis.summary_ko}\nD1 연결·Queue 처리 확인\n원문: https://x.com/thsottiaux/status/${job.post.id}\n※ 현재 수집·분석 경로의 단발 검증이며 전체 글 수집이나 다음 초기화 시각을 보장하지 않습니다.`;
      const delivered=await updateOriginal(env,job,content);
      console.log(JSON.stringify({probe:'tibo-bot',event:'discord-result',interactionId:job.interactionId,delivered,postId:job.post.id,category:job.analysis.category,usage:job.analysis.usage}));
    }
    message.ack();
    console.log(JSON.stringify({probe:'tibo-bot',event:'discord-stage',kind:job.kind,interactionId:job.interactionId,action:'ack'}));
  }catch{
    // 토큰이 포함될 수 있는 외부 요청 URL과 오류 원문은 로그에 남기지 않는다.
    if(message.attempts<3){message.retry({delaySeconds:30});}
    else{
      try{await updateOriginal(env,job,'검증을 완료하지 못했습니다. 수집원 상태 또는 Gemini 무료 한도를 확인해 주세요.');}catch{}
      message.ack();
    }
    console.log(JSON.stringify({probe:'tibo-bot',event:'discord-stage',kind:job.kind,interactionId:job.interactionId,action:message.attempts<3?'retry':'failed'}));
  }
  return true;
}
