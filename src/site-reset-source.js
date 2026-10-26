import {readLimitedText} from './input.js';
import {encodeEmbedNotification} from './notification-payload.js';
import {formatKoreanTime} from './reset-time.js';

export const resetSite='https://codex-resets.com/';
const endpoint=resetSite+'api/v1/resets';
function validDate(value) {
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
}
export function parseSiteResets(data,now=Date.now()) {
  if(data?.meta?.api_version!=='v1'||!validDate(data.meta.generated_at)||Math.abs(now-Date.parse(data.meta.generated_at))>15*60000||
    !Array.isArray(data.data)||data.data.length>100||typeof data.pagination?.has_more!=='boolean')throw new Error('Invalid reset site response');
  const cursor=data.pagination.next_cursor;
  if(data.pagination.has_more&&(typeof cursor!=='string'||!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)))throw new Error('Invalid reset site cursor');
  const events=data.data.map(row=>{
    if(typeof row?.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(row.id)||!['regular','banked'].includes(row.reset_type)||
      !validDate(row.announced_at)||Date.parse(row.announced_at)>now+5*60000||
      !['x_post','observed'].includes(row.source?.type)||('status' in row&&row.status!=='executed'))throw new Error('Invalid reset site event');
    if(row.source.type==='x_post'&&row.source.author!=='thsottiaux')throw new Error('Invalid reset site author');
    const url=row.source.url??null;
    if(url!==null&&(typeof url!=='string'||!/^https:\/\/x\.com\/thsottiaux\/status\/\d{1,20}$/.test(url)))throw new Error('Invalid reset site URL');
    if(row.source.type==='x_post'&&!url)throw new Error('Reset site original missing');
    // observed-ID와 X-ID가 달라도 같은 원문·유형이면 같은 사이트 알림이다.
    const identity=url?.split('/').at(-1)??row.id;
    return {key:`site:${row.reset_type}:${identity}`,id:row.id,type:row.reset_type,announcedAt:new Date(row.announced_at).toISOString(),url};
  });
  return {events,nextCursor:data.pagination.has_more?cursor:null};
}
export async function collectSiteResets(now=Date.now()) {
  const events=new Map(),seenCursors=new Set();let cursor=null;
  for(let page=0;page<3;page++){
    const url=new URL(endpoint);url.searchParams.set('limit','100');url.searchParams.set('order','desc');if(cursor)url.searchParams.set('cursor',cursor);
    const response=await fetch(url,{redirect:'manual',headers:{'User-Agent':'TiboBot/0.1 (+https://github.com/hyxx-su/Tibo-bot)'},signal:AbortSignal.timeout(10000)});
    if(!response.ok){
      const error=new Error('Reset site unavailable');
      if(response.status===429){
        const header=response.headers.get('Retry-After');
        const seconds=header&&/^\d+$/.test(header)?Number(header):Math.ceil((Date.parse(header)-now)/1000);
        error.retryAfter=Number.isFinite(seconds)?Math.min(86400,Math.max(60,seconds)):60;
      }
      await response.body?.cancel();throw error;
    }
    const parsed=parseSiteResets(JSON.parse(await readLimitedText(response,1024*1024)),now);
    for(const event of parsed.events)if(!events.has(event.key))events.set(event.key,event);
    cursor=parsed.nextCursor;
    if(!cursor){
      if(!events.size)throw new Error('Empty reset site history');
      return [...events.values()].sort((a,b)=>a.announcedAt.localeCompare(b.announcedAt));
    }
    if(seenCursors.has(cursor))throw new Error('Repeated reset site cursor');seenCursors.add(cursor);
  }
  // 불완전한 첫 스냅샷으로 기준점을 잡아 과거 기록을 신규로 발송하지 않는다.
  throw new Error('Reset site page limit');
}
export function siteResetNotification(event) {
  const type=event.type==='regular'?'정기 리셋 (regular)':event.type==='banked'?'저장형 리셋 (banked)':null;
  if(!type||!validDate(event.announcedAt))throw new Error('Invalid reset site notification');
  const announced=formatKoreanTime(Date.parse(event.announcedAt)).replace(' (한국시간, KST)',' KST');
  return encodeEmbedNotification({title:'🔄 Codex 사용량 리셋 감지',color:0x57F287,url:event.url??resetSite,
    description:`유형: ${type}\n발표 시각: ${announced}\n출처: ${resetSite}\n원문: ${event.url??'제공되지 않음'}`});
}
