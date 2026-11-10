'use strict';
// A small stand-in for the vscode module: enough for activation, the diagram panel, the language features, the Pro
// tools and the license facade. Tests script the dialogs through `ui` and read what happened from `log`.
const fs = require('fs');
const path = require('path');
const Module = require('module');

function create() {
  const log = { info: [], warn: [], error: [], status: [], opened: [], external: [], commands: [], posted: [], saved: [], progress: [] };
  const ui = { open: [], save: [], input: [], quick: [], info: [] };
  const commands = new Map();
  const providers = new Map();
  const state = new Map();
  const config = { showProTools: true, showSupportLinks: true, askForRating: true };
  const workspaceState = new Map();
  class EventEmitter { constructor() { this.l = new Set(); this.event = (f) => { this.l.add(f); return { dispose: () => this.l.delete(f) }; }; } fire(v) { for (const f of this.l) f(v); } dispose() { this.l.clear(); } }
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
    static file(p) { return new Uri('file', path.resolve(p)); }
    static parse(s) { const u = new Uri(s.split(':')[0], s); u.str = s; return u; }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.join(u.path, ...parts)); }
    toString() { return this.str || `${this.scheme}://${this.path}`; }
    with() { return this; }
  }
  const nextOf = (q, dflt) => (q.length ? q.shift() : dflt);
  const msg = (kind) => async (text, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : {};
    log[kind].push({ text, opts, buttons: rest.map((b) => (typeof b === 'string' ? b : b.title)) });
    return kind === 'info' ? nextOf(ui.info, undefined) : undefined;
  };
  class Position { constructor(l, c) { this.line = l; this.character = c; } translate(dl, dc) { return new Position(this.line + (dl || 0), this.character + (dc || 0)); } }
  class Range { constructor(a, b, c, d) { if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; } } }
  class Location { constructor(uri, range) { this.uri = uri; this.range = range; } }
  class DocumentSymbol { constructor(name, detail, kind, range, sel) { Object.assign(this, { name, detail, kind, range, selectionRange: sel, children: [] }); } }
  class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
  const diags = new Map();
  const docs = new Map();
  const listeners = { change: [], open: [], close: [], active: [] };
  let version = 0;
  function makeDoc(uri, text, languageId) {
    const lines = () => doc.text.split('\n');
    const doc = {
      uri, fileName: uri.fsPath, languageId: languageId || (/\.dbml$/.test(uri.fsPath) ? 'dbml' : /\.sql$/.test(uri.fsPath) ? 'sql' : /\.prisma$/.test(uri.fsPath) ? 'prisma' : 'plaintext'),
      version: ++version, text,
      getText(r) { if (!r) return doc.text; const off = (p) => lines().slice(0, p.line).reduce((a, l) => a + l.length + 1, 0) + p.character; return doc.text.slice(off(r.start), off(r.end)); },
      get lineCount() { return lines().length; },
      lineAt(i) { return { text: lines()[i] || '' }; },
      offsetAt(p) { return lines().slice(0, p.line).reduce((a, l) => a + l.length + 1, 0) + p.character; },
      getWordRangeAtPosition(p, re) { const l = lines()[p.line] || ''; const g = new RegExp(re.source, 'g'); let m; while ((m = g.exec(l))) { if (p.character >= m.index && p.character <= m.index + m[0].length) return new Range(p.line, m.index, p.line, m.index + m[0].length); if (!m[0].length) g.lastIndex++; } return undefined; },
    };
    return doc;
  }
  function setText(doc, text) { doc.text = text; doc.version = ++version; for (const f of listeners.change) f({ document: doc, contentChanges: [{ text }] }); }
  const panels = [];
  const vscode = {
    version: '1.90.2',
    EventEmitter, Uri, Position, Range, Location, DocumentSymbol, Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    SymbolKind: { Module: 1, Namespace: 2, Class: 4, Field: 7, Enum: 9, Interface: 10, String: 14, Struct: 22, EnumMember: 21 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    languages: {
      createDiagnosticCollection: () => ({ set: (u, l) => diags.set(String(u.fsPath), l), delete: (u) => diags.delete(String(u.fsPath)), dispose() {} }),
      registerDocumentSymbolProvider: (sel, p) => { providers.set('symbols', p); return { dispose() {} }; },
      registerDefinitionProvider: (sel, p) => { providers.set('definition', p); return { dispose() {} }; },
    },
    ViewColumn: { Beside: -2, Active: -1, One: 1 },
    ProgressLocation: { Notification: 15, Window: 10 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    env: { appName: 'Visual Studio Code', uriScheme: 'vscode', machineId: 'test', clipboard: { writeText: async (t) => { log.clipboard = t; } }, openExternal: async (u) => { log.external.push(String(u)); return true; }, asExternalUri: async (u) => u },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async () => {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      fs: {
        stat: async (u) => ({ size: fs.statSync(u.fsPath).size }),
        readFile: async (u) => fs.readFileSync(u.fsPath),
        writeFile: async (u, b) => { fs.writeFileSync(u.fsPath, b); log.saved.push(u.fsPath); },
      },
      openTextDocument: async (o) => {
        if (o && o.scheme) { const k = o.fsPath; if (!docs.has(k)) docs.set(k, makeDoc(o, fs.readFileSync(k, 'utf8'))); const d = docs.get(k); for (const f of listeners.open) f(d); return d; }
        const d = { uri: Uri.parse('untitled:doc'), getText: () => (o && o.content) || '', o, languageId: o && o.language }; log.untitled = (log.untitled || []).concat([d]); return d;
      },
      get textDocuments() { return [...docs.values()]; },
      onDidChangeTextDocument: (f) => { listeners.change.push(f); return { dispose() {} }; },
      onDidOpenTextDocument: (f) => { listeners.open.push(f); return { dispose() {} }; },
      onDidCloseTextDocument: (f) => { listeners.close.push(f); return { dispose() {} }; },
      isTrusted: true,
    },
    window: {
      state: { focused: true },
      onDidChangeWindowState: () => ({ dispose() {} }),
      registerCustomEditorProvider: (vt, p) => { providers.set(vt, p); return { dispose() {} }; },
      activeTextEditor: undefined,
      visibleTextEditors: [],
      activeColorTheme: { kind: 2 },
      onDidChangeActiveTextEditor: (f) => { listeners.active.push(f); return { dispose() {} }; },
      createWebviewPanel: (viewType, title) => {
        const posted = []; let onMsg; const disposeL = [];
        const panel = {
          viewType, title, active: true, visible: true, posted, iconPath: null,
          webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); log.posted.push(m); if (panel.autoPng && m.type === 'rasterize') setTimeout(() => onMsg && onMsg({ type: 'png', id: m.id, data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') }), 0); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
          onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: (f) => { disposeL.push(f); return { dispose() {} }; }, reveal() {},
          send: (m) => onMsg(m), dispose: () => disposeL.forEach((f) => f()),
        };
        panels.push(panel);
        return panel;
      },
      registerUriHandler: () => ({ dispose() {} }),
      showInformationMessage: msg('info'), showWarningMessage: msg('warn'), showErrorMessage: msg('error'),
      setStatusBarMessage: (t) => { log.status.push(t); return { dispose() {} }; },
      showOpenDialog: async () => nextOf(ui.open, undefined),
      showSaveDialog: async () => nextOf(ui.save, undefined),
      showInputBox: async (o) => { const v = nextOf(ui.input, undefined); if (v !== undefined && o && o.validateInput) { const e = o.validateInput(v); if (e) throw new Error(e); } return v; },
      showQuickPick: async (items) => { const f = nextOf(ui.quick, undefined); return typeof f === 'function' ? f(await items) : f; },
      showTextDocument: async (d) => { log.opened.push(d); return {}; },
      withProgress: async (o, fn) => { log.progress.push(o.title); return fn({ report: (r) => log.progress.push(r.message) }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }); },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...a) => { log.commands.push([id, ...a]); if (commands.has(id)) return commands.get(id)(...a); return undefined; },
    },
    extensions: { all: [], getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose() {} }) },
    l10n: { t: (s) => s },
  };
  const secrets = new Map();
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(path.join(__dirname, '..', '..')),
    extensionPath: path.join(__dirname, '..', '..'),
    extension: undefined,
    globalStorageUri: Uri.file(fs.mkdtempSync(path.join(require('os').tmpdir(), 'dbml-gs-'))),
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()], setKeysForSync() {} },
    workspaceState: { get: (k, d) => (workspaceState.has(k) ? workspaceState.get(k) : d), update: async (k, v) => { workspaceState.set(k, v); }, keys: () => [...workspaceState.keys()] },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) },
  };
  return { vscode, context, log, ui, commands, providers, state, config, panels, diags, docs, setText, makeDoc };
}

/** Load src/extension.js with a fresh stub; returns the stub and the module. */
function loadExtension() {
  const stub = create();
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  const root = path.join(__dirname, '..', '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
  try { stub.ext = require(path.join(root, 'extension.js')); } finally { Module._load = orig; }
  // later requires of vscode (lazy ones) still need the stub
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  stub.restore = () => { Module._load = orig; };
  return stub;
}

/** Open a schema file's diagram; waits for the first model message. */
async function openDiagram(stub, file) {
  const uri = stub.vscode.Uri.file(file);
  const before = stub.panels.length;
  await stub.commands.get('dbmlViewer.openDiagram')(uri);
  const panel = stub.panels[before] || stub.panels.find((p) => p.title.endsWith(require('path').basename(file)));
  await panel.send({ type: 'ready' });
  return panel;
}

module.exports = { create, loadExtension, openDiagram };
