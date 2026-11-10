'use strict';
// Zovo Pro for DBML Viewer & ER Diagram, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license). Three Pro tools, 3 free tries each on this computer. A try counts only after the tool
// produced its output (a written file, a diff report on screen); Escape or Cancel never uses one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');

const SKU = 'dbml-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'dbmlViewer.proTrial';

const FEATURES = {
  sql: {
    title: 'Export SQL (PostgreSQL, MySQL, SQL Server, SQLite or DBML)',
    detail: 'Writes CREATE TABLE scripts with keys, indexes, enums and foreign keys for PostgreSQL, MySQL, SQL Server or SQLite from DBML, and turns SQL DDL into DBML.',
  },
  image: {
    title: 'Export the diagram (PNG, SVG, PDF or data dictionary)',
    detail: 'Saves the ER diagram as a high-resolution PNG, an SVG or a vector PDF, or writes a Markdown data dictionary with one table per database table.',
  },
  diff: {
    title: 'Schema diff with migration SQL',
    detail: 'Compares two DBML or SQL schemas, lists the tables, columns, indexes and relations that were added, removed or changed, and writes the ALTER TABLE migration for your database.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, prefix = 'dbmlViewer', productName = 'DBML Viewer & ER Diagram' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS }));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS };
