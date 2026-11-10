'use strict';
// Runs the readers in one long-lived worker thread with a memory cap and a watchdog: a schema that takes longer than
// the budget ends the worker (a new one starts for the next job), so the extension host never hangs on a file.
const path = require('path');
const { Worker } = require('worker_threads');

const BUDGET_MS = 15000;
let worker = null;
let seq = 0;
const pending = new Map();

function failAll(err) { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); } pending.clear(); }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 } });
  worker.unref();
  worker.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: 'PARSE' })); else p.resolve(m);
  });
  const dead = (why) => { const w = worker; worker = null; if (w) w.removeAllListeners(); failAll(Object.assign(new Error(why), { code: 'WORKER' })); };
  worker.on('error', (e) => dead(`The schema reader stopped: ${e && e.message || e}`));
  worker.on('exit', (code) => { if (pending.size) dead(`The schema reader stopped (exit ${code}).`); else worker = null; });
  return worker;
}

/** Parse (and lay out) text in the worker. Resolves { model, layout, ms }. */
function runParse(text, kind, opts = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const w = getWorker();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`Reading the schema took more than ${Math.round((opts.budgetMs || BUDGET_MS) / 1000)} seconds and was stopped.`), { code: 'TIMEOUT' }));
      if (worker === w) { worker = null; w.removeAllListeners(); w.terminate().catch(() => {}); failAll(Object.assign(new Error('The schema reader was restarted.'), { code: 'WORKER' })); }
    }, opts.budgetMs || BUDGET_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, text, kind, layout: opts.layout });
  });
}

function stop() { if (worker) { const w = worker; worker = null; w.terminate().catch(() => {}); } failAll(new Error('stopped')); }

module.exports = { runParse, stop, BUDGET_MS };
