import {discordApi,validId} from './guild-settings.js';

export function serverCountDescription(description,count) {
  if(typeof description!=='string'||!Number.isSafeInteger(count)||count<0)throw new Error('Invalid profile data');
  const base=description.split('\n').filter(line=>!/^현재 \d+개 서버에서 운영 중입니다\.$/.test(line.trim())).join('\n').trimEnd();
  const result=[base,`현재 ${count}개 서버에서 운영 중입니다.`].filter(Boolean).join('\n');
  // 기존 소개를 잘라내는 대신 갱신을 중단해 운영자가 작성한 내용을 보존한다.
  if(result.length>400)throw new Error('Profile description too long');
  return result;
}

export async function syncBotProfile(env) {
  const ids=new Set();let after='0',complete=false;
  for(let page=0;page<10;page++){
    const guilds=await discordApi(env,`/users/@me/guilds?limit=200&after=${after}`);
    if(!Array.isArray(guilds)||guilds.length>200||guilds.some(guild=>!validId(guild?.id)||BigInt(guild.id)<=BigInt(after)))throw new Error('Invalid guild list');
    for(const guild of guilds)ids.add(guild.id);
    if(guilds.length<200){complete=true;break;}
    after=guilds.reduce((max,guild)=>BigInt(guild.id)>BigInt(max)?guild.id:max,after);
  }
  // 일부 페이지만 조회한 숫자를 전체 서버 수로 표시하지 않는다.
  if(!complete)throw new Error('Guild list incomplete');
  const app=await discordApi(env,'/applications/@me');
  if(app.id!==env.DISCORD_APPLICATION_ID)throw new Error('Application mismatch');
  const description=serverCountDescription(app.description,ids.size);
  if(description!==app.description)await discordApi(env,'/applications/@me',{method:'PATCH',body:JSON.stringify({description})});
  return {count:ids.size,updated:description!==app.description};
}

export async function maintainBotProfile(env,scheduledTime) {
  if(env.PROFILE_SYNC_ENABLED!=='true'||!env.DISCORD_BOT_TOKEN||!Number.isFinite(scheduledTime)||Math.floor(scheduledTime/60000)%5!==0)return;
  try{
    const result=await syncBotProfile(env);
    if(result.updated)console.log(JSON.stringify({service:'tibo-bot',event:'profile-count-updated',count:result.count}));
  }catch{
    // 프로필 오류가 수집·Gateway 유지 작업에 전파되지 않도록 분리한다.
    console.log(JSON.stringify({service:'tibo-bot',event:'profile-count-sync-failed'}));
  }
}
