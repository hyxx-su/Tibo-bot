import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {timelineHtml,latestId} from './fixtures/timeline.mjs';

const implementation=(await readFile(new URL('../src/collector.js',import.meta.url),'utf8')).replaceAll('export async function','async function');
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
    if(scenario==='403'||scenario==='429')return new Response('unavailable',{status:Number(scenario)});
    if(scenario==='failure')throw new Error('synthetic connection failure');
    if(scenario==='empty')return new Response('<html>maintenance</html>');
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
  await test('HTTPS가 아닌 설정은 외부 요청 전에 거부한다',async()=>{
    const before=outboundCalls;assert.equal((await mf.dispatchFetch('http://test/?base=http://fixture.test')).status,503);assert.equal(outboundCalls,before);
  });
  await test('수집 연결 실패는 처리된 오류로 반환한다',async()=>{
    scenario='failure';assert.equal((await mf.dispatchFetch('http://test/')).status,503);
  });
}finally{await mf.dispose();}
