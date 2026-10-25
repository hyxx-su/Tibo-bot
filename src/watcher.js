import {collectTimelinePage} from './collector.js';
import {hasResetKeyword,analyzeReset,resetNotification} from './reset-analysis.js';
import {acquirePoll,recordPage,pendingJobs,claimPost,advancePost,retryPost,reserveAnalysis,deferAnalysis} from './watch-store.js';

const log=data=>console.log(JSON.stringify({service:'tibo-bot',...data}));
export const watchEnabled=env=>env.WATCH_ENABLED==='true';

async function dispatchPending(env) {
  const jobs=await pendingJobs(env.DB,Date.now());
  if(jobs.length)await env.PROBE_JOBS.sendBatch(jobs);
}

async function poll(env,job) {
  const token=crypto.randomUUID();
  if(!job.cursor&&!await acquirePoll(env.DB,Date.now(),token))return;
  try{
    // 수집원이 실패하는 동안에도 이미 저장한 발송·분석 작업은 재개한다.
    await dispatchPending(env);
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

export async function sendNotification(env,postId,content,kind) {
  const channel=env.DISCORD_NOTIFY_CHANNEL_ID??env.DISCORD_TEST_CHANNEL_ID;
  if(!env.DISCORD_BOT_TOKEN||!/^\d+$/.test(channel??''))throw new Error('Notification configuration missing');
  const response=await fetch(`https://discord.com/api/v10/channels/${channel}/messages`,{
    method:'POST',headers:{Authorization:'Bot '+env.DISCORD_BOT_TOKEN,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),
    body:JSON.stringify({content:Array.from(content).slice(0,1900).join(''),allowed_mentions:{parse:[]},flags:4,nonce:`${kind==='link'?'l':'r'}${postId}`,enforce_nonce:true}),
  });
  if(!response.ok){
    const error=new Error('Notification failed');error.code='discord_'+response.status;error.permanent=[400,401,403,404].includes(response.status);
    if(response.status===429){const data=await response.json().catch(()=>({}));error.retryAfter=Math.min(86400,Math.ceil(Number(data.retry_after)||60));}
    else await response.body?.cancel();
    throw error;
  }
  const data=await response.json();
  if(typeof data.id!=='string')throw new Error('Notification ID missing');
  return data.id;
}

async function processPost(env,job) {
  const token=crypto.randomUUID();
  const row=await claimPost(env.DB,job.postId,job.phase,Date.now(),token);
  if(!row)return;
  let next;
  try{
    const post={id:row.id,text:row.body,date:row.published_at,context:JSON.parse(row.context_json??'[]')};
    if(row.phase==='link'){
      const needsAnalysis=!row.analysis_json&&hasResetKeyword([row.body,...post.context.map(p=>p.text)].join('\n'));
      if(needsAnalysis){
        next='analyze';await advancePost(env.DB,row,token,next);
      }else{
        const messageId=row.message_id??await sendNotification(env,row.id,`https://x.com/thsottiaux/status/${row.id}`,'link');
        next='done';await advancePost(env.DB,row,token,next,{messageId});
      }
    }else if(row.phase==='analyze'){
      const limit=Math.min(100,Math.max(1,Number(env.RESET_ANALYSIS_DAILY_LIMIT)||100));
      if(!await reserveAnalysis(env.DB,Date.now(),limit)){
        await deferAnalysis(env.DB,row,token,Date.now());log({event:'watch-analysis-budget'});return;
      }
      const analysis=await analyzeReset(env,post);
      next=analysis.status==='unrelated'?'link':'reset';
      await advancePost(env.DB,row,token,next,{analysis});
      log({event:'watch-analysis',status:analysis.status,timeResolved:Boolean(analysis.time),totalTokens:analysis.usage?.totalTokenCount});
    }else if(row.phase==='reset'){
      const content=resetNotification(post,JSON.parse(row.analysis_json));
      if(!content)throw new Error('Reset notification missing');
      const resetMessageId=await sendNotification(env,row.id,content,'reset');
      next='done';await advancePost(env.DB,row,token,next,{resetMessageId});
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

export async function scheduleWatch(env) {
  if(watchEnabled(env))await env.PROBE_JOBS.send({kind:'watch-poll'});
}

export async function processWatchJob(message,env) {
  const job=message.body;
  if(!['watch-poll','watch-post','watch-replay'].includes(job?.kind))return false;
  if(!watchEnabled(env)){message.ack();return true;}
  try{
    if(job.kind==='watch-poll')await poll(env,job);
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
