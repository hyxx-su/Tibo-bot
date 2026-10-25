const author='thsottiaux';

export async function parseTimeline(response) {
  const rows=[];
  let current;
  const rewriter=new HTMLRewriter()
    .on('.timeline-item',{element(el){current={author:el.getAttribute('data-username'),id:null,text:'',date:null};rows.push(current);}})
    .on('.timeline-item > .tweet-link',{element(el){if(current)current.id=el.getAttribute('href')?.match(/status\/(\d+)/)?.[1];}})
    .on('.timeline-item .tweet-header .tweet-date a',{element(el){if(current)current.date=el.getAttribute('title');}})
    .on('.timeline-item .tweet-content',{text(chunk){if(current)current.text+=chunk.text;}});
  await rewriter.transform(response).text();
  return rows.filter(row=>row.author===author&&row.id);
}

export async function collectLatestPost(baseUrl='https://x.noodl3.net') {
  const url=new URL(`/${author}/with_replies`,baseUrl);
  if(url.protocol!=='https:')throw new Error('The source must use HTTPS');
  const response=await fetch(url,{
    headers:{'User-Agent':'TiboBot/0.1 (+https://github.com/hyxx-su/Tibo-bot)'},
    signal:AbortSignal.timeout(20000),
  });
  if(!response.ok){await response.body?.cancel();throw new Error('Post source unavailable: '+response.status);}
  const [post]=await parseTimeline(response);
  if(!post?.date||!post.text.trim())throw new Error('Post source returned no complete post');
  return post;
}
