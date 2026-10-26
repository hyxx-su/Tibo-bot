import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

function run(existing,failRegistration=false){
  const fixture=`
    const existing=${JSON.stringify(existing)};const requests=[];
    globalThis.fetch=async(url,options={})=>{
      const method=options.method??'GET';const path=new URL(url).pathname;requests.push({method,path,body:options.body?JSON.parse(options.body):null});
      if(path.endsWith('/oauth2/applications/@me'))return Response.json({id:'1'});
      if(method==='GET')return Response.json(existing);
      if(method==='DELETE')return new Response(null,{status:204});
      if(${failRegistration})return new Response(null,{status:503});
      const body=JSON.parse(options.body);return Response.json({id:method==='PATCH'?path.split('/').at(-1):body.name==='채널'?'20':'30',name:body.name});
    };
    process.on('exit',()=>console.log(JSON.stringify({requests})));
  `;
  const result=spawnSync(process.execPath,['--import','data:text/javascript;base64,'+Buffer.from(fixture).toString('base64'),'scripts/register-command.mjs','--application-id','1','--global'],{
    cwd:new URL('../',import.meta.url),env:{...process.env,DISCORD_BOT_TOKEN:'synthetic-command-token'},encoding:'utf8',timeout:10000,
  });
  assert.equal(result.error,undefined);
  const lines=result.stdout.trim().split('\n').map(JSON.parse);
  return {status:result.status,requests:lines.find(row=>row.requests)?.requests??[]};
}

test('알림설정을 채널로 바꿀 때 기존 명령 ID와 관리자·채널 옵션을 유지한다',()=>{
  const result=run([{id:'10',name:'알림설정',type:1},{id:'30',name:'상태',type:1}]);assert.equal(result.status,0);
  const renamed=result.requests.find(row=>row.method==='PATCH');assert.ok(renamed.path.endsWith('/commands/10'));
  assert.equal(renamed.body.name,'채널');assert.equal(renamed.body.default_member_permissions,'32');assert.deepEqual(renamed.body.contexts,[0]);assert.deepEqual(renamed.body.options[0].channel_types,[0,5]);assert.equal(result.requests.filter(row=>row.method==='DELETE').length,0);
});
test('새 이름이 이미 있으면 갱신 후 이전 이름만 제거하고 다른 명령을 보존한다',()=>{
  const result=run([{id:'10',name:'알림설정',type:1},{id:'20',name:'채널',type:1},{id:'40',name:'검증',type:1},{id:'50',name:'기타',type:1},{id:'60',name:'알림설정',type:2}]);assert.equal(result.status,0);
  const deletes=result.requests.filter(row=>row.method==='DELETE');assert.deepEqual(deletes.map(row=>row.path.split('/').at(-1)),['10','40']);
  assert.ok(result.requests.findIndex(row=>row.method==='POST'&&row.body.name==='채널')<result.requests.findIndex(row=>row.method==='DELETE'));
  assert.equal(result.requests.some(row=>row.method==='PATCH'),false);
});
test('등록에 실패하면 기존 이름을 먼저 삭제하지 않는다',()=>{
  const result=run([{id:'10',name:'알림설정',type:1}],true);assert.equal(result.status,1);assert.equal(result.requests.some(row=>row.method==='DELETE'),false);
});
