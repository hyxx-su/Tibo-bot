// 프롬프트 예시와 분리한 합성 평가 자료. 이 자료에 맞춰 수정하면 이후에는 회귀 자료로 이동한다.
export const holdoutCases=[
  {name:'사용량 증가와 초기화 구분',text:'Everyone can make twice as many requests now. Existing counters are unchanged.',expected:'unrelated',resetType:'unknown'},
  {name:'캐시 오류 수정과 초기화 구분',text:'Fixed stale usage numbers in the dashboard. This changes the display, not the allowances.',expected:'unrelated',resetType:'unknown'},
  {name:'저장형 추가 지급 완료',text:'An extra banked reset is now in your account, ready for you to redeem.',expected:'completed',resetType:'banked'},
  {name:'아직 지급하지 않은 저장형',text:'The banked reset is not credited yet. Distribution is underway.',expected:'in_progress',resetType:'banked'},
  {name:'완료 인용에 대한 부정 답변',text:'Not this time. No new reset is being applied.',context:[{id:'1',author:'thsottiaux',text:'We reset all usage counters yesterday.',date:'Oct 24, 2026 · 6:00 AM UTC'}],expected:'mentioned'},
  {name:'타인의 완료 주장과 질문',text:'Where did you see that?',context:[{id:'1',author:'someone',text:'All usage counters have been reset!',date:'Oct 25, 2026 · 5:00 AM UTC'}],expected:'unrelated'},
  {name:'예정 수정 후 상대 시간',text:'The usage reset will arrive in 45 minutes, not at the previously announced time.',expected:'scheduled',time:Date.parse('2026-10-25T06:45:00Z')},
  {name:'여전히 적용 중인 일부 초기화',text:'Usage counters are back to zero for some accounts. The remaining accounts are still being updated.',expected:'in_progress',resetType:'regular'},
  {name:'일반 모델 출시의 짧은 완료',text:'All set!',context:[{id:'1',author:'thsottiaux',text:'We are rolling out the new text model.',date:'Oct 25, 2026 · 5:00 AM UTC'}],expected:'unrelated'},
  {name:'사용자가 원하는 초기화',text:'Would a usage reset make your weekend better?',expected:'mentioned'},
  {name:'명시적 사용량 복구 완료',text:'We have restored every account to its full usage allowance. The operation is complete.',expected:'completed',resetType:'regular'},
  {name:'초기화 연기와 시간 미정',text:'We need more time before resetting the usage counters. The earlier deadline is withdrawn; a new one will follow.',expected:'mentioned'},
];
