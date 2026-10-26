// 기존 TEXT 발송 대기열의 문자열·v1 카드를 유지하며 v2는 요약 본문을 함께 전달한다.
const prefix='tibo-embed:v1:',combinedPrefix='tibo-embed:v2:';
function validate(embed) {
  if(!embed||typeof embed.title!=='string'||!embed.title||embed.title.length>256||
    (embed.description!==undefined&&(typeof embed.description!=='string'||embed.description.length>4096))||
    !Number.isInteger(embed.color)||embed.color<0||embed.color>0xffffff||
    typeof embed.url!=='string'||!/^https:\/\/x\.com\/thsottiaux\/status\/\d{1,20}$/.test(embed.url))throw new Error('Invalid notification embed');
  return {title:embed.title,...(embed.description!==undefined?{description:embed.description}:{}),color:embed.color,url:embed.url};
}
function validateContent(content) {
  if(typeof content!=='string'||content.length>1900)throw new Error('Invalid notification content');
  return content;
}
function validateSource(source) {
  if(!source||source.author?.name!=='Tibo (@thsottiaux)'||
    typeof source.author.url!=='string'||!/^https:\/\/x\.com\/thsottiaux\/status\/\d{1,20}$/.test(source.author.url)||
    typeof source.description!=='string'||!source.description||source.description.length>3000||
    source.color!==0x1DA1F2||typeof source.footer?.text!=='string'||source.footer.text.length>100)throw new Error('Invalid source embed');
  // 원문 링크는 author에 둔다. 같은 최상위 URL을 가진 Discord 카드의 중복 제거를 피한다.
  return {author:{name:source.author.name,url:source.author.url},description:source.description,color:source.color,footer:{text:source.footer.text}};
}
function combinedPayload(content,embed,source) {
  const embeds=[validate(embed)];
  if(source!==undefined)embeds.push(validateSource(source));
  const size=embeds.reduce((n,e)=>n+(e.title?.length??0)+(e.description?.length??0)+(e.author?.name.length??0)+(e.footer?.text.length??0),0);
  if(size>6000)throw new Error('Notification embeds too large');
  return {content:validateContent(content),embeds};
}
export function encodeEmbedNotification(embed,content='',source) {
  const payload=combinedPayload(content,embed,source);
  return content||source!==undefined?combinedPrefix+JSON.stringify({content,embed:payload.embeds[0],...(source!==undefined?{source:payload.embeds[1]}:{})}):prefix+JSON.stringify(payload.embeds[0]);
}
export function notificationPayload(content) {
  if(typeof content!=='string')throw new Error('Invalid notification content');
  if(content.startsWith(prefix))return {content:'',embeds:[validate(JSON.parse(content.slice(prefix.length)))]};
  if(content.startsWith(combinedPrefix)){
    const payload=JSON.parse(content.slice(combinedPrefix.length));
    return combinedPayload(payload?.content,payload?.embed,payload?.source);
  }
  return {content:Array.from(content).slice(0,1900).join('')};
}
