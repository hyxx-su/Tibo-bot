export {sendNotification} from './notifications.js';
import {seedLegacyGuild,pendingSetupJobs} from './guild-settings.js';
import {queueDeliveries,pendingDeliveries,processDeliveryJob} from './deliveries.js';
import {collectTimelinePage} from './collector.js';
import {analyzeReset,resetNotification} from './reset-analysis.js';
import {acquirePoll,recordPage,pendingJobs,claimPost,advancePost,retryPost,reserveAnalysis,deferAnalysis,resolveQuoteContext} from './watch-store.js';

const log=data=>console.log(JSON.stringify({service:'tibo-bot',...data}));
export const watchEnabled=env=>env.WATCH_ENABLED==='true';

async function dispatchPending(env) {
  const jobs=[...await pendingJobs(env.DB,Date.now()),...await pendingDeliveries(env.DB,Date.now())];
  if(jobs.length)await env.PROBE_JOBS.sendBatch(jobs);
}

async function poll(env,job) {
  const token=crypto.randomUUID();
  if(!job.cursor&&!await acquirePoll(env.DB,Date.now(),token))return;
  try{
    // 수집원이 실패하는 동안에도 이미 저장한 발송·분석 작업은 재개한다.
    await seedLegacyGuild(env);
    await dispatchPending(env);
    const setupJobs=await pendingSetupJobs(env.DB,Date.now());
    if(setupJobs.length)await env.PROBE_JOBS.sendBatch(setupJobs);
    const page=await collectTimelinePage(env.NITTER_BASE_URL,job.cursor);
    const result=await recordPage(env.DB,page.posts,Date.now());
    const cutoff=job.cutoff??result.cutoff;
    const hasGap=!result.baseline&&page.nextCursor&&BigInt(page.posts.at(-1).id)>BigInt(cutoff);
    if(hasGap&&(job.page??1)<3)await env.PROBE_JOBS.send({kind:'watch-poll',cursor:page.nextCursor,cutoff,page:(job.page??1)+1});
    if(hasGap&&(job.page??1)>=3)log({event:'watch-page-limit',coverage:'partial'});
    await dispatchPending(env);
    await env.DB.prepare('UPDATE watch_state SET last_success=?,last_error=NULL WHERE id=1').bind(Date.now()).run();
    log({event:'watch-poll',baseline:result.baseline,added:result.added,page:job.page??1});
  }catch{
    await env.DB.prepare('UPDATE watch_state SET last_error=? WHERE id=1').bind('poll_failed').run();
    throw new Error('Watch poll failed');
  }finally{
    if(!job.cursor)await env.DB.prepare('UPDATE watch_state SET poll_lease_until=0,poll_token=NULL WHERE id=1 AND poll_token=?').bind(token).run();
  }
}


async function processPost(env,job) {
  const token=crypto.randomUUID();
  const row=await claimPost(env.DB,job.postId,job.phase,Date.now(),token);
  if(!row)return;
  let next;
  try{
    const post={id:row.id,text:row.body,date:row.published_at,context:JSON.parse(row.context_json??'[]')};
    if(row.phase==='link'){
      // 짧은 완료 공지와 오탈자도 누락하지 않도록 모든 미분석 새 글을 판별한다.
      const needsAnalysis=!row.analysis_json;
      if(needsAnalysis){
        next='analyze';await advancePost(env.DB,row,token,next);
      }else{
        await queueDeliveries(env,row,`https://x.com/thsottiaux/status/${row.id}`,'link');
        next='done';await advancePost(env.DB,row,token,next);
        await dispatchPending(env);
      }
    }else if(row.phase==='analyze'){
      const limit=Math.min(100,Math.max(1,Number(env.RESET_ANALYSIS_DAILY_LIMIT)||100));
      if(!await reserveAnalysis(env.DB,Date.now(),limit)){
        await deferAnalysis(env.DB,row,token,Date.now());log({event:'watch-analysis-budget'});return;
      }
      const analysis=await analyzeReset(env,await resolveQuoteContext(env.DB,post));
      next=analysis.status==='unrelated'?'link':'reset';
      await advancePost(env.DB,row,token,next,{analysis});
      log({event:'watch-analysis',status:analysis.status,timeResolved:Boolean(analysis.time),totalTokens:analysis.usage?.totalTokenCount});
    }else if(row.phase==='reset'){
      const content=resetNotification(post,JSON.parse(row.analysis_json));
      if(!content)throw new Error('Reset notification missing');
      await queueDeliveries(env,row,content,'reset');
      next='done';await advancePost(env.DB,row,token,next);
      await dispatchPending(env);
    }
    log({event:'watch-post',phase:row.phase,next});
  }catch(error){
    if(row.phase==='analyze'&&row.attempts>=5){
      // 분석 장애로 원문까지 누락되지 않게 최종 실패 시 링크 전송으로 마무리한다.
      next='link';await advancePost(env.DB,row,token,next,{analysis:{status:'unavailable'}});
      log({event:'watch-analysis-fallback'});
    }else{
      const action=await retryPost(env.DB,row,token,Date.now(),error);
      log({event:'watch-post',phase:row.phase,action,code:error.code??'processing_failed'});
      return;
    }
  }
  if(next&&next!=='done'){
    // 저장 후 큐 발행이 실패해도 다음 주기에서 D1의 미완료 작업을 다시 찾는다.
    try{await env.PROBE_JOBS.send({kind:'watch-post',postId:row.id,phase:next});}
    catch{log({event:'watch-dispatch-deferred'});}
  }
}

async function replayPost(env,postId) {
  if(!/^\d{1,20}$/.test(postId??''))throw new Error('Invalid replay post');
  const page=await collectTimelinePage(env.NITTER_BASE_URL);
  const post=page.posts.find(post=>post.id===postId);
  if(!post)throw new Error('Replay post not on current timeline');
  // 계정 관리 권한이 필요한 Queue에서 지정한 실제 글만 재수집한다. 완료 이력은 덮어쓰지 않는다.
  await env.DB.prepare("INSERT OR IGNORE INTO watched_posts (id,body,published_at,phase,discovered_at,context_json) VALUES (?,?,?,'link',?,?)")
    .bind(post.id,post.text,post.date,Date.now(),JSON.stringify(post.context??[])).run();
  await dispatchPending(env);
  log({event:'watch-replay',found:true});
}

async function reanalyzePost(env,postId) {
  if(!/^\d{1,20}$/.test(postId??''))throw new Error('Invalid reanalysis post');
  const page=await collectTimelinePage(env.NITTER_BASE_URL);
  const post=page.posts.find(source=>source.id===postId);
  if(!post)throw new Error('Reanalysis post not on current timeline');
  // 관리자 Queue의 지정 글 한 건만 재분석한다. 기존 링크 메시지를 수정하므로 중복 발송하지 않는다.
  await env.DB.prepare("UPDATE watched_posts SET body=?,published_at=?,context_json=?,phase='analyze',attempts=0,next_attempt=0,last_error=NULL WHERE id=? AND phase='done' AND message_id IS NOT NULL AND reset_message_id IS NULL AND analysis_json IS NULL AND lease_until=0")
    .bind(post.text,post.date,JSON.stringify(post.context??[]),post.id).run();
  await dispatchPending(env);
  log({event:'watch-reanalyze'});
}

export async function scheduleWatch(env) {
  if(watchEnabled(env))await env.PROBE_JOBS.send({kind:'watch-poll'});
}

export async function processWatchJob(message,env) {
  const job=message.body;
  if(job?.kind==='watch-delivery')return processDeliveryJob(message,env);
  if(!['watch-poll','watch-post','watch-replay','watch-reanalyze'].includes(job?.kind))return false;
  if(!watchEnabled(env)){message.ack();return true;}
  try{
    if(job.kind==='watch-poll')await poll(env,job);
    else if(job.kind==='watch-reanalyze')await reanalyzePost(env,job.postId);
    else if(job.kind==='watch-replay')await replayPost(env,job.postId);
    else await processPost(env,job);
    message.ack();
  }catch{
    log({event:'watch-job-failed',kind:job.kind});
    // 다음 Cron이 수집과 D1 미완료 작업을 재개하므로 동일 수집원을 즉시 두드리지 않는다.
    if(job.cursor&&message.attempts<3)message.retry({delaySeconds:60});else message.ack();
  }
  return true;
}
