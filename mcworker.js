// Legend (أسطوري) thinking for online rooms: runs in its own thread so the server never stalls.
// Gets what one computer seat can see (never the other hands), plays each choice forward on private copies of the game, answers with the best one.
'use strict';
const { parentPort } = require('worker_threads'), vm = require('vm'), fs = require('fs'), path = require('path');
const { MC, MC_ENGINE, MC_TAIL } = require('./mcbrain.js');
const ENG = fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8');
const TAIL = MC_TAIL.replace('({getS', 'return ({getS');
const E = MC_ENGINE(env => {
  const ctx = vm.createContext({}), src = '(function(performance,setTimeout,clearTimeout,Math,render,say,endGame,NET_ON,LANG,__env){' + ENG + TAIL + '})';
  const f = vm.runInContext(src, ctx), M = Object.create(Math); M.random = () => env.random();
  return f(env.performance, env.setTimeout, env.clearTimeout, M, () => {}, () => {}, () => {}, true, 'ar', env);
});
const B = MC(E);
parentPort.on('message', m => {
  const t = Date.now();
  try { const r = B.decide(m.snap, m.seat, m.opts); parentPort.postMessage({ id: m.id, act: r && r.act, ms: Date.now() - t }) }
  catch (e) { parentPort.postMessage({ id: m.id, err: String(e).slice(0, 200) }) }
});
