import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscordGateway,maintainGateway} from '../src/gateway.js';

class Socket extends EventTarget {
  sent=[];closed=[];
  accept(){}
  send(value){this.sent.push(JSON.parse(value));}
  close(code){this.closed.push(code);}
  message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
}
async function fixture(control={nextIdentifyAt:0,blockedUntil:0}){
  const writes=[];let initialized;
  const ctx={storage:{async get(){return {...control};},async put(key,value){writes.push(structuredClone(value));}},blockConcurrencyWhile(fn){initialized=fn();},waitUntil(p){return p;}};
  const env={GATEWAY_ENABLED:'true',DISCORD_BOT_TOKEN:'synthetic-token'};
  const gateway=new DiscordGateway(ctx,env);await initialized;
  return {gateway,env,writes};
}
function discovery(remaining=1){return Response.json({url:'wss://gateway.discord.gg',session_start_limit:{remaining,reset_after:3600000}});}
const hello={op:10,d:{heartbeat_interval:1000}};
const ready={op:0,s:42,t:'READY',d:{session_id:'synthetic-session',resume_gateway_url:'wss://gateway-us-east1-b.discord.gg'}};

test('Gateway 연결·인증·복구 경로',async t=>{
  const originalFetch=globalThis.fetch;
  try{
    await t.test('동시 유지 요청은 연결 하나만 만들고 온라인 상태로 인증한다',async()=>{
      const {gateway,writes}=await fixture();let count=0;const socket=new Socket();
      globalThis.fetch=async()=>{count++;return count===1?discovery():{webSocket:socket};};
      try{
        await Promise.all([gateway.ensure(),gateway.ensure()]);assert.equal(count,2);assert.ok(writes.some(state=>state.nextIdentifyAt>Date.now()));
        socket.message(hello);assert.equal(socket.sent[0].op,2);assert.equal(socket.sent[0].d.intents,0);assert.equal(socket.sent[0].d.presence.status,'online');
        socket.message(ready);socket.message({op:1});assert.deepEqual(socket.sent.at(-1),{op:1,d:42});socket.message({op:11});
        const state=await(await gateway.fetch(new Request('https://test/status'))).json();assert.equal(state.status,'online');assert.ok(state.lastHeartbeatAck);assert.ok(!JSON.stringify(state).includes('synthetic'));
        await gateway.ensure();assert.equal(count,2);
      }finally{gateway.disconnect();}
    });
    await t.test('업그레이드 완료 뒤 제한 시간이 지나도 연결을 취소하지 않는다',async t=>{
      t.mock.timers.enable({apis:['setTimeout']});const {gateway}=await fixture();let signal;const socket=new Socket();let count=0;
      globalThis.fetch=async(url,options)=>{if(++count===1)return discovery();signal=options.signal;return {webSocket:socket};};
      try{await gateway.ensure();socket.message(ready);t.mock.timers.tick(15000);assert.equal(signal.aborted,false);assert.equal(gateway.ws,socket);}
      finally{gateway.disconnect();t.mock.timers.reset();}
    });
    await t.test('재연결은 기존 세션과 최신 sequence로 재개한다',async()=>{
      const {gateway}=await fixture();const old=new Socket();gateway.ws=old;gateway.receive(ready);gateway.receive({op:0,s:43,t:'OTHER',d:{}});gateway.receive({op:7});
      assert.equal(old.closed[0],4000);gateway.retryAt=0;const socket=new Socket();let destination;
      globalThis.fetch=async url=>{destination=String(url);return {webSocket:socket};};
      try{await gateway.ensure();socket.message(hello);assert.match(destination,/gateway-us-east1-b.discord.gg/);assert.equal(socket.sent[0].op,6);assert.equal(socket.sent[0].d.seq,43);socket.message({op:0,t:'RESUMED',s:44});assert.equal(gateway.status,'online');}
      finally{gateway.disconnect();}
    });
    await t.test('만료된 세션은 초기화하되 재인증 대기 시간을 우회하지 않는다',async()=>{
      const {gateway}=await fixture({nextIdentifyAt:Date.now()+120000,blockedUntil:0});gateway.ws=new Socket();gateway.receive(ready);gateway.receive({op:9,d:false});gateway.retryAt=0;
      globalThis.fetch=async()=>{throw Error('Must not connect');};await gateway.ensure();assert.equal(gateway.session,null);assert.equal(gateway.seq,null);
    });
    await t.test('Heartbeat ACK가 없으면 연결을 끊고 복구를 대기한다',async t=>{
      t.mock.timers.enable({apis:['setTimeout']});const {gateway}=await fixture();const socket=new Socket();gateway.ws=socket;
      try{gateway.receive(hello);t.mock.timers.tick(1000);assert.equal(socket.sent.filter(m=>m.op===1).length,1);t.mock.timers.tick(1000);assert.equal(gateway.ws,null);assert.equal(gateway.status,'reconnecting');}
      finally{gateway.disconnect();t.mock.timers.reset();}
    });
    await t.test('치명적인 인증 오류는 재시도를 한 시간 제한하고 비밀을 저장하지 않는다',async()=>{
      const {gateway,writes}=await fixture();gateway.ws=new Socket();gateway.closed(4004);assert.equal(gateway.status,'blocked');assert.ok(writes.at(-1).blockedUntil>Date.now()+3500000);assert.ok(!JSON.stringify(writes).includes('synthetic-token'));
      globalThis.fetch=async()=>{throw Error('Must not connect');};await gateway.ensure();
    });
    await t.test('세션 시작 한도를 소진하면 새 WebSocket을 열지 않는다',async()=>{
      const {gateway}=await fixture();let count=0;globalThis.fetch=async()=>{count++;return discovery(0);};await gateway.ensure();assert.equal(count,1);assert.equal(gateway.status,'rate-limited');
    });
    await t.test('Discord 이외의 WebSocket 주소에는 토큰을 전송하지 않는다',async()=>{
      const {gateway}=await fixture();let count=0;globalThis.fetch=async()=>{count++;return Response.json({url:'wss://attacker.invalid'});};await gateway.ensure();assert.equal(count,1);assert.equal(gateway.ws,null);
    });
    await t.test('Discord 하위 도메인이라도 Gateway가 아닌 주소는 거부한다',async()=>{
      const {gateway}=await fixture();let count=0;globalThis.fetch=async()=>{count++;return Response.json({url:'wss://uploads.discord.gg'});};await gateway.ensure();assert.equal(count,1);assert.equal(gateway.ws,null);
    });
    await t.test('재시작 뒤에도 저장된 인증 간격을 지킨다',async()=>{
      const {gateway}=await fixture({nextIdentifyAt:Date.now()+120000,blockedUntil:0});globalThis.fetch=async()=>{throw Error('Must not connect');};await gateway.ensure();assert.equal(gateway.ws,null);
    });
    await t.test('토큰이 바뀌면 이전 인증 실패 대기를 해제하되 최소 인증 간격은 유지한다',async()=>{
      const nextIdentifyAt=Date.now()+120000;
      const {gateway,writes}=await fixture({nextIdentifyAt,blockedUntil:Date.now()+3600000,tokenFingerprint:'previous-token-fingerprint'});
      assert.equal(gateway.control.blockedUntil,0);assert.equal(gateway.control.nextIdentifyAt,nextIdentifyAt);assert.notEqual(gateway.control.tokenFingerprint,'previous-token-fingerprint');assert.ok(!JSON.stringify(writes).includes('synthetic-token'));
      globalThis.fetch=async()=>{throw Error('Must not connect before cooldown');};await gateway.ensure();assert.equal(gateway.ws,null);
    });
    await t.test('동일 토큰으로 재시작하면 기존 인증 실패 대기를 우회하지 않는다',async()=>{
      const first=await fixture();const blockedUntil=Date.now()+3600000;
      const {gateway}=await fixture({...first.gateway.control,blockedUntil});assert.equal(gateway.control.blockedUntil,blockedUntil);
      globalThis.fetch=async()=>{throw Error('Must not connect while blocked');};await gateway.ensure();assert.equal(gateway.ws,null);
    });
    await t.test('연결 비활성화는 정상 종료하고 온라인 세션을 제거한다',async()=>{
      const {gateway,env}=await fixture();const socket=new Socket();gateway.ws=socket;gateway.receive(ready);env.GATEWAY_ENABLED='false';await gateway.ensure();assert.equal(socket.closed[0],1000);assert.equal(gateway.status,'disabled');assert.equal(gateway.session,null);
    });
    await t.test('연결 유지 실패를 기존 예약 수집으로 전파하지 않는다',async()=>{
      await maintainGateway({GATEWAY:{idFromName(){return 'one';},get(){return {fetch(){throw Error('synthetic unavailable');}};}}});
    });
  }finally{globalThis.fetch=originalFetch;}
});
