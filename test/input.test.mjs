import test from 'node:test';
import assert from 'node:assert/strict';
import {readLimitedText,discordPlainText} from '../src/input.js';
import worker from '../src/index.js';
import {analyzeReset,resetNotification} from '../src/reset-analysis.js';
import {notificationPayload} from '../src/notification-payload.js';
import {analyzePost} from '../src/gemini.js';

await test('분할된 UTF-8 문자를 보존하며 바이트 한도를 적용한다',async()=>{
  const bytes=new TextEncoder().encode('한글');
  const stream=new ReadableStream({start(c){c.enqueue(bytes.slice(0,2));c.enqueue(bytes.slice(2));c.close();}});
  assert.equal(await readLimitedText(new Response(stream),6),'한글');
  await assert.rejects(()=>readLimitedText(new Response('한글'),5),{code:'body_too_large'});
});
await test('Content-Length가 없거나 작게 적혀 있어도 실제 읽은 크기로 차단한다',async()=>{
  await assert.rejects(()=>readLimitedText(new Response('123456',{headers:{'Content-Length':'1'}}),5),{code:'body_too_large'});
});
await test('큰 Content-Length는 본문을 읽기 전에 취소한다',async()=>{
  let cancelled=false;const stream=new ReadableStream({cancel(){cancelled=true;}});
  await assert.rejects(()=>readLimitedText(new Response(stream,{headers:{'Content-Length':'100'}}),5),{code:'body_too_large'});assert.equal(cancelled,true);
});
await test('AI 요약은 숨겨진 링크와 Discord 서식을 제거·이스케이프한다',()=>{
  const summary=discordPlainText('[공식 공지](https://attacker.invalid/)\n**초기화** <@123>');
  assert.ok(!summary.includes('https://'));assert.ok(summary.includes('\\[공식 공지\\]'));assert.ok(!summary.includes('\n'));assert.ok(summary.includes('\\*\\*초기화'));
  const message=resetNotification({id:'1'},{status:'mentioned',summary_ko:'[공지](https://attacker.invalid)'});const payload=notificationPayload(message);assert.equal(payload.content.match(/https?:\/\//g).length,1);assert.ok(payload.content.includes('\nhttps://x.com/thsottiaux/status/1\n'));assert.equal(payload.embeds,undefined);assert.doesNotMatch(message,/attacker\.invalid/);
});
await test('공개 상태 조회는 Gateway 객체를 호출하지 않고 연결 정보를 숨긴다',async()=>{
  let calls=0;const env={GATEWAY:{get(){calls++;throw Error('Must not call');}},GATEWAY_ENABLED:'true'};
  assert.deepEqual(await(await worker.fetch(new Request('https://test/health'),env)).json(),{service:'tibo-bot',status:'ok'});assert.equal(calls,0);
  assert.equal((await worker.fetch(new Request('https://test/health',{method:'POST'}),env)).status,405);
  assert.equal(await(await worker.fetch(new Request('https://test/health',{method:'HEAD'}),env)).text(),'');
});
await test('Gemini 인증 요청은 리다이렉트를 거부하고 과대한 응답을 읽지 않는다',async()=>{
  const original=globalThis.fetch;let redirects=[];
  globalThis.fetch=async(url,options)=>{redirects.push(options.redirect);return new Response('x'.repeat(65537));};
  try{
    const post={id:'1',text:'reset',date:'Oct 25, 2026 · 12:00 PM UTC'};
    await assert.rejects(()=>analyzeReset({GEMINI_API_KEY:'synthetic'},post),{code:'body_too_large'});
    await assert.rejects(()=>analyzePost({GEMINI_API_KEY:'synthetic'},post),{code:'body_too_large'});
    assert.deepEqual(redirects,['manual','manual']);
  }finally{globalThis.fetch=original;}
});
