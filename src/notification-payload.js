// 기존 TEXT 발송 대기열과 일반 문자열 알림을 보존하는 명시적 임베드 봉투다.
const prefix='tibo-embed:v1:';
function validate(embed) {
  if(!embed||typeof embed.title!=='string'||!embed.title||embed.title.length>256||
    typeof embed.description!=='string'||embed.description.length>4096||
    !Number.isInteger(embed.color)||embed.color<0||embed.color>0xffffff||
    typeof embed.url!=='string'||!/^https:\/\/x\.com\/thsottiaux\/status\/\d{1,20}$/.test(embed.url))throw new Error('Invalid notification embed');
  return {title:embed.title,description:embed.description,color:embed.color,url:embed.url};
}
export function encodeEmbedNotification(embed) {
  return prefix+JSON.stringify(validate(embed));
}
export function notificationPayload(content) {
  if(typeof content!=='string')throw new Error('Invalid notification content');
  if(content.startsWith(prefix))return {content:'',embeds:[validate(JSON.parse(content.slice(prefix.length)))]};
  return {content:Array.from(content).slice(0,1900).join('')};
}
