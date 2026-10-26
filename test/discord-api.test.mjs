import test from 'node:test';
import assert from 'node:assert/strict';
import {discordApi} from '../src/guild-settings.js';

const originalFetch=globalThis.fetch;
try{
  for(const [body,header,expected] of [[{retry_after:45.2},'50',50],[{retry_after:80},'10',80],[{retry_after:-1},null,60],[{retry_after:'bad'},'3.1',4],[null,null,60]]){
    await test(`Discord 요청 제한의 양수 대기 지시를 사용한다: ${JSON.stringify(body)} / ${header}`,async()=>{
      globalThis.fetch=async(url,options)=>{
        assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bot synthetic');
        return Response.json(body,{status:429,headers:header?{'Retry-After':header}:{}});
      };
      await assert.rejects(discordApi({DISCORD_BOT_TOKEN:'synthetic'},'/channels/1/messages'),error=>error.status===429&&error.retryAfter===expected&&!error.message.includes('synthetic'));
    });
  }
  await test('오류 응답이 과대하거나 JSON이 아니어도 원문을 노출하지 않는다',async()=>{
    for(const body of ['secret-response','x'.repeat(17000)]){
      globalThis.fetch=async()=>new Response(body,{status:429});
      await assert.rejects(discordApi({DISCORD_BOT_TOKEN:'synthetic'},'/channels/1/messages'),error=>error.status===429&&error.retryAfter===60&&error.message==='Discord API failed');
    }
  });
}finally{globalThis.fetch=originalFetch;}
