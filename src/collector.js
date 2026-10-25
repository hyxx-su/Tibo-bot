import {readLimitedText} from './input.js';
const author='thsottiaux';

export async function parseTimelinePage(response) {
  const rows=[];
  let current;
  let nextCursor=null;
  let thread=null;
  let quote=null;
  const rewriter=new HTMLRewriter()
    .on('.thread-line',{element(el){thread=[];el.onEndTag(()=>{thread=null;});}})
    .on('.timeline-item',{element(el){quote=null;if(rows.length>=200)throw new Error('Too many source posts');current={author:el.getAttribute('data-username'),id:null,text:'',date:null};if(thread){current.thread=thread;thread.push(current);}rows.push(current);}})
    .on('.timeline-item > .tweet-link',{element(el){if(current)current.id=el.getAttribute('href')?.match(/^\/thsottiaux\/status\/(\d{1,20})(?:[#?]|$)/)?.[1];}})
    .on('.timeline-item .tweet-header .tweet-date a',{element(el){if(current&&!quote)current.date=el.getAttribute('title')?.slice(0,160);}})
    .on('.timeline-item .tweet-content',{text(chunk){if(current&&!quote){current.text+=chunk.text;if(current.text.length>16000)throw new Error('Source post too large');}}})
    .on('.timeline-item > .tweet-body > .quote',{element(el){
      quote={id:null,text:'',date:null,ownAuthor:false};if(current)current.quoted=quote;
      el.onEndTag(()=>{quote=null;});
    }})
    .on('.timeline-item > .tweet-body > .quote > .quote-link',{element(el){if(quote)quote.id=el.getAttribute('href')?.match(/^\/thsottiaux\/status\/(\d{1,20})(?:[#?]|$)/)?.[1];}})
    .on('.timeline-item > .tweet-body > .quote .username',{element(el){if(quote)quote.ownAuthor=el.getAttribute('href')==='/thsottiaux';}})
    .on('.timeline-item > .tweet-body > .quote .tweet-date a',{element(el){if(quote)quote.date=el.getAttribute('title')?.slice(0,160);}})
    .on('.timeline-item > .tweet-body > .quote .quote-text',{text(chunk){if(quote){quote.text+=chunk.text;if(quote.text.length>16000)throw new Error('Quoted post too large');}}})
    // 프로필·인용 카드의 이미지와 구분하여 해당 글에 직접 첨부된 미디어만 인정한다.
    .on('.timeline-item > .tweet-body > .attachments img, .timeline-item > .tweet-body > .attachments video',{element(el){
      if(current&&['src','poster','data-url'].some(name=>el.getAttribute(name)?.trim()))current.hasMedia=true;
    }})
    .on('.timeline-item > .tweet-body > .attachments video source[src]',{element(el){if(current&&el.getAttribute('src')?.trim())current.hasMedia=true;}})
    .on('.timeline-item .retweet-header',{element(){if(current)current.repost=true;}})
    .on('.show-more a',{element(el){
      const href=el.getAttribute('href');
      if(href){const cursor=new URL(href,'https://source.invalid').searchParams.get('cursor');if(cursor){if(cursor.length>2048)throw new Error('Source cursor too large');nextCursor=cursor;}}
    }});
  await rewriter.transform(response).text();
  const posts=rows.filter(row=>row.author===author&&row.id&&!row.repost).map(row=>{
    const context=(row.thread??[]).filter(other=>other!==row&&other.author===author&&other.id&&!other.repost&&BigInt(other.id)<BigInt(row.id))
      .slice(-5).map(({id,text,date})=>({id,text,date}));
    const quoted=row.quoted;
    if(quoted?.ownAuthor&&quoted.id&&BigInt(quoted.id)<BigInt(row.id)&&quoted.text.trim()){
      const existing=context.findIndex(other=>other.id===quoted.id);if(existing!==-1)context.splice(existing,1);
      context.push({id:quoted.id,text:quoted.text,date:quoted.date,relation:'quote'});
    }
    const {thread:ignored,quoted:ignoredQuote,...post}=row;
    return context.length?{...post,context}:post;
  });
  return {posts,nextCursor};
}

export async function parseTimeline(response) {
  return (await parseTimelinePage(response)).posts;
}

export async function collectTimelinePage(baseUrl='https://x.noodl3.net',cursor=null) {
  const url=new URL(`/${author}/with_replies`,baseUrl);
  if(url.protocol!=='https:'||url.hostname!=='x.noodl3.net'||url.username||url.password||url.port)throw new Error('The source must use HTTPS');
  if(cursor)url.searchParams.set('cursor',cursor);
  const response=await fetch(url,{
    redirect:'manual',headers:{'User-Agent':'TiboBot/0.1 (+https://github.com/hyxx-su/Tibo-bot)'},
    signal:AbortSignal.timeout(20000),
  });
  if(!response.ok){await response.body?.cancel();throw new Error('Post source unavailable: '+response.status);}
  const page=await parseTimelinePage(new Response(await readLimitedText(response,2*1024*1024)));
  if(!page.posts.length||page.posts.some(post=>!post.date||(!post.text.trim()&&!post.hasMedia)))throw new Error('Post source returned no complete post');
  return page;
}

export async function collectLatestPost(baseUrl='https://x.noodl3.net') {
  const {posts:[post]}=await collectTimelinePage(baseUrl);
  return post;
}
