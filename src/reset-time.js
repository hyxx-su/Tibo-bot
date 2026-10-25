const zones={UTC:'UTC',GMT:'UTC',KST:'Asia/Seoul',PT:'America/Los_Angeles',ET:'America/New_York',PST:-480,PDT:-420,EST:-300,EDT:-240};
const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function partsAt(timestamp,zone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(timestamp);
  return Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}

function localToUtc(year,month,day,hour,minute,zone) {
  const wall=Date.UTC(year,month-1,day,hour,minute);
  const date=new Date(wall);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||hour>23||minute>59)return null;
  if(typeof zone==='number')return wall-zone*60000;
  let candidate=wall;
  for(let i=0;i<3;i++){
    const p=partsAt(candidate,zone);
    candidate+=wall-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);
  }
  // DST 전환으로 존재하지 않거나 두 번 나타나는 현지 시각은 확정하지 않는다.
  const matches=[candidate-3600000,candidate,candidate+3600000].filter(t=>{
    const p=partsAt(t,zone);return p.year===year&&p.month===month&&p.day===day&&p.hour===hour&&p.minute===minute;
  });
  return matches.length===1?matches[0]:null;
}

export function publishedTimestamp(post) {
  const parsed=Date.parse(post.date.replace('·','').replace(/\s+/g,' ').trim());
  return Number.isFinite(parsed)?parsed:null;
}

export function parseResetTime(expression,publishedAt) {
  if(typeof expression!=='string'||!expression.trim()||!Number.isFinite(publishedAt))return null;
  const text=expression.trim();
  const midnight=text.match(/^(by|before|at)\s+midnight\s+(UTC|GMT|KST|PST|PDT|PT|EST|EDT|ET)[.!]?$/i);
  if(midnight){
    const zoneName=midnight[2].toUpperCase();const zone=zones[zoneName];
    const day=typeof zone==='number'?partsAt(publishedAt+zone*60000,'UTC'):partsAt(publishedAt,zone);
    const next=new Date(Date.UTC(day.year,day.month-1,day.day+1));
    const timestamp=localToUtc(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate(),0,0,zone);
    return timestamp===null?null:{timestamp,basis:`게시 당시 ${zoneName} 날짜의 다음 자정 (${zoneName} 기준)`,relation:/^(by|before)$/i.test(midnight[1])?'deadline':'at'};
  }
  const within=text.match(/\bwithin\s+(?:the\s+)?(?:next\s+)?(\d{1,3})\s+(minutes?|hours?)\b/i);
  const relative=within??text.match(/\bin\s+(\d{1,3})\s+(minutes?|hours?)\b/i)??text.match(/(\d{1,3})\s*(분|시간)\s*후/);
  if(relative){
    const amount=Number(relative[1]);const unit=/hour|시간/i.test(relative[2])?3600000:60000;
    // within은 정확한 실행 시각이 아니라 게시 시각부터 계산한 상한이다.
    return amount>0&&amount*unit<=7*86400000?{timestamp:publishedAt+amount*unit,basis:'게시 시각 기준 상대시간',...(within?{relation:'deadline'}:{})}:null;
  }
  const iso=text.match(/\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})\b/i);
  if(iso){
    const [year,month,day]=iso[1].split('-').map(Number);const [hour,minute]=iso[2].split(':').map(Number);
    const suffix=iso[3].toUpperCase();let offset=0;
    if(suffix!=='Z'){
      const [h,m]=suffix.slice(1).split(':').map(Number);
      if(h>14||m>59||(h===14&&m!==0))return null;
      offset=(h*60+m)*(suffix[0]==='-'?-1:1);
    }
    const timestamp=localToUtc(year,month,day,hour,minute,offset);
    return timestamp===null?null:{timestamp,basis:'원문 날짜·시각·시간대'};
  }
  const clock=text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(UTC|GMT|KST|PST|PDT|PT|EST|EDT|ET)\b/i);
  if(!clock||(!clock[2]&&!clock[3]))return null;
  let hour=Number(clock[1]);const minute=Number(clock[2]??0);
  if(clock[3]){if(hour<1||hour>12)return null;hour=hour%12+(/pm/i.test(clock[3])?12:0);}
  const zone=zones[clock[4].toUpperCase()];
  const sourceDay=typeof zone==='number'?partsAt(publishedAt+zone*60000,'UTC'):partsAt(publishedAt,zone);
  let year=sourceDay.year,month,day;
  const calendar=text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const named=text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  if(calendar){[year,month,day]=calendar.slice(1).map(Number);}
  else if(named){
    month=months.indexOf(named[1].slice(0,3).toLowerCase())+1;day=Number(named[2]);year=Number(named[3]??year);
    if(!named[3]&&Date.UTC(year,month-1,day)<publishedAt-183*86400000)year++;
  }else if(/\b(today|tomorrow)\b|오늘|내일/i.test(text)){
    const nextDay=/\btomorrow\b|내일/i.test(text)?1:0;
    const d=new Date(Date.UTC(sourceDay.year,sourceDay.month-1,sourceDay.day+nextDay));
    year=d.getUTCFullYear();month=d.getUTCMonth()+1;day=d.getUTCDate();
  }else return null;
  const timestamp=localToUtc(year,month,day,hour,minute,zone);
  return timestamp===null?null:{timestamp,basis:'원문 날짜·시각·시간대'};
}

export function formatKoreanTime(timestamp) {
  const p=partsAt(timestamp,'Asia/Seoul');const pad=n=>String(n).padStart(2,'0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (한국시간, KST)`;
}
