import {analyzeReset} from '../src/reset-analysis.js';

// 실제 API를 사용하는 선택적 회귀 검증이다. 운영 DB·Discord에는 접근하지 않는다.
if(!process.env.GEMINI_API_KEY)throw new Error('GEMINI_API_KEY 환경변수가 필요합니다.');
import {regressionCases} from '../test/fixtures/reset-analysis-cases.mjs';
import {holdoutCases} from '../test/fixtures/reset-analysis-holdout.mjs';

const args=process.argv.slice(2),heldout=args.includes('--heldout');
const cases=heldout?holdoutCases:regressionCases;
const intervalArg=args.find(arg=>arg.startsWith('--interval-ms='));
const intervalMs=Number(intervalArg?.split('=')[1]??7000);
if(!Number.isFinite(intervalMs)||intervalMs<1000)throw new Error('호출 간격은 1000ms 이상이어야 합니다.');
const names=args.filter(arg=>!arg.startsWith('--'));
const selected=names.length?cases.filter(entry=>names.includes(entry.name)):cases;
if(!selected.length)throw new Error('일치하는 검증 사례가 없습니다.');
const report={dataset:heldout?'holdout-v1':'regression',planned:selected.length,attempted:0,resolved:0,passed:0,requestFailures:0,totalTokens:0,statusCorrect:0,typeTotal:0,typeCorrect:0,timeTotal:0,timeCorrect:0,tp:0,fp:0,fn:0,confusion:{},errors:{}};
const durations=[];let consecutiveFailures=0;
for(const entry of selected){
  if(report.attempted)await new Promise(resolve=>setTimeout(resolve,intervalMs));
  report.attempted++;
  try{
    const result=await analyzeReset(process.env,{id:'2',date:entry.date??'Oct 25, 2026 · 6:00 AM UTC',text:entry.text,context:entry.context??[]});
    report.resolved++;consecutiveFailures=0;durations.push(result.metrics.analysis_ms);
    const prose=[result.title_ko,...(result.bullets??[])].join(' ');
    const statusPass=result.status===entry.expected;
    const typePass=entry.resetType===undefined||result.reset_type===entry.resetType;
    const timePass=entry.time===undefined||result.time?.timestamp===entry.time;
    const passed=statusPass&&typePass&&timePass&&(entry.expected==='scheduled'||result.time_expression==='')&&(!entry.meaning||(entry.meaning.test(prose)&&result.bullets.length===1&&!/게시글을 게시|내용의 게시글|내용을 게시/.test(prose)));
    report.totalTokens+=result.usage?.totalTokenCount??0;report.statusCorrect+=Number(statusPass);report.passed+=Number(passed);
    if(entry.resetType!==undefined){report.typeTotal++;report.typeCorrect+=Number(typePass);}
    if(entry.time!==undefined){report.timeTotal++;report.timeCorrect+=Number(timePass);}
    const actual=result.status!=='unrelated',expected=entry.expected!=='unrelated';
    if(actual&&expected)report.tp++;if(actual&&!expected)report.fp++;if(!actual&&expected)report.fn++;
    const pair=entry.expected+' → '+result.status;report.confusion[pair]=(report.confusion[pair]??0)+1;
    console.log(JSON.stringify({name:entry.name,expected:entry.expected,actual:result.status,resetType:result.reset_type,passed,analysisMs:result.metrics.analysis_ms}));
  }catch(error){
    report.requestFailures++;consecutiveFailures++;
    const code=error.code??'analysis_failed';report.errors[code]=(report.errors[code]??0)+1;
    console.log(JSON.stringify({name:entry.name,passed:false,code}));
    if(error.permanent||code==='analysis_http_429'||consecutiveFailures>=3){
      console.log(JSON.stringify({stopped:'연속 장애·요청 제한·영구 오류로 추가 API 호출 중단'}));break;
    }
  }
}
durations.sort((a,b)=>a-b);
const ratio=(a,b)=>b?a/b:null;
console.log(JSON.stringify({...report,precision:ratio(report.tp,report.tp+report.fp),recall:ratio(report.tp,report.tp+report.fn),statusAccuracy:ratio(report.statusCorrect,report.resolved),allChecksPassRate:ratio(report.passed,report.attempted),latencyMs:{p50:durations[Math.ceil(durations.length*.5)-1]??null,p95:durations[Math.ceil(durations.length*.95)-1]??null},note:'정확도는 응답 성공 표본 기준. API 실패율과 전체 통과율을 함께 확인하며 합성 자료를 운영 정확도로 일반화하지 않는다.'}));
process.exitCode=report.passed!==selected.length?1:0;
