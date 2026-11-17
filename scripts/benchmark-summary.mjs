import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {summaryCases} from '../test/fixtures/summary-semantics-cases.mjs';

// 실제 호출은 명시적으로 실행한다. 원문/결과는 지정한 비공개 파일에만 기록한다.
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...value]=arg.replace(/^--/,'').split('=');return [key,value.join('=')||true];}));
if(!process.env.GEMINI_API_KEY||!args.output)throw new Error('GEMINI_API_KEY와 --output 경로가 필요합니다.');
const moduleUrl=args.module?pathToFileURL(resolve(args.module)):new URL('../src/reset-analysis.js',import.meta.url);
const {analyzeReset}=await import(moduleUrl);
const cases=args.dataset?JSON.parse(await fs.readFile(args.dataset,'utf8')):summaryCases;
const delay=Number(args.interval??7000);
if(!Number.isFinite(delay)||delay<1000)throw new Error('호출 간격은 1000ms 이상이어야 합니다.');
const rows=[],originalFetch=globalThis.fetch;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
await fs.writeFile(args.output,'',{mode:0o600,flag:'wx'});
let stop=false;
for(const [index,entry] of cases.entries()){
  if(index)await sleep(delay);
  const row={name:entry.name,expected:entry.status,calls:[]},started=Date.now();
  const request=async(url,options,body)=>{
    const call={started:Date.now(),promptChars:body.systemInstruction.parts[0].text.length,inputChars:body.contents[0].parts[0].text.length};row.calls.push(call);
    try{
      const response=await originalFetch(url,{...options,body:JSON.stringify(body)});
      call.status=response.status;
      if(response.ok){const data=await response.clone().json();call.usage=data.usageMetadata;call.finish=data.candidates?.[0]?.finishReason;}
      if([401,403,429].includes(response.status))stop=true;
      return response;
    }finally{call.ms=Date.now()-call.started;delete call.started;}
  };
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(!args.split||!body.generationConfig.responseSchema.properties.status)return request(url,options,body);
    const prompt=body.systemInstruction.parts[0].text,resetAt=prompt.indexOf('RESET CLASSIFICATION'),editAt=prompt.indexOf('KOREAN EDITING');
    if(resetAt<0||editAt<0)throw new Error('분리 비교는 현재 지침의 명시된 경계가 필요합니다.');
    const summaryKeys=['title_evidence','title_ko','summary_items'];
    const partition=summary=>{
      const copy=structuredClone(body),schema=copy.generationConfig.responseSchema;
      schema.properties=Object.fromEntries(Object.entries(schema.properties).filter(([key])=>summaryKeys.includes(key)===summary));
      schema.required=schema.required.filter(key=>summaryKeys.includes(key)===summary);
      if(schema.propertyOrdering)schema.propertyOrdering=schema.propertyOrdering.filter(key=>summaryKeys.includes(key)===summary);
      copy.systemInstruction.parts[0].text=summary?prompt.slice(0,resetAt):prompt.slice(0,editAt)+prompt.slice(resetAt);
      return copy;
    };
    const attempts=await Promise.allSettled([request(url,options,partition(true)),request(url,options,partition(false))]);
    const rejected=attempts.find(attempt=>attempt.status==='rejected');
    if(rejected){
      await Promise.all(attempts.filter(attempt=>attempt.status==='fulfilled').map(attempt=>attempt.value.body?.cancel()));
      throw rejected.reason;
    }
    const responses=attempts.map(attempt=>attempt.value);
    const failure=responses.find(response=>!response.ok);
    if(failure){await Promise.all(responses.filter(response=>response!==failure).map(response=>response.body?.cancel()));return failure;}
    const data=await Promise.all(responses.map(response=>response.json()));
    const incomplete=data.find(value=>value.candidates?.[0]?.finishReason!=='STOP');
    if(incomplete)return Response.json(incomplete);
    const results=data.map(value=>JSON.parse(value.candidates[0].content.parts.filter(part=>!part.thought).map(part=>part.text??'').join('')));
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(Object.assign({},...results))}]}}]});
  };
  try{row.result=await analyzeReset(process.env,entry.post);row.statusCorrect=row.result.status===entry.status;}
  catch(error){row.error=/^analysis_[a-z0-9_]+$/.test(error.code??'')?error.code:'benchmark_failed';}
  finally{globalThis.fetch=originalFetch;}
  row.ms=Date.now()-started;rows.push(row);
  await fs.appendFile(args.output,JSON.stringify(row)+'\n');
  console.log(JSON.stringify({index,name:row.name,ms:row.ms,calls:row.calls.length,error:row.error,statusCorrect:row.statusCorrect}));
  if(stop)break;
}
const times=rows.map(row=>row.ms).sort((a,b)=>a-b),sum=values=>values.reduce((a,b)=>a+b,0);
const calls=rows.flatMap(row=>row.calls),usage=calls.filter(call=>call.usage).map(call=>call.usage);
const input=sum(usage.map(u=>u.promptTokenCount??0)),cached=sum(usage.map(u=>u.cachedContentTokenCount??0));
const output=sum(usage.map(u=>(u.candidatesTokenCount??0)+(u.thoughtsTokenCount??0)));
console.log(JSON.stringify({attempted:rows.length,completed:rows.filter(row=>row.result).length,failures:rows.filter(row=>row.error).length,statusCorrect:rows.filter(row=>row.statusCorrect).length,meanMs:sum(times)/times.length,p50Ms:times[Math.ceil(times.length*.5)-1],p95Ms:times[Math.ceil(times.length*.95)-1],callsPerPost:calls.length/rows.length,reportedInputTokens:input,reportedOutputIncludingThinkingTokens:output,unreportedCalls:calls.length-usage.length,estimatedPaidUsd:(process.env.RESET_ANALYSIS_MODEL??'gemini-3.1-flash-lite')==='gemini-3.1-flash-lite'?((input-cached)*.25+cached*.025+output*1.5)/1e6:null,note:'비용은 2026-11-18 3.1 Flash-Lite Standard 공개 요율 추정치. 오류 호출의 미보고 토큰은 제외. 의미 정확도는 원문과 결과를 별도 검토한다. 자동 상태 일치는 전체 요약 정확도가 아니다.'}));
