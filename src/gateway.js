import {recordGuildEvent,recordChannelDeletion} from './guild-settings.js';
import {readLimitedText} from './input.js';
import {resetQuestionJob,dispatchResetQuestion} from './reset-reply.js';
import {claimResetQuestion} from './command-guard.js';
const log=event=>console.log(JSON.stringify({service:'tibo-bot',event}));
const fatalCodes=new Set([4004,4010,4011,4012,4013,4014]);

function gatewayUrl(value) {
  const url=new URL(value);
  // Discord가 제공한 주소라도 토큰을 보내는 WebSocket 목적지는 제한한다.
  if(url.protocol!=='wss:'||!(/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname))||url.username||url.password||url.port)throw new Error('Invalid gateway destination');
  url.protocol='https:';url.search='?v=10&encoding=json';
  return url;
}

export class DiscordGateway {
  constructor(ctx,env) {
    this.ctx=ctx;this.env=env;this.ws=null;this.connecting=null;this.session=null;this.seq=null;
    this.guildEvents=Promise.resolve();
    this.status='offline';this.acked=true;this.lastAck=null;this.connectedAt=null;this.retryAt=0;this.failures=0;
    ctx.blockConcurrencyWhile(async()=>{
      this.control=await ctx.storage.get('control')??{nextIdentifyAt:0,blockedUntil:0};
      const fingerprint=env.DISCORD_BOT_TOKEN?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.DISCORD_BOT_TOKEN))),byte=>byte.toString(16).padStart(2,'0')).join(''):null;
      if(this.control.tokenFingerprint!==fingerprint){
        // 새 토큰에는 이전 토큰의 인증 실패 대기를 적용하지 않는다. 인증 간격은 유지한다.
        if(this.control.tokenFingerprint)this.control.blockedUntil=0;
        this.control.tokenFingerprint=fingerprint;
        await ctx.storage.put('control',this.control);
      }
    });
  }

  async fetch(request) {
    if(new URL(request.url).pathname==='/ensure')await this.ensure();
    return Response.json({status:this.status,lastHeartbeatAck:this.lastAck,connectedAt:this.connectedAt});
  }

  async ensure() {
    if(this.env.GATEWAY_ENABLED!=='true'){
      this.disconnect(1000);this.session=null;this.seq=null;this.status='disabled';return;
    }
    if(!this.env.DISCORD_BOT_TOKEN){this.status='missing-token';return;}
    if(this.ws||this.connecting)return this.connecting;
    const now=Date.now();
    if(now<Math.max(this.retryAt,this.control.blockedUntil)||(!this.session&&now<this.control.nextIdentifyAt))return;
    this.connecting=this.connect().catch(()=>{this.disconnect();this.defer();log('gateway-connect-failed');}).finally(()=>{this.connecting=null;});
    return this.connecting;
  }

  async connect() {
    this.status='connecting';
    let url=this.session?.url;
    if(!url){
      const response=await fetch('https://discord.com/api/v10/gateway/bot',{redirect:'manual',headers:{Authorization:'Bot '+this.env.DISCORD_BOT_TOKEN},signal:AbortSignal.timeout(10000)});
      if(!response.ok){
        if([401,403].includes(response.status)){this.control.blockedUntil=Date.now()+3600000;await this.ctx.storage.put('control',this.control);}
        await response.body?.cancel();throw new Error('Gateway discovery failed');
      }
      const data=JSON.parse(await readLimitedText(response,65536));url=data.url;
      if(data.session_start_limit?.remaining===0){
        this.control.nextIdentifyAt=Date.now()+Math.max(120000,data.session_start_limit.reset_after||86400000);
        await this.ctx.storage.put('control',this.control);this.status='rate-limited';return;
      }
      // 재시작을 포함해 새 인증을 최소 2분 간격으로 제한하여 Discord 상한을 보호한다.
      this.control.nextIdentifyAt=Date.now()+120000;
      await this.ctx.storage.put('control',this.control);
    }
    const controller=new AbortController();
    const upgradeTimeout=setTimeout(()=>controller.abort(),10000);
    let response;
    // 업그레이드 뒤까지 timeout이 살아 있으면 정상 WebSocket도 중단된다.
    try{response=await fetch(gatewayUrl(url),{redirect:'manual',headers:{Upgrade:'websocket'},signal:controller.signal});}
    finally{clearTimeout(upgradeTimeout);}
    if(!response.webSocket){await response.body?.cancel();throw new Error('Gateway upgrade failed');}
    const ws=response.webSocket;this.ws=ws;this.acked=true;
    ws.accept();
    ws.addEventListener('message',event=>{
      if(ws!==this.ws)return;
      try{if(typeof event.data!=='string'||event.data.length>2097152)throw new Error('Invalid gateway message');this.receive(JSON.parse(event.data));}catch{this.disconnect();this.defer();log('gateway-protocol-failed');}
    });
    ws.addEventListener('close',event=>{if(ws===this.ws)this.closed(event.code);});
    ws.addEventListener('error',()=>{if(ws===this.ws){this.disconnect();this.defer();}});
    this.handshake=setTimeout(()=>{if(ws===this.ws&&this.status!=='online'){this.disconnect();this.defer();}},20000);
  }

  send(op,d) {this.ws.send(JSON.stringify({op,d}));}

  receive(payload) {
    if(payload.s!==null&&payload.s!==undefined)this.seq=payload.s;
    if(payload.op===10){
      const interval=payload.d?.heartbeat_interval;
      if(!Number.isFinite(interval)||interval<1000||interval>120000)throw new Error('Invalid heartbeat interval');
      clearTimeout(this.heartbeatTimer);
      const tick=()=>{
        if(!this.ws)return;
        if(!this.acked){this.disconnect();this.defer();log('gateway-heartbeat-timeout');return;}
        try{this.heartbeat();this.heartbeatTimer=setTimeout(tick,interval);}catch{this.disconnect();this.defer();}
      };
      this.heartbeatTimer=setTimeout(tick,Math.random()*interval);
      if(this.session)this.send(6,{token:this.env.DISCORD_BOT_TOKEN,session_id:this.session.id,seq:this.seq});
      else this.send(2,{token:this.env.DISCORD_BOT_TOKEN,intents:this.env.RESET_CHAT_ENABLED==='true'?33281:1,properties:{os:'linux',browser:'Tibo-bot',device:'Tibo-bot'},presence:{status:'online',since:null,afk:false,activities:[]}});
    }else if(payload.op===11){this.acked=true;this.lastAck=new Date().toISOString();}
    else if(payload.op===1)this.heartbeat();
    else if(payload.op===7){this.disconnect();this.defer();}
    else if(payload.op===9){
      if(!payload.d){this.session=null;this.seq=null;}
      this.disconnect();this.defer();
    }else if(payload.op===0&&['GUILD_CREATE','GUILD_DELETE'].includes(payload.t)){
      // 입퇴장 순서를 보존하고 재연결의 GUILD_CREATE는 저장된 상태로 중복 안내를 방지한다.
      this.guildEvents=this.guildEvents.then(()=>recordGuildEvent(this.env,payload.t,payload.d?.id,payload.d?.unavailable===true)).catch(()=>log('guild-event-failed'));
      this.ctx.waitUntil(this.guildEvents);
    }else if(payload.op===0&&payload.t==='CHANNEL_DELETE'){
      this.guildEvents=this.guildEvents.then(()=>recordChannelDeletion(this.env,payload.d?.guild_id,payload.d?.id)).catch(()=>log('channel-delete-failed'));
      this.ctx.waitUntil(this.guildEvents);
    }else if(payload.op===0&&payload.t==='MESSAGE_CREATE'&&this.env.RESET_CHAT_ENABLED==='true'){
      const job=resetQuestionJob(payload.d,this.env.DISCORD_APPLICATION_ID);
      if(job)this.ctx.waitUntil((async()=>{
        if(await claimResetQuestion(this.env,job)==='accepted')await dispatchResetQuestion(job,this.env);
      })().catch(()=>log('reset-question-dispatch-failed')));
    }else if(payload.op===0&&(payload.t==='READY'||payload.t==='RESUMED')){
      if(payload.t==='READY'){
        gatewayUrl(payload.d.resume_gateway_url);
        this.session={id:payload.d.session_id,url:payload.d.resume_gateway_url};
      }
      clearTimeout(this.handshake);this.status='online';this.failures=0;this.connectedAt=new Date().toISOString();log('gateway-online');
    }
  }

  heartbeat() {this.send(1,this.seq);this.acked=false;}

  disconnect(code=4000) {
    const ws=this.ws;this.ws=null;
    clearTimeout(this.heartbeatTimer);clearTimeout(this.handshake);
    if(ws){try{ws.close(code,'Connection closed');}catch{/* 이미 닫힌 연결은 다음 Cron에서 복구한다. */}}
  }

  closed(code) {
    this.disconnect();this.defer();
    if([1000,1001,4007,4009].includes(code)){this.session=null;this.seq=null;}
    if(fatalCodes.has(code)){
      this.session=null;this.seq=null;this.status='blocked';this.control.blockedUntil=Date.now()+3600000;
      this.ctx.waitUntil(this.ctx.storage.put('control',this.control));log('gateway-auth-blocked');
    }
  }

  defer() {
    this.status='reconnecting';this.retryAt=Date.now()+Math.min(900000,5000*2**Math.min(this.failures++,8));
  }
}

export async function maintainGateway(env) {
  if(!env.GATEWAY)return;
  try{
    const stub=env.GATEWAY.get(env.GATEWAY.idFromName('discord-presence'));
    const response=await stub.fetch('https://gateway.internal/ensure',{method:'POST'});
    await response.body?.cancel();
  }catch{log('gateway-maintenance-failed');}
}

export async function gatewayStatus(env) {
  if(!env.GATEWAY||env.GATEWAY_ENABLED!=='true')return {status:'disabled'};
  try{return await(await env.GATEWAY.get(env.GATEWAY.idFromName('discord-presence')).fetch('https://gateway.internal/status')).json();}
  catch{return {status:'unavailable'};}
}
