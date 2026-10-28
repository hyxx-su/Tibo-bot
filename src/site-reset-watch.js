import {collectSiteResets,siteResetNotification,siteResetCorrection} from './site-reset-source.js';
import {verifySiteReset} from './site-reset-verification.js';
import {resolveQuoteContext} from './watch-store.js';
import {queueDeliveries,pendingDeliveries} from './deliveries.js';

const enabled=env=>env.WATCH_ENABLED==='true'&&env.SITE_RESETS_ENABLED==='true';
export async function scheduleSiteResets(env) {
  if(enabled(env))await env.PROBE_JOBS.send({kind:'site-reset-poll'});
}
async function dispatchSiteResets(env) {
  const {results}=await env.DB.prepare("SELECT * FROM site_reset_events WHERE phase='pending' AND verification='verified' AND missing_count=0 ORDER BY discovered_at,event_key LIMIT 10").all();
  for(const event of results){
    // 기존 서버별 발송 대기열을 재사용하고 X 게시글 처리 이력은 수정하지 않는다.
    await queueDeliveries(env,{id:event.event_key,message_id:null,discovered_at:event.discovered_at},event.content,'site-reset');
    await env.DB.prepare("UPDATE site_reset_events SET phase='queued' WHERE event_key=? AND phase='pending'").bind(event.event_key).run();
  }
  const jobs=await pendingDeliveries(env.DB,Date.now());
  if(jobs.length)await env.PROBE_JOBS.sendBatch(jobs);
}
async function reconcileSiteResets(env,events,now,token) {
  const current=new Map(events.map(event=>[event.key,event]));
  const {results}=await env.DB.prepare(`SELECT e.*,p.body,p.published_at,p.context_json,p.analysis_json FROM site_reset_events e
    LEFT JOIN watched_posts p ON e.original_url='https://x.com/thsottiaux/status/'||p.id`).all();
  const guard='EXISTS(SELECT 1 FROM site_reset_state WHERE id=1 AND claim_token=?)';
  const statements=[];
  for(const row of results){
    const event=current.get(row.event_key),missing=event?0:Math.min(row.missing_count+1,3);
    let verification=row.verification,reason=row.verification_reason;
    // 정정한 이벤트는 자동 재승인하여 동일 메시지를 다시 완료 카드로 바꾸지 않는다.
    if(!['rejected','retracted'].includes(verification)){
      let post,analysis;
      try{
        analysis=JSON.parse(row.analysis_json??'null');
        if(row.body!==null)post={id:row.original_url?.split('/').at(-1),text:row.body,date:row.published_at,context:JSON.parse(row.context_json??'[]')};
        if(post&&analysis?.status==='completed')post=await resolveQuoteContext(env.DB,post);
      }catch{post=null;analysis=null;}
      const checked=verifySiteReset(event??{type:row.reset_type,sourceType:row.source_type,announcedAt:row.announced_at},post,analysis);
      const changed=event&&row.verification==='verified'&&(event.announcedAt!==row.announced_at||event.sourceType!==row.source_type);
      if(missing>=3||changed){verification='retracted';reason=changed?'source_changed':'source_removed';}
      else if(row.verification==='verified'&&checked.verification!=='verified'){
        verification='retracted';reason=checked.reason;
      }else{verification=checked.verification;reason=checked.reason;}
    }
    statements.push(env.DB.prepare(`UPDATE site_reset_events SET source_type=?,verification=?,verification_reason=?,last_seen_at=?,missing_count=?,announced_at=?,content=? WHERE event_key=? AND ${guard}`)
      .bind(event?.sourceType??row.source_type,verification,reason,event?now:row.last_seen_at,missing,
        verification==='retracted'?row.announced_at:event?.announcedAt??row.announced_at,
        event&&verification!=='retracted'?siteResetNotification(event):row.content,row.event_key,token));
    if(['rejected','retracted'].includes(verification)){
      // 보낸 서버와 메시지 ID를 보존한다. 정정 실패를 신규 메시지 전송으로 대체하지 않는다.
      const content=siteResetCorrection({...row,verification_reason:reason});
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO post_deliveries(post_id,guild_id,kind,channel_id,content,message_id)
        SELECT post_id,guild_id,'site-correction',channel_id,?,message_id FROM post_deliveries
        WHERE post_id=? AND kind='site-reset' AND phase='done' AND message_id IS NOT NULL AND ${guard}`).bind(content,row.event_key,token));
      statements.push(env.DB.prepare(`UPDATE post_deliveries SET phase='cancelled' WHERE post_id=? AND kind='site-reset' AND phase='pending' AND ${guard}`).bind(row.event_key,token));
    }
  }
  // 갱신과 정정 대기열은 같은 트랜잭션으로 기록한다.
  if(statements.length)await env.DB.batch(statements);
}
export async function pollSiteResets(env,now=Date.now()) {
  const token=crypto.randomUUID();
  const state=await env.DB.prepare('UPDATE site_reset_state SET lease_until=?,claim_token=?,next_poll_at=? WHERE id=1 AND lease_until<=? AND next_poll_at<=? RETURNING *')
    .bind(now+90000,token,now+60000,now,now).first();
  if(!state)return;
  try{
    const events=await collectSiteResets(now);
    const guard='EXISTS(SELECT 1 FROM site_reset_state WHERE id=1 AND claim_token=?)';
    const statements=events.map(event=>env.DB.prepare(`INSERT OR IGNORE INTO site_reset_events
      (event_key,source_id,reset_type,announced_at,original_url,content,discovered_at,phase)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`)
      .bind(event.key,event.id,event.type,event.announcedAt,event.url,siteResetNotification(event),now,state.initialized_at===null?'baseline':'pending',token));
    statements.push(env.DB.prepare('UPDATE site_reset_state SET initialized_at=COALESCE(initialized_at,?),last_success=?,last_error=NULL WHERE id=1 AND claim_token=?').bind(now,now,token));
    await env.DB.batch(statements);
    await reconcileSiteResets(env,events,now,token);
    await dispatchSiteResets(env);
    console.log(JSON.stringify({service:'tibo-bot',event:'site-reset-poll',baseline:state.initialized_at===null,records:events.length}));
  }catch(error){
    const corrections=await env.DB.prepare("SELECT post_id,guild_id,kind FROM post_deliveries WHERE kind='site-correction' AND phase='pending' AND next_attempt<=? AND lease_until<=? LIMIT 10").bind(now,now).all();
    if(corrections.results.length)await env.PROBE_JOBS.sendBatch(corrections.results.map(row=>({body:{kind:'watch-delivery',postId:row.post_id,guildId:row.guild_id,deliveryKind:row.kind}})));
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
