// 직접 작성한 합성 데이터다. 실제 계정의 발언이나 수집 원본이 아니다.
export const latestId='9000000000000000020';

export function timelineHtml({count=20,incomplete=false}={}) {
  const rows=['<html><body>'];
  rows.push('<div class="timeline-item" data-username="fixture-context"><a class="tweet-link" href="/fixture-context/status/999"></a><div class="tweet-content">다른 작성자의 합성 문맥</div></div>');
  for(let i=count;i>0;i--){
    const id=String(9000000000000000000n+BigInt(i));
    rows.push(`<div class="timeline-item ${i%2?'thread-last thread':''}" data-username="thsottiaux"><a class="tweet-link" href="/thsottiaux/status/${id}"></a><div class="tweet-header"><span class="tweet-date"><a ${incomplete?'':'title="Jan 1, 2000 · 12:00 AM UTC"'}></a></span></div>${incomplete?'':`<div class="tweet-content">합성 ${i%2?'답글':'게시글'} ${i}</div>`}</div>`);
  }
  rows.push('</body></html>');
  return rows.join('');
}
