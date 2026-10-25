// 서명 검증 뒤에만 호출한다. 재시작·동시 요청에도 검증 API의 일일 한도를 유지한다.
export class DiscordCommandGuard {
  constructor(ctx) {this.ctx=ctx;}

  async fetch(request) {
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
