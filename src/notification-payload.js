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
export function encodeEmbedNotification(embed,content='') {
  validateContent(content);
  return content?combinedPrefix+JSON.stringify({content,embed:validate(embed)}):prefix+JSON.stringify(validate(embed));
}
export function notificationPayload(content) {
  if(typeof content!=='string')throw new Error('Invalid notification content');
  if(content.startsWith(prefix))return {content:'',embeds:[validate(JSON.parse(content.slice(prefix.length)))]};
  if(content.startsWith(combinedPrefix)){
    const payload=JSON.parse(content.slice(combinedPrefix.length));
    return {content:validateContent(payload?.content),embeds:[validate(payload?.embed)]};
  }
  return {content:Array.from(content).slice(0,1900).join('')};
}
