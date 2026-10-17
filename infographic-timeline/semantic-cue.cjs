function timelineCueV2({data,segment,words}, numberMatch) {
  const origin=Number(segment?.start_s), duration=Number(segment?.duration_sec);
  if(!Number.isFinite(origin)||!(duration>0)||!Array.isArray(words))return null;
  const events=Array.isArray(data?.events)?data.events.slice(0,20):[];
  const monthGroups=['january januar jan','february februar feb','march marz märz mar','april apr','may mai','june juni jun','july juli jul','august aug','september sep sept','october oktober oct okt','november nov','december dezember dec dez'];
  const month=new Map(monthGroups.flatMap((s,i)=>s.split(' ').map(t=>[t,'month'+i])));
  const tokens=v=>(String(v??'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).map(t=>month.get(t)??t);
  const ws=words.filter(w=>Number(w.start)>=origin-.3&&Number(w.start)<=origin+duration)
    .flatMap(w=>tokens(w.text??w.word).map(token=>({token,start:Number(w.start),end:Number(w.end)})));
  const exact=phrase=>{
    const p=tokens(phrase),hits=[];
    if(!p.length)return hits;
    for(let i=0;i<=ws.length-p.length;i++)if(p.every((t,j)=>t===ws[i+j].token)&&ws[i+p.length-1].end-ws[i].start<=6)
      hits.push({start:ws[i].start,end:ws[i+p.length-1].end});
    return hits;
  };
  const years=events.map(e=>String(e.date??'').match(/\b\d{4}\b/)?.[0]??null);
  const item_secs=events.map((e,i)=>{
    const titles=exact(e.title);
    const dateTokens=tokens(e.date),year=years[i];
    let dates=exact(e.date);
    // Numeric matching remains the native implementation; never infer a month.
    if(!dates.length&&year&&dateTokens.length===1) {
      let from=origin-.3;
      for(let n=0;n<words.length;n++){
        const hit=numberMatch({words,value:Number(year),from,to:origin+duration});
        if(!hit)break;
        dates.push(hit);from=hit.end+1e-5;
      }
    }
    const sharedYear=year&&years.filter(y=>y===year).length>1;
    // A bare repeated year cannot distinguish events. A unique full title can.
    if(sharedYear&&dateTokens.length===1)dates=[];
    if(events.filter(other=>tokens(other.date).join(' ')===dateTokens.join(' ')).length>1)dates=[];
    let hit=titles.length===1?titles[0]:dates.length===1?dates[0]:null;
    if(titles.length>1)hit=null;
    const expectedMonth=dateTokens.find(t=>/^month\d+$/.test(t));
    if(hit&&expectedMonth){
      const nearby=ws.filter(w=>w.start>=hit.start-3&&w.start<=hit.end).map(w=>w.token).filter(t=>/^month\d+$/.test(t));
      if(nearby.length&&!nearby.includes(expectedMonth))hit=null;
    }
    if(hit&&year){
      const nearbyYears=ws.filter(w=>w.start>=hit.start-3&&w.start<=hit.end&&/^\d{4}$/.test(w.token)).map(w=>w.token);
      if(nearbyYears.length&&!nearbyYears.includes(year))hit=null;
    }
    if(!hit)return null;
    return Math.round(Math.max(0,hit.start-origin)*1000)/1000;
  });
  const known=item_secs.filter(v=>v!=null);
  return known.length?{item_secs,land_sec:Math.round((Math.max(...known)+.4)*1000)/1000}:null;
}
module.exports={timelineCueV2};
