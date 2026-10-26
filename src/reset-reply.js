import {validId,discordApi} from './guild-settings.js';
import {publishedTimestamp,formatKoreanTime} from './reset-time.js';

const dayMs=86400000;
const koreanDay=timestamp=>new Date(timestamp+9*3600000).toISOString().slice(0,10);

export function resetQuestionJob(message,applicationId,now=Date.now()) {
  if(!message||message.author?.bot||message.webhook_id||![0,19].includes(message.type)||
    ![message.id,message.guild_id,message.channel_id,message.author?.id,applicationId].every(validId)||
    typeof message.content!=='string'||message.content.length>180||/[\r\n]/.test(message.content))return null;
  const postedAt=Date.parse(message.timestamp);
  if(!Number.isFinite(postedAt)||Math.abs(now-postedAt)>120000)return null;
  let text=message.content.normalize('NFKC').trim();
  const mention=new RegExp(`^<@!?${applicationId}>\\s*`);
  if(mention.test(text))text=text.replace(mention,'');
  else if(/^(?:tibo|티보)(?:야|아)?[\s,:!~]*/i.test(text))text=text.replace(/^(?:tibo|티보)(?:야|아)?[\s,:!~]*/i,'');
  else return null;
  if(!/^(?:오늘\s*)?(?:초기화|리셋)(?:\s*(?:예정|계획|소식))?\s*(?:있(?:니|어|냐|나요|나|어요)?|없(?:니|어|냐|나)|언제(?:야|해|돼|해요|인가요)?)[?？!~.\s]*$/i.test(text))return null;
  // 질문 본문은 보관하거나 모델에 보내지 않고 답장에 필요한 식별자만 전달한다.
  return {kind:'reset-question',guildId:message.guild_id,channelId:message.channel_id,userId:message.author.id,messageId:message.id,issuedAt:now};
}

export function resetQuestionReply({state,posts,pending},now=Date.now()) {
  if(!state?.baseline_id||!Number.isFinite(state.last_success)||state.last_error||now-state.last_success>180000||state.last_success>now+60000)return '지금 새 공지를 확인 중이야. 조금 뒤에 다시 물어봐.';
  if(pending)return '새 글이 들어와서 확인 중이야. 잠깐만 기다려.';
  const signals=[];
  for(const post of posts){
    const at=typeof post.published_at==='string'?publishedTimestamp({date:post.published_at}):null;
    if(!Number.isFinite(at)||at>now+60000||now-at>7*dayMs)continue;
    let analysis;
    try{analysis=JSON.parse(post.analysis_json);}catch{analysis={status:'unavailable'};}
    if(!analysis||analysis.status==='unrelated')continue;
    signals.push({analysis,at,id:post.id});
  }
  signals.sort((a,b)=>b.at-a.at||(BigInt(a.id)>BigInt(b.id)?-1:1));
  const latest=signals[0];
  if(!latest)return '아직 오늘 초기화 공지는 못 봤네.';
  const {analysis,at}=latest;const today=koreanDay(now);
  // 최신 완료·취소 관련 언급을 건너뛰어 과거 예정을 되살리지 않는다.
  if(analysis.status==='scheduled'){
    const timestamp=analysis.time?.timestamp;
    if(!Number.isFinite(timestamp))return now-at<=dayMs?'초기화 예정은 있어. 정확한 시간은 아직 못 박지 않았네.':'예전에 초기화 예고는 있었는데, 새 일정은 아직 확인 못 했어.';
    if(timestamp<now)return '예정 시각은 지났는데, 완료 공지는 아직 못 봤네.';
    if(timestamp>now+7*dayMs)return '초기화 예고는 있는데, 가까운 일정인지는 더 확인해야겠네.';
    const formatted=formatKoreanTime(timestamp);const [date,time]=formatted.split(' ');
    const when=date===today?'오늘':date===koreanDay(now+dayMs)?'내일':`${Number(date.slice(5,7))}월 ${Number(date.slice(8,10))}일`;
    return `있지. ${when} ${time}(KST)${analysis.time.relation==='deadline'?'까지':'쯤'} 초기화 예정이야.`;
  }
  if(analysis.status==='completed')return koreanDay(at)===today?'오늘 초기화는 이미 끝났다는 공지가 있어. 달려보자.':'아직 오늘 새 초기화 공지는 못 봤네.';
  if(analysis.status==='in_progress')return now-at<=dayMs?'초기화 반영 중이라는 공지가 있어. 조금만 기다려.':'이전에는 반영 중이었는데, 지금 상태는 더 확인해야겠네.';
  if(analysis.status==='mentioned')return now-at<=dayMs?'초기화 얘기는 있는데, 확정된 일정은 아직 못 봤네.':'아직 오늘 초기화 공지는 못 봤네.';
  return '최근 글 분석을 아직 확인 못 했어. 조금 뒤에 다시 물어봐.';
}

export async function processResetQuestionJob(message,env) {
  if(message.body?.kind!=='reset-question')return false;
  const job=message.body,now=Date.now();
  const invalid=![job.guildId,job.channelId,job.userId,job.messageId].every(validId)||!Number.isFinite(job.issuedAt);
  if(env.RESET_CHAT_ENABLED!=='true'||invalid||job.issuedAt>now+60000||now-job.issuedAt>120000){
    message.ack();console.log(JSON.stringify({service:'tibo-bot',event:'reset-question-skipped',reason:env.RESET_CHAT_ENABLED!=='true'?'disabled':invalid?'invalid':'expired'}));return true;
  }
  try{
    const results=await env.DB.batch([
      env.DB.prepare('SELECT active FROM guild_settings WHERE guild_id=?').bind(job.guildId),
      env.DB.prepare('SELECT baseline_id,last_success,last_error FROM watch_state WHERE id=1'),
      env.DB.prepare('SELECT id,published_at,analysis_json FROM watched_posts ORDER BY id DESC LIMIT 100'),
      env.DB.prepare("SELECT EXISTS(SELECT 1 FROM watched_posts WHERE phase IN ('link','analyze','failed') AND analysis_json IS NULL) AS pending"),
    ]);
    if(results[0].results[0]?.active!==1){message.ack();console.log(JSON.stringify({service:'tibo-bot',event:'reset-question-skipped',reason:'inactive-server'}));return true;}
    const content=resetQuestionReply({state:results[1].results[0],posts:results[2].results,pending:Boolean(results[3].results[0]?.pending)},now);
    await discordApi(env,`/channels/${job.channelId}/messages`,{method:'POST',body:JSON.stringify({content,
      allowed_mentions:{parse:[],replied_user:false},nonce:'q'+job.messageId,enforce_nonce:true,
      message_reference:{message_id:job.messageId,fail_if_not_exists:false},
    })});
    message.ack();
    console.log(JSON.stringify({service:'tibo-bot',event:'reset-question-replied',dispatchAgeMs:Math.max(0,now-job.issuedAt),processingMs:Date.now()-now}));
  }catch(error){
    if(![400,401,403,404].includes(error.status)&&message.attempts<2)message.retry({delaySeconds:30});
    else message.ack();
    console.log(JSON.stringify({service:'tibo-bot',event:'reset-question-failed',httpStatus:error.status??null}));
  }
  return true;
}

export async function dispatchResetQuestion(job,env) {
  // 대화 응답은 수집 Queue를 기다리지 않는다. 일시 실패만 기존 Queue에서 재시도한다.
  let retry;
  await processResetQuestionJob({body:job,attempts:0,ack(){},retry(options){retry=options;}},env);
  if(retry)await env.PROBE_JOBS.send(job,{delaySeconds:retry.delaySeconds});
}
