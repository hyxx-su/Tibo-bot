import {noAnnouncementReplies,selectNoAnnouncementReplyIndex} from './reset-replies.js';
const validQuestionHash=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);

// 서명 검증 또는 내부 Gateway 경로에서만 호출하며 재시작·동시 요청에도 한도를 유지한다.
export class DiscordCommandGuard {
  constructor(ctx) {this.ctx=ctx;}

  async fetch(request) {
    if(request.method==='POST'&&new URL(request.url).pathname==='/chat-claim')return this.claimChat(await request.json());
    if(request.method!=='POST'||new URL(request.url).pathname!=='/claim')return new Response('Not found',{status:404});
    const input=await request.json();
    if(typeof input.id!=='string'||!/^\d{1,20}$/.test(input.id))return new Response('Invalid interaction',{status:400});
    return this.ctx.blockConcurrencyWhile(async()=>{
      const now=Date.now();const day=new Date(now).toISOString().slice(0,10);
      const state=await this.ctx.storage.get('budget')??{day,count:0,nextAt:0,seen:[]};
      state.seen=state.seen.filter(entry=>entry.expiresAt>now);
      if(state.seen.some(entry=>entry.id===input.id))return Response.json({result:'duplicate'});
      if(state.day!==day){state.day=day;state.count=0;}
      if(state.count>=20||state.nextAt>now)return Response.json({result:'limited'});
      state.count++;state.nextAt=now+60000;state.seen.push({id:input.id,expiresAt:now+600000});
      await this.ctx.storage.put('budget',state);
      return Response.json({result:'accepted'});
    });
  }

  async claimChat(input) {
    if(![input?.messageId,input?.guildId,input?.channelId,input?.userId].every(value=>typeof value==='string'&&/^\d{1,20}$/.test(value)))return new Response('Invalid question',{status:400});
    if(input.questionHash!==undefined&&!validQuestionHash(input.questionHash))return new Response('Invalid question fingerprint',{status:400});
    return this.ctx.blockConcurrencyWhile(async()=>{
      const now=Date.now(),day=new Date(now).toISOString().slice(0,10);
      const state=await this.ctx.storage.get('chat-budget')??{day,count:0,nextAt:0,seen:[]};
      state.seen=state.seen.filter(entry=>entry.expiresAt>now);
      if(state.seen.some(entry=>entry.id===input.messageId))return Response.json({result:'duplicate'});
      if(state.day!==day){state.day=day;state.count=0;}
      const burst=state.seen.filter(entry=>entry.acceptedAt>now-10000);
      // 여러 서버가 동시에 호출해도 한 저장 값의 크기 제한을 넘지 않게 기록 수를 제한한다.
      if(state.count>=1000||state.seen.length>=500||burst.filter(entry=>entry.userId===input.userId).length>=8||burst.filter(entry=>entry.channelId===input.channelId).length>=30)return Response.json({result:'limited'});
      const previous=validQuestionHash(input.questionHash)?state.seen.filter(entry=>entry.guildId===input.guildId&&entry.channelId===input.channelId&&entry.userId===input.userId&&entry.phrase===input.questionHash&&entry.acceptedAt>now-300000):[];
      const repeatCount=previous.length;
      const recent=state.seen.filter(entry=>entry.guildId===input.guildId&&entry.channelId===input.channelId&&Number.isInteger(entry.choice)).map(entry=>entry.choice);
      const replyIndex=selectNoAnnouncementReplyIndex(recent);
      state.count++;state.seen.push({id:input.messageId,guildId:input.guildId,channelId:input.channelId,userId:input.userId,acceptedAt:now,expiresAt:now+600000,phrase:input.questionHash,choice:replyIndex});
      await this.ctx.storage.put('chat-budget',state);
      return Response.json({result:'accepted',repeatCount,replyIndex});
    });
  }
}

export async function claimResetQuestion(env,job) {
  if(!env.COMMAND_GUARD)throw new Error('Question guard missing');
  const stub=env.COMMAND_GUARD.get(env.COMMAND_GUARD.idFromName('discord-reset-chat'));
  const response=await stub.fetch('https://guard.internal/chat-claim',{method:'POST',body:JSON.stringify({messageId:job.messageId,guildId:job.guildId,channelId:job.channelId,userId:job.userId,questionHash:job.questionHash})});
  if(!response.ok)throw new Error('Question guard unavailable');
  const {result,repeatCount=0,replyIndex}=await response.json();
  if(!['accepted','duplicate','limited'].includes(result))throw new Error('Invalid question guard result');
  if(!Number.isInteger(repeatCount)||repeatCount<0||repeatCount>1000)throw new Error('Invalid question repetition');
  if(replyIndex!==undefined&&(!Number.isInteger(replyIndex)||replyIndex<0||replyIndex>=noAnnouncementReplies.length))throw new Error('Invalid question reply index');
  return {result,repeatCount,replyIndex};
}

export async function claimVerification(env,id) {
  if(!env.COMMAND_GUARD)throw new Error('Command guard missing');
  const stub=env.COMMAND_GUARD.get(env.COMMAND_GUARD.idFromName('discord-verification'));
  const response=await stub.fetch('https://guard.internal/claim',{method:'POST',body:JSON.stringify({id})});
  if(!response.ok)throw new Error('Command guard unavailable');
  const {result}=await response.json();
  if(!['accepted','duplicate','limited'].includes(result))throw new Error('Invalid command guard result');
  return result;
}
