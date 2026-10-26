import {validId,discordApi} from './guild-settings.js';
import {publishedTimestamp,formatKoreanTime} from './reset-time.js';
import {noAnnouncementReplies,noAnnouncementReply,manualResetReply} from './reset-replies.js';

const dayMs=86400000;
const koreanDay=timestamp=>new Date(timestamp+9*3600000).toISOString().slice(0,10);
const questionIntents=new Set(['status','timing','remaining','completed','help','greeting','manual','personal']);

export function resetQuestionIntent(value) {
  const text=value.toLowerCase().replace(/[\s,.!?？!~:ㅋㅎㅠㅜᄏ휴ᅮ]/g,'').replace(/쫌/g,'좀');
  const days=[...text.matchAll(/(오늘|내일|모레|어제)/g)].map(match=>({오늘:0,내일:1,모레:2,어제:-1})[match[1]]);
  const dayOffset=days[0];
  const result=intent=>({intent,...(dayOffset===undefined?{}:{dayOffset})});
  if(/^(안녕|하이|ㅎㅇ|반가워|안녕하세요)$/.test(text))return result('greeting');
  if(days.some(day=>day!==dayOffset)||/(이번주|다음주|지난주|다음달|\d+월|\d+일|그제)/.test(text))return result('help');
  if(/(컴퓨터|휴대폰|핸드폰|윈도우|공장|비밀번호|설정|버튼|파일|기기|명령|프롬프트|지시|멘션|http|<@)/.test(text))return result('help');
  if(/(내계정|내사용량|내한도|내쿼터)/.test(text))return result('personal');
  const topic=/(초기화|리셋|reset|사용량|한도|쿼터)/.test(text);
  const asksForInformation=/(언제|몇시|몇분|몇시간|얼마|시간|시각|날짜|일정|예정|계획|소식|공지|상태|알려|설명|맞아|맞지|했|됐|끝|완료|안해|안하|안줘|왜|진행|반영)/.test(text);
  const asksToReset=/(줘|주라|줘라|주세요|주세[요욤용]|주셈|쥬라|주삼|줄래|주면|달라|내놔|시켜|실행해|풀어|부탁|제발|해라|해주|해줄|해봐|ㄱㄱ|ᄀᄀ|ㅈㅂ|ᄌᄇ|가자|드가자|원해|하고싶|해$|좀(?:요|욤|용)?$)/.test(text);
  // 부탁·요구와 시각 질문을 구분한다. “언제 해줘?”는 일정 질문이며 실행 약속을 만들지 않는다.
  if(topic&&asksToReset&&!asksForInformation)return result('manual');
  // 문장 전체를 모델에 보내지 않고 주제·의문 표현만 판별한다. 생략형은 짧은 질문으로 제한한다.
  const short=text.replace(/^(?:(?:그럼|그래서|혹시|진짜|오늘|내일|모레|어제|은|는|아직|벌써|이제|다|좀|또|대체|도대체|도|지금|대략|이번엔|이번에는))*/,'');
  if(!topic&&/(밥|점심|저녁|아침|학교|숙제|날씨|게임|택배|생일|영화)/.test(text))return result('help');
  if(!topic&&!/^(언제|몇시|몇분|몇시간|얼마나|얼마|끝|완료|됐|됨|했|되었|남|있|없|하나|해|할|진행|반영|해준|해줄)/.test(short))return result('help');
  if(/(얼마|몇분|몇시간|남았|남음|남은|남아)/.test(text))return result('remaining');
  if(/(언제|몇시|시간|시각|날짜)/.test(text))return result('timing');
  if(/(끝|완료|됐|됨|되었|했|함$)/.test(text))return result('completed');
  if(topic||/(있|없|하나|해|할|진행|반영)/.test(short))return result('status');
  return result('help');
}

export function resetQuestionJob(message,applicationId,now=Date.now()) {
  if(!message||message.author?.bot||message.webhook_id||![0,19].includes(message.type)||
    ![message.id,message.guild_id,message.channel_id,message.author?.id,applicationId].every(validId)||
    typeof message.content!=='string'||message.content.length>180||/[\r\n]/.test(message.content))return null;
  const postedAt=Date.parse(message.timestamp);
  if(!Number.isFinite(postedAt)||Math.abs(now-postedAt)>120000)return null;
  let text=message.content.normalize('NFKC').trim();
  const mention=new RegExp(`^<@!?${applicationId}>\\s*`);
  if(mention.test(text))text=text.replace(mention,'');
  else if(/^(?:tibo|티보)(?:야|아|(?=[\s,:!~]))[\s,:!~]*/i.test(text))text=text.replace(/^(?:tibo|티보)(?:야|아|(?=[\s,:!~]))[\s,:!~]*/i,'');
  else return null;
  // 질문 본문은 보관하거나 모델에 보내지 않고 답장에 필요한 식별자만 전달한다.
  return {kind:'reset-question',guildId:message.guild_id,channelId:message.channel_id,userId:message.author.id,messageId:message.id,issuedAt:now,...resetQuestionIntent(text)};
}

export async function resetQuestionFingerprint(content) {
  // 보이는 문장이 같은 유니코드 조합만 통일한다. 띄어쓰기·문장부호·표현은 보존한다.
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content.normalize('NFC')));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export function resetQuestionReply({state,posts,pending},now=Date.now(),question={}) {
  if(['help','greeting'].includes(question.intent))return '초기화 관련 질문에만 답변할 수 있어. 초기화 일정이나 진행 상태가 궁금하면 물어봐!';
  if(question.intent==='manual')return manualResetReply(question);
  if(question.intent==='personal')return '네 계정의 사용량은 확인할 수 없어. Tibo가 올린 초기화 공지 기준으로 알려줄게.';
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
  const scope=Number.isInteger(question.dayOffset)?koreanDay(now+question.dayOffset*dayMs):null;
  const scopeName=({[-1]:'어제',0:'오늘',1:'내일',2:'모레'})[question.dayOffset]??'오늘';
  if(scope&&question.dayOffset>0&&signals[0]?.analysis.status==='scheduled'&&!Number.isFinite(signals[0].analysis.time?.timestamp))return `초기화 예고는 있어. 다만 ${scopeName} 일정인지는 아직 확인 못 했네.`;
  const matchesScope=signal=>koreanDay(signal.analysis.status==='scheduled'&&Number.isFinite(signal.analysis.time?.timestamp)?signal.analysis.time.timestamp:signal.at)===scope;
  // 오늘·미래 질문에서도 최신 완료 공지를 건너뛰어 과거 예고를 되살리지 않는다.
  const latest=!scope?signals[0]:question.dayOffset<0?signals.find(matchesScope):signals[0]&&matchesScope(signals[0])?signals[0]:null;
  if(!latest)return noAnnouncementReply(question,`아직 ${scopeName} 초기화 공지는 못 봤네.`);
  const {analysis,at}=latest;const today=koreanDay(now);
  // 최신 완료·취소 관련 언급을 건너뛰어 과거 예정을 되살리지 않는다.
  if(analysis.status==='scheduled'){
    const timestamp=analysis.time?.timestamp;
    if(!Number.isFinite(timestamp))return now-at<=dayMs?'초기화 예정은 있어. 정확한 시간은 아직 못 박지 않았네.':'예전에 초기화 예고는 있었는데, 새 일정은 아직 확인 못 했어.';
    if(timestamp<now)return '예정 시각은 지났는데, 완료 공지는 아직 못 봤네.';
    if(timestamp>now+7*dayMs)return '초기화 예고는 있는데, 가까운 일정인지는 더 확인해야겠네.';
    const formatted=formatKoreanTime(timestamp);const [date,time]=formatted.split(' ');
    const when=date===today?'오늘':date===koreanDay(now+dayMs)?'내일':`${Number(date.slice(5,7))}월 ${Number(date.slice(8,10))}일`;
    const schedule=`${when} ${time}(KST)${analysis.time.relation==='deadline'?'까지':'쯤'}`;
    if(question.intent==='remaining'){
      const minutes=Math.ceil((timestamp-now)/60000),hours=Math.floor(minutes/60);
      const left=minutes===0?'1분 미만':`${hours?hours+'시간 ':''}${minutes%60?minutes%60+'분':''}`.trim();
      return `공지한 ${analysis.time.relation==='deadline'?'기한':'예정 시각'}까지 ${left} 남았어. ${schedule} 예정이야.`;
    }
    return `${question.intent==='completed'?'아직 확인된 건 예고야.':'있지.'} ${schedule} 초기화 예정이야.`;
  }
  if(analysis.status==='completed')return scope||koreanDay(at)===today?`${scope?scopeName:'오늘'} 초기화는 이미 끝났다는 공지가 있어. 달려보자.`:noAnnouncementReply(question,'아직 오늘 새 초기화 공지는 못 봤네.');
  if(analysis.status==='in_progress')return now-at<=dayMs?'초기화 반영 중이라는 공지가 있어. 조금만 기다려.':'이전에는 반영 중이었는데, 지금 상태는 더 확인해야겠네.';
  if(analysis.status==='mentioned')return now-at<=dayMs?'초기화 얘기는 있는데, 확정된 일정은 아직 못 봤네.':noAnnouncementReply(question,'아직 오늘 초기화 공지는 못 봤네.');
  return '최근 글 분석을 아직 확인 못 했어. 조금 뒤에 다시 물어봐.';
}

export function repeatQuestionReply(content,count=0) {
  if(!Number.isInteger(count)||count<=0)return content;
  const endings=['아까도 물어봤지? 😏','또 확인했네. 기다리는 마음은 알지.','계속 확인해도 괜찮아. 새 공지가 기준이야.'];
  return content+' '+endings[Math.min(count-1,endings.length-1)];
}

export async function processResetQuestionJob(message,env) {
  if(message.body?.kind!=='reset-question')return false;
  const job=message.body,now=Date.now();
  const invalid=![job.guildId,job.channelId,job.userId,job.messageId].every(validId)||!Number.isFinite(job.issuedAt)||
    (job.intent!==undefined&&!questionIntents.has(job.intent))||(job.dayOffset!==undefined&&![-1,0,1,2].includes(job.dayOffset))||
    (job.replyIndex!==undefined&&(!Number.isInteger(job.replyIndex)||job.replyIndex<0||job.replyIndex>=noAnnouncementReplies.length));
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
    const answer=resetQuestionReply({state:results[1].results[0],posts:results[2].results,pending:Boolean(results[3].results[0]?.pending)},now,job);
    const content=['help','greeting'].includes(job.intent)?answer:repeatQuestionReply(answer,job.repeatCount);
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
