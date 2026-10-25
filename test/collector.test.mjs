import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {timelineHtml,latestId} from './fixtures/timeline.mjs';

const inputImplementation=(await readFile(new URL('../src/input.js',import.meta.url),'utf8')).replaceAll('export ','');
const implementation=inputImplementation+(await readFile(new URL('../src/collector.js',import.meta.url),'utf8')).replace("import {readLimitedText} from './input.js';",'').replaceAll('export async function','async function');
let scenario='normal';
let outboundCalls=0;
const mf=new Miniflare({
  modules:true,compatibilityDate:'2026-07-30',log:new Log(LogLevel.ERROR),
  script:implementation+`\nexport default {async fetch(request){try{
    const url=new URL(request.url);
    if(url.searchParams.get('mode')==='parse')return Response.json(await parseTimeline(await fetch('https://fixture.test/')));
    return Response.json(await collectLatestPost(url.searchParams.get('base')??undefined));
  }catch(error){return Response.json({error:error.message},{status:503});}}};`,
  outboundService:async()=>{
    outboundCalls++;
    if(scenario==='oversized')return new Response('x'.repeat(2*1024*1024+1));
    if(scenario==='redirect')return new Response(null,{status:302,headers:{Location:'https://attacker.invalid/'}});
    if(scenario==='403'||scenario==='429')return new Response('unavailable',{status:Number(scenario)});
    if(scenario==='failure')throw new Error('synthetic connection failure');
    if(scenario==='empty')return new Response('<html>maintenance</html>');
    if(scenario.startsWith('media-')){
      const media={image:'<img src="/pic/fixture.jpg">',gif:'<video poster="/pic/fixture.jpg"><source src="/video/fixture.mp4"></video>',video:'<video data-url="/video/fixture.m3u8"></video>',source:'<video><source src="/video/fixture.mp4"></video>',empty:'<img src="">',quote:'',avatar:''}[scenario.slice(6)];
      return new Response(`<div class="timeline-item" data-username="thsottiaux"><a class="tweet-link" href="/thsottiaux/status/301"></a><div class="tweet-body"><div class="tweet-header"><span class="tweet-date"><a title="Oct 25, 2026 · 3:40 AM UTC"></a></span><img class="avatar" src="/pic/avatar.jpg"></div><div class="tweet-content"></div><div class="attachments">${media}</div><div class="quote"><div class="attachments"><img src="/pic/quoted.jpg"></div></div></div></div>`);
    }
    if(scenario==='thread')return new Response(`<div class="thread-line"><div class="timeline-item" data-username="thsottiaux"><a class="tweet-link" href="/thsottiaux/status/201"></a><div class="tweet-content">Day 1/ Rest and reset</div></div><div class="timeline-item" data-username="someone"><a class="tweet-link" href="/someone/status/202"></a><div class="tweet-content">untrusted other author</div></div><div class="timeline-item" data-username="thsottiaux"><a class="tweet-link" href="/thsottiaux/status/203"></a><div class="tweet-content">By midnight PST</div></div></div><div class="timeline-item" data-username="thsottiaux"><a class="tweet-link" href="/thsottiaux/status/204"></a><div class="tweet-content">unrelated next post</div></div>`);
    return new Response(timelineHtml({incomplete:scenario==='incomplete'}));
  },
});

try{
  await test('대상 작성자 20개만 추출하고 부모 문맥을 제외한다',async()=>{
    const rows=await(await mf.dispatchFetch('http://test/?mode=parse')).json();
    assert.equal(rows.length,20);assert.ok(rows.every(r=>r.author==='thsottiaux'));assert.equal(rows[0].id,latestId);
  });
  await test('답글의 본문과 날짜를 보존한다',async()=>{
    const rows=await(await mf.dispatchFetch('http://test/?mode=parse')).json();
    assert.ok(rows.some(r=>r.text.startsWith('합성 답글')));assert.ok(rows.every(r=>r.date&&r.text.trim()));
  });
  await test('완전한 첫 게시글 표본을 반환한다',async()=>{
    const row=await(await mf.dispatchFetch('http://test/')).json();assert.equal(row.id,latestId);assert.equal(row.text,'합성 게시글 20');
  });
  for(const status of ['403','429'])await test(`수집원의 HTTP ${status}를 성공으로 처리하지 않는다`,async()=>{
    scenario=status;const response=await mf.dispatchFetch('http://test/');assert.equal(response.status,503);assert.match((await response.json()).error,new RegExp(status));
  });
  await test('점검 HTML은 게시글 부재 오류로 처리한다',async()=>{
    scenario='empty';assert.equal((await mf.dispatchFetch('http://test/')).status,503);
  });
  await test('본문이나 날짜가 빠진 표본을 거부한다',async()=>{
    scenario='incomplete';assert.equal((await mf.dispatchFetch('http://test/')).status,503);
  });
  for(const kind of ['image','gif','video','source'])await test(`본문 없는 ${kind} 첨부 답글을 수집한다`,async()=>{
    scenario='media-'+kind;const response=await mf.dispatchFetch('http://test/');assert.equal(response.status,200);
    const post=await response.json();assert.equal(post.id,'301');assert.equal(post.text,'');assert.equal(post.hasMedia,true);
  });
  for(const kind of ['empty','quote','avatar'])await test(`${kind}만으로 빈 게시글을 정상 첨부 글로 오인하지 않는다`,async()=>{
    scenario='media-'+kind;assert.equal((await mf.dispatchFetch('http://test/')).status,503);
  });
  await test('HTTPS가 아닌 설정은 외부 요청 전에 거부한다',async()=>{
    const before=outboundCalls;assert.equal((await mf.dispatchFetch('http://test/?base=http://fixture.test')).status,503);assert.equal(outboundCalls,before);
  });
  for(const base of ['https://127.0.0.1','https://attacker.invalid','https://user:secret@x.noodl3.net'])await test('허용하지 않은 수집 주소는 요청 전에 거부한다: '+new URL(base).hostname,async()=>{
    const before=outboundCalls;assert.equal((await mf.dispatchFetch('http://test/?base='+encodeURIComponent(base))).status,503);assert.equal(outboundCalls,before);
  });
  for(const kind of ['oversized','redirect'])await test('외부 '+kind+' 응답을 거부한다',async()=>{
    scenario=kind;assert.equal((await mf.dispatchFetch('http://test/')).status,503);
  });
  await test('수집 연결 실패는 처리된 오류로 반환한다',async()=>{
    scenario='failure';assert.equal((await mf.dispatchFetch('http://test/')).status,503);
  });
  await test('같은 스레드의 앞선 동일 작성자 본문만 답글 문맥으로 보존한다',async()=>{
    scenario='thread';const rows=await(await mf.dispatchFetch('http://test/?mode=parse')).json();
    assert.equal(rows[1].id,'203');assert.equal(rows[1].context.length,1);assert.equal(rows[1].context[0].id,'201');assert.equal(rows[2].context,undefined);
  });
}finally{await mf.dispose();}
