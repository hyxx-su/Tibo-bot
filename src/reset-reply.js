import {validId,discordApi} from './guild-settings.js';
import {publishedTimestamp,formatKoreanTime} from './reset-time.js';
import {noAnnouncementReplies,noAnnouncementReply,mentionedResetReply,resetRequestLead} from './reset-replies.js';

const dayMs=86400000;
const koreanDay=timestamp=>new Date(timestamp+9*3600000).toISOString().slice(0,10);
const questionIntents=new Set(['status','timing','remaining','completed','help','greeting','manual','personal','absence','delay','change','comparison','clarify','date_scope','history','source','coverage','banked','timezone','deadline']);
const fixedIntents=new Set(['help','greeting','personal','absence','clarify','date_scope','timezone','banked']);

export function resetQuestionIntent(value) {
  const text=value.toLowerCase().replace(/[\s,.!?？!~:ㅋㅎㅠㅜᄏ휴ᅮ]/g,'').replace(/쫌/g,'좀');
  const topic=/(초기화|리셋|reset|사용량|한도|쿼터)/.test(text);
  const plain=intent=>({intent});
  if(/^(안녕|하이|ㅎㅇ|반가워|안녕하세요)$/.test(text))return plain('greeting');
  // 외부 명령·기기 초기화는 말투 확장보다 먼저 차단한다.
  if(/(컴퓨터|휴대폰|핸드폰|윈도우|공장|비밀번호|설정|파일|기기|명령|프롬프트|지시|멘션|http|<@)/.test(text))return plain('help');
  if(!topic&&/(밥|점심|저녁|학교|숙제|날씨|게임|택배|생일|영화)/.test(text))return plain('help');
  if(/(내계정|내사용량|내한도|내쿼터|(?<!하)나만|나는아직|왜그대로|코덱스써도)/.test(text))return plain('personal');
  if(/(초기화권|리셋권|banked)/.test(text))return plain('banked');
  if(/(무료계정|plus|pro만|팀계정|모든사용자|모두한테|일부만|안된사람|주간한도|다섯시간한도|5시간한도|추가사용량|남은사용량은사라|적용대상)/.test(text))return plain('coverage');
  if(/(공지가없으면|안된다는뜻으로|공지없다고)/.test(text))return plain('absence');
  if(/(원래몇시|아까곧|잘못알려|넘어갔|오늘이야내일|바뀐|바꾼|달라진|이전예고)/.test(text))return plain('comparison');
  if(/(취소|연기|밀린|늦어진다는공지)/.test(text))return plain('change');
  if(/(왜.*안|한다더니|지났|아직도안풀|기다려야하는이유|얼마나늦)/.test(text))return plain('delay');
  if(/(원문|링크|누가|직접말|어느글|본문|답글|댓글|근거|공식발표|확정공지만|그냥reset|농담|예전글|최신|새로.*소식|며칠전에|배포완료|관련글보여)/.test(text))return plain('source');
  if(/(정확히자정|전이면.*일찍|이전에끝|기한|일찍초기화|아침까지.*뜻)/.test(text))return plain('deadline');
  if(/(pst|pdt|pt(?=랑|오전|오후|\d)|미국|서머타임|시간대|어느나라|글올라온시간|어제말한내일|자정넘|한국날짜로오늘|한국시간\d|추정인|오늘밤이라는|날짜가바뀌)/.test(text)){
    const clock=text.match(/(pst|pdt)(오전|오후)?(\d{1,2})시(?!\d|반)/);
    if(clock&&(text.match(/pst|pdt/g)||[]).length===1){const hour=Number(clock[3]);if((clock[2]&&hour>=1&&hour<=12)||(!clock[2]&&hour<24))return {intent:'timezone',zone:clock[1].toUpperCase(),hour:clock[2]?hour%12+(clock[2]==='오후'?12:0):hour};}
    return plain('timezone');
  }
  if(/(이번주|다음주|지난주|다음달|주말|[월화수목금토일]요일|\d+월|\d+일|그제)/.test(text))return plain('date_scope');
  if(/^(아직|됐냐|그럼지금은기다리면되는거지|지금기다리고있으면돼|그래서결론은언제된다는거야)$/.test(text)||/(오늘새벽|어젯밤)/.test(text))return plain('clarify');
  const days=[...text.matchAll(/(오늘|내일|모레|어제)/g)].map(match=>({오늘:0,내일:1,모레:2,어제:-1})[match[1]]);
  const dayOffset=days[0];
  const result=intent=>({intent,...(dayOffset===undefined?{}:{dayOffset})});
  if(days.some(day=>day!==dayOffset))return plain('clarify');
  // 날짜가 지정된 질문과 앞으로의 예고를 최근 완료 이력으로 바꾸지 않는다.
  if(topic&&dayOffset===undefined&&/(최근|요즘|요새|근래|얼마전|지난번|저번|마지막)/.test(text)&&
    !/(예정|예고|계획|다음|앞으로|할거|할까|할지|할건|해줄|될까|되나|할예정|진행중|되는중|반영중|해줘|해주|주라|내놔|제발|부탁)/.test(text)&&
    /(지난번|저번|마지막|있|없|했|됐|되었|완료|끝|한적|된적|한게|한건|이력|기록|언제|몇시|시각|날짜)/.test(text))return plain('history');
  if(/(카운트다운|얼마|몇분|몇시간|남았|남음|남은|남아|곧이야|시간안에돼|분뒤면|시간다됐)/.test(text))return result('remaining');
  if(/(오전이야오후|저녁전에|자정에|자기전에|오늘안에|kst로|한국날짜로며칠|다음리셋일정)/.test(text))return result('timing');
  if(/(되는중|반영중|진행|시작한거야|예고만|다음에또|한다고했|언제인지있는지)/.test(text))return result('status');
  if((topic&&/확정/.test(text))||/(한다던건|확실한소식)/.test(text)||(topic&&/[?？]/.test(value)&&!/(언제|몇시|시간)/.test(text)&&/(초기화|리셋)해$/.test(text)))return result('status');
  const asksForInformation=/(언제|몇시|몇분|몇시간|얼마|시간|시각|날짜|일정|예정|계획|소식|공지|상태|알려|설명|맞아|맞지|맞긴|했|됐|끝|완료|안해|안하|안줘|왜|진행|반영)/.test(text);
  const asksToReset=/(줘|주라|줘라|주세요|주세[요욤용]|주셈|쥬라|주삼|줄래|주면|달라|내놔|시켜|실행해|풀어|부탁|제발|해라|해주|해줄|해봐|ㄱㄱ|ᄀᄀ|ㅈㅂ|ᄌᄇ|가자|드가자|원해|하고싶|간절|리셋하자|눌러줘|해$|좀(?:요|욤|용)?$)/.test(text);
  // 부탁·요구와 시각 질문을 구분한다. “언제 해줘?”는 일정 질문이며 실행 약속을 만들지 않는다.
  if(topic&&asksToReset&&!asksForInformation)return result('manual');
  // 문장 전체를 모델에 보내지 않고 주제·의문 표현만 판별한다. 생략형은 짧은 질문으로 제한한다.
  const short=text.replace(/^(?:(?:그럼|그래서|혹시|진짜|오늘|내일|모레|어제|은|는|아직|벌써|이제|다|좀|또|대체|도대체|도|지금|대략|이번엔|이번에는))*/,'');

  if(!topic&&!/(확실한소식|한국시간|시간은|정확히몇시|대략적인시간|다풀린)/.test(text)&&!/^(언제|몇시|몇분|몇시간|얼마나|얼마|끝|완료|됐|됨|했|되었|남|있|없|하나|해|할|진행|반영|해준|해줄)/.test(short))return result('help');
  if(/(얼마|몇분|몇시간|남았|남음|남은|남아)/.test(text))return result('remaining');
  if(/(언제|몇시|시간|시각|날짜)/.test(text))return result('timing');
  if(/(끝|완료|됐|됨|되었|했|함$|다풀린|초기화된거)/.test(text))return result('completed');
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

export function resetQuestionReply(input,now=Date.now(),question={}) {
  const answer=resetQuestionStatusReply(input,now,question);
  if(question.intent!=='manual'||!input.state?.baseline_id||input.pending||input.state.last_error||!Number.isFinite(input.state.last_success)||now-input.state.last_success>180000)return answer;
  return resetRequestLead(question)+' '+answer;
}

function resetQuestionStatusReply({state,posts,pending,siteResets=[]},now,question) {
  if(['help','greeting'].includes(question.intent))return '초기화 관련 질문에만 답변할 수 있어. 초기화 일정이나 진행 상태가 궁금하면 물어봐!';
  if(question.intent==='absence')return '공지가 안 보인다고 초기화가 없다는 뜻은 아니야. 아직 확인되지 않은 거야.';
  if(question.intent==='clarify')return '초기화 예정 시간인지, 완료됐는지 조금만 더 알려줘.';
  if(question.intent==='date_scope')return '주간·요일별 전체 일정은 확인 못 해. 오늘·내일·모레·어제 중 어느 날이 궁금해?';
  if(question.intent==='banked')return '초기화권 지급과 즉시 초기화는 달라. 사용 위치나 자동 적용 여부는 해당 공지에서 확인해야 해.';
  if(question.intent==='timezone'){
    if(['PST','PDT'].includes(question.zone)&&Number.isInteger(question.hour)&&question.hour>=0&&question.hour<24){
      const hour=question.hour+(question.zone==='PST'?17:16);
      return `${question.zone} ${String(question.hour).padStart(2,'0')}:00이면 한국시간 ${hour>=24?'다음 날':'같은 날'} ${String(hour%24).padStart(2,'0')}:00야. 실제 초기화 일정과는 별개인 시간 변환이야.`;
    }
    return '원문 게시 날짜와 시간대가 필요해. PST는 UTC−8, PDT는 UTC−7이고 PT는 날짜에 따라 달라서, 원문 없이 시각을 확정하진 않을게.';
  }
  if(question.intent==='personal')return '네 계정의 사용량은 확인할 수 없어. Tibo가 올린 초기화 공지 기준으로 알려줄게.';
  if(!state?.baseline_id||!Number.isFinite(state.last_success)||state.last_error||now-state.last_success>180000||state.last_success>now+60000)return '지금 새 공지를 확인 중이야. 조금 뒤에 다시 물어봐.';
  if(pending)return '새 글이 들어와서 확인 중이야. 잠깐만 기다려.';
  const signals=[];
  for(const post of posts){
    if(!validId(post.id))continue;
    const at=typeof post.published_at==='string'?publishedTimestamp({date:post.published_at}):null;
    if(!Number.isFinite(at)||at>now+60000||now-at>7*dayMs)continue;
    let analysis;
    try{analysis=JSON.parse(post.analysis_json);}catch{analysis={status:'unavailable'};}
    if(!analysis||analysis.status==='unrelated')continue;
    signals.push({analysis,at,id:post.id});
  }
  for(const event of siteResets){
    const at=Date.parse(event.announced_at);
    if(!['regular','banked'].includes(event.reset_type)||!Number.isFinite(at)||at>now+60000||now-at>7*dayMs)continue;
    const match=typeof event.original_url==='string'?event.original_url.match(/^https:\/\/x\.com\/thsottiaux\/status\/(\d{1,20})$/):null;
    if(event.original_url!==null&&!match)continue;
    // 같은 원문의 예고 분류보다 사이트에서 확인한 실행 기록을 우선한다.
    if(match){const index=signals.findIndex(signal=>!signal.site&&signal.id===match[1]);if(index>=0)signals.splice(index,1);}
    signals.push({analysis:{status:'completed',reset_type:event.reset_type},at,id:match?.[1]??'0',site:true});
  }
  signals.sort((a,b)=>b.at-a.at||Number(Boolean(b.site))-Number(Boolean(a.site))||(BigInt(a.id)>BigInt(b.id)?-1:1));
  const newest=signals[0];
  const sourceLink=signal=>signal.site?'https://codex-resets.com/':`https://x.com/thsottiaux/status/${signal.id}`;
  if(question.intent==='history'){
    const completed=signals.find(signal=>signal.analysis.status==='completed'&&!['banked','unknown'].includes(signal.analysis.reset_type));
    if(completed?.site)return `최근 7일 범위에서 찾은 마지막 정기 리셋 실행 기록의 사이트 발표 시각은 ${formatKoreanTime(completed.at)}이야.`;
    return completed?`최근 100개 글·7일 범위에서 찾은 마지막 완료 공지는 ${formatKoreanTime(completed.at)}에 올라왔어.`:'최근 100개 글·7일 범위에서는 완료 공지를 찾지 못했어.';
  }
  if(['source','coverage','comparison','change'].includes(question.intent)){
    const labels={scheduled:'초기화 예고',completed:'초기화 완료',in_progress:'초기화 반영 중',mentioned:'초기화 관련 언급'};
    if(question.intent==='coverage')return '적용 대상이나 한도 종류는 저장된 분석만으로 확인 못 해.'+(newest?` 해당 공지에서 확인해 줘. ${sourceLink(newest)}`:' 확인할 초기화 공지도 아직 못 찾았어.');
    if(newest?.analysis.reset_type==='banked')Object.assign(labels,{scheduled:'저장형 리셋 지급 예정',completed:'저장형 리셋 지급 완료',in_progress:'저장형 리셋 지급 중',mentioned:'저장형 리셋 관련 언급'});
    else if(newest?.analysis.reset_type==='unknown'&&newest.analysis.status==='completed')labels.completed='완료 안내 · 리셋 유형 미확인';
    const lead=question.intent==='comparison'?'이전 답변과의 변경 여부는 단정할 수 없어. ':question.intent==='change'?'취소·연기 여부는 현재 분류만으로 확정할 수 없어. ':'';
    return lead+(newest?`저장된 최신 ${newest.site?'사이트 실행 기록의 발표 시각은':'관련 글은'} ${formatKoreanTime(newest.at)}이야. 저장된 분류는 ‘${labels[newest.analysis.status]??'확인 불가'}’야. 출처: ${sourceLink(newest)}`:'확인할 초기화 관련 원문은 아직 못 찾았어.');
  }
  if(question.intent==='deadline')return '“까지·이전”은 완료 기한이라 그보다 일찍 될 수도 있어. 정확한 실행 시각이나 이미 완료됐다는 뜻은 아니야.'+(newest?.analysis.status==='scheduled'&&newest.analysis.time?.relation==='deadline'?' 최근 예고도 기한으로 해석됐어.':' 지금 글에 그 기한이 있는지는 원문을 확인해야 해.');
  const scope=Number.isInteger(question.dayOffset)?koreanDay(now+question.dayOffset*dayMs):null;
  const scopeName=({[-1]:'어제',0:'오늘',1:'내일',2:'모레'})[question.dayOffset]??'오늘';
  if(scope&&question.dayOffset>0&&signals[0]?.analysis.status==='scheduled'&&!Number.isFinite(signals[0].analysis.time?.timestamp))return `${signals[0]?.analysis.reset_type==='banked'?'저장형 리셋 지급':'초기화'} 예고는 있어. 다만 ${scopeName} 일정인지는 아직 확인 못 했네.`;
  const matchesScope=signal=>koreanDay(signal.analysis.status==='scheduled'&&Number.isFinite(signal.analysis.time?.timestamp)?signal.analysis.time.timestamp:signal.at)===scope;
  // 오늘·미래 질문에서도 최신 완료 공지를 건너뛰어 과거 예고를 되살리지 않는다.
  // 완료 뒤의 단순 언급은 완료 사실을 지우지 않는다. 새로운 예고·진행·분석 불명은 건너뛰지 않는다.
  const candidates=scope&&question.dayOffset<0?signals.filter(matchesScope):signals;
  const actionable=candidates.find(signal=>signal.analysis.status!=='mentioned');
  const effective=candidates[0]?.analysis.status==='mentioned'&&actionable?.analysis.status==='completed'?actionable:candidates[0];
  const latest=!scope?effective:effective&&matchesScope(effective)?effective:null;
  if(!latest)return noAnnouncementReply(question,`아직 ${scopeName} 초기화 공지는 못 봤네.`);
  const {analysis,at}=latest;const today=koreanDay(now);
  const banked=analysis.reset_type==='banked';
  if(latest.site){
    if(!scope&&koreanDay(at)!==today)return noAnnouncementReply(question,'아직 오늘 새 초기화 공지는 못 봤네.');
    const time=formatKoreanTime(at).split(' ')[1];
    return banked?`${scope?scopeName:'오늘'} 저장형 리셋 지급 기록이 있어. 사이트 발표 시각은 ${time}(KST)야. 현재 사용량의 즉시 초기화와는 달라.`:`${scope?scopeName:'오늘'} 정기 리셋이 실행된 기록이 있어. 사이트 발표 시각은 ${time}(KST)야.`;
  }
  if(analysis.status==='completed'&&analysis.reset_type==='unknown')return '완료 안내는 있지만 정기 리셋인지 저장형 지급인지 아직 확인되지 않았어.';
  if(banked){
    if(analysis.status==='completed')return scope||koreanDay(at)===today?'저장형 리셋이 지급됐다는 공지가 있어. 현재 사용량의 즉시 초기화와는 달라.':noAnnouncementReply(question,'아직 오늘 새 초기화 공지는 못 봤네.');
    if(analysis.status==='in_progress')return now-at<=dayMs?'저장형 리셋 지급이 진행 중이야. 현재 사용량이 바로 초기화됐다는 뜻은 아니야.':'이전에는 저장형 리셋 지급 중이었는데, 지금 상태는 더 확인해야 해.';
    if(analysis.status==='mentioned')return '저장형 리셋 얘기는 있지만 지급 일정이나 완료 여부는 아직 확인되지 않았어.';
  }
  // 최신 완료·취소 관련 언급을 건너뛰어 과거 예정을 되살리지 않는다.
  if(analysis.status==='scheduled'){
    const timestamp=analysis.time?.timestamp;
    if(banked&&!Number.isFinite(timestamp))return '저장형 리셋 지급 예고는 있어. 정확한 지급 시간은 아직 확인되지 않았어.';
    if(!Number.isFinite(timestamp))return now-at<=dayMs?'초기화 예정은 있어. 정확한 시간은 아직 못 박지 않았네.':'예전에 초기화 예고는 있었는데, 새 일정은 아직 확인 못 했어.';
    if(banked&&timestamp<now)return '저장형 리셋 지급 예정 시각은 지났지만 지급 완료 공지는 아직 못 봤네.';
    if(timestamp<now)return question.intent==='delay'?'예정 시각은 지났어. 완료 공지나 늦어진 이유는 아직 확인 못 했네.':'예정 시각은 지났는데, 완료 공지는 아직 못 봤네.';
    if(timestamp>now+7*dayMs)return '초기화 예고는 있는데, 가까운 일정인지는 더 확인해야겠네.';
    const formatted=formatKoreanTime(timestamp);const [date,time]=formatted.split(' ');
    const when=date===today?'오늘':date===koreanDay(now+dayMs)?'내일':`${Number(date.slice(5,7))}월 ${Number(date.slice(8,10))}일`;
    const schedule=`${when} ${time}(KST)${analysis.time.relation==='deadline'?'까지':'쯤'}`;
    if(question.intent==='remaining'){
      const minutes=Math.ceil((timestamp-now)/60000),hours=Math.floor(minutes/60);
      const left=minutes===0?'1분 미만':`${hours?hours+'시간 ':''}${minutes%60?minutes%60+'분':''}`.trim();
      if(banked)return `저장형 리셋 지급 ${analysis.time.relation==='deadline'?'기한':'예정 시각'}까지 ${left} 남았어. ${schedule} 예정이야.`;
      return `공지한 ${analysis.time.relation==='deadline'?'기한':'예정 시각'}까지 ${left} 남았어. ${schedule} 예정이야.`;
    }
    if(banked)return `저장형 리셋 지급은 ${schedule} 예정이야. 현재 사용량이 바로 초기화됐다는 뜻은 아니야.`;
    return `${question.intent==='completed'?'아직 확인된 건 예고야.':'있지.'} ${schedule} 초기화 예정이야.`;
  }
  if(analysis.status==='completed')return scope||koreanDay(at)===today?`${scope?scopeName:'오늘'} 초기화는 이미 끝났다는 공지가 있어. 달려보자.`:noAnnouncementReply(question,'아직 오늘 새 초기화 공지는 못 봤네.');
  if(analysis.status==='in_progress')return now-at<=dayMs?'초기화 반영 중이라는 공지가 있어. 조금만 기다려.':'이전에는 반영 중이었는데, 지금 상태는 더 확인해야겠네.';
  if(analysis.status==='mentioned')return now-at<=dayMs?mentionedResetReply(question):noAnnouncementReply(question,'아직 오늘 초기화 공지는 못 봤네.');
  return '최근 글 분석을 아직 확인 못 했어. 조금 뒤에 다시 물어봐.';
}

export function repeatQuestionReply(content,count=0) {
  if(count!==1)return content;
  return content+' 아까도 물어봤지? 😏';
}

export async function processResetQuestionJob(message,env) {
  if(message.body?.kind!=='reset-question')return false;
  const job=message.body,now=Date.now();
  const invalid=![job.guildId,job.channelId,job.userId,job.messageId].every(validId)||!Number.isFinite(job.issuedAt)||
    (job.intent!==undefined&&!questionIntents.has(job.intent))||(job.dayOffset!==undefined&&![-1,0,1,2].includes(job.dayOffset))||
    ((job.zone!==undefined||job.hour!==undefined)&&(job.intent!=='timezone'||!['PST','PDT'].includes(job.zone)||!Number.isInteger(job.hour)||job.hour<0||job.hour>23))||
    (job.replyIndex!==undefined&&(!Number.isInteger(job.replyIndex)||job.replyIndex<0||job.replyIndex>=noAnnouncementReplies.length));
  if(env.RESET_CHAT_ENABLED!=='true'||invalid||job.issuedAt>now+60000||now-job.issuedAt>120000){
    message.ack();console.log(JSON.stringify({service:'tibo-bot',event:'reset-question-skipped',reason:env.RESET_CHAT_ENABLED!=='true'?'disabled':invalid?'invalid':'expired'}));return true;
  }
  try{
    const needsStatus=!fixedIntents.has(job.intent);
    // 고정 안내에는 게시글 분석을 읽지 않되, 퇴장한 서버의 응답 차단은 유지한다.
    const queries=[env.DB.prepare('SELECT active FROM guild_settings WHERE guild_id=?').bind(job.guildId)];
    if(needsStatus)queries.push(
      env.DB.prepare('SELECT baseline_id,last_success,last_error FROM watch_state WHERE id=1'),
      env.DB.prepare('SELECT id,published_at,analysis_json FROM watched_posts ORDER BY id DESC LIMIT 100'),
      env.DB.prepare("SELECT EXISTS(SELECT 1 FROM watched_posts WHERE phase IN ('link','analyze','failed') AND analysis_json IS NULL) AS pending"),
    );
    const includeSiteResets=needsStatus&&env.WATCH_ENABLED==='true'&&env.SITE_RESETS_ENABLED==='true';
    if(includeSiteResets)queries.push(env.DB.prepare('SELECT reset_type,announced_at,original_url FROM site_reset_events WHERE announced_at>=? ORDER BY announced_at DESC LIMIT 100').bind(new Date(now-7*dayMs).toISOString()));
    const results=await env.DB.batch(queries);
    const databaseMs=Date.now()-now;
    if(results[0].results[0]?.active!==1){message.ack();console.log(JSON.stringify({service:'tibo-bot',event:'reset-question-skipped',reason:'inactive-server'}));return true;}
    const answer=resetQuestionReply(needsStatus?{state:results[1].results[0],posts:results[2].results,pending:Boolean(results[3].results[0]?.pending),siteResets:includeSiteResets?results[4].results:[]}:{},now,job);
    const content=['help','greeting'].includes(job.intent)?answer:repeatQuestionReply(answer,job.repeatCount);
    await discordApi(env,`/channels/${job.channelId}/messages`,{method:'POST',body:JSON.stringify({content,
      allowed_mentions:{parse:[],replied_user:false},nonce:'q'+job.messageId,enforce_nonce:true,
      message_reference:{message_id:job.messageId,fail_if_not_exists:false},
    })});
    message.ack();
    console.log(JSON.stringify({service:'tibo-bot',event:'reset-question-replied',dispatchAgeMs:Math.max(0,now-job.issuedAt),databaseMs,processingMs:Date.now()-now}));
  }catch(error){
    const delaySeconds=error.status===429?Math.max(1,error.retryAfter??60):30;
    const transient=error.status===undefined||error.status===429||error.status>=500;
    // 제한을 일찍 재시도하지 않고, 기한 안에 답할 수 없는 질문은 Queue에 다시 넣지 않는다.
    if(transient&&message.attempts<2&&Date.now()+delaySeconds*1000<job.issuedAt+120000)message.retry({delaySeconds});
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
