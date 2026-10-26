import {collectSiteResets,siteResetNotification} from './site-reset-source.js';
import {queueDeliveries,pendingDeliveries} from './deliveries.js';

const enabled=env=>env.WATCH_ENABLED==='true'&&env.SITE_RESETS_ENABLED==='true';
export async function scheduleSiteResets(env) {
  if(enabled(env))await env.PROBE_JOBS.send({kind:'site-reset-poll'});
}
async function dispatchSiteResets(env) {
  const {results}=await env.DB.prepare("SELECT * FROM site_reset_events WHERE phase='pending' ORDER BY discovered_at,event_key LIMIT 10").all();
  for(const event of results){
    // 기존 서버별 발송 대기열을 재사용하고 X 게시글 처리 이력은 수정하지 않는다.
    await queueDeliveries(env,{id:event.event_key,message_id:null,discovered_at:event.discovered_at},event.content,'site-reset');
    await env.DB.prepare("UPDATE site_reset_events SET phase='queued' WHERE event_key=? AND phase='pending'").bind(event.event_key).run();
  }
  const jobs=await pendingDeliveries(env.DB,Date.now());
  if(jobs.length)await env.PROBE_JOBS.sendBatch(jobs);
}
export async function pollSiteResets(env,now=Date.now()) {
  const token=crypto.randomUUID();
  const state=await env.DB.prepare('UPDATE site_reset_state SET lease_until=?,claim_token=?,next_poll_at=? WHERE id=1 AND lease_until<=? AND next_poll_at<=? RETURNING *')
    .bind(now+90000,token,now+60000,now,now).first();
  if(!state)return;
  try{
    await dispatchSiteResets(env);
    const events=await collectSiteResets(now);
    const guard='EXISTS(SELECT 1 FROM site_reset_state WHERE id=1 AND claim_token=?)';
    const statements=events.map(event=>env.DB.prepare(`INSERT OR IGNORE INTO site_reset_events
      (event_key,source_id,reset_type,announced_at,original_url,content,discovered_at,phase)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`)
      .bind(event.key,event.id,event.type,event.announcedAt,event.url,siteResetNotification(event),now,state.initialized_at===null?'baseline':'pending',token));
    statements.push(env.DB.prepare('UPDATE site_reset_state SET initialized_at=COALESCE(initialized_at,?),last_success=?,last_error=NULL WHERE id=1 AND claim_token=?').bind(now,now,token));
    await env.DB.batch(statements);
    await dispatchSiteResets(env);
    console.log(JSON.stringify({service:'tibo-bot',event:'site-reset-poll',baseline:state.initialized_at===null,records:events.length}));
  }catch(error){
    await env.DB.prepare('UPDATE site_reset_state SET last_error=?,next_poll_at=MAX(next_poll_at,?) WHERE id=1 AND claim_token=?')
      .bind('site_poll_failed',now+Math.max(60,error.retryAfter??60)*1000,token).run();
    throw new Error('Reset site poll failed');
  }finally{
    await env.DB.prepare('UPDATE site_reset_state SET lease_until=0,claim_token=NULL WHERE id=1 AND claim_token=?').bind(token).run();
  }
}
export async function processSiteResetJob(message,env) {
  if(message.body?.kind!=='site-reset-poll')return false;
  if(enabled(env))try{await pollSiteResets(env);}catch{console.log(JSON.stringify({service:'tibo-bot',event:'site-reset-poll-failed'}));}
  message.ack();return true;
}
