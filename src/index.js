import {handleDiscord,processDiscordJob} from './discord.js';

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/discord')return handleDiscord(request,env);
    if(path==='/'||path==='/health')return Response.json({service:'tibo-bot',mode:'verification',commands:['검증']});
    return new Response('Not found',{status:404});
  },
  async queue(batch,env) {
    for(const message of batch.messages){
      if(!await processDiscordJob(message,env)){
        console.log(JSON.stringify({service:'tibo-bot',event:'unsupported-job'}));
        message.ack();
      }
    }
  }
};
