import {readLimitedText} from './input.js';

export async function sendNotification(env,postId,content,kind,messageId=null,channelOverride=null) {
  const channel=channelOverride??env.DISCORD_NOTIFY_CHANNEL_ID??env.DISCORD_TEST_CHANNEL_ID;
  if(!env.DISCORD_BOT_TOKEN||!/^\d+$/.test(channel??''))throw new Error('Notification configuration missing');
  if(messageId!==null&&!/^\d{1,20}$/.test(messageId))throw new Error('Invalid notification ID');
  const payload={content:Array.from(content).slice(0,1900).join(''),allowed_mentions:{parse:[]}};
  const legacy=channel===(env.DISCORD_NOTIFY_CHANNEL_ID??env.DISCORD_TEST_CHANNEL_ID);
  const nonce=legacy?`${kind==='link'?'l':'r'}${postId}`:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${channel}:${kind}:${postId}`))),b=>b.toString(16).padStart(2,'0')).join('').slice(0,24);
  if(messageId)payload.flags=0;else Object.assign(payload,{nonce,enforce_nonce:true});
  const response=await fetch(`https://discord.com/api/v10/channels/${channel}/messages${messageId?'/'+messageId:''}`,{
    method:messageId?'PATCH':'POST',redirect:'manual',headers:{Authorization:'Bot '+env.DISCORD_BOT_TOKEN,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),
    body:JSON.stringify(payload),
  });
  if(messageId&&response.status===404){await response.body?.cancel();return sendNotification(env,postId,content,kind,null,channel);}
  if(!response.ok){
    const error=new Error('Notification failed');error.code='discord_'+response.status;error.permanent=[400,401,403,404].includes(response.status);
    if(response.status===429){const data=await readLimitedText(response,16384).then(JSON.parse).catch(()=>({}));error.retryAfter=Math.min(86400,Math.ceil(Number(data.retry_after)||60));}
    else await response.body?.cancel();
    throw error;
  }
  const data=JSON.parse(await readLimitedText(response,16384));
  if(typeof data.id!=='string')throw new Error('Notification ID missing');
  return data.id;
}

