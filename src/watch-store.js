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
    const results=await db.batch(fresh.map(post=>db.prepare("INSERT OR IGNORE INTO watched_posts (id,body,published_at,phase,discovered_at,context_json) VALUES (?,?,?,'link',?,?)").bind(post.id,post.text,post.date,now,JSON.stringify(post.context??[]))));
    added=results.reduce((sum,result)=>sum+result.meta.changes,0);
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

export async function retryPost(db,row,token,now,error) {
  const attempts=row.attempts+1;
  const terminal=attempts>=6||error.permanent===true;
  const delay=Math.max(error.retryAfter??0,[60,120,300,900,3600,3600][Math.min(attempts-1,5)])*1000;
  await db.prepare('UPDATE watched_posts SET phase=?,attempts=?,next_attempt=?,lease_until=0,claim_token=NULL,last_error=? WHERE id=? AND claim_token=?')
    .bind(terminal?'failed':row.phase,attempts,now+delay,error.code??'processing_failed',row.id,token).run();
  return terminal?'failed':'retry';
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

export async function readWatchStatus(db) {
  const results=await db.batch([
    db.prepare('SELECT baseline_id,last_success,last_error,started_at FROM watch_state WHERE id=1'),
    db.prepare('SELECT phase,COUNT(*) AS count FROM watched_posts GROUP BY phase'),
  ]);
  return {state:results[0].results[0],counts:results[1].results};
}


export async function resolveQuoteContext(db,post) {
  const context=[...(post.context??[])];
  const quote=context.find(source=>source.relation==='quote');
  if(!quote)return post;
  // 인용한 글의 ID로 한정하여 저장된 같은 작성자의 예고 문맥만 보충한다.
  const stored=await db.prepare('SELECT context_json,analysis_json FROM watched_posts WHERE id=?').bind(quote.id).first();
  if(stored){
    const parents=JSON.parse(stored.context_json??'[]');
    for(const source of parents){
      if(typeof source.id==='string'&&/^\d{1,20}$/.test(source.id)&&BigInt(source.id)<BigInt(quote.id)&&typeof source.text==='string'&&!context.some(other=>other.id===source.id)){
        context.push({id:source.id,text:source.text.slice(0,16000),date:source.date,relation:'quoted-context'});
        if(context.length>=8)break;
      }
    }
  }
  return {...post,context:context.slice(0,8)};
}
