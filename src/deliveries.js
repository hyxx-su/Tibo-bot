import {sendNotification} from './notifications.js';
import {seedLegacyGuild,recordChannelDeletion} from './guild-settings.js';

export async function queueDeliveries(env,post,content,kind) {
  await seedLegacyGuild(env);
  // 각 서버의 목적지를 저장하므로 다른 서버의 실패·재시도가 성공한 서버를 재발송하지 않는다.
  await env.DB.prepare(`INSERT OR IGNORE INTO post_deliveries (post_id,guild_id,kind,channel_id,content,message_id)
    SELECT ?,guild_id,?,channel_id,?,CASE WHEN guild_id=? THEN ? ELSE NULL END FROM guild_settings
    WHERE active=1 AND channel_id IS NOT NULL AND activated_at<=?`)
    .bind(post.id,kind,content,env.DISCORD_TEST_GUILD_ID??'',post.message_id,post.discovered_at).run();
}

export async function pendingDeliveries(db,now,includeSiteResets=true) {
  // 중지한 사이트 알림이 조회 상한을 차지하여 X 알림의 복구를 막지 않게 한다.
  const {results}=await db.prepare("SELECT post_id,guild_id,kind FROM post_deliveries WHERE phase='pending' AND next_attempt<=? AND lease_until<=? AND (?=1 OR kind!='site-reset') LIMIT 10").bind(now,now,includeSiteResets?1:0).all();
  return results.map(row=>({body:{kind:'watch-delivery',postId:row.post_id,guildId:row.guild_id,deliveryKind:row.kind}}));
}

export async function processDeliveryJob(message,env) {
  if(env.WATCH_ENABLED!=='true'||(message.body?.deliveryKind==='site-reset'&&env.SITE_RESETS_ENABLED!=='true')){message.ack();return true;}
  const job=message.body,token=crypto.randomUUID();let row;
  try{
    row=await env.DB.prepare("UPDATE post_deliveries SET lease_until=?,claim_token=? WHERE post_id=? AND guild_id=? AND kind=? AND phase='pending' AND lease_until<=? AND next_attempt<=? RETURNING *")
      .bind(Date.now()+90000,token,job.postId,job.guildId,job.deliveryKind,Date.now(),Date.now()).first();
    if(!row){message.ack();return true;}
    const settings=await env.DB.prepare('SELECT active,channel_id FROM guild_settings WHERE guild_id=?').bind(row.guild_id).first();
    if(!settings?.active||settings.channel_id!==row.channel_id){
      await env.DB.prepare("UPDATE post_deliveries SET phase='cancelled',lease_until=0,claim_token=NULL WHERE post_id=? AND guild_id=? AND kind=? AND claim_token=?").bind(row.post_id,row.guild_id,row.kind,token).run();
    }else{
      const messageId=row.kind==='link'&&row.message_id?row.message_id:await sendNotification(env,row.post_id,row.content,row.kind,row.message_id,row.channel_id);
      const statements=[env.DB.prepare("UPDATE post_deliveries SET phase='done',message_id=?,lease_until=0,claim_token=NULL,last_error=NULL WHERE post_id=? AND guild_id=? AND kind=? AND claim_token=?").bind(messageId,row.post_id,row.guild_id,row.kind,token)];
      // 기존 단일 서버의 관리자 재분석과 발송 기록 호환성을 보존한다.
      if(row.kind!=='site-reset'&&row.guild_id===env.DISCORD_TEST_GUILD_ID)statements.push(env.DB.prepare(`UPDATE watched_posts SET ${row.kind==='link'?'message_id':'reset_message_id'}=? WHERE id=?`).bind(messageId,row.post_id));
      await env.DB.batch(statements);
    }
    message.ack();
  }catch(error){
    if(row&&error.discordCode===10003){
      await recordChannelDeletion(env,row.guild_id,row.channel_id);
      await env.DB.prepare("UPDATE post_deliveries SET phase='cancelled',lease_until=0,claim_token=NULL WHERE post_id=? AND guild_id=? AND kind=? AND claim_token=?").bind(row.post_id,row.guild_id,row.kind,token).run();
      message.ack();return true;
    }
    if(row){
      const attempts=row.attempts+1;const delay=Math.max(error.retryAfter??0,[60,120,300,900,3600,3600][Math.min(attempts-1,5)])*1000;
      await env.DB.prepare('UPDATE post_deliveries SET phase=?,attempts=?,next_attempt=?,lease_until=0,claim_token=NULL,last_error=? WHERE post_id=? AND guild_id=? AND kind=? AND claim_token=?')
        .bind(error.permanent||attempts>=6?'failed':'pending',attempts,Date.now()+delay,error.code??'delivery_failed',row.post_id,row.guild_id,row.kind,token).run();
    }
    message.ack();console.log(JSON.stringify({service:'tibo-bot',event:'delivery-retry',code:error.code??'delivery_failed'}));
  }
  return true;
}
