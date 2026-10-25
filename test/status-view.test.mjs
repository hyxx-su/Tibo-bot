import test from 'node:test';
import assert from 'node:assert/strict';
import {statusMessage} from '../src/status-view.js';

const now=Date.parse('2026-10-25T11:36:30Z');
const base={state:{baseline_id:'100',last_success:now-30000,last_error:null},counts:[{phase:'done',count:5}],delivery:[],gateway:{status:'online'},channelId:'300',now};
const field=(data,name)=>data.embeds.flatMap(embed=>embed.fields).find(field=>field.name===name)?.value;

test('정상 상태는 세 구역의 비공개 임베드와 실제 채널·한국시간을 표시한다',()=>{
  const data=statusMessage(base);
  assert.match(data.content,/✅ 시스템 정상 작동 중/);
  assert.equal(data.embeds.length,3);assert.equal(field(data,'알림 채널'),'<#300>');
  assert.match(field(data,'마지막 성공'),/2026-10-25 20:36/);assert.match(field(data,'마지막 성공'),/<t:1792928160:R>/);
  assert.equal(field(data,'처리 완료'),'✅ 5건');assert.equal(field(data,'전송 실패'),'🟢 0건');
  assert.equal(data.flags,64);assert.deepEqual(data.allowed_mentions,{parse:[]});
});

test('첫 수집 전 상태는 정상·최근 성공으로 잘못 표시하지 않는다',()=>{
  const data=statusMessage({...base,state:{baseline_id:null,last_success:null}});
  assert.match(data.content,/🟡/);assert.equal(field(data,'마지막 성공'),'아직 없음');assert.equal(field(data,'수집 상태'),'🟡 첫 수집 대기');
});

test('오래된 성공 기록은 연결이 온라인이어도 수집 지연으로 표시한다',()=>{
  const data=statusMessage({...base,state:{...base.state,last_success:now-240000}});
  assert.match(data.content,/🟡/);assert.equal(field(data,'수집 상태'),'🟡 최근 수집 지연');
});

test('최근 수집 오류와 실제 전송 실패는 붉은 상태로 표시하고 수량을 구분한다',()=>{
  const data=statusMessage({...base,state:{...base.state,last_error:'poll_failed'},counts:[{phase:'done',count:5},{phase:'analyze',count:2},{phase:'link',count:1},{phase:'failed',count:1}],delivery:[{phase:'pending',count:3},{phase:'failed',count:2}]});
  assert.match(data.content,/🔴/);assert.equal(field(data,'수집 상태'),'🔴 최근 오류 있음');
  assert.equal(field(data,'분석·처리 대기'),'🟡 3건');assert.equal(field(data,'처리 실패'),'🔴 1건');assert.equal(field(data,'전송 대기'),'🟡 3건');assert.equal(field(data,'전송 실패'),'🔴 2건');
});

for(const status of ['reconnecting','disabled','unavailable'])test(`Discord ${status}를 정상으로 표시하지 않는다`,()=>{
  const data=statusMessage({...base,gateway:{status}});assert.match(data.content,/🟡/);assert.doesNotMatch(field(data,'Discord 연결'),/정상/);
});

for(const channelId of [undefined,'not-a-channel'])test(`알림 채널 미설정 ${channelId}는 설정 방법을 표시한다`,()=>{
  const data=statusMessage({...base,channelId});assert.match(data.content,/🟡/);assert.match(field(data,'알림 채널'),/알림설정/);
});
