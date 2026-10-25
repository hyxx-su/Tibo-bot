export async function readLimitedText(message,limit) {
  const length=message.headers.get('Content-Length');
  if(length&&/^\d+$/.test(length)&&Number(length)>limit){
    await message.body?.cancel();const error=new Error('Body limit exceeded');error.code='body_too_large';throw error;
  }
  if(!message.body)return '';
  const reader=message.body.getReader();const decoder=new TextDecoder();let size=0;let text='';
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>limit){await reader.cancel();const error=new Error('Body limit exceeded');error.code='body_too_large';throw error;}
      text+=decoder.decode(value,{stream:true});
    }
    return text+decoder.decode();
  }finally{reader.releaseLock();}
}

// 모델이 만든 링크·Discord 서식이 원문 안내나 공식 메시지처럼 보이지 않게 한다.
export function discordPlainText(value) {
  return value.replace(/https?:\/\/\S+/gi,'외부 링크 생략').replace(/[\r\n\u2028\u2029]+/g,' ').replace(/([\\\[\]()*_`~<>|])/g,'\\$1');
}
