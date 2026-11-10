'use strict';
// Worker thread: reads a schema (DBML, SQL or Prisma) and lays it out, away from the extension host.
const { parentPort } = require('worker_threads');
const { parse } = require('./core');
const { layout } = require('./core/layout');

parentPort.on('message', (job) => {
  const t0 = Date.now();
  try {
    const model = parse(job.text, job.kind);
    const lay = job.layout === false ? null : layout(model);
    parentPort.postMessage({ id: job.id, model, layout: lay, ms: Date.now() - t0 });
  } catch (e) {
    parentPort.postMessage({ id: job.id, error: String(e && e.message || e) });
  }
});
