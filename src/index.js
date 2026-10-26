import {scheduleSiteResets,processSiteResetJob} from './site-reset-watch.js';
import {processGuildJob} from './guild-settings.js';
import {maintainGateway} from './gateway.js';
import {maintainBotProfile} from './bot-profile.js';
export {DiscordGateway} from './gateway.js';
export {DiscordCommandGuard} from './command-guard.js';
import {handleDiscord,processDiscordJob} from './discord.js';
import {scheduleWatch,processWatchJob} from './watcher.js';
import {processResetQuestionJob} from './reset-reply.js';

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/discord')return handleDiscord(request,env);
    if(path==='/'||path==='/health'){
      if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
      return new Response(request.method==='HEAD'?null:JSON.stringify({service:'tibo-bot',status:'ok'}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    }
    return new Response('Not found',{status:404});
  },
  async scheduled(controller,env) {
    await Promise.all([scheduleWatch(env),scheduleSiteResets(env),maintainGateway(env),maintainBotProfile(env,controller.scheduledTime)]);
  },
  async queue(batch,env) {
    for(const message of batch.messages){
      if(!await processSiteResetJob(message,env)&&!await processGuildJob(message,env)&&!await processDiscordJob(message,env)&&!await processResetQuestionJob(message,env)&&!await processWatchJob(message,env)){
        console.log(JSON.stringify({service:'tibo-bot',event:'unsupported-job'}));
        message.ack();
      }
    }
  }
};
