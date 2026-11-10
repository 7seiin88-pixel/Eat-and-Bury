// حفر ودفن: the server runs every online game. Same rules as the app (engine_core.js is generated from it),
// so no player's phone is in charge any more: nobody waits for a slow "host" and nobody can cheat by editing the page.
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
const CORE = fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8');
const SCRIPT = new vm.Script(CORE + '\n;function __getS(){return S}\nfunction __setGen(){gen++}\nfunction __ctx(){return {sum,teamScore,nextIdx,isLone,ORDER,canThrow,throwable,mustNow,mustEat,canSleep,onGround}}\n', { filename: 'engine_core.js' });
const TURN_MS = 10000, AWAY_MS = 4000;

class Game {
  constructor(room, cfg, hooks) {
    this.room = room; this.hooks = hooks; this.twSeen = {}; this.timers = new Set(); this.fx = []; this.upT = null; this.turnKey = ''; this.turnDeadline = 0; this.dead = false;
    const T = this.timers, self = this;
    const ctx = {
      Math, JSON, console, Array, Object, String, Number, Boolean, Set, Map, Date,
      NET_ON: true, LANG: cfg.lang === 'en' ? 'en' : 'ar',
      performance: { now: () => Date.now() },
      setTimeout: (fn, ms) => { const h = setTimeout(() => { T.delete(h); if (!self.dead) try { fn() } catch (e) { console.error('engine', e) } }, ms); T.add(h); return h },
      clearTimeout: h => { clearTimeout(h); T.delete(h) },
      render: () => this.changed(),
      say: (i, t) => this.push({ t: 'say', s: i, text: String(t) }),
      endGame: () => { const S = this.S; if (S) S.phase = 'over'; this.push({ t: 'over' }); this.flush(); this.hooks.over && this.hooks.over(this) },
    };
    vm.createContext(ctx); SCRIPT.runInContext(ctx); this.ctx = ctx;
    // moves made by anyone (people or the computer) become effects every phone animates
    const E = ctx, sayT = (i, ar, en) => ctx.say(i, ctx.LANG === 'ar' ? ar : en);
    const d0 = E.declareEat; E.declareEat = function (i, card, r, incl = null) { const S = self.S; S.moves = (S.moves || 0) + 1; const n = (S.chain && !S.eatCut) ? (S.eatN || 1) + 1 : 1; S.eatN = n; S.eatCut = false; d0(i, card, r, incl); self.push({ t: 'eat', s: i, c: card }); sayT(i, card.r === 'JK' ? 'جوكر!' : n === 1 ? 'آكل' : 'وباكل', card.r === 'JK' ? 'Joker!' : n === 1 ? 'Eat!' : 'Eat again!') };
    const c0 = E.intercept; E.intercept = function (j, card, fire = false) { const S = self.S; if (!S || !S.war) return; const w = S.war, pl = w.leader, vic = [...(w.victims || [])];
      S.eatCut = true; c0(j, card); self.push({ t: 'cut', s: j, c: card, fire: !!fire }); sayT(j, fire ? 'طق!' : 'قطع!', fire ? 'Slap!' : 'Cut!'); self.autoEvents('cut', j, pl, vic) };
    const r0 = E.resolveWar; E.resolveWar = function () { const S = self.S; if (!S || !S.war) return; const lostTo = self.bigLoss(S.war); S.moves = (S.moves || 0) + 1; const W = S.war.leader, fought = S.war.pot.length > 1, gain = E.__ctx().sum([...S.war.targets, ...S.war.pot]);
      r0(); self.push({ t: 'win', s: W, gain }); if (fought) self.autoEvents('win', W); lostTo.forEach(j => self.push({ t: 'auto', s: j, ev: 'lost', n: (Math.random() * 6) | 0 })); if (gain > 50) self.push({ t: 'auto', s: W, ev: 'winbig', n: (Math.random() * 6) | 0 }); { const tw = (S.stats && S.stats[W] && S.stats[W].tw) || 0; if (tw > (self.twSeen[W] || 0)) { self.twSeen[W] = tw; self.push({ t: 'auto', s: W, ev: 'tauf', n: (Math.random() * 6) | 0 }) } } if (self.hooks.war) try { self.hooks.war(W, gain) } catch (e) { console.error(e) } };
    const t0 = E.throwCard; E.throwCard = function (i, c) { const S = self.S; S.moves = (S.moves || 0) + 1; const sleeping = S.players[i].hand.length === 2 && S.draw.length > 0; t0(i, c); self.push({ t: 'throw', s: i, c }); if (sleeping) sayT(i, 'على كرت', 'Sleeping') };
    const s0 = E.startTurn; E.startTurn = function (i) { const S = self.S; if (S) S.moves = (S.moves || 0) + 1; s0(i); const S2 = self.S; if (S2 && S2.turn === i && S2.phase === 'choose' && !S2.chain) self.push({ t: 'turn', s: i }) };
    // names and who is a person, then deal
    E.newGame({ mode: cfg.mode, decks: cfg.decks, timer: cfg.timer, level: cfg.level, hints: !!cfg.hints, fx: cfg.fx !== false });
    this.syncSeats(true);
    { const S = this.S, ar = this.ctx.LANG === 'ar'; S.log[0] = ar ? `توزّعت ${S.cfg.decks} شدّات. يبدأ ${S.players[0].name}.` : `Dealt ${S.cfg.decks} decks. ${S.players[0].name} goes first.`; }
    this.clock = setInterval(() => this.tick(), 200);
  }
  get S() { return this.ctx.__getS() }
  push(e) { this.fx.push(e); this.changed() }
  changed() { if (!this.upT && !this.dead) this.upT = setTimeout(() => this.flush(), 12) }
  // who sits where: people in the room play their seats, the computer plays the rest
  syncSeats(first) {
    const S = this.S; if (!S) return; const ms = this.room.members.filter(m => !m.watch);
    const taken = new Set(ms.map(m => m.name)), spare = ['فيصل', 'يوسف', 'خالد', 'مريم', 'سالم', 'ناصر', 'عبدالله', 'دانة'].filter(n => !taken.has(n));
    S.players.forEach((p, i) => {
      const m = ms.find(x => x.seat === i);
      if (m) { p.name = m.name; p.f = false; p.human = true; p.remote = false }
      else { if (taken.has(p.name) || (first && i === 0)) { p.name = spare.shift() || p.name; p.f = ['مريم', 'دانة'].includes(p.name) } const was = p.human; p.human = false; p.remote = false;
        if ((was || first) && S.turn === i && (S.phase === 'choose' || S.phase === 'throw')) this.ctx.later(() => { if (S.turn === i) S.phase === 'choose' ? this.ctx.aiChoose(i) : this.ctx.aiThrow(i) }, 600) }
    });
    this.changed();
  }
  member(seat) { return this.room.members.find(m => !m.watch && m.seat === seat) }
  // the clock: war windows and turn timers
  tick() {
    const S = this.S; if (!S || this.dead) return; const now = Date.now();
    if (S.war && S.war.deadline && now >= S.war.deadline) { this.ctx.resolveWar(); return }
    const key = S.moves + '|' + S.phase + '|' + S.turn;
    if (key !== this.turnKey) { this.turnKey = key; const p = S.players[S.turn];
      this.turnDeadline = (S.phase === 'choose' || S.phase === 'throw') && p && p.human ? now + TURN_MS : 0; this.changed() }
    if (this.turnDeadline) { const m = this.member(S.turn), lim = m && m.away ? Math.min(this.turnDeadline, this.turnKeyAt(now)) : this.turnDeadline;
      if (now >= lim) { this.turnDeadline = 0; const i = S.turn; S.sel = null; this.ctx.log(this.ctx.LANG === 'ar' ? `${S.players[i].name} خلص وقته.` : `${S.players[i].name} ran out of time.`);
        this.ctx.say(i, this.ctx.LANG === 'ar' ? 'الوقت!' : 'Time!'); if (S.phase === 'choose') this.ctx.aiChoose(i); else if (S.phase === 'throw') this.ctx.aiThrow(i) } }
  }
  turnKeyAt(now) { return this.turnDeadline - TURN_MS + AWAY_MS }
  // a person's move (checked against the rules)
  act(seat, a) {
    const S = this.S, E = Object.assign(Object.create(this.ctx), this.ctx.__ctx()); if (!S || S.phase === 'over') return; const p = S.players[seat]; if (!p || !p.human) return;
    const n = S.players.length, card = id => p.hand.find(c => c.id === id);
    switch (a.a) {
      case 'eat': { if (S.turn !== seat || S.phase !== 'choose') return; const c = card(a.card); if (!c) return; const r = String(a.r); if (!(c.r === r || c.r === 'JK')) return; if (!E.options(seat).some(o => o.r === r)) return;
        const incl = a.incl == null ? null : (a.incl + seat) % n; E.declareEat(seat, c, r, incl); break }
      case 'throw': { if (S.turn !== seat) return; const c = card(a.card); if (!c || !E.canThrow(seat) || !E.throwable(seat, c)) return; if (S.phase === 'choose' && E.mustNow(seat)) return; if (S.phase !== 'choose' && S.phase !== 'throw') return; E.throwCard(seat, c); break }
      case 'pass': if (S.turn === seat && S.phase === 'choose' && !E.mustNow(seat) && !E.canThrow(seat)) { S.lone ? E.passTurn(seat) : E.endTurn(seat) } break;
      case 'cut': { const c = card(a.card); if (c && S.war && E.canIntercept(seat).includes(c)) E.intercept(seat, c, false); break } // fire only comes from the paid 'slam' act, never from a cut
      case 'gift': { const to = ((+a.to || 0) + seat) % n; if (to !== seat && /^[a-z0-9]{1,16}$/.test(String(a.id))) { this.push({ t: 'gift', f: seat, to, id: String(a.id) }); const st = this.statOf(seat); if (st) st.gifts = Math.min(60, (st.gifts || 0) + 1) } break }
      case 'chat': this.push({ t: 'chat', s: seat, text: String(a.text || '').slice(0, 60) }); break;
      case 'say': this.push({ t: 'say', s: seat, text: String(a.text || '').slice(0, 40) }); break;
      case 'slam': { const st = this.statOf(seat); if (st) st.fire = (st.fire || 0) + 1 } this.push({ t: 'slam', s: seat }); this.push({ t: 'say', s: seat, text: this.ctx.LANG === 'ar' ? 'صفقة!' : 'SLAM!' }); break;
    }
  }
  // automatic replies chosen by each player (fend off an attack, a partner rescue, a partner cutting over, winning a war)
  // players who just lost more than 50 points from their own pile to the other side
  bigLoss(w) { const S = this.S, E = this.ctx.__ctx(); if (!w || !w.fromPiles) return []; const W = w.leader;
    return w.fromPiles.filter(x => x.j !== W && S.players[x.j] && S.players[W] && S.players[x.j].team !== S.players[W].team && E.sum(x.cards || []) > 50).map(x => x.j) }
  autoEvents(kind, j, pl, vic) {
    const S = this.S, mates = (a, b) => a !== b && S.players[a] && S.players[b] && S.players[a].team === S.players[b].team;
    const ev = (s, e) => this.push({ t: 'auto', s, ev: e, n: (Math.random() * 6) | 0 });
    if (kind === 'win') return ev(j, 'win');
    if (vic.includes(j)) ev(j, 'def'); vic.forEach(v => { if (mates(v, j)) ev(v, 'save') }); if (pl != null && mates(pl, j)) ev(pl, 'took');
  }
  viewFor(k, watcher) {
    const S = this.S, n = S.players.length, r = i => (i - k + n) % n, me = S.players[k], myTeam = me.team, solo = S.cfg.mode === 'solo';
    const tm = t => solo ? (t - k + n) % n : (t - myTeam + 2) % 2; const players = [];
    S.players.forEach((p, i) => { players[r(i)] = { name: p.name, f: p.f, team: tm(p.team), human: i === k && !watcher, pile: p.pile, hand: i === k && !watcher ? p.hand : p.hand.map(() => ({ id: -1, r: '?', s: '' })) } });
    const teams = solo ? S.teams.map((t, i) => S.teams[(i + k) % n]) : S.teams;
    const now = Date.now(), w = S.war && { ...S.war, orig: r(S.war.orig), leader: r(S.war.leader), victims: S.war.victims.map(r), fromPiles: S.war.fromPiles.map(x => ({ j: r(x.j), cards: x.cards })), left: Math.max(0, S.war.deadline - now), deadline: 0 };
    const stats = S.stats ? S.players.map((_, j) => S.stats[(j + k) % n]) : undefined;
    return { cfg: S.cfg, players, teams, drawN: S.draw.length, ground: S.ground, turn: r(S.turn), phase: S.phase, war: w, log: S.log, passes: S.passes, lone: S.lone, wasLone: S.wasLone, chain: S.chain, moves: S.moves, decor: {}, stats, turnLeft: this.turnDeadline ? Math.max(0, this.turnDeadline - now) : 0 };
  }
  rotFx(e, k) { const n = this.S.players.length, r = i => (i - k + n) % n, o = { ...e }; ['s', 'f', 'to'].forEach(f => { if (typeof o[f] === 'number') o[f] = r(o[f]) }); return o }
  flush(onlySid) {
    if (this.upT) { clearTimeout(this.upT); this.upT = null } const S = this.S; if (!S || this.dead) return;
    const fx = onlySid ? [] : this.fx.splice(0);
    for (const m of this.room.members) { if (onlySid && m.sid !== onlySid) continue; if (m.away) continue;
      const watcher = !!m.watch || m.seat >= S.players.length, k = watcher ? 0 : m.seat;
      this.hooks.send(m.sid, 'up', { v: this.viewFor(k, watcher), fx: fx.map(e => this.rotFx(e, k)) }) }
  }
  statOf(i) { const S = this.S; if (!S || !S.players || !S.players[i]) return null; S.stats = S.stats || S.players.map(() => ({ wars: 0, best: 0 })); return S.stats[i] || (S.stats[i] = { wars: 0, best: 0 }) }
  results() { const S = this.S, E = this.ctx.__ctx(); const rows = S.teams.map((t, k) => ({ k, s: E.teamScore(k) })).sort((a, b) => b.s - a.s); const tie = rows[1] && rows[0].s === rows[1].s;
    return S.players.map((p, i) => ({ seat: i, won: !tie && rows[0].k === p.team, wars: (S.stats && S.stats[i] && S.stats[i].wars) || 0, best: (S.stats && S.stats[i] && S.stats[i].best) || 0, tauf: (S.stats && S.stats[i] && S.stats[i].tauf) || 0, team: p.team, ...(() => { const t = (S.stats && S.stats[i]) || {}, won = !tie && rows[0].k === p.team; return { fire: t.fire || 0, bigwar: t.bigwar || 0, jk: t.jk || 0, pile: t.pile || 0, dig: t.dig || 0, gifts: t.gifts || 0, lastw: t.lastw || 0, tw: t.tw || 0, faz: t.faz || 0, comeback: won && (t.low || 0) <= -300 ? 1 : 0 } })() })) }
  stop() { this.dead = true; clearInterval(this.clock); for (const h of this.timers) clearTimeout(h); this.timers.clear(); if (this.upT) clearTimeout(this.upT); try { this.ctx.__setGen() } catch (e) {} }
}
module.exports = { Game };
