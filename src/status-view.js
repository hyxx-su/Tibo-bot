import {formatKoreanTime} from './reset-time.js';

const colors={healthy:0x57F287,warning:0xFEE75C,error:0xED4245};
const count=(rows,phase)=>rows.find(row=>row.phase===phase)?.count??0;

export function statusMessage({state,counts,delivery,gateway,channelId,now=Date.now()}) {
  const pending=count(counts,'link')+count(counts,'analyze')+count(counts,'reset');
  const failed=count(counts,'failed');
  const deliveryPending=count(delivery,'pending'),deliveryFailed=count(delivery,'failed');
  const hasSuccess=Number.isFinite(state?.last_success)&&state.last_success>0;
  // 정상 응답이라도 수집이 오래 중단됐으면 정상 카드로 보이지 않도록 한다.
  const stale=hasSuccess&&(now-state.last_success>180000||state.last_success>now+60000);
  const sourceError=Boolean(state?.last_error);
  const online=gateway.status==='online';
  const configured=typeof channelId==='string'&&/^\d{1,20}$/.test(channelId);
  const severity=sourceError||failed>0||deliveryFailed>0?'error':!online||!state?.baseline_id||!hasSuccess||stale||!configured?'warning':'healthy';
  const headline=severity==='healthy'?'✅ 시스템 정상 작동 중':severity==='error'?'🔴 시스템 상태 확인 필요':'🟡 시스템 확인 중';
  const color=colors[severity];
  const connection=online?'🟢 정상':gateway.status==='disabled'?'⚪ 비활성화':'🟡 연결 확인 중';
  const collection=sourceError?'🔴 최근 오류 있음':!hasSuccess?'🟡 첫 수집 대기':stale?'🟡 최근 수집 지연':'🟢 정상';
  const channel=configured?`<#${channelId}>`:'미설정 · `/알림설정`으로 선택';
  const last=hasSuccess?`${formatKoreanTime(state.last_success)}\n<t:${Math.floor(state.last_success/1000)}:R>`:'아직 없음';
  return {
    content:`## ${headline}`,
    embeds:[
      {title:'연결 및 수집',color,fields:[
        {name:'Discord 연결',value:connection,inline:true},
        {name:'자동 확인 주기',value:'1분',inline:true},
        {name:'수집 상태',value:collection,inline:true},
        {name:'알림 채널',value:channel,inline:false},
      ]},
      {title:'최근 수집',color,fields:[
        {name:'마지막 성공',value:last,inline:false},
        {name:'처리 완료',value:`✅ ${count(counts,'done')}건`,inline:true},
        {name:'처리 실패',value:`${failed?'🔴':'🟢'} ${failed}건`,inline:true},
        {name:'분석·처리 대기',value:`${pending?'🟡':'⚪'} ${pending}건`,inline:true},
        {name:'감시 기준점',value:state?.baseline_id?'설정됨':'🟡 첫 수집 대기',inline:false},
      ]},
      {title:'이 서버 알림 전송',color,fields:[
        {name:'전송 대기',value:`${deliveryPending?'🟡':'⚪'} ${deliveryPending}건`,inline:true},
        {name:'전송 실패',value:`${deliveryFailed?'🔴':'🟢'} ${deliveryFailed}건`,inline:true},
      ],footer:{text:'외부 서비스 상황에 따라 수집이 지연되거나 누락될 수 있습니다.'}},
    ],
    flags:64,
    allowed_mentions:{parse:[]},
  };
}
