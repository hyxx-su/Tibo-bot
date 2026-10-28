import {publishedTimestamp} from './reset-time.js';

// 사이트의 실행 표시는 후보일 뿐이다. 이미 검증해 저장한 X 분석과 원문을 재사용한다.
export function verifySiteReset(event,post,analysis) {
  const result=(verification,reason)=>({verification,reason});
  if(!post||!analysis||analysis.status==='unavailable')return result('pending','analysis_missing');
  if(analysis.status==='unrelated')return result('rejected','unrelated_post');
  if(event.sourceType!=='x_post')return result('pending','observation_unconfirmed');
  if(analysis.status!=='completed')return result('pending','completion_unconfirmed');
  if(analysis.reset_type!==event.type)return result('pending','type_mismatch');
  if(typeof analysis.evidence!=='string'||!analysis.evidence.trim()||!post.text.includes(analysis.evidence))return result('pending','completion_evidence_missing');
  const sources=[post,...(post.context??[])];
  if(typeof analysis.type_evidence!=='string'||!analysis.type_evidence.trim()||!sources.some(source=>typeof source.text==='string'&&source.text.includes(analysis.type_evidence)))return result('pending','type_evidence_missing');
  const published=publishedTimestamp(post),announced=Date.parse(event.announcedAt);
  if(!Number.isFinite(published)||!Number.isFinite(announced)||Math.abs(published-announced)>=60000)return result('pending','announcement_time_mismatch');
  return result('verified','x_completion_confirmed');
}
