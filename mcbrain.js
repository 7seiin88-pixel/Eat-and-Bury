// ===================== Round 150: the legend thinks ahead =====================
// Before it plays, the legend deals the cards it cannot see in many possible ways (only from what it has watched: its own hand, the ground,
// every pile; never the real hands of the others) and plays each of its choices forward a couple of rounds on a private copy of the game.
// It then plays the choice that left its team furthest ahead on average. The same code runs in the test arena (Node) and on the phone (a worker).
// MC(E) -> decide(snapshot, seat, opts): E is a private engine instance exposing the functions below.
function MC(E){
  const RANKS=['A','2','3','4','5','6','7','8','9','10','J','Q','K'],SUITS=['♠','♥','♦','♣'];
  let seed=1;const rnd=()=>{seed=(seed+0x6D2B79F5)>>>0;let t=seed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296};
  E.setRandom(rnd);
  // the cards this seat has not seen: the whole deck minus its hand, the ground and every pile
  function unseen(snap,seat){const left={};const decks=+snap.cfg.decks||4;for(const r of RANKS)for(const s of SUITS)left[r+s]=decks;left['JK']=2*decks;
    const see=c=>{const k=c.r==='JK'?'JK':c.r+c.s;if(left[k]>0)left[k]--};snap.ground.forEach(see);snap.players[seat].hand.forEach(see);snap.players.forEach(p=>p.pile.forEach(see));
    if(snap.war){(snap.war.pot||[]).forEach(see);(snap.war.targets||[]).forEach(see)}
    const out=[];let id=900000;for(const k in left)for(let n=0;n<left[k];n++)out.push(k==='JK'?{id:id++,r:'JK',s:''}:{id:id++,r:k.slice(0,-1),s:k.slice(-1)});return out}
  function deal(snap,seat,pool){const S=JSON.parse(JSON.stringify(snap));const cards=pool.slice();for(let k=cards.length-1;k>0;k--){const j=Math.floor(rnd()*(k+1));const t=cards[k];cards[k]=cards[j];cards[j]=t}
    let at=0;S.players.forEach((p,j)=>{p.human=false;p.remote=false;p.lv='pro';delete p.k;if(j===seat)return;const n=p.n!=null?p.n:p.hand.length;
      p.hand=cards.slice(at,at+n);at+=n});
    S.__early=Math.max(0,Math.min(1,(snap.drawN||0)/((+snap.cfg.decks||4)*54)));const dn=Math.max(0,Math.min(cards.length-at,snap.drawN!=null?snap.drawN:cards.length-at));S.draw=cards.slice(at,at+dn);S.aiTimers=[];S.sel=null;S.log=[];return S}
  // round 165: besides the score, the cards lying on top of a pile are still open to attack: what is exposed on the other teams' piles is a chance, what is exposed on ours is a risk
  const value=(S,team)=>{const sc=S.teams.map((t,k)=>E.teamScore(k));let best=-1e9;sc.forEach((v,k)=>{if(k!==team&&v>best)best=v});let ex=0;const vk=E.valK||0;
    if(vk&&E.exposed)try{S.players.forEach(p=>{if(!p.pile||!p.pile.length)return;const u=E.exposed(p.pile);if(u)ex+=(p.team===team?-1:1)*E.sum(u.cards)})}catch(e){}
    return sc[team]-best+vk*ex};
  // round 164: uncovering a teammate's rich pile (cards under his cover) with fewer than two defenders in hand costs points
  const tops=(S,seat)=>{const o={};S.players.forEach((p,j)=>{if(j===seat||p.team!==S.players[seat].team||!p.pile||!p.pile.length)return;const u=E.exposed&&E.exposed(p.pile);o[j]=u?u.cards.map(c=>c.id).join(','):''});return o};
  function uncovPen(S,seat,before){let w=0;const after=tops(S,seat),me=S.players[seat];for(const j in after){if(!after[j]||after[j]===before[j])continue;const u=E.exposed(S.players[j].pile);if(!u)continue;const uv=E.sum(u.cards),hasJ=u.cards.some(c=>c.r==='JK');
      if(uv<15&&!hasJ)continue;const def=me.hand.filter(c=>c.r===u.rank||c.r==='JK').length;let pen=uv*1.7+(hasJ?60:0)+(uv>=50?120:0);if(def>=2)pen*=.5;pen*=(E.penK||50);w=Math.max(w,pen)}return w}
  function rollout(S,seat,act,turns){E.reset(S);const me=S.players[seat];let before={};try{before=tops(S,seat)}catch(e){}
    try{if(act.type==='eat'){const c=me.hand.find(x=>x.id===act.id);if(!c)return null;E.declareEat(seat,c,act.r)}else if(act.type==='cut'){const c=me.hand.find(x=>x.id===act.id);if(!c)return null;E.intercept(seat,c)}else if(act.type==='nocut'){S.players[seat].__skip=1}else E.aiChoose(seat)}catch(e){return null}
    let pen=0;try{pen=uncovPen(E.getS(),seat,before)}catch(e){}const jc=act.jk?(E.jkCost!=null?E.jkCost:40)*(S.__early||0):0;E.run(turns);return value(E.getS(),me.team)-pen-jc}
  // choices at the start of a turn: what the pro would do, and every eat that is allowed
  function choices(snap,seat){const S0=deal(snap,seat,[]);E.reset(S0);const out=[{type:'default'}];try{const h=S0.players[seat].hand,jk=h.find(c=>c.r==='JK'),must=E.mustNow(seat);
      const twoJ=h.length===2&&jk&&snap.drawN>0,allowJ=!must&&!twoJ&&!(h.length<=2&&snap.drawN>0);
      for(const o of E.options(seat)){const nat=o.r==='JK'?(o.natural?jk:null):h.find(c=>c.r===o.r);if(nat)out.push({type:'eat',id:nat.id,r:o.r});if(allowJ&&jk&&o.r!=='JK')out.push({type:'eat',id:jk.id,r:o.r,jk:1})}}catch(e){}
    return out}
  function decide(snap,seat,opts){opts=opts||{};const K=opts.K||24,turns=opts.turns||(snap.players.length*2),budget=opts.ms||0,t0=Date.now();
    const cands=opts.cands||choices(snap,seat);if(cands.length<2)return {act:cands[0],n:0};
    const pool=unseen(snap,seat),vals=cands.map(()=>[]);let k=0;seed=(opts.seed||1)>>>0;
    for(;k<K;k++){if(budget&&k>=6&&Date.now()-t0>budget)break;const s0=seed+k*7919;seed=s0;const base=deal(snap,seat,pool);const js=JSON.stringify(base);
      for(let c=0;c<cands.length;c++){seed=(s0^0x9E3779B9)>>>0;const v=rollout(c?JSON.parse(js):base,seat,cands[c],turns);vals[c].push(v)}}
    // compare every other choice with what the pro would do, on the same deals; switch only when it is clearly better (not by luck of the deals)
    const Z=opts.z!=null?opts.z:1.6,MIN=opts.min!=null?opts.min:4;let best=0,bz=0;const avg=cands.map(()=>0);
    for(let c=1;c<cands.length;c++){let n=0,m=0,q=0;for(let t=0;t<k;t++){const a=vals[c][t],b=vals[0][t];if(a==null||b==null)continue;const d=a-b;n++;m+=d;q+=d*d}
      if(n<4)continue;m/=n;const sd=Math.sqrt(Math.max(0,q/n-m*m)),se=sd/Math.sqrt(n)||1e-6;avg[c]=m;const z=m/se;const jk=cands[c].jk,mn=jk?(opts.jkMin!=null?opts.jkMin:15):MIN,zz=jk?(opts.jkZ!=null?opts.jkZ:2.5):Z;if(m>=mn&&z>=zz&&z>bz){bz=z;best=c}}
    return {act:cands[best],avg,n:k,cands}}
  return {decide,choices}}
// a private engine instance from the engine source: used by the arena (Node vm) and by the phone's worker (see extras149)
function MC_ENGINE(run){ // run(src) evaluates src in a fresh global scope and returns the value of its last expression
  const st={now:0,seq:0,q:[],rnd:Math.random,turns:0};
  const env={performance:{now:()=>st.now},setTimeout:(fn,ms)=>{const h=++st.seq;st.q.push({t:st.now+(ms||0),h,fn});return h},clearTimeout:h=>{st.q=st.q.filter(x=>x.h!==h)},random:()=>st.rnd(),onTurn:()=>{st.turns++}};
  const api=run(env);
  return {getS:api.getS,teamScore:api.teamScore,declareEat:api.declareEat,intercept:api.intercept,aiChoose:api.aiChoose,options:api.options,exposed:api.exposed,sum:api.sum,mustNow:api.mustNow,
    setRandom:f=>{st.rnd=f},reset:S=>{st.now=0;st.q=[];st.turns=0;api.setS(S)},
    run:turns=>{let steps=0;while(steps++<4000){const S=api.getS();if(!S||S.phase==='over'||st.turns>=turns)break;const w=S.war;st.q.sort((a,b)=>a.t-b.t||a.h-b.h);
      try{if(w&&w.deadline&&(!st.q.length||st.q[0].t>=w.deadline)){st.now=Math.max(st.now,w.deadline);api.resolveWar()}else if(st.q.length){const e=st.q.shift();st.now=e.t;e.fn()}else break}catch(e){break}}}}}
const MC_TAIL=`;(function(){const _st=startTurn;startTurn=function(i){try{__env.onTurn()}catch(e){}return _st.apply(this,arguments)}})();
({getS:()=>S,setS:x=>{S=x;gen++},teamScore,declareEat,intercept,aiChoose,options,mustNow,resolveWar,exposed,sum})`;
if(typeof module!=='undefined')module.exports={MC,MC_ENGINE,MC_TAIL};
