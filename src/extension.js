'use strict';
// DBML Viewer & ER Diagram: a live ER diagram beside the editor for DBML, SQL DDL and Prisma schemas, plus DBML
// language support (grammar, problems, outline, go to definition). The readers run in a worker thread (runner.js)
// with a time and memory cap. No network: the webview gets the model by postMessage. Pro tools (pro.js) ask only
// when used.
const vscode = require('vscode');
const path = require('path');
const { runParse } = require('./runner');
const { kindOf, hasCreateTable } = require('./core');
const { makeResolver } = require('./core/model');
const { layout, merge } = require('./core/layout');
const { toSvg } = require('./core/svg');
const { toPdf } = require('./core/pdf');
const gen = require('./core/gen');
const diff = require('./core/diff');
const { buildHtml } = require('./html');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const EXT_ID = 'zovo.zovo-dbml-viewer';
const PREFIX = 'dbmlViewer';
const VIEW_TYPE = 'dbmlViewer.diagram';
const POS_KEY = 'dbmlViewer.positions';
const MAX_DOC_CHARS = 8 * 1024 * 1024;

let rating = { success() {}, failure() {} };
let pro;
let ctx;
const diagrams = new Map(); // document uri string -> Diagram
let activeDiagram = null;
let diagnostics;
const parseCache = new Map(); // uri -> { version, promise }

function setting(key, dflt) { try { return vscode.workspace.getConfiguration(PREFIX).get(key, dflt); } catch { return dflt; } }
const baseName = (uri) => path.posix.basename(uri.path) || uri.toString();
const docKind = (doc) => kindOf(doc.fileName || doc.uri.path, doc.languageId);

/** Parse a document once per version (shared by the diagram, the problems, the outline and go to definition). */
function parseDoc(doc, kind) {
  const key = doc.uri.toString();
  const c = parseCache.get(key);
  const k = kind || docKind(doc) || 'dbml';
  if (c && c.version === doc.version && c.kind === k) return c.promise;
  const text = doc.getText();
  const promise = text.length > MAX_DOC_CHARS
    ? Promise.reject(Object.assign(new Error(`This file has ${Math.round(text.length / 1048576)} million characters; the diagram reads files up to 8 million.`), { code: 'TOO_BIG' }))
    : runParse(text, k);
  promise.catch(() => {});
  parseCache.set(key, { version: doc.version, kind: k, promise });
  if (parseCache.size > 50) parseCache.delete(parseCache.keys().next().value);
  return promise;
}

function savedPositions(uri) { const all = ctx.workspaceState.get(POS_KEY) || {}; return all[uri] || {}; }
async function savePositions(uri, p) {
  const all = { ...(ctx.workspaceState.get(POS_KEY) || {}) };
  if (p && Object.keys(p).length) all[uri] = p; else delete all[uri];
  const keys = Object.keys(all);
  if (keys.length > 200) delete all[keys[0]];
  await ctx.workspaceState.update(POS_KEY, all);
}

function proState() {
  return { show: setting('showProTools', true) !== false, licensed: !!(pro && pro.licensed), tries: pro ? pro.tries() : {} };
}

class Diagram {
  constructor(doc, panel) {
    this.doc = doc; this.uri = doc.uri; this.key = doc.uri.toString(); this.panel = panel; this.name = baseName(doc.uri);
    this.kind = docKind(doc) || 'dbml'; this.model = null; this.layout = null; this.pos = {}; this.counted = false; this.timer = null; this.seq = 0; this.pngWait = new Map();
  }
  post(msg) { return this.panel.webview.postMessage(msg).then(undefined, () => false); }
  schedule(ms = 350) { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), ms); }
  async refresh(opts = {}) {
    const my = ++this.seq;
    try {
      const r = await parseDoc(this.doc, this.kind);
      if (my !== this.seq) return;
      this.model = r.model; this.layout = r.layout;
      this.pos = merge(r.layout, savedPositions(this.key));
      await this.post({ type: 'model', model: r.model, pos: this.pos, name: this.name, kind: this.kind, pro: proState(), fit: !!opts.fit });
    } catch (e) {
      if (my !== this.seq) return;
      if (e.code === 'WORKER' || e.code === 'TIMEOUT') rating.failure();
      await this.post({ type: 'fatal', message: e.message || String(e) });
    }
  }
  async onMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'ready': return this.refresh({ fit: true });
      case 'rendered':
        if (!this.counted && msg.tables > 0 && !msg.errors && !msg.fatal) { this.counted = true; rating.success(this.uri); }
        return undefined;
      case 'moved': {
        const k = String(msg.key || '');
        if (!this.pos[k] || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return undefined;
        this.pos[k] = { ...this.pos[k], x: Math.round(msg.x), y: Math.round(msg.y) };
        const s = { ...savedPositions(this.key), [k]: { x: Math.round(msg.x), y: Math.round(msg.y) } };
        return savePositions(this.key, s);
      }
      case 'reset': await savePositions(this.key, {}); return this.refresh({ fit: true });
      case 'reveal': return this.reveal(String(msg.key || ''), Number(msg.row));
      case 'line': return this.revealLine(Number(msg.line) || 1, Number(msg.col) || 1);
      case 'copySvg': return copySvg(this, msg.pos);
      case 'tool': this.takePos(msg.pos); return runTool(String(msg.tool), this);
      case 'png': { const w = this.pngWait.get(msg.id); if (w) { this.pngWait.delete(msg.id); w(msg); } return undefined; }
      default: return undefined;
    }
  }
  takePos(p) {
    if (!p || typeof p !== 'object') return;
    for (const k of Object.keys(this.pos)) { const v = p[k]; if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) this.pos[k] = { ...this.pos[k], x: v.x, y: v.y }; }
  }
  async reveal(key, row) {
    if (!this.model) return;
    let line = 1, col = 1, len = 0;
    if (key.startsWith('enum:')) { const e = this.model.enums.find((x) => `enum:${x.key}` === key); if (e) { line = e.line; col = e.col; len = e.len; } }
    else if (key.startsWith('note:')) { const n = this.model.notes.find((x) => `note:${x.name}` === key); if (n) line = n.line; }
    else {
      const t = this.model.tables.find((x) => x.key === key);
      if (!t) return;
      const c = row >= 0 && row < t.columns.length ? t.columns[row] : null;
      if (c && c.line) { line = c.line; col = c.col; len = c.len; } else { line = t.line; col = t.col; len = t.len; }
    }
    return this.revealLine(line, col, len);
  }
  async revealLine(line, col, len = 0) {
    const doc = this.doc;
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.key);
    const start = new vscode.Position(Math.max(0, line - 1), Math.max(0, col - 1));
    const range = new vscode.Range(start, start.translate(0, len));
    const shown = await vscode.window.showTextDocument(doc, { viewColumn: ed ? ed.viewColumn : vscode.ViewColumn.One, selection: range, preserveFocus: false });
    if (shown && shown.revealRange) shown.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  /** PNG through the webview canvas. */
  rasterize(svg, width, height, scale) {
    const id = `png${++this.seq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pngWait.delete(id); reject(new Error('The diagram view did not answer; keep it open and try again.')); }, 30000);
      this.pngWait.set(id, (m) => { clearTimeout(t); if (m.error || !m.data) reject(new Error(m.error || 'No image data.')); else resolve(Buffer.from(m.data, 'base64')); });
      this.post({ type: 'rasterize', id, svg, width, height, scale });
    });
  }
}

/** Open (or show) the ER diagram of a document beside it. */
async function openDiagram(arg) {
  let doc;
  if (arg && arg.scheme) doc = await vscode.workspace.openTextDocument(arg);
  else if (vscode.window.activeTextEditor) doc = vscode.window.activeTextEditor.document;
  else if (activeDiagram) doc = activeDiagram.doc;
  if (!doc) {
    const p = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open ER Diagram', title: 'Pick a DBML, SQL or Prisma schema', filters: { 'Schemas': ['dbml', 'sql', 'ddl', 'prisma'], 'All files': ['*'] } });
    if (!p || !p[0]) return undefined;
    doc = await vscode.workspace.openTextDocument(p[0]);
  }
  const key = doc.uri.toString();
  const have = diagrams.get(key);
  if (have) { have.panel.reveal(vscode.ViewColumn.Beside, true); return have; }
  if (!docKind(doc)) {
    const pick = await vscode.window.showQuickPick([{ label: 'DBML', k: 'dbml' }, { label: 'SQL DDL', k: 'sql' }, { label: 'Prisma schema', k: 'prisma' }], { title: `Read ${baseName(doc.uri)} as` });
    if (!pick) return undefined;
    doc.__dbmlKind = pick.k;
  }
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `ER Diagram: ${baseName(doc.uri)}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media], enableCommandUris: commandUris(PREFIX) });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'diagram-icon.svg');
  const w = panel.webview;
  w.html = buildHtml({
    cspSource: w.cspSource,
    scriptUris: [w.asWebviewUri(vscode.Uri.joinPath(media, 'geometry.js')).toString(), w.asWebviewUri(vscode.Uri.joinPath(media, 'diagram.js')).toString()],
    styleUri: w.asWebviewUri(vscode.Uri.joinPath(media, 'diagram.css')).toString(),
    title: baseName(doc.uri),
    showSupportLinks: showLinks(vscode, PREFIX),
  });
  const d = new Diagram(doc, panel);
  if (doc.__dbmlKind) d.kind = doc.__dbmlKind;
  diagrams.set(key, d);
  activeDiagram = d;
  panel.onDidChangeViewState(() => { if (panel.active) activeDiagram = d; });
  panel.onDidDispose(() => { diagrams.delete(key); if (activeDiagram === d) activeDiagram = null; clearTimeout(d.timer); });
  w.onDidReceiveMessage((m) => d.onMessage(m).then(undefined, (e) => vscode.window.showWarningMessage(String(e && e.message || e))));
  return d;
}

// ---------------- language support for DBML ----------------

function updateDiagnostics(doc) {
  if (docKind(doc) !== 'dbml' || !diagnostics) return;
  if (doc.getText().length > MAX_DOC_CHARS) { diagnostics.delete(doc.uri); return; }
  parseDoc(doc).then((r) => {
    const list = r.model.errors.map((e) => {
      const line = Math.max(0, e.line - 1);
      const lineText = line < doc.lineCount ? doc.lineAt(line).text : '';
      const c = Math.max(0, Math.min(e.col - 1, lineText.length));
      const m = /^[\w"`'.]+/.exec(lineText.slice(c));
      const range = new vscode.Range(line, c, line, c + Math.max(1, m ? m[0].length : 1));
      const dg = new vscode.Diagnostic(range, e.message, vscode.DiagnosticSeverity.Error);
      dg.source = 'DBML';
      return dg;
    });
    diagnostics.set(doc.uri, list);
  }, () => diagnostics.delete(doc.uri));
}

const symbolProvider = {
  async provideDocumentSymbols(doc) {
    let r;
    try { r = await parseDoc(doc); } catch { return []; }
    const m = r.model;
    const at = (line, col, len) => { const l = Math.max(0, Math.min(doc.lineCount - 1, line - 1)); const c = Math.max(0, col - 1); return new vscode.Range(l, c, l, c + Math.max(1, len || 1)); };
    const out = [];
    if (m.project) { const pl = findLine(doc, /^\s*Project\b/i); if (pl >= 0) out.push(new vscode.DocumentSymbol(m.project.name || 'Project', m.project.databaseType || '', vscode.SymbolKind.Module, new vscode.Range(pl, 0, pl, 7), new vscode.Range(pl, 0, pl, 7))); }
    for (const t of m.tables) {
      const range = at(t.line, t.col, t.len);
      const s = new vscode.DocumentSymbol(t.key, `${t.columns.length} columns${t.alias ? `, alias ${t.alias}` : ''}`, vscode.SymbolKind.Struct, range, range);
      for (const c of t.columns) { if (!c.line || c.partial) continue; const cr = at(c.line, c.col, c.len); s.children.push(new vscode.DocumentSymbol(c.name, `${c.type}${c.pk ? ' PK' : ''}${c.fk ? ' FK' : ''}`, vscode.SymbolKind.Field, cr, cr)); }
      out.push(s);
    }
    for (const e of m.enums) { const range = at(e.line, e.col, e.len); const s = new vscode.DocumentSymbol(e.key, `${e.values.length} values`, vscode.SymbolKind.Enum, range, range); out.push(s); }
    for (const g of m.groups) { const range = at(g.line, 1, 10); out.push(new vscode.DocumentSymbol(g.name, `TableGroup, ${g.tables.length} tables`, vscode.SymbolKind.Namespace, range, range)); }
    for (const n of m.notes) { const range = at(n.line, 1, 4); out.push(new vscode.DocumentSymbol(n.name, 'Note', vscode.SymbolKind.String, range, range)); }
    out.sort((a, b) => a.range.start.line - b.range.start.line);
    return out;
  },
};

function findLine(doc, re) { for (let i = 0; i < Math.min(doc.lineCount, 20000); i++) if (re.test(doc.lineAt(i).text)) return i; return -1; }

const definitionProvider = {
  async provideDefinition(doc, position) {
    const range = doc.getWordRangeAtPosition(position, /("[^"\n]+"|[\w$]+)(\.("[^"\n]+"|[\w$]+|\([^)\n]*\)))*/);
    if (!range) return undefined;
    const text = doc.getText(range);
    let r;
    try { r = await parseDoc(doc); } catch { return undefined; }
    const m = r.model;
    const parts = [];
    const re = /"([^"\n]+)"|([\w$]+)/g;
    let x;
    while ((x = re.exec(text))) parts.push(x[1] || x[2]);
    // which part is under the cursor
    let offset = doc.offsetAt(position) - doc.offsetAt(range.start);
    let upto = 0, k = 0;
    re.lastIndex = 0;
    while ((x = re.exec(text))) { if (offset >= x.index && offset <= x.index + x[0].length) { upto = k; break; } k++; upto = k; }
    const resolve = makeResolver(m);
    const loc = (line, col, len) => new vscode.Location(doc.uri, new vscode.Range(Math.max(0, line - 1), Math.max(0, col - 1), Math.max(0, line - 1), Math.max(0, col - 1) + Math.max(1, len || 1)));
    for (let n = Math.min(parts.length, upto + 1); n >= 1; n--) {
      const head = parts.slice(0, n).join('.');
      const t = resolve(head);
      if (t) {
        if (n === upto && parts[n]) { const c = t.columns.find((y) => y.name === parts[n]); if (c && c.line) return loc(c.line, c.col, c.len); }
        if (n === upto + 1 || !parts[n]) return loc(t.line, t.col, t.len);
        const c = t.columns.find((y) => y.name === parts[n]);
        if (c && c.line) return loc(c.line, c.col, c.len);
        return loc(t.line, t.col, t.len);
      }
      const e = m.enums.find((y) => y.key === head || y.name === head);
      if (e) return loc(e.line, e.col, e.len);
    }
    return undefined;
  },
};

// ---------------- free: copy as SVG ----------------

async function copySvg(d, p) {
  if (!d || !d.model) return;
  if (p) d.takePos(p);
  const { svg } = toSvg(d.model, d.pos, { theme: themeKind(), title: d.name });
  await vscode.env.clipboard.writeText(svg);
  vscode.window.setStatusBarMessage(`Copied the diagram of ${d.name} as SVG (${Math.round(svg.length / 1024)} KB).`, 5000);
}
function themeKind() { const k = vscode.window.activeColorTheme ? vscode.window.activeColorTheme.kind : 1; return k === 2 || k === 3 ? 'dark' : 'light'; }

// ---------------- Pro tools ----------------

/** The schema a tool works on: the active diagram, the active editor, or a picked file. */
async function sourceFor(from, title) {
  if (from instanceof Diagram) return from;
  if (activeDiagram && (!vscode.window.activeTextEditor || vscode.window.activeTextEditor.document.uri.toString() === activeDiagram.key || !docKind(vscode.window.activeTextEditor.document))) return activeDiagram;
  let doc = vscode.window.activeTextEditor && docKind(vscode.window.activeTextEditor.document) ? vscode.window.activeTextEditor.document : null;
  if (from && from.scheme) doc = await vscode.workspace.openTextDocument(from);
  if (!doc) {
    const p = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: title, title: `${title}: pick a DBML, SQL or Prisma schema`, filters: { Schemas: ['dbml', 'sql', 'ddl', 'prisma'] } });
    if (!p || !p[0]) return null;
    doc = await vscode.workspace.openTextDocument(p[0]);
  }
  const have = diagrams.get(doc.uri.toString());
  if (have) return have;
  const r = await parseDoc(doc);
  return { doc, uri: doc.uri, key: doc.uri.toString(), name: baseName(doc.uri), kind: docKind(doc) || 'dbml', model: r.model, pos: merge(r.layout, savedPositions(doc.uri.toString())), detached: true };
}

async function freshModel(src) {
  if (src.detached) return src.model;
  const r = await parseDoc(src.doc, src.kind);
  src.model = r.model;
  return r.model;
}

function defaultDialect(model) {
  const t = String(model.project && model.project.databaseType || '').toLowerCase();
  if (/mysql|maria/.test(t)) return 'mysql';
  if (/sql ?server|mssql|azure/.test(t)) return 'mssql';
  if (/sqlite/.test(t)) return 'sqlite';
  return 'postgres';
}

function dialectItems(first) {
  const order = ['postgres', 'mysql', 'mssql', 'sqlite'];
  order.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
  return order.map((k) => ({ label: gen.DIALECTS[k].label, k }));
}

const stem = (name) => name.replace(/\.(dbml|sql|ddl|prisma)$/i, '');
function besideUri(src, suffix) {
  if (src.uri.scheme === 'file') return vscode.Uri.file(path.join(path.dirname(src.uri.fsPath), `${stem(src.name)}${suffix}`));
  return undefined;
}

async function runTool(tool, from) {
  if (tool === 'exportSql') return exportSql(from);
  if (tool === 'exportImage') return exportImage(from);
  if (tool === 'diff') return compareSchemas(from);
  return undefined;
}

/** Column for a result file: the column of the schema's text editor (else the first one), so the diagram beside
 *  it stays visible and repeated exports do not open a new editor group each time. */
function resultColumn(src) {
  const k = src && src.uri ? src.uri.toString() : '';
  const ed = (vscode.window.visibleTextEditors || []).find((e) => e.document && e.document.uri.toString() === k);
  return (ed && ed.viewColumn) || vscode.ViewColumn.One;
}

async function exportSql(from) {
  if (!(await pro.allowed('sql'))) return;
  let src;
  try { src = await sourceFor(from, 'Export SQL'); } catch (e) { vscode.window.showWarningMessage(`Could not read the schema: ${e.message}`); return; }
  if (!src) return;
  const model = await freshModel(src).catch((e) => { vscode.window.showWarningMessage(`Could not read the schema: ${e.message}`); return null; });
  if (!model) return;
  if (!model.tables.length) { vscode.window.showInformationMessage(`${src.name} has no table to export yet.`); return; }
  const items = dialectItems(defaultDialect(model)).map((x) => ({ ...x, description: 'CREATE TABLE script' }));
  if (src.kind !== 'dbml') items.unshift({ label: 'DBML', k: 'dbml', description: 'for dbdiagram.io, dbdocs and this diagram' });
  const pick = await vscode.window.showQuickPick(items, { title: `Export ${src.name} as`, placeHolder: 'Pick the database (or DBML)' });
  if (!pick) return; // no try used
  const isDbml = pick.k === 'dbml';
  const target = await vscode.window.showSaveDialog({ defaultUri: besideUri(src, isDbml ? '.dbml' : `.${pick.k}.sql`), filters: isDbml ? { DBML: ['dbml'] } : { SQL: ['sql'] }, title: `Save the ${pick.label} export of ${src.name}` });
  if (!target) return; // no try used
  const text = isDbml ? gen.toDbml(model) : gen.toSql(model, pick.k);
  await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
  await pro.produced('sql');
  if (model.errors.length) vscode.window.setStatusBarMessage(`${model.errors.length} line${model.errors.length === 1 ? '' : 's'} of ${src.name} could not be read and are not in the export.`, 8000);
  await vscode.window.showTextDocument(target, { preview: false, viewColumn: resultColumn(src) });
  refreshPro();
}

async function exportImage(from) {
  if (!(await pro.allowed('image'))) return;
  let src;
  try { src = await sourceFor(from, 'Export the diagram'); } catch (e) { vscode.window.showWarningMessage(`Could not read the schema: ${e.message}`); return; }
  if (!src) return;
  const model = await freshModel(src).catch(() => null);
  if (!model || !(model.tables.length + model.enums.length)) { vscode.window.showInformationMessage(`${src.name} has no table to draw yet.`); return; }
  const pick = await vscode.window.showQuickPick([
    { label: 'PNG image', description: 'high resolution, 2x', k: 'png' },
    { label: 'SVG image', description: 'vector, opens in browsers and design tools', k: 'svg' },
    { label: 'PDF document', description: 'vector, one page', k: 'pdf' },
    { label: 'Markdown data dictionary', description: 'one table per database table: column, type, keys, nullable, default, note', k: 'md' },
  ], { title: `Export the diagram of ${src.name}`, placeHolder: 'Pick a format' });
  if (!pick) return; // no try used
  const ext = { png: 'png', svg: 'svg', pdf: 'pdf', md: 'md' }[pick.k];
  const target = await vscode.window.showSaveDialog({ defaultUri: besideUri(src, pick.k === 'md' ? '.dictionary.md' : `.erd.${ext}`), filters: { [pick.label]: [ext] }, title: `Save ${pick.label}` });
  if (!target) return; // no try used
  // keep the model and positions in step (a table added since the last drag gets its automatic place)
  const pos = src.detached ? src.pos : merge(layout(model), Object.fromEntries(Object.entries(src.pos).map(([k, v]) => [k, { x: v.x, y: v.y }])));
  let data;
  try {
    if (pick.k === 'svg') data = Buffer.from(toSvg(model, pos, { theme: 'light', title: src.name }).svg, 'utf8');
    else if (pick.k === 'pdf') data = toPdf(model, pos, { title: src.name }).buffer;
    else if (pick.k === 'md') data = Buffer.from(gen.dictionary(model, src.name), 'utf8');
    else {
      const s = toSvg(model, pos, { theme: 'light', title: src.name });
      let scale = 2;
      while (scale > 0.25 && (s.width * scale > 16000 || s.height * scale > 16000 || s.width * s.height * scale * scale > 120e6)) scale /= 2;
      let d = src instanceof Diagram ? src : null;
      if (!d) { d = await openDiagram(src.uri); await new Promise((r) => setTimeout(r, 1200)); }
      if (!d) return;
      data = await d.rasterize(s.svg, s.width, s.height, scale);
    }
  } catch (e) { vscode.window.showWarningMessage(`The export did not work: ${e.message}`); return; }
  await vscode.workspace.fs.writeFile(target, data);
  // the "Saved" line goes first so the try count of Zovo Pro (shown by produced) is the one on top
  if (pick.k !== 'md') vscode.window.setStatusBarMessage(`Saved ${baseName(target)} (${Math.max(1, Math.round(data.length / 1024))} KB).`, 8000);
  await pro.produced('image');
  if (pick.k === 'md') await vscode.window.showTextDocument(target, { preview: false, viewColumn: resultColumn(src) });
  refreshPro();
}

async function compareSchemas(from) {
  if (!(await pro.allowed('diff'))) return;
  let src;
  try { src = await sourceFor(from, 'Compare schemas'); } catch (e) { vscode.window.showWarningMessage(`Could not read the schema: ${e.message}`); return; }
  if (!src) return;
  const B = await freshModel(src).catch(() => null);
  if (!B) return;
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title: `Pick the older schema to compare ${src.name} with`, filters: { Schemas: ['dbml', 'sql', 'ddl', 'prisma'], 'All files': ['*'] }, defaultUri: src.uri.scheme === 'file' ? vscode.Uri.file(path.dirname(src.uri.fsPath)) : undefined });
  if (!pick || !pick[0]) return; // no try used
  let A;
  try {
    const other = await vscode.workspace.openTextDocument(pick[0]);
    const k = docKind(other) || src.kind;
    A = (await runParse(other.getText().slice(0, MAX_DOC_CHARS), k, { layout: false })).model;
  } catch (e) { vscode.window.showWarningMessage(`${baseName(pick[0])}: ${e.message}`); return; }
  if (!A.tables.length && !A.enums.length) { vscode.window.showWarningMessage(`${baseName(pick[0])} has no table: nothing to compare.`); return; }
  const dl = await vscode.window.showQuickPick(dialectItems(defaultDialect(B)), { title: 'Write the migration SQL for', placeHolder: 'Pick the database' });
  if (!dl) return; // no try used
  const d = diff.compare(A, B);
  const sql = diff.migration(d, A, B, dl.k);
  const md = diff.report(d, baseName(pick[0]), src.name, sql, dl.k);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: resultColumn(src) });
  await pro.produced('diff');
  refreshPro();
}

function refreshPro() { for (const d of diagrams.values()) d.post({ type: 'pro', pro: proState() }); }

// ---------------- SQL editor title button ----------------

let sqlTimer = null;
function updateSqlContext() {
  clearTimeout(sqlTimer);
  sqlTimer = setTimeout(() => {
    const ed = vscode.window.activeTextEditor;
    const on = !!(ed && docKind(ed.document) === 'sql' && hasCreateTable(ed.document.getText()));
    vscode.commands.executeCommand('setContext', 'dbmlViewer.sqlHasTables', on);
  }, 200);
}

// ---------------- activation ----------------

function activate(context) {
  ctx = context;
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'DBML Viewer' });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  diagnostics = vscode.languages.createDiagnosticCollection('dbml');
  context.subscriptions.push(diagnostics);
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg(`${PREFIX}.openDiagram`, (uri) => openDiagram(uri && uri.scheme ? uri : undefined));
  reg(`${PREFIX}.openSample`, async (which) => {
    const file = which === 'sql' ? 'sample.sql' : 'sample.dbml';
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, 'samples', file));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    await openDiagram(doc.uri);
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#dbmlViewer.start`, false));
  reg(`${PREFIX}.copySvg`, async () => { const d = activeDiagram || (await openDiagram()); if (d) { if (!d.model) await d.refresh(); await copySvg(d); } });
  reg(`${PREFIX}.resetLayout`, async () => { const d = activeDiagram; if (d) { await savePositions(d.key, {}); await d.refresh({ fit: true }); } });
  reg(`${PREFIX}.exportSql`, (uri) => exportSql(uri && uri.scheme ? uri : activeDiagram));
  reg(`${PREFIX}.exportImage`, (uri) => exportImage(uri && uri.scheme ? uri : activeDiagram));
  reg(`${PREFIX}.compare`, (uri) => compareSchemas(uri && uri.scheme ? uri : activeDiagram));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) refreshPro(); }));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider({ language: 'dbml' }, symbolProvider));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'dbml' }, definitionProvider));
  const diagTimers = new Map();
  context.subscriptions.push({ dispose: () => { for (const t of diagTimers.values()) clearTimeout(t); diagTimers.clear(); } });
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const d = diagrams.get(e.document.uri.toString());
    if (d && e.contentChanges.length) d.schedule();
    if (docKind(e.document) === 'dbml') {
      // TextDocument objects are frozen in the real host: keep the debounce timers in a Map
      const k = e.document.uri.toString();
      clearTimeout(diagTimers.get(k));
      diagTimers.set(k, setTimeout(() => { diagTimers.delete(k); updateDiagnostics(e.document); }, 400));
    }
    if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) updateSqlContext();
  }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => updateDiagnostics(doc)));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => { if (diagnostics) diagnostics.delete(doc.uri); parseCache.delete(doc.uri.toString()); }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateSqlContext()));
  for (const doc of vscode.workspace.textDocuments || []) updateDiagnostics(doc);
  updateSqlContext();
}

function deactivate() { try { require('./runner').stop(); } catch { /* ignore */ } }

module.exports = { activate, deactivate, Diagram, defaultDialect };
