import test from 'node:test';
import assert from 'node:assert/strict';
import {statusMessage} from '../src/status-view.js';

const now=Date.parse('2026-10-25T11:36:30Z');
const base={state:{baseline_id:'100',last_success:now-30000,last_error:null},hasFailures:false,gateway:{status:'online'},channelId:'300',now};
const field=(data,name)=>data.embeds.flatMap(embed=>embed.fields).find(field=>field.name===name)?.value;

test('정상 상태는 하나의 비공개 임베드와 실제 채널·한국시간을 표시한다',()=>{
  const data=statusMessage(base);
  assert.match(data.embeds[0].title,/✅ 알림 정상 작동 중/);
  assert.equal(data.embeds.length,1);assert.equal(field(data,'알림 채널'),'<#300>');
  assert.match(field(data,'최근 확인'),/2026-10-25 20:36/);assert.match(field(data,'최근 확인'),/<t:1792928160:R>/);
  assert.equal(data.embeds[0].fields.length,2);assert.doesNotMatch(JSON.stringify(data),/감시 기준점|처리 완료|처리 실패|전송 대기|전송 실패|5건/);
  assert.equal(data.flags,64);assert.deepEqual(data.allowed_mentions,{parse:[]});
});

test('첫 수집 전 상태는 정상·최근 성공으로 잘못 표시하지 않는다',()=>{
  const data=statusMessage({...base,state:{baseline_id:null,last_success:null}});
  assert.match(data.embeds[0].title,/🟡/);assert.equal(field(data,'최근 확인'),'아직 확인 전');assert.match(data.embeds[0].title,/첫 확인/);
});

test('오래된 성공 기록은 연결이 온라인이어도 수집 지연으로 표시한다',()=>{
  const data=statusMessage({...base,state:{...base.state,last_success:now-240000}});
  assert.match(data.embeds[0].title,/🟡/);assert.match(data.embeds[0].title,/지연/);
});

test('최근 수집 오류는 세부 건수 없이 오류와 필요한 안내만 표시한다',()=>{
  const data=statusMessage({...base,state:{...base.state,last_error:'poll_failed'},hasFailures:true});
  assert.match(data.embeds[0].title,/🔴/);assert.match(data.embeds[0].title,/새 글을 확인하지 못/);
  assert.match(data.embeds[0].description,/다시 확인/);assert.doesNotMatch(JSON.stringify(data),/감시 기준점|전송 대기|처리 실패|[1235]건/);
});

for(const status of ['reconnecting','disabled','unavailable'])test(`Discord ${status}를 정상으로 표시하지 않는다`,()=>{
  const data=statusMessage({...base,gateway:{status}});assert.match(data.embeds[0].title,/🟡/);assert.match(data.embeds[0].title,/연결/);
});

for(const channelId of [undefined,'not-a-channel'])test(`알림 채널 미설정 ${channelId}는 설정 방법을 표시한다`,()=>{
  const data=statusMessage({...base,channelId});assert.match(data.embeds[0].title,/🟡/);assert.equal(field(data,'알림 채널'),'미설정');assert.match(data.embeds[0].description,/알림설정/);
});

test('실제 전송 실패가 있으면 건수를 노출하지 않고 권한 확인을 안내한다',()=>{
  const data=statusMessage({...base,hasFailures:true});assert.match(data.embeds[0].title,/🔴 일부 알림/);assert.match(data.embeds[0].description,/권한/);assert.doesNotMatch(JSON.stringify(data),/2건|전송 실패/);
});
