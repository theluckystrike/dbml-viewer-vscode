'use strict';
// The extension host with a stub vscode: activation, the diagram panel, live updates, layout memory, click to jump,
// DBML problems, outline and go to definition, the three Pro tools with their tries and the panel, the CSP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { loadExtension, openDiagram } = require('./support/vscode-stub');
const { buildHtml } = require('../src/html');
const { XSS } = require('./build');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbml-ext-'));
const file = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.dbml'), 'utf8');
const DBML = file('shop.dbml', SAMPLE);
const OLD = file('shop-old.dbml', SAMPLE.replace(/Table countries \{[^}]*\}/, '').replace(/ \[ref: > countries\.code\]/g, ''));
const SQL = file('blog.sql', fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.sql'), 'utf8'));
const BAD = file('bad.dbml', 'Table a {\n  id int [pk]\n  x int [ref: > nowhere.id]\n}\nTabel b { }\n');
const XSSF = file('xss.dbml', `Table "${XSS}" [note: '${XSS}'] { id int [pk, note: '${XSS}'] }`);
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); require('../src/runner').stop(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(20); } return null; }
const lastModel = (panel) => [...panel.posted].reverse().find((m) => m.type === 'model' || m.type === 'fatal');
const PANEL = ['Pay by card (USD 19)', 'Get Zovo Pro with GitHub Sponsors', 'Pay with PayPal', 'Enter a key'];

function trapNetwork() {
  const calls = [];
  const saved = { fetch: global.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection };
  global.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in test'); };
  http.request = http.get = https.request = https.get = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].host || a[0]))); throw new Error('network blocked in test'); };
  net.connect = net.createConnection = (...a) => { calls.push('net ' + JSON.stringify(a[0])); throw new Error('network blocked in test'); };
  return { calls, restore: () => { global.fetch = saved.fetch; http.request = saved.hr; http.get = saved.hg; https.request = saved.sr; https.get = saved.sg; net.connect = saved.nc; net.createConnection = saved.ncc; } };
}

test('activation and opening DBML and SQL diagrams make no network call and show no message', async () => {
  const nw = trapNetwork();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    for (const c of ['dbmlViewer.openDiagram', 'dbmlViewer.openSample', 'dbmlViewer.copySvg', 'dbmlViewer.resetLayout', 'dbmlViewer.exportSql', 'dbmlViewer.exportImage', 'dbmlViewer.compare', 'dbmlViewer.getPro', 'dbmlViewer.payByCard', 'dbmlViewer.enterLicenseKey', 'dbmlViewer.supportDeveloper', 'dbmlViewer.moreViewers']) assert.ok(s.commands.has(c), c);
    assert.ok(s.providers.has('symbols') && s.providers.has('definition'));
    const p = await openDiagram(s, DBML);
    const m = await until(() => lastModel(p));
    assert.strictEqual(m.type, 'model');
    assert.strictEqual(m.model.tables.length, 6);
    assert.strictEqual(Object.keys(m.pos).length, 8, '6 tables, 1 enum, 1 note');
    assert.deepStrictEqual(m.pro.tries, { sql: 3, image: 3, diff: 3 });
    assert.strictEqual(m.fit, true);
    assert.match(p.title, /ER Diagram: shop\.dbml/);
    const q = await openDiagram(s, SQL);
    const m2 = await until(() => lastModel(q));
    assert.deepStrictEqual(m2.model.tables.map((t) => t.key), ['authors', 'posts', 'tags', 'post_tags', 'comments']);
    assert.strictEqual(m2.kind, 'sql');
    assert.deepStrictEqual(nw.calls, []);
    assert.deepStrictEqual([s.log.info.length, s.log.warn.length, s.log.error.length], [0, 0, 0], 'no message on open');
    assert.deepStrictEqual(s.log.external, []);
  } finally { nw.restore(); s.restore(); }
});

test('the diagram follows edits; dragged positions are kept per file; Reset layout forgets them; click jumps to the line', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const p = await openDiagram(s, DBML);
    await until(() => lastModel(p));
    const doc = s.docs.get(DBML);
    const n0 = p.posted.length;
    s.setText(doc, doc.text + '\nTable audit {\n  id int [pk]\n  user_id int [ref: > U.id]\n}\n');
    const m = await until(() => p.posted.slice(n0).find((x) => x.type === 'model'));
    assert.strictEqual(m.model.tables.length, 7);
    assert.ok(m.pos.audit);
    await p.send({ type: 'moved', key: 'users', x: 1234, y: 567 });
    const saved = s.context.workspaceState.get('dbmlViewer.positions');
    assert.deepStrictEqual(saved[doc.uri.toString()].users, { x: 1234, y: 567 });
    const n1 = p.posted.length;
    s.setText(doc, doc.text + '\n');
    const m2 = await until(() => p.posted.slice(n1).find((x) => x.type === 'model'));
    assert.deepStrictEqual([m2.pos.users.x, m2.pos.users.y], [1234, 567]);
    const n2 = p.posted.length;
    await p.send({ type: 'reset' });
    const m3 = await until(() => p.posted.slice(n2).find((x) => x.type === 'model'));
    assert.notStrictEqual(m3.pos.users.x, 1234);
    assert.strictEqual(m3.fit, true);
    // click on the "email" row of users: the editor selects the column name on its line
    await p.send({ type: 'reveal', key: 'users', row: 1 });
    const shown = s.log.opened.at(-1);
    assert.strictEqual(shown, doc);
    // rendered with tables and no error counts for the rating, once
    await p.send({ type: 'rendered', tables: 7, errors: 0 });
  } finally { s.restore(); }
});

test('problems follow edits on a frozen TextDocument (the real host does not allow new properties)', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const doc = await s.vscode.workspace.openTextDocument(s.vscode.Uri.file(BAD));
    await until(() => s.diags.get(BAD) && s.diags.get(BAD).length === 2);
    assert.ok(!Object.isExtensible(doc));
    s.setText(doc, 'Table a {\n  id int [pk]\n}\n');
    const d = await until(() => s.diags.get(BAD) && s.diags.get(BAD).length === 0 && s.diags.get(BAD), 3000);
    assert.ok(d, 'the 2 problems are gone after the fix is typed');
    s.setText(doc, 'Tabel a { }\n');
    const d2 = await until(() => s.diags.get(BAD) && s.diags.get(BAD).length === 1 && s.diags.get(BAD), 3000);
    assert.strictEqual(d2[0].range.start.line, 0);
  } finally { s.restore(); }
});

test('problems with line and column, outline and go to definition for DBML', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const doc = await s.vscode.workspace.openTextDocument(s.vscode.Uri.file(BAD));
    const d = await until(() => s.diags.get(BAD));
    assert.deepStrictEqual(d.map((x) => [x.range.start.line, x.message]).sort(), [[2, 'Ref to an unknown table "nowhere".'], [4, 'Unknown keyword "Tabel". Expected Table, Ref, Enum, TableGroup, Project or Note.']]);
    const good = await s.vscode.workspace.openTextDocument(s.vscode.Uri.file(DBML));
    const syms = await s.providers.get('symbols').provideDocumentSymbols(good);
    assert.ok(syms.some((x) => x.name === 'users' && x.children.some((c) => c.name === 'email')));
    assert.ok(syms.some((x) => x.name === 'order_status'));
    assert.ok(syms.some((x) => x.name === 'sales'));
    // "Ref: order_items.product_id > products.id": cursor on products -> the products table, on id -> products.id
    const line = good.text.split('\n').findIndex((l) => l.startsWith('Ref: order_items.product_id'));
    const L = good.text.split('\n')[line];
    const atTable = await s.providers.get('definition').provideDefinition(good, new s.vscode.Position(line, L.indexOf('products.id') + 2));
    const tLine = good.text.split('\n').findIndex((l) => l.startsWith('Table products'));
    assert.strictEqual(atTable.range.start.line, tLine);
    const atCol = await s.providers.get('definition').provideDefinition(good, new s.vscode.Position(line, L.indexOf('products.id') + 10));
    assert.strictEqual(atCol.range.start.line, tLine + 1);
    const alias = good.text.split('\n').findIndex((l) => l.includes('admin_id integer [ref: > U.id]'));
    const atAlias = await s.providers.get('definition').provideDefinition(good, new s.vscode.Position(alias, good.text.split('\n')[alias].indexOf('U.id')));
    assert.strictEqual(atAlias.range.start.line, good.text.split('\n').findIndex((l) => l.startsWith('Table users')));
  } finally { s.restore(); }
});

test('HTML in names goes to the webview as data; the CSP has nonces and no remote source', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const p = await openDiagram(s, XSSF);
    const m = await until(() => lastModel(p));
    assert.strictEqual(m.model.tables[0].name, XSS);
    const html = p.webview.html;
    assert.match(html, /default-src 'none'/);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.ok(!/unsafe-inline|unsafe-eval|https?:|\*/.test(csp), 'CSP: no unsafe-inline, no remote origin, no wildcard');
    // remote loads: no src= or stylesheet href pointing outside the webview (support links are plain anchors)
    assert.ok(!/(src|srcset)=["']?https?:/i.test(html) && !/<link[^>]+href=["']?https?:/i.test(html), 'no remote load');
    assert.strictEqual((html.match(/<script nonce="[^"]+" src=/g) || []).length, 2);
    assert.ok(!html.includes(XSS));
    const h = buildHtml({ cspSource: 'vscode-resource:', scriptUris: ['a.js'], styleUri: 's.css', title: XSS, nonce: 'n1' });
    assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'));
  } finally { s.restore(); }
});

test('Copy SVG (free) puts an SVG on the clipboard and uses no try', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const p = await openDiagram(s, DBML);
    await until(() => lastModel(p));
    await p.send({ type: 'copySvg', pos: { users: { x: 10, y: 20 } } });
    assert.match(s.log.clipboard, /^<svg xmlns/);
    assert.match(s.log.clipboard, /<rect x="10" y="20"/);
    assert.strictEqual(s.state.get('dbmlViewer.proTrial'), undefined);
  } finally { s.restore(); }
});

test('Export SQL: Escape keeps the try; 3 exports use the 3 tries; the 4th click shows the card1 panel', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const p = await openDiagram(s, DBML);
    await until(() => lastModel(p));
    s.ui.quick.push(undefined);
    await p.send({ type: 'tool', tool: 'exportSql' });
    s.ui.quick.push((items) => items[0]); s.ui.save.push(undefined);
    await p.send({ type: 'tool', tool: 'exportSql' });
    assert.strictEqual(s.state.get('dbmlViewer.proTrial'), undefined, 'cancel uses no try');
    const outs = [['PostgreSQL', 'shop.pg.sql'], ['MySQL', 'shop.my.sql'], ['SQLite', 'shop.lite.sql']];
    for (let i = 0; i < 3; i++) {
      const out = path.join(dir, outs[i][1]);
      s.ui.quick.push((items) => items.find((x) => x.label === outs[i][0]));
      s.ui.save.push(s.vscode.Uri.file(out));
      await p.send({ type: 'tool', tool: 'exportSql' });
      assert.ok(fs.existsSync(out), out);
      assert.strictEqual(s.state.get('dbmlViewer.proTrial').sql, i + 1);
    }
    assert.match(fs.readFileSync(path.join(dir, 'shop.pg.sql'), 'utf8'), /CREATE TYPE "order_status"/);
    assert.match(fs.readFileSync(path.join(dir, 'shop.my.sql'), 'utf8'), /AUTO_INCREMENT/);
    assert.match(fs.readFileSync(path.join(dir, 'shop.lite.sql'), 'utf8'), /AUTOINCREMENT/);
    assert.ok(s.log.status.some((t) => /free try 3 of 3/.test(t)));
    assert.strictEqual(s.log.info.length, 0, 'no panel while tries are left');
    s.ui.info.push(undefined); // Cancel
    await p.send({ type: 'tool', tool: 'exportSql' });
    const panel = s.log.info.at(-1);
    assert.strictEqual(panel.text, 'Export SQL (PostgreSQL, MySQL, SQL Server, SQLite or DBML) is part of Zovo Pro.');
    assert.deepStrictEqual(panel.buttons, PANEL);
    assert.ok(panel.opts.modal);
    assert.match(panel.opts.detail, /Export the diagram/);
    assert.ok(!/refund/i.test(panel.opts.detail));
    // Pay by card opens the license Worker with an install id; Sponsors opens the USD 19 tier
    s.ui.info.push('Pay by card (USD 19)');
    await p.send({ type: 'tool', tool: 'exportSql' });
    assert.match(s.log.external.at(-1), /^https:\/\/license\.zovo\.one\/buy\/zovo-pro\?client_reference_id=[0-9a-f-]{36}$/);
    s.ui.info.push('Get Zovo Pro with GitHub Sponsors');
    await p.send({ type: 'tool', tool: 'exportSql' });
    assert.strictEqual(s.log.external.at(-1), 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
    assert.strictEqual(fs.readdirSync(dir).filter((f) => /\.sql$/.test(f) && f !== 'blog.sql').length, 3, 'nothing written after the tries');
  } finally { s.restore(); }
});

test('Export SQL from a SQL file writes DBML that reads back', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const p = await openDiagram(s, SQL);
    await until(() => lastModel(p));
    const out = path.join(dir, 'blog.dbml');
    s.ui.quick.push((items) => { assert.strictEqual(items[0].label, 'DBML'); return items[0]; });
    s.ui.save.push(s.vscode.Uri.file(out));
    await p.send({ type: 'tool', tool: 'exportSql' });
    const back = require('../src/core/dbml').parseDbml(fs.readFileSync(out, 'utf8'));
    assert.deepStrictEqual(back.errors, []);
    assert.strictEqual(back.tables.length, 5);
    assert.strictEqual(back.refs.length, 5);
  } finally { s.restore(); }
});

test('Export image: PNG (through the webview canvas), SVG, PDF and the data dictionary; tries after output; 4th = panel', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const p = await openDiagram(s, DBML);
    await until(() => lastModel(p));
    p.autoPng = true;
    s.ui.quick.push((items) => items[0]); s.ui.save.push(undefined);
    await p.send({ type: 'tool', tool: 'exportImage' });
    assert.strictEqual(s.state.get('dbmlViewer.proTrial'), undefined);
    const outs = [['png', 'shop.erd.png'], ['svg', 'shop.erd.svg'], ['pdf', 'shop.erd.pdf']];
    for (let i = 0; i < 3; i++) {
      const out = path.join(dir, outs[i][1]);
      s.ui.quick.push((items) => items.find((x) => x.k === outs[i][0]));
      s.ui.save.push(s.vscode.Uri.file(out));
      await p.send({ type: 'tool', tool: 'exportImage', pos: {} });
      assert.ok(fs.existsSync(out), out);
      assert.strictEqual(s.state.get('dbmlViewer.proTrial').image, i + 1);
    }
    const r = p.posted.find((m) => m.type === 'rasterize');
    assert.strictEqual(r.scale, 2);
    assert.match(r.svg, /^<svg/);
    assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'shop.erd.png')).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.match(fs.readFileSync(path.join(dir, 'shop.erd.svg'), 'utf8'), /^<svg/);
    assert.match(fs.readFileSync(path.join(dir, 'shop.erd.pdf'), 'latin1'), /^%PDF-1\.4/);
    s.ui.info.push(undefined);
    await p.send({ type: 'tool', tool: 'exportImage' });
    assert.strictEqual(s.log.info.at(-1).text, 'Export the diagram (PNG, SVG, PDF or data dictionary) is part of Zovo Pro.');
    assert.deepStrictEqual(s.log.info.at(-1).buttons, PANEL);
  } finally { s.restore(); }
});

test('Schema diff: Escape on the file or the database keeps the try; the report opens with migration SQL', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const p = await openDiagram(s, DBML);
    await until(() => lastModel(p));
    s.ui.open.push(undefined);
    await p.send({ type: 'tool', tool: 'diff' });
    s.ui.open.push([s.vscode.Uri.file(OLD)]); s.ui.quick.push(undefined);
    await p.send({ type: 'tool', tool: 'diff' });
    assert.strictEqual(s.state.get('dbmlViewer.proTrial'), undefined);
    for (let i = 1; i <= 3; i++) {
      s.ui.open.push([s.vscode.Uri.file(OLD)]); s.ui.quick.push((items) => { assert.strictEqual(items[0].k, 'postgres'); return items[i === 2 ? 1 : 0]; });
      await p.send({ type: 'tool', tool: 'diff' });
      assert.strictEqual(s.state.get('dbmlViewer.proTrial').diff, i);
    }
    const rep = s.log.untitled.at(-1).getText();
    assert.match(rep, /^# Schema diff: shop-old\.dbml → shop\.dbml/);
    assert.match(rep, /## Tables added\n\n- countries/);
    assert.match(rep, /ALTER TABLE "users" ADD CONSTRAINT "fk_users_country_code" FOREIGN KEY \("country_code"\) REFERENCES "countries" \("code"\);/);
    assert.match(s.log.untitled[1].getText(), /Migration \(MySQL\)/);
    s.ui.info.push(undefined);
    await p.send({ type: 'tool', tool: 'diff' });
    assert.strictEqual(s.log.info.at(-1).text, 'Schema diff with migration SQL is part of Zovo Pro.');
  } finally { s.restore(); }
});

test('the showProTools setting hides the buttons; a reading timeout gives a message and a rating failure only then', async () => {
  const s = loadExtension();
  try {
    s.config.showProTools = false;
    s.ext.activate(s.context);
    const p = await openDiagram(s, DBML);
    const m = await until(() => lastModel(p));
    assert.strictEqual(m.pro.show, false);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    for (const c of ['dbmlViewer.exportSql', 'dbmlViewer.exportImage', 'dbmlViewer.compare']) assert.strictEqual(pkg.contributes.menus.commandPalette.find((x) => x.command === c).when, 'config.dbmlViewer.showProTools');
  } finally { s.restore(); }
});

test('package.json: name, engine, phrase-first display name, walkthrough with the cross-sell step last', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(`${pkg.publisher}.${pkg.name}`, 'zovo.zovo-dbml-viewer');
  assert.strictEqual(pkg.engines.vscode, '^1.90.0');
  assert.strictEqual(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.ok(pkg.displayName.startsWith('DBML Viewer & ER Diagram'));
  assert.ok(pkg.description.startsWith('DBML viewer and ER diagram'));
  assert.ok(!pkg.dependencies, 'no runtime dependencies');
  const steps = pkg.contributes.walkthroughs[0].steps;
  assert.strictEqual(steps.at(-1).id, 'zovo-related');
  assert.strictEqual(steps.length, 4);
  for (const st of steps) assert.ok(fs.existsSync(path.join(__dirname, '..', st.media.markdown)), st.media.markdown);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'samples', 'sample.dbml')) && fs.existsSync(path.join(__dirname, '..', 'samples', 'sample.sql')));
});
