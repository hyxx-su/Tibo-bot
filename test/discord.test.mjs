import {Miniflare,Log,LogLevel} from 'miniflare';
import test from 'node:test';
import {timelineHtml,latestId} from './fixtures/timeline.mjs';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {processDiscordJob} from '../src/discord.js';

const check=(name,fn)=>test(name,fn);
const keys=await webcrypto.subtle.generateKey('Ed25519',true,['sign','verify']);
const publicKey=Buffer.from(await webcrypto.subtle.exportKey('raw',keys.publicKey)).toString('hex');
const pages={first:timelineHtml()};
const calls=[];
const mf=new Miniflare({
  modules:true,script:await readFile(new URL('../.build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),
  bindings:{WATCH_ENABLED:'true',DISCORD_BOT_TOKEN:'synthetic-bot',DISCORD_PUBLIC_KEY:publicKey,DISCORD_APPLICATION_ID:'1',DISCORD_TEST_GUILD_ID:'2',DISCORD_TEST_CHANNEL_ID:'3',GEMINI_API_KEY:'synthetic-test-key'},
  durableObjects:{COMMAND_GUARD:{className:'DiscordCommandGuard',useSQLite:true}},d1Databases:['DB'],queueProducers:{PROBE_JOBS:'discord-fixture'},queueConsumers:{'discord-fixture':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:2,retryDelay:0}},
  outboundService:async request=>{
    const url=new URL(request.url);
    if(url.hostname==='x.noodl3.net'){calls.push({kind:'source'});return new Response(pages.first);}
    if(url.hostname==='generativelanguage.googleapis.com'){
      const body=await request.json();calls.push({kind:'gemini',hasKey:request.headers.get('x-goog-api-key')==='synthetic-test-key',input:JSON.parse(body.contents[0].parts[0].text)});
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({category:'unrelated',summary_ko:'합성 테스트 데이터에 관한 요약입니다.'})}]}}],usageMetadata:{totalTokenCount:100}});
    }
    if(url.hostname==='discord.com'){
      if(request.method==='GET'){
        const path=url.pathname.replace('/api/v10','');
        if(path==='/guilds/20')return Response.json({id:'20',owner_id:'90'});
        if(path==='/guilds/20/roles')return Response.json([{id:'20',permissions:'19456'}]);
        if(path==='/guilds/20/members/90')return Response.json({user:{id:'90'},roles:[]});
        if(path==='/guilds/20/members/1')return Response.json({user:{id:'1'},roles:[]});
        if(path==='/channels/30')return Response.json({id:'30',guild_id:'20',type:0,permission_overwrites:[]});
        throw new Error('Unexpected setup destination');
      }
      calls.push({kind:'discord',method:request.method,path:url.pathname,body:await request.json()});return Response.json({id:'fixture-message'});
    }
    throw new Error('Unexpected outbound fixture destination');
  },
});
const setupDb=await mf.getD1Database('DB');
await setupDb.batch((await readFile(new URL('../migrations/0001_watch.sql',import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>setupDb.prepare(s)));
await setupDb.batch((await readFile(new URL('../migrations/0003_guild_channels.sql',import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean).map(s=>setupDb.prepare(s)));
const base={type:2,application_id:'1',guild_id:'2',channel_id:'3',id:'9001',member:{permissions:'32'},token:'synthetic-interaction-token',data:{name:'검증'}};
async function signed(raw,overrides={}){
  const timestamp=overrides['X-Signature-Timestamp']??String(Math.floor(Date.now()/1000));
  const signature=Buffer.from(await webcrypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+raw))).toString('hex');
  return mf.dispatchFetch('http://probe/discord',{method:'POST',headers:{'X-Signature-Ed25519':signature,'X-Signature-Timestamp':timestamp,...overrides},body:raw});
}
async function waitFor(fn){const deadline=Date.now()+5000;while(Date.now()<deadline){if(fn())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Fixture pipeline timed out');}
try{
  await check('GET is refused',async()=>assert.equal((await mf.dispatchFetch('http://probe/discord')).status,405));
  await check('missing signature is refused',async()=>assert.equal((await mf.dispatchFetch('http://probe/discord',{method:'POST',body:'{}'})).status,401));
  await check('malformed hex signature is refused',async()=>assert.equal((await signed('{}',{'X-Signature-Ed25519':'not-hex'})).status,401));
  await check('forged signature is refused',async()=>assert.equal((await signed('{}',{'X-Signature-Ed25519':'00'.repeat(64)})).status,401));
  await check('malformed timestamp is refused',async()=>assert.equal((await signed('{}',{'X-Signature-Timestamp':'invalid'})).status,401));
  for(const offset of [-301,301])await check(`서명이 맞아도 ${offset}초 차이 요청을 거부한다`,async()=>assert.equal((await signed('{"type":1}',{'X-Signature-Timestamp':String(Math.floor(Date.now()/1000)+offset)})).status,401));
  await check('valid signed Unicode and exact whitespace are accepted',async()=>{
    const r=await signed('{ "type": 1, "fixture": "한글 😀" }');assert.equal(r.status,200);assert.deepEqual(await r.json(),{type:1});
  });
  await check('modified signed body is refused',async()=>{
    const timestamp=String(Math.floor(Date.now()/1000));const sig=Buffer.from(await webcrypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+'{"type":1}'))).toString('hex');
    const r=await mf.dispatchFetch('http://probe/discord',{method:'POST',headers:{'X-Signature-Ed25519':sig,'X-Signature-Timestamp':timestamp},body:'{"type":2}'});assert.equal(r.status,401);
  });
  await check('valid signature with invalid JSON is refused',async()=>assert.equal((await signed('{broken')).status,400));
  await check('null interaction is refused',async()=>assert.equal((await signed('null')).status,400));
  await check('oversized payload is refused',async()=>assert.equal((await signed(' '.repeat(65537))).status,413));
  await check('문자 수가 작아도 UTF-8 바이트 한도를 넘으면 거부한다',async()=>assert.equal((await signed('한'.repeat(22000))).status,413));
  await check('unsupported command receives private explanation',async()=>{const r=await(await signed(JSON.stringify({...base,data:{name:'unknown'}}))).json();assert.equal(r.type,4);assert.equal(r.data.flags,64);});
  for(const field of ['application_id','guild_id','channel_id'])await check(`wrong ${field} cannot enqueue analysis`,async()=>{
    const r=await(await signed(JSON.stringify({...base,[field]:'different'}))).json();assert.equal(r.type,4);assert.equal(r.data.flags,64);assert.equal(calls.length,0);
  });
  for(const permissions of [undefined,'0','-8','invalid'])await check(`검증 권한 부재·변조 ${permissions}를 거부한다`,async()=>{
    const before=calls.length;const r=await(await signed(JSON.stringify({...base,member:{permissions}}))).json();assert.match(r.data.content,/서버 관리/);assert.equal(calls.length,before);
  });
  await check('missing continuation token is refused',async()=>assert.equal((await signed(JSON.stringify({...base,token:''}))).status,400));
  await check('valid command receives deferred private response',async()=>{const r=await(await signed(JSON.stringify(base))).json();assert.equal(r.type,5);assert.equal(r.data.flags,64);});
  await check('actual local Queue pipeline collects, analyzes and replies',async()=>{
    await waitFor(()=>calls.some(c=>c.kind==='discord'));assert.equal(calls.filter(c=>c.kind==='source').length,1);assert.equal(calls.filter(c=>c.kind==='gemini').length,1);
    const ai=calls.find(c=>c.kind==='gemini');assert.equal(ai.hasKey,true);assert.equal(ai.input.id,latestId);
    const reply=calls.find(c=>c.kind==='discord');assert.equal(reply.method,'PATCH');assert.ok(reply.path.endsWith('/messages/@original'));assert.deepEqual(reply.body.allowed_mentions,{parse:[]});assert.match(reply.body.content,/D1 연결/);
  });
  await check('같은 서명 요청 재사용과 다른 검증 요청 폭주가 추가 분석을 만들지 않는다',async()=>{
    const before=calls.filter(c=>c.kind==='source').length;const duplicate=await(await signed(JSON.stringify(base))).json();assert.equal(duplicate.type,5);
    const limited=await(await signed(JSON.stringify({...base,id:'9002'}))).json();assert.match(limited.data.content,/분당 1회/);assert.equal(calls.filter(c=>c.kind==='source').length,before);
  });
  await check('공개 health는 내부 상태를 공개하지 않는다',async()=>{assert.deepEqual(await(await mf.dispatchFetch('http://probe/health')).json(),{service:'tibo-bot',status:'ok'});});
  await check('duplicate result delivery updates the same message',async()=>{
    const queue=await mf.getQueueProducer('PROBE_JOBS');const job={kind:'discord-reply',interactionToken:base.token,interactionId:base.id,expiresAt:Date.now()+60000,post:{id:latestId},analysis:{category:'unrelated',summary_ko:'중복 처리 시험'}};
    await queue.send(job);await queue.send(job);await waitFor(()=>calls.filter(c=>c.kind==='discord').length===3);
    const replies=calls.filter(c=>c.kind==='discord');assert.equal(new Set(replies.map(r=>r.path)).size,1);assert.ok(replies.every(r=>r.method==='PATCH'));
  });
  await check('새 서버의 관리자가 알림설정 메뉴를 비공개로 열 수 있다',async()=>{
    const response=await(await signed(JSON.stringify({...base,guild_id:'20',data:{name:'알림설정'}}))).json();
    assert.equal(response.type,4);assert.equal(response.data.flags,64);assert.equal(response.data.components[0].components[0].type,8);assert.deepEqual(response.data.components[0].components[0].channel_types,[0,5]);
  });
  await check('일반 사용자와 DM의 메뉴 선택은 설정을 변경하지 않는다',async()=>{
    for(const fields of [{member:{permissions:'0',user:{id:'90'}}},{guild_id:undefined}]){
      const response=await(await signed(JSON.stringify({...base,type:3,guild_id:'20',data:{custom_id:'tibo:notify-channel',values:['30']},...fields}))).json();assert.equal(response.type,4);assert.equal(response.data.flags,64);
    }
    assert.equal(await setupDb.prepare("SELECT * FROM guild_settings WHERE guild_id='20'").first(),null);
  });
  await check('서명된 채널 메뉴 선택은 지연 응답 후 실제 설정과 비공개 확인을 저장한다',async()=>{
    const response=await(await signed(JSON.stringify({...base,type:3,id:'9200',guild_id:'20',member:{permissions:'32',user:{id:'90'}},data:{custom_id:'tibo:notify-channel',values:['30']}}))).json();assert.equal(response.type,5);assert.equal(response.data.flags,64);
    await waitFor(()=>calls.some(c=>c.kind==='discord'&&c.body.content?.includes('이제 <#30>')));
    assert.equal((await setupDb.prepare("SELECT channel_id FROM guild_settings WHERE guild_id='20'").first()).channel_id,'30');
    const notice=calls.find(c=>c.kind==='discord'&&c.path==='/api/v10/channels/30/messages');assert.ok(notice);assert.match(notice.body.embeds[0].description,/이제부터 이 채널에서/);assert.equal(notice.body.nonce,'c9200');assert.equal(notice.body.enforce_nonce,true);assert.deepEqual(notice.body.allowed_mentions,{parse:[]});
  });
  await check('상태 명령은 현재 서버 채널과 확인 시각만 단일 비공개 임베드로 제공한다',async()=>{
    const response=await(await signed(JSON.stringify({...base,guild_id:'20',data:{name:'상태'}}))).json();
    assert.equal(response.type,4);assert.equal(response.data.flags,64);assert.equal(response.data.embeds.length,1);assert.deepEqual(response.data.allowed_mentions,{parse:[]});
    const fields=response.data.embeds.flatMap(embed=>embed.fields);assert.equal(fields.find(f=>f.name==='알림 채널').value,'<#30>');assert.equal(fields.length,2);assert.equal(fields.find(f=>f.name==='최근 확인').value,'아직 확인 전');assert.match(response.data.embeds[0].title,/🟡/);
  });
}finally{await mf.dispose();}

await check('expired jobs are acknowledged without external work',async()=>{
  let ack=false;const result=await processDiscordJob({body:{kind:'discord-analyze',interactionToken:'synthetic',expiresAt:Date.now()-1},ack(){ack=true;}},{});assert.equal(result,true);assert.equal(ack,true);
});
const originalFetch=globalThis.fetch;
try{
  globalThis.fetch=async()=>new Response('fixture unavailable',{status:503});
  await check('transient Gemini failure schedules a bounded retry',async()=>{
    let retry;let ack=false;await processDiscordJob({attempts:1,body:{kind:'discord-analyze',interactionId:'fixture-failure',interactionToken:'synthetic',expiresAt:Date.now()+60000,post:{id:'1',text:'fixture'}},retry(options){retry=options;},ack(){ack=true;}},{GEMINI_API_KEY:'synthetic',DISCORD_APPLICATION_ID:'1'});assert.deepEqual(retry,{delaySeconds:30});assert.equal(ack,false);
  });
  await check('exhausted attempts stop retrying and acknowledge',async()=>{
    let retries=0;let ack=false;await processDiscordJob({attempts:3,body:{kind:'discord-analyze',interactionId:'fixture-exhausted',interactionToken:'synthetic',expiresAt:Date.now()+60000,post:{id:'1',text:'fixture'}},retry(){retries++;},ack(){ack=true;}},{GEMINI_API_KEY:'synthetic',DISCORD_APPLICATION_ID:'1'});assert.equal(retries,0);assert.equal(ack,true);
  });
}finally{globalThis.fetch=originalFetch;}
