export async function acquirePoll(db,now,token) {
  return db.prepare('UPDATE watch_state SET poll_lease_until=?,poll_token=? WHERE id=1 AND poll_lease_until<=? RETURNING *').bind(now+90000,token,now).first();
}

export async function recordPage(db,posts,now) {
  const state=await db.prepare('SELECT * FROM watch_state WHERE id=1').first();
  if(!state)throw new Error('Watch migration missing');
  const ordered=[...posts].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
  const newest=ordered.at(-1).id;
  if(!state.baseline_id){
    await db.prepare('UPDATE watch_state SET baseline_id=?,high_water_id=?,started_at=? WHERE id=1 AND baseline_id IS NULL').bind(newest,newest,now).run();
    return {baseline:true,added:0,cutoff:newest};
  }
  const fresh=ordered.filter(post=>BigInt(post.id)>BigInt(state.baseline_id));
  let added=0;
  if(fresh.length){
    // 최고 ID보다 오래된 글도 미러에 늦게 나타날 수 있어 실제 저장 ID로 확인한다.
    // JSON 배열을 한 번 바인딩해 한 페이지가 D1의 매개변수 한도를 넘지 않게 한다.
    const {results:stored}=await db.prepare('SELECT id FROM watched_posts WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(fresh.map(post=>post.id))).all();
    const seen=new Set(stored.map(post=>post.id));
    const unseen=fresh.filter(post=>{if(seen.has(post.id))return false;seen.add(post.id);return true;});
    if(unseen.length){
      // 조회 이후 다른 작업이 같은 ID를 저장해도 기존 처리 이력을 보존한다.
      const results=await db.batch(unseen.map(post=>db.prepare("INSERT OR IGNORE INTO watched_posts (id,body,published_at,phase,discovered_at,context_json) VALUES (?,?,?,'link',?,?)").bind(post.id,post.text,post.date,now,JSON.stringify(post.context??[]))));
      added=results.reduce((sum,result)=>sum+result.meta.changes,0);
    }
  }
  if(BigInt(newest)>BigInt(state.high_water_id))await db.prepare('UPDATE watch_state SET high_water_id=? WHERE id=1 AND high_water_id=?').bind(newest,state.high_water_id).run();
  return {baseline:false,added,cutoff:state.high_water_id};
}

export async function pendingJobs(db,now) {
  const {results}=await db.prepare("SELECT id,phase FROM watched_posts WHERE phase IN ('link','analyze','reset') AND next_attempt<=? AND lease_until<=? ORDER BY discovered_at,id LIMIT 10").bind(now,now).all();
  return results.map(row=>({body:{kind:'watch-post',postId:row.id,phase:row.phase}}));
}

export async function claimPost(db,id,phase,now,token) {
  return db.prepare('UPDATE watched_posts SET lease_until=?,claim_token=? WHERE id=? AND phase=? AND lease_until<=? AND next_attempt<=? RETURNING *').bind(now+120000,token,id,phase,now,now).first();
}

export async function advancePost(db,row,token,phase,fields={}) {
  await db.prepare('UPDATE watched_posts SET phase=?,attempts=0,next_attempt=0,lease_until=0,claim_token=NULL,last_error=NULL,message_id=COALESCE(?,message_id),reset_message_id=COALESCE(?,reset_message_id),analysis_json=COALESCE(?,analysis_json) WHERE id=? AND claim_token=?')
    .bind(phase,fields.messageId??null,fields.resetMessageId??null,fields.analysis?JSON.stringify(fields.analysis):null,row.id,token).run();
}

// 429는 분 단위 제한일 수 있어 초기에 자주 재시도하고, 장시간 지속되면 다음 날에도 한 번 시도한다.
const rateLimitDelays=[15,60,180,300,900,1800,3600,14400,86400];

export function analysisRetryPolicy(row,error,now=Date.now()) {
  const validation=/^analysis_(?:schema|title|summary|type|type_evidence|evidence|current_evidence|summary_evidence|contradiction|json|truncated)$/.test(error.code??'');
  const transient=/^analysis_(?:http_(?:408|500|502|503|504)|timeout|network)$/.test(error.code??'');
  const limited=error.code==='analysis_http_429',attempts=row.attempts+1;
  const shortLimit=validation?2:transient?6:4;
  const recoverable=validation||transient||limited;
  // 같은 analyze 작업과 발송 ID를 유지한다. 장기 장애는 Cron이 인덱스된 next_attempt로 재개한다.
  const recovery=recoverable&&attempts>=shortLimit;
  let base=recovery?(attempts===shortLimit?21600:86400):[15,60,180,900,3600][Math.min(attempts-1,4)];
  if(limited)base=rateLimitDelays[Math.min(attempts-1,rateLimitDelays.length-1)];
  const delaySeconds=Math.ceil(Math.max(error.retryAfter??0,base));
  const expires=Number.isFinite(row.discovered_at)?row.discovered_at+7*86400000:Infinity;
  const terminal=error.permanent===true||attempts>=(recoverable?10:shortLimit)||((limited||recovery)&&now+delaySeconds*1000>expires);
  return {attempts,terminal,delaySeconds,recovery:recovery&&!terminal};
}
export async function retryPost(db,row,token,now,error) {
  const policy=row.phase==='analyze'?analysisRetryPolicy(row,error,now):{
    attempts:row.attempts+1,terminal:row.attempts>=5||error.permanent===true,
    delaySeconds:Math.max(error.retryAfter??0,[60,120,300,900,3600,3600][Math.min(row.attempts,5)]),
  };
  await db.prepare('UPDATE watched_posts SET phase=?,attempts=?,next_attempt=?,lease_until=0,claim_token=NULL,last_error=? WHERE id=? AND claim_token=?')
    .bind(policy.terminal?'failed':row.phase,policy.attempts,now+policy.delaySeconds*1000,error.code??'processing_failed',row.id,token).run();
  return policy.terminal?'failed':'retry';
}

export async function reserveAnalysis(db,now,limit) {
  const day=new Date(now).toISOString().slice(0,10);
  const row=await db.prepare('INSERT INTO analysis_budget (day,calls) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls<? RETURNING calls').bind(day,limit).first();
  return Boolean(row);
}

export async function deferAnalysis(db,row,token,now) {
  const tomorrow=(Math.floor(now/86400000)+1)*86400000;
  await db.prepare('UPDATE watched_posts SET next_attempt=?,lease_until=0,claim_token=NULL,last_error=? WHERE id=? AND claim_token=?').bind(tomorrow,'daily_analysis_limit',row.id,token).run();
}

export async function readWatchStatus(db,guildId) {
  const results=await db.batch([
    db.prepare('SELECT baseline_id,last_success,last_error,started_at FROM watch_state WHERE id=1'),
    // 상태 화면에는 건수가 필요 없으므로 실패 인덱스에서 존재 여부만 확인한다.
    db.prepare(`SELECT EXISTS(SELECT 1 FROM watched_posts WHERE phase='failed')
      OR EXISTS(SELECT 1 FROM post_deliveries WHERE phase='failed' AND guild_id=?) AS has_failures`).bind(guildId),
  ]);
  return {state:results[0].results[0],hasFailures:Boolean(results[1].results[0].has_failures)};
}


export async function resolveQuoteContext(db,post) {
  const context=[...(post.context??[])];
  const quote=context.find(source=>source.relation==='quote'&&(!source.author||source.author==='thsottiaux'));
  if(!quote)return post;
  // 인용한 글의 ID로 한정하여 저장된 같은 작성자의 예고 문맥만 보충한다.
  const stored=await db.prepare('SELECT context_json,analysis_json FROM watched_posts WHERE id=?').bind(quote.id).first();
  let previousExpectedAt=null;
  if(stored){
    const analysis=JSON.parse(stored.analysis_json??'null');
    if(analysis?.status==='scheduled'&&Number.isFinite(analysis.time?.timestamp))previousExpectedAt=analysis.time.timestamp;
    const parents=JSON.parse(stored.context_json??'[]');
    for(const source of parents){
      if(typeof source.id==='string'&&/^\d{1,20}$/.test(source.id)&&BigInt(source.id)<BigInt(quote.id)&&typeof source.text==='string'&&!context.some(other=>other.id===source.id)){
        context.push({id:source.id,author:source.author??'thsottiaux',text:source.text.slice(0,16000),date:source.date,relation:'quoted-context'});
        if(context.length>=8)break;
      }
    }
  }
  return {...post,context:context.slice(0,8),previousExpectedAt};
}
