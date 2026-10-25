import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';

const {values}=parseArgs({options:{'application-id':{type:'string'},'guild-id':{type:'string'},global:{type:'boolean',default:false}}});
const applicationId=values['application-id']??process.env.DISCORD_APPLICATION_ID;
const guildId=values['guild-id']??process.env.DISCORD_TEST_GUILD_ID;
let token=process.env.DISCORD_BOT_TOKEN?.trim();
if(!token&&process.env.DISCORD_BOT_TOKEN_FILE)token=(await readFile(process.env.DISCORD_BOT_TOKEN_FILE,'utf8')).trim();
if(!/^\d{1,20}$/.test(applicationId??'')||(!values.global&&!/^\d{1,20}$/.test(guildId??''))||!token){console.error('앱 ID·서버 ID와 비공개 봇 토큰이 필요합니다. README의 명령 등록 절차를 확인하세요.');process.exit(2);}
const headers={Authorization:'Bot '+token,'Content-Type':'application/json'};
const identity=await fetch('https://discord.com/api/v10/oauth2/applications/@me',{redirect:'manual',headers,signal:AbortSignal.timeout(15000)});
if(!identity.ok){console.error('봇 인증 실패: HTTP '+identity.status);process.exit(1);}
if((await identity.json()).id!==applicationId){console.error('지정한 앱의 토큰이 아닙니다. 명령을 등록하지 않았습니다.');process.exit(1);}
// 운영 명령만 이름별로 생성·갱신하고, 종료한 검증 명령은 지정 범위에서 제거한다.
const commands=[
  {name:'알림설정',description:'Tibo 메시지를 받을 채널을 선택합니다.',type:1,default_member_permissions:'32',contexts:[0],integration_types:[0],options:[{type:7,name:'채널',description:'알림을 받을 텍스트 채널',required:false,channel_types:[0,5]}]},
  {name:'상태',description:'자동 새 글 알림의 최근 수집 시각과 처리 상태를 확인합니다.',type:1},
];
const commandsUrl=`https://discord.com/api/v10/applications/${applicationId}${values.global?'':`/guilds/${guildId}`}/commands`;
const existingResponse=await fetch(commandsUrl,{redirect:'manual',headers,signal:AbortSignal.timeout(15000)});
if(!existingResponse.ok){console.error('기존 명령 조회 실패: HTTP '+existingResponse.status);process.exit(1);}
for(const retired of (await existingResponse.json()).filter(command=>command.name==='검증')){
  const removed=await fetch(`${commandsUrl}/${retired.id}`,{method:'DELETE',redirect:'manual',headers,signal:AbortSignal.timeout(15000)});
  if(!removed.ok){console.error('검증 명령 제거 실패: HTTP '+removed.status);process.exit(1);}
  console.log(JSON.stringify({removed:retired.name,httpStatus:removed.status}));
}
for(const command of commands){
if(!values.global){delete command.contexts;delete command.integration_types;}
const response=await fetch(commandsUrl,{
  method:'POST',redirect:'manual',headers,signal:AbortSignal.timeout(15000),
  body:JSON.stringify(command),
});
if(!response.ok){console.error('명령 등록 실패: HTTP '+response.status);process.exit(1);}
const registered=await response.json();
console.log(JSON.stringify({commandId:registered.id,name:registered.name,httpStatus:response.status}));
}
