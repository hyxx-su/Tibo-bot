import {maintainGateway,gatewayStatus} from './gateway.js';
export {DiscordGateway} from './gateway.js';
import {handleDiscord,processDiscordJob} from './discord.js';
import {scheduleWatch,processWatchJob,watchEnabled} from './watcher.js';

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/discord')return handleDiscord(request,env);
    if(path==='/'||path==='/health')return Response.json({service:'tibo-bot',mode:watchEnabled(env)?'watching':'verification',commands:['검증','상태'],gateway:await gatewayStatus(env)});
    return new Response('Not found',{status:404});
  },
  async scheduled(controller,env) {
    await Promise.all([scheduleWatch(env),maintainGateway(env)]);
  },
  async queue(batch,env) {
    for(const message of batch.messages){
      if(!await processDiscordJob(message,env)&&!await processWatchJob(message,env)){
        console.log(JSON.stringify({service:'tibo-bot',event:'unsupported-job'}));
        message.ack();
      }
    }
  }
};
