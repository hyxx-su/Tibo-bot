import {formatKoreanTime} from './reset-time.js';

const colors={healthy:0x57F287,warning:0xFEE75C,error:0xED4245};

export function statusMessage({state,hasFailures,gateway,channelId,now=Date.now()}) {
  const hasSuccess=Number.isFinite(state?.last_success)&&state.last_success>0;
  // 내부 처리 정보는 숨겨도 지연·실패를 정상 상태로 안내하지 않도록 판정에 사용한다.
  const stale=hasSuccess&&(now-state.last_success>180000||state.last_success>now+60000);
  const configured=typeof channelId==='string'&&/^\d{1,20}$/.test(channelId);
  let severity='healthy',title='✅ 알림 정상 작동 중',description;
  if(state?.last_error){
    severity='error';title='🔴 새 글을 확인하지 못했어요';description='잠시 후 다시 확인해 주세요. 문제가 계속되면 봇 관리자에게 문의해 주세요.';
  }else if(hasFailures){
    severity='error';title='🔴 일부 알림을 보내지 못했어요';description='알림 채널의 봇 권한을 확인해 주세요. 문제가 계속되면 봇 관리자에게 문의해 주세요.';
  }else if(!configured){
    severity='warning';title='🟡 알림 채널을 선택해 주세요';description='`/알림설정`으로 메시지를 받을 채널을 선택할 수 있어요.';
  }else if(gateway.status!=='online'){
    severity='warning';title='🟡 봇 연결을 확인 중이에요';description=gateway.status==='disabled'?'봇 관리자에게 연결 설정을 확인해 달라고 요청해 주세요.':'잠시 후 다시 확인해 주세요.';
  }else if(!state?.baseline_id||!hasSuccess){
    severity='warning';title='🟡 첫 확인을 기다리고 있어요';description='잠시 후 다시 확인해 주세요.';
  }else if(stale){
    severity='warning';title='🟡 새 글 확인이 지연되고 있어요';description='잠시 후 다시 확인해 주세요.';
  }
  return {
    embeds:[{
      title,color:colors[severity],...(description?{description}:{}),
      fields:[
        {name:'알림 채널',value:configured?`<#${channelId}>`:'미설정',inline:false},
        {name:'최근 확인',value:hasSuccess?`${formatKoreanTime(state.last_success)}\n<t:${Math.floor(state.last_success/1000)}:R>`:'아직 확인 전',inline:false},
      ],
      footer:{text:'새 게시글을 1분마다 확인해요.'},
    }],
    flags:64,
    allowed_mentions:{parse:[]},
  };
}
