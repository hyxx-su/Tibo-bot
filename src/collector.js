const author='thsottiaux';

export async function parseTimelinePage(response) {
  const rows=[];
  let current;
  let nextCursor=null;
  const rewriter=new HTMLRewriter()
    .on('.timeline-item',{element(el){current={author:el.getAttribute('data-username'),id:null,text:'',date:null};rows.push(current);}})
    .on('.timeline-item > .tweet-link',{element(el){if(current)current.id=el.getAttribute('href')?.match(/status\/(\d+)/)?.[1];}})
    .on('.timeline-item .tweet-header .tweet-date a',{element(el){if(current)current.date=el.getAttribute('title');}})
    .on('.timeline-item .tweet-content',{text(chunk){if(current)current.text+=chunk.text;}})
    .on('.timeline-item .retweet-header',{element(){if(current)current.repost=true;}})
    .on('.show-more a',{element(el){
      const href=el.getAttribute('href');
      if(href){const cursor=new URL(href,'https://source.invalid').searchParams.get('cursor');if(cursor)nextCursor=cursor;}
    }});
  await rewriter.transform(response).text();
  return {posts:rows.filter(row=>row.author===author&&row.id&&!row.repost),nextCursor};
}

export async function parseTimeline(response) {
  return (await parseTimelinePage(response)).posts;
}

export async function collectTimelinePage(baseUrl='https://x.noodl3.net',cursor=null) {
  const url=new URL(`/${author}/with_replies`,baseUrl);
  if(url.protocol!=='https:')throw new Error('The source must use HTTPS');
  if(cursor)url.searchParams.set('cursor',cursor);
  const response=await fetch(url,{
    headers:{'User-Agent':'TiboBot/0.1 (+https://github.com/hyxx-su/Tibo-bot)'},
    signal:AbortSignal.timeout(20000),
  });
  if(!response.ok){await response.body?.cancel();throw new Error('Post source unavailable: '+response.status);}
  const page=await parseTimelinePage(response);
  if(!page.posts.length||page.posts.some(post=>!post.date||!post.text.trim()))throw new Error('Post source returned no complete post');
  return page;
}

export async function collectLatestPost(baseUrl='https://x.noodl3.net') {
  const {posts:[post]}=await collectTimelinePage(baseUrl);
  return post;
}
