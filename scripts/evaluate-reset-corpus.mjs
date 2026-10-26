import {readFile,appendFile,chmod,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {analyzeReset} from '../src/reset-analysis.js';

const statuses=['scheduled','in_progress','completed','mentioned','unrelated'];
const has=(value,key)=>Object.hasOwn(value,key);

export function validateCorpus(data) {
  if(data?.version!==1||!Array.isArray(data.cases)||!data.cases.length)throw new Error('평가 자료 형식이 잘못되었습니다.');
  const names=new Set();
  for(const entry of data.cases){
    const expected=entry.expected;const post=entry.post;
    const labels=Array.isArray(expected?.status)?expected.status:[expected?.status];
    if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(entry.name)||names.has(entry.name)||!['dev','holdout'].includes(entry.split)||
      !post||typeof post.text!=='string'||post.text.length>16000||typeof post.date!=='string'||!Number.isFinite(Date.parse(post.date.replace('·',' ')))||
      !labels.length||labels.some(label=>!statuses.includes(label))||
      (has(expected,'timestamp')&&expected.timestamp!==null&&!Number.isFinite(expected.timestamp))||
      (has(expected,'relation')&&!['at','deadline'].includes(expected.relation))||
      (post.context!==undefined&&(!Array.isArray(post.context)||post.context.length>8||post.context.some(source=>typeof source.text!=='string'||source.text.length>16000))))throw new Error('평가 사례의 이름·분류·본문·시각을 확인하세요.');
    names.add(entry.name);
  }
  return data.cases;
}

export function scoreAnalysis(expected,actual) {
  const labels=Array.isArray(expected.status)?expected.status:[expected.status];
  const statusPassed=labels.includes(actual.status);
  const timePassed=(!has(expected,'timestamp')||expected.timestamp===(actual.time?.timestamp??null))&&
    (!has(expected,'relation')||expected.relation===actual.time?.relation)&&
    (actual.status==='scheduled'||(!actual.time&&!actual.time_expression));
  return {passed:statusPassed&&timePassed,statusPassed,timePassed};
}

export function caseFingerprint(entry,implementationHash) {
  // 정답이나 입력, 프롬프트·시간 변환 코드가 달라지면 이전 결과를 재사용하지 않는다.
  return createHash('sha256').update(JSON.stringify({entry,implementationHash})).digest('hex');
}

export function summarize(results,total,attempted,cached) {
  const scored=results.filter(row=>!Array.isArray(row.expected.status));
  const confusion={};
  for(const row of scored){
    const actual=row.actual?.status??'error';
    confusion[row.expected.status]??={};
    confusion[row.expected.status][actual]=(confusion[row.expected.status][actual]??0)+1;
  }
  return {total,evaluated:results.length,remaining:total-results.length,attempted,cached,
    passed:results.filter(row=>row.passed).length,failed:results.filter(row=>!row.passed).length,
    unambiguous:scored.length,unambiguousPassed:scored.filter(row=>row.passed).length,
    ambiguous:results.length-scored.length,falseCompleted:scored.filter(row=>row.expected.status!=='completed'&&row.actual?.status==='completed').length,
    tokensThisRun:results.filter(row=>!row.cached).reduce((sum,row)=>sum+(row.tokens??0),0),confusion};
}

export async function evaluateCases({cases,implementationHash,previous=[],limit=25,intervalMs=5000,env,analyze=analyzeReset,save=async()=>{},emit=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isFinite(intervalMs)||intervalMs<0)throw new Error('호출 상한 또는 간격이 잘못되었습니다.');
  const saved=new Map(previous.filter(row=>!row.error).map(row=>[row.fingerprint,row]));
  const results=[];let attempted=0,cached=0;
  for(const entry of cases){
    const fingerprint=caseFingerprint(entry,implementationHash);
    if(saved.has(fingerprint)){results.push({...saved.get(fingerprint),cached:true});cached++;continue;}
    if(attempted>=limit)break;
    if(attempted)await sleep(intervalMs);
    attempted++;
    let row={fingerprint,name:entry.name,split:entry.split,expected:entry.expected};
    try{
      const result=await analyze(env,entry.post);
      row={...row,...scoreAnalysis(entry.expected,result),actual:{status:result.status,timestamp:result.time?.timestamp??null,relation:result.time?.relation??null},tokens:result.usage?.totalTokenCount??0};
    }catch(error){
      row={...row,passed:false,error:/^Reset analysis HTTP \d{3}$/.test(error.message)?error.message:'분석 요청 또는 응답 검증 실패'};
    }
    // 원문·요약·외부 오류 원문·API 키는 평가 보고서에도 기록하지 않는다.
    await save(row);results.push(row);emit(row);
    if(row.error==='Reset analysis HTTP 429')break;
  }
  return summarize(results,cases.length,attempted,cached);
}

async function main() {
  const args=process.argv.slice(2);const options={};
  for(let i=0;i<args.length;i+=2){
    if(!['--dataset','--report','--split','--limit','--interval-ms'].includes(args[i])||args[i+1]===undefined)throw new Error('사용법: --dataset 비공개.json --report 비공개.jsonl [--split dev|holdout] [--limit 25] [--interval-ms 5000]');
    options[args[i]]=args[i+1];
  }
  if(!options['--dataset']||!options['--report']||!process.env.GEMINI_API_KEY)throw new Error('자료·보고서 경로와 GEMINI_API_KEY 환경변수가 필요합니다.');
  if(options['--split']&&!['dev','holdout'].includes(options['--split']))throw new Error('split은 dev 또는 holdout입니다.');
  const limit=Number(options['--limit']??25);const intervalMs=Number(options['--interval-ms']??5000);
  if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isFinite(intervalMs)||intervalMs<1000)throw new Error('호출 상한은 1~200, 요청 간격은 1000ms 이상이어야 합니다.');
  const dataset=resolve(options['--dataset']);const report=resolve(options['--report']);
  if(dataset===report)throw new Error('자료와 보고서 경로는 달라야 합니다.');
  let cases=validateCorpus(JSON.parse(await readFile(dataset,'utf8')));
  if(options['--split'])cases=cases.filter(entry=>entry.split===options['--split']);
  if(!cases.length)throw new Error('선택된 평가 사례가 없습니다.');
  const sources=await Promise.all(['../src/reset-analysis.js','../src/reset-time.js','../src/input.js','./evaluate-reset-corpus.mjs'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
  const implementationHash=createHash('sha256').update(sources.join('\n')).digest('hex');
  const handle=await open(report,'a',0o600);await handle.close();await chmod(report,0o600);
  const previous=(await readFile(report,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const summary=await evaluateCases({cases,implementationHash,previous,limit,intervalMs,env:process.env,
    save:row=>appendFile(report,JSON.stringify(row)+'\n'),emit:row=>console.log(JSON.stringify(row))});
  console.log(JSON.stringify({summary}));
  process.exitCode=summary.remaining?2:summary.failed?1:0;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(()=>{console.error('평가를 시작하거나 보고서를 기록하지 못했습니다. 입력 형식·경로·환경변수를 확인하세요.');process.exitCode=1;});
}
