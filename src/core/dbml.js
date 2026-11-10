'use strict';
// DBML reader (https://dbml.dbdiagram.io/docs): Project, Table (alias, settings, columns, inline refs, indexes, notes,
// TablePartial injection), Ref (short and long form, composite keys, < > - <>, delete/update actions), Enum,
// TableGroup, Note (sticky notes), schema-qualified and quoted names, comments, multi-line strings.
// Written from the language reference; no code from @dbml/core. Iterative (no recursion), every loop is bounded by
// the token count, so any input ends in linear time. Errors carry 1-based line and column and reading goes on at the
// next line, so one typo does not hide the rest of the diagram.
const { LIMITS, emptyModel, tableKey, finish, addError, addSkipped } = require('./model');

// ---------------- tokenizer ----------------
// t: id (word), q (double-quoted name), s (single or triple-quoted string), x (backtick expression), n (number),
//    c (#color), nl, p (punctuation, one char: { } [ ] ( ) , : . ~ ;), op (> < - <>), eof
function tokenize(text, model) {
  const toks = [];
  const n = text.length;
  let i = 0, line = 1, lineStart = 0;
  const push = (t, v, s, l, c) => { toks.push({ t, v, pos: s, line: l, col: c }); };
  const isWord = (ch) => /[A-Za-z0-9_$À-￿]/.test(ch);
  while (i < n) {
    if (toks.length >= LIMITS.maxTokens) { model.truncated = `The file has more than ${LIMITS.maxTokens.toLocaleString('en-US')} tokens; the rest is not read.`; break; }
    const ch = text[i];
    const col = i - lineStart + 1;
    if (ch === '\n') { push('nl', '\n', i, line, col); i++; line++; lineStart = i; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '﻿') { i++; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const sl = line, sc = col;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') { line++; lineStart = i + 1; } i++; }
      if (i >= n) addError(model, sl, sc, 'This /* comment has no closing */.');
      i += 2; continue;
    }
    if (ch === "'" && text.startsWith("'''", i)) {
      const sl = line, sc = col, s = i;
      i += 3;
      let buf = '';
      while (i < n && !text.startsWith("'''", i)) {
        if (text[i] === '\\' && i + 1 < n) { buf += text[i + 1] === "'" ? "'" : text[i] + text[i + 1]; if (text[i + 1] === '\n') { line++; lineStart = i + 2; } i += 2; continue; }
        if (text[i] === '\n') { line++; lineStart = i + 1; }
        if (buf.length < LIMITS.maxStringLen) buf += text[i];
        i++;
      }
      if (i >= n) addError(model, sl, sc, "This ''' string has no closing '''.");
      else i += 3;
      push('s', dedent(buf), s, sl, sc); continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const sl = line, sc = col, s = i;
      i++;
      let buf = '';
      let closed = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n && text[i + 1] !== '\n') { const e = text[i + 1]; buf += e === 'n' ? '\n' : e === 't' ? '\t' : e === ch || e === '\\' ? e : '\\' + e; i += 2; continue; }
        if (text[i] === ch) { closed = true; i++; break; }
        if (buf.length < LIMITS.maxStringLen) buf += text[i];
        i++;
      }
      if (!closed) addError(model, sl, sc, `This ${ch === '`' ? 'expression' : 'string'} has no closing ${ch}.`);
      push(ch === '"' ? 'q' : ch === '`' ? 'x' : 's', buf, s, sl, sc); continue;
    }
    if (ch === '#') {
      const s = i; i++;
      while (i < n && /[0-9A-Fa-f]/.test(text[i])) i++;
      push('c', text.slice(s, i), s, line, col); continue;
    }
    // a relation may end with ? (an optional relation, written by the dbml exporter): same relation, ? dropped
    if (ch === '<' && text[i + 1] === '>') { push('op', '<>', i, line, col); i += 2; if (text[i] === '?') i++; continue; }
    if (ch === '<' || ch === '>') { push('op', ch, i, line, col); i++; if (text[i] === '?') i++; continue; }
    if (ch === '-') {
      if (/[0-9]/.test(text[i + 1] || '') && /[:\s(,[]/.test(prevNonSpace(text, i))) { // a negative number (default: -1)
        const s = i; i++;
        while (i < n && /[0-9.eE]/.test(text[i])) i++;
        push('n', text.slice(s, i), s, line, col); continue;
      }
      push('op', '-', i, line, col); i++; if (text[i] === '?') i++; continue;
    }
    if (/[0-9]/.test(ch)) {
      const s = i;
      while (i < n && /[0-9.]/.test(text[i])) i++;
      if (i < n && isWord(text[i])) { while (i < n && isWord(text[i])) i++; push('id', text.slice(s, i), s, line, col); continue; }
      push('n', text.slice(s, i), s, line, col); continue;
    }
    if (ch === '?' && /[<>-]/.test(text[i + 1] || '')) { i++; continue; } // ?< ?> ?- : optional relation side
    if ('{}[](),:.~;'.includes(ch)) { push('p', ch, i, line, col); i++; continue; }
    if (isWord(ch)) {
      const s = i;
      while (i < n && isWord(text[i])) i++;
      push('id', text.slice(s, i), s, line, col); continue;
    }
    addError(model, line, col, `Unexpected character "${ch}".`);
    i++;
  }
  toks.push({ t: 'eof', v: '', pos: n, line, col: n - lineStart + 1 });
  return toks;
}

function prevNonSpace(text, i) {
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  return j < 0 ? '\n' : text[j];
}

function dedent(s) {
  const lines = s.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '').split(/\r?\n/);
  let min = Infinity;
  for (const l of lines) if (l.trim()) min = Math.min(min, l.match(/^[ \t]*/)[0].length);
  if (!Number.isFinite(min)) min = 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

// ---------------- parser ----------------
function parseDbml(text) {
  const model = emptyModel('dbml');
  text = String(text == null ? '' : text);
  if (text.length > LIMITS.maxText) {
    model.truncated = `The file has ${text.length.toLocaleString('en-US')} characters; the first ${LIMITS.maxText.toLocaleString('en-US')} are read.`;
    text = text.slice(0, LIMITS.maxText);
  }
  const toks = tokenize(text, model);
  let i = 0;
  const peek = (k = 0) => toks[Math.min(i + k, toks.length - 1)];
  const next = () => toks[Math.min(i++, toks.length - 1)];
  const is = (t, v, k = 0) => { const x = peek(k); return x.t === t && (v === undefined || x.v === v); };
  const isKw = (w, k = 0) => { const x = peek(k); return x.t === 'id' && x.v.toLowerCase() === w; };
  const skipNl = () => { while (is('nl') || is('p', ';')) i++; };
  const err = (tok, message) => addError(model, tok.line, tok.col, message);
  const atEnd = () => is('eof');
  const partials = new Map();
  const pendingInject = [];

  /** Skip the rest of the line; when it opens a block, skip the whole block (iterative brace count). */
  function skipLineOrBlock() {
    let depth = 0;
    while (!atEnd()) {
      const x = next();
      if (x.t === 'p' && x.v === '{') depth++;
      else if (x.t === 'p' && x.v === '}') { depth--; if (depth <= 0) { if (depth < 0) i--; return; } }
      else if (x.t === 'nl' && depth === 0) return;
    }
  }
  function skipToEol() { while (!atEnd() && !is('nl')) { if (is('p', '}')) return; i++; } }

  /** name or "quoted name"; returns the token or null */
  function nameTok() { if (is('id') || is('q')) return next(); return null; }
  /** a.b.c (each part a word or quoted); returns { parts, tok } or null */
  function dotted() {
    const t = nameTok(); if (!t) return null;
    const parts = [t.v];
    while (is('p', '.') && (is('id', undefined, 1) || is('q', undefined, 1)) && parts.length < 4) { i++; parts.push(next().v); }
    return { parts, tok: t };
  }
  function stringValue() {
    if (is('s') || is('q') || is('x')) return next().v;
    if (is('id') || is('n')) return next().v;
    return null;
  }

  /** [ a, b: c, ... ] -> [{ key, value, tok, raw }] ; key is lower-case words joined by a space */
  function settings() {
    const out = [];
    const open = next(); // [
    let guard = 0;
    while (!atEnd() && guard++ < 100000) {
      while (is('nl')) i++;
      if (is('p', ']')) { i++; return out; }
      const start = peek();
      const keyParts = [];
      while ((is('id') || is('q')) && !is('p', ':', 1) && keyParts.length < 4) keyParts.push(next().v.toLowerCase());
      if ((is('id') || is('q')) && is('p', ':', 1)) keyParts.push(next().v.toLowerCase());
      let value = null, valueTok = null, refOp = null;
      const raw = [];
      if (is('p', ':')) {
        i++;
        while (is('nl')) i++;
        valueTok = peek();
        if (keyParts.join(' ') === 'ref') {
          if (is('op')) refOp = next().v;
          const d = refEndpoint();
          value = d;
        } else {
          let depth = 0;
          while (!atEnd() && guard++ < 100000) {
            if (depth === 0 && (is('p', ',') || is('p', ']'))) break;
            if (is('nl') && depth === 0) break;
            const x = next();
            if (x.t === 'p' && x.v === '(') depth++;
            if (x.t === 'p' && x.v === ')') depth--;
            raw.push(x);
          }
          value = raw.length === 1 ? raw[0] : raw.length ? { t: 'raw', v: text.slice(raw[0].pos, peek().pos).trim() } : null;
        }
      }
      if (!keyParts.length && !value) {
        err(start, `Unexpected "${tokText(start)}" in the settings.`);
        while (!atEnd() && !is('p', ',') && !is('p', ']') && !is('nl')) i++;
        if (is('nl')) { err(open, 'This [ has no closing ].'); return out; }
      } else out.push({ key: keyParts.join(' '), value, refOp, tok: start, valueTok });
      while (is('nl')) i++;
      if (is('p', ',')) { i++; continue; }
      if (is('p', ']')) { i++; return out; }
      if (atEnd() || is('p', '}')) { err(open, 'This [ has no closing ].'); return out; }
      err(peek(), `Expected , or ] in the settings, found "${tokText(peek())}".`);
      while (!atEnd() && !is('p', ',') && !is('p', ']') && !is('nl') && !is('p', '}')) i++;
      if (is('p', ',')) i++;
    }
    return out;
  }

  /** schema.table.column, table.column or table.(a, b) / schema.table.(a, b) */
  function refEndpoint() {
    const start = peek();
    const parts = [];
    let cols = null;
    let guard = 0;
    while (guard++ < 8) {
      if (is('id') || is('q')) parts.push(next().v);
      else if (is('p', '(')) {
        i++; cols = [];
        while (!atEnd() && !is('p', ')') && !is('nl')) {
          if (is('id') || is('q')) cols.push(next().v);
          else if (is('p', ',')) i++;
          else { err(peek(), `Unexpected "${tokText(peek())}" in a composite column list.`); i++; }
          if (cols.length > LIMITS.maxColumns) break;
        }
        if (is('p', ')')) i++; else err(start, 'This ( has no closing ).');
        break;
      } else break;
      if (is('p', '.')) i++; else break;
    }
    if (cols) {
      if (!parts.length) { err(start, 'A reference needs a table name before the column list.'); return null; }
      return { table: parts.join('.'), columns: cols, tok: start };
    }
    if (parts.length < 2) { err(start, 'A reference needs table.column (or schema.table.column).'); return null; }
    return { table: parts.slice(0, -1).join('.'), columns: [parts[parts.length - 1]], tok: start };
  }

  function addRef(r) {
    if (model.refs.length >= LIMITS.maxRefs) { if (!model.truncated) model.truncated = `Only the first ${LIMITS.maxRefs.toLocaleString('en-US')} references are read.`; return; }
    model.refs.push(r);
  }

  function refActions(st, r) {
    for (const s of st) {
      const v = s.value ? tokText(s.value).trim() : '';
      if (s.key === 'delete') r.onDelete = v.toLowerCase();
      else if (s.key === 'update') r.onUpdate = v.toLowerCase();
      else if (s.key === 'color') r.color = v;
    }
  }

  /** endpoint op endpoint [settings], on one line */
  function refBody(nameStr, kwTok) {
    const a = refEndpoint();
    if (!a) { skipToEol(); return; }
    if (!is('op')) { err(peek(), `Expected a relation (>, <, - or <>) after ${a.table}.${a.columns.join(',')}.`); skipToEol(); return; }
    const op = next().v;
    const b = refEndpoint();
    if (!b) { skipToEol(); return; }
    const r = { name: nameStr || '', from: { table: a.table, columns: a.columns }, to: { table: b.table, columns: b.columns }, rel: op, onDelete: '', onUpdate: '', line: (kwTok || a.tok).line, col: (kwTok || a.tok).col, inline: false };
    if (a.columns.length !== b.columns.length) err(a.tok, `The two sides of this reference have ${a.columns.length} and ${b.columns.length} columns.`);
    if (is('p', '[')) refActions(settings(), r);
    addRef(r);
  }

  function parseRef(kw) {
    let nameStr = '';
    if ((is('id') || is('q')) && (is('p', ':', 1) || is('p', '{', 1) || (is('nl', undefined, 1) && is('p', '{', 2)))) nameStr = next().v;
    if (is('p', ':')) { i++; refBody(nameStr, kw); return; }
    while (is('nl')) i++;
    if (is('p', '{')) {
      const open = next();
      let guard = 0;
      while (!atEnd() && guard++ < 1000000) {
        skipNl();
        if (is('p', '}')) { i++; return; }
        if (atEnd()) break;
        const before = i;
        refBody(nameStr, null);
        if (i === before) i++;
      }
      err(open, 'This Ref { has no closing }.');
      return;
    }
    err(peek(), 'Expected : or { after Ref.');
    skipLineOrBlock();
  }

  function noteBlockValue() { // after "Note" : either ": 'text'" or "{ 'text' }"
    if (is('p', ':')) { i++; const v = stringValue(); return v == null ? '' : v; }
    if (is('p', '{')) {
      const open = next();
      let v = '';
      let guard = 0;
      while (!atEnd() && guard++ < 100000) {
        skipNl();
        if (is('p', '}')) { i++; return v; }
        if (is('s') || is('q')) { v += (v ? '\n' : '') + next().v; continue; }
        err(peek(), `Expected a string in the Note block, found "${tokText(peek())}".`);
        skipToEol();
      }
      err(open, 'This Note { has no closing }.');
      return v;
    }
    return null;
  }

  function columnSettings(col, st, table) {
    for (const s of st) {
      const v = s.value && s.value.t ? s.value : null;
      switch (s.key) {
        case 'pk': case 'primary key': col.pk = true; break;
        case 'increment': col.increment = true; break;
        case 'unique': col.unique = true; break;
        case 'not null': col.notNull = true; break;
        case 'null': col.nullable = true; break;
        case 'note': col.note = v ? v.v : ''; break;
        case 'default': col.dflt = v ? dfltValue(v) : null; break;
        case 'check': col.check = v ? v.v : ''; break;
        case 'ref': {
          const ep = s.value;
          if (!ep || !s.refOp) { err(s.tok, 'An inline ref needs a relation and a target, for example ref: > users.id'); break; }
          addRef({ name: '', from: { table: table.key, columns: [col.name] }, to: { table: ep.table, columns: ep.columns }, rel: s.refOp, onDelete: '', onUpdate: '', line: s.tok.line, col: s.tok.col, inline: true });
          break;
        }
        default:
          if (s.key) err(s.tok, `Unknown column setting "${s.key}".`);
      }
    }
  }

  function parseIndexes(table) {
    const open = next(); // {
    let guard = 0;
    while (!atEnd() && guard++ < 1000000) {
      skipNl();
      if (is('p', '}')) { i++; return; }
      if (atEnd()) break;
      const start = peek();
      const cols = [];
      if (is('p', '(')) {
        i++;
        while (!atEnd() && !is('p', ')') && !is('nl')) {
          if (is('id') || is('q')) cols.push({ name: next().v });
          else if (is('x')) cols.push({ expr: next().v });
          else if (is('p', ',')) i++;
          else { err(peek(), `Unexpected "${tokText(peek())}" in an index.`); i++; }
          if (cols.length > LIMITS.maxColumns) break;
        }
        if (is('p', ')')) i++; else err(start, 'This ( has no closing ).');
      } else if (is('id') || is('q')) cols.push({ name: next().v });
      else if (is('x')) cols.push({ expr: next().v });
      else { err(start, `Unexpected "${tokText(start)}" in the indexes block.`); skipToEol(); continue; }
      const idx = { columns: cols, pk: false, unique: false, name: '', type: '', note: '' };
      if (is('p', '[')) {
        for (const s of settings()) {
          const v = s.value && s.value.t ? s.value.v : '';
          if (s.key === 'pk' || s.key === 'primary key') idx.pk = true;
          else if (s.key === 'unique') idx.unique = true;
          else if (s.key === 'name') idx.name = v;
          else if (s.key === 'type') idx.type = v;
          else if (s.key === 'note') idx.note = v;
          else if (s.key) err(s.tok, `Unknown index setting "${s.key}".`);
        }
      }
      for (const c of cols) if (c.name && !table.columns.some((x) => x.name === c.name)) err(start, `Index column "${c.name}" is not in table "${table.key}".`);
      if (idx.pk && cols.length === 1 && cols[0].name) { const c = table.columns.find((x) => x.name === cols[0].name); if (c) c.pk = true; }
      if (idx.pk && cols.length > 1) for (const c of cols) { const x = table.columns.find((y) => y.name === c.name); if (x) x.pk = true; }
      table.indexes.push(idx);
      if (!is('nl') && !is('p', '}') && !atEnd()) { err(peek(), `Unexpected "${tokText(peek())}" after the index.`); skipToEol(); }
    }
    err(open, 'This indexes { has no closing }.');
  }

  function parseTable(kw, isPartial) {
    const d = dotted();
    if (!d) { err(peek(), `Expected a table name after ${kw.v}.`); skipLineOrBlock(); return; }
    const schema = d.parts.length > 1 ? d.parts.slice(0, -1).join('.') : '';
    const name = d.parts[d.parts.length - 1];
    const table = { key: tableKey(schema, name), name, schema, alias: '', note: '', headerColor: '', group: '', line: d.tok.line, col: d.tok.col, len: (d.tok.t === 'q' ? 2 : 0) + name.length, columns: [], indexes: [] };
    if (isKw('as')) { i++; const a = nameTok(); if (a) table.alias = a.v; else err(peek(), 'Expected an alias after "as".'); }
    if (is('p', '[')) {
      for (const s of settings()) {
        const v = s.value && s.value.t ? s.value.v : '';
        if (s.key === 'headercolor') table.headerColor = v;
        else if (s.key === 'note') table.note = v;
        else if (s.key) err(s.tok, `Unknown table setting "${s.key}".`);
      }
    }
    while (is('nl')) i++;
    if (!is('p', '{')) { err(peek(), `Expected { after the table name "${name}".`); skipLineOrBlock(); return; }
    const open = next();
    let closed = false;
    let guard = 0;
    while (!atEnd() && guard++ < 1000000) {
      skipNl();
      if (is('p', '}')) { i++; closed = true; break; }
      if (atEnd()) break;
      if (isKw('note') && (is('p', ':', 1) || is('p', '{', 1))) { i++; const v = noteBlockValue(); table.note = v || ''; continue; }
      if (isKw('indexes') && is('p', '{', 1)) { i++; parseIndexes(table); continue; }
      if (is('p', '~')) { i++; const p = nameTok(); if (p) pendingInject.push({ table, name: p.v, at: table.columns.length, tok: p }); else err(peek(), 'Expected a TablePartial name after ~.'); skipToEol(); continue; }
      if (isKw('checks') && is('p', '{', 1)) { const t = next(); addSkipped(model, t.line, `checks block in table ${name} (not drawn)`); skipLineOrBlock(); continue; }
      if (isKw('records') && is('p', '{', 1)) { const t = next(); addSkipped(model, t.line, 'records block (sample rows)'); skipLineOrBlock(); continue; }
      const ct = nameTok();
      if (!ct) { err(peek(), `Expected a column name in table "${name}", found "${tokText(peek())}".`); skipLineOrBlock(); continue; }
      const col = { name: ct.v, type: '', pk: false, increment: false, unique: false, notNull: false, nullable: false, dflt: null, note: '', line: ct.line, col: ct.col, len: ct.v.length + (ct.t === 'q' ? 2 : 0) };
      // type: words, quoted names, (args), dots and [] array suffixes, up to [settings] or the end of the line
      let type = '', depth = 0, g2 = 0;
      while (!atEnd() && g2++ < 10000) {
        if (is('nl') && depth === 0) break;
        if (is('p', '}') && depth === 0) break;
        if (is('p', '[') && depth === 0) { if (is('p', ']', 1)) { i += 2; type += '[]'; continue; } break; }
        const x = next();
        if (x.t === 'p' && x.v === '(') depth++;
        if (x.t === 'p' && x.v === ')') depth = Math.max(0, depth - 1);
        if (x.t === 'nl') continue;
        type += x.t === 'q' ? (/^[\w.]+$/.test(x.v) ? x.v : x.v) : x.t === 's' ? `'${x.v}'` : x.v;
        if (x.t === 'p' && x.v === ',') type += ' ';
        else if (x.t === 'id' && (is('id') || is('q'))) type += ' ';
      }
      col.type = type.trim();
      if (!col.type) err(ct, `Column "${ct.v}" in table "${name}" has no type.`);
      if (table.columns.length < LIMITS.maxColumns) table.columns.push(col);
      else if (table.columns.length === LIMITS.maxColumns) addError(model, ct.line, ct.col, `Table "${name}" has more than ${LIMITS.maxColumns} columns; the rest are not shown.`);
      if (is('p', '[')) columnSettings(col, settings(), table);
      if (!is('nl') && !is('p', '}') && !atEnd()) { err(peek(), `Unexpected "${tokText(peek())}" after column "${ct.v}".`); skipToEol(); }
    }
    if (!closed) err(open, `Table "${name}" has no closing }.`);
    if (isPartial) { partials.set(name, table); return; }
    if (model.tables.length >= LIMITS.maxTables) { if (!model.truncated) model.truncated = `Only the first ${LIMITS.maxTables.toLocaleString('en-US')} tables are read.`; return; }
    if (model.tables.some((t) => t.key === table.key)) err(d.tok, `Table "${table.key}" is defined twice.`);
    model.tables.push(table);
  }

  function parseEnum() {
    const d = dotted();
    if (!d) { err(peek(), 'Expected an enum name.'); skipLineOrBlock(); return; }
    const schema = d.parts.length > 1 ? d.parts.slice(0, -1).join('.') : '';
    const name = d.parts[d.parts.length - 1];
    const en = { key: tableKey(schema, name), name, schema, note: '', values: [], line: d.tok.line, col: d.tok.col, len: name.length };
    while (is('nl')) i++;
    if (!is('p', '{')) { err(peek(), `Expected { after the enum name "${name}".`); skipLineOrBlock(); return; }
    const open = next();
    let closed = false, guard = 0;
    while (!atEnd() && guard++ < 1000000) {
      skipNl();
      if (is('p', '}')) { i++; closed = true; break; }
      if (isKw('note') && (is('p', ':', 1) || is('p', '{', 1))) { i++; en.note = noteBlockValue() || ''; continue; }
      const v = nameTok() || (is('s') ? next() : null) || (is('n') ? next() : null);
      if (!v) { err(peek(), `Expected an enum value in "${name}", found "${tokText(peek())}".`); skipLineOrBlock(); continue; }
      const val = { name: v.v, note: '' };
      if (is('p', '[')) for (const s of settings()) { if (s.key === 'note') val.note = s.value && s.value.t ? s.value.v : ''; else if (s.key) err(s.tok, `Unknown enum value setting "${s.key}".`); }
      if (en.values.length < LIMITS.maxEnumValues) en.values.push(val);
      if (!is('nl') && !is('p', '}') && !atEnd()) { err(peek(), `Unexpected "${tokText(peek())}" after enum value "${v.v}".`); skipToEol(); }
    }
    if (!closed) err(open, `Enum "${name}" has no closing }.`);
    if (model.enums.length < LIMITS.maxEnums) model.enums.push(en);
  }

  function parseGroup() {
    const d = dotted();
    if (!d) { err(peek(), 'Expected a TableGroup name.'); skipLineOrBlock(); return; }
    const g = { name: d.parts.join('.'), tables: [], color: '', note: '', line: d.tok.line };
    if (is('p', '[')) for (const s of settings()) { const v = s.value && s.value.t ? s.value.v : ''; if (s.key === 'color') g.color = v; else if (s.key === 'note') g.note = v; else if (s.key) err(s.tok, `Unknown TableGroup setting "${s.key}".`); }
    while (is('nl')) i++;
    if (!is('p', '{')) { err(peek(), `Expected { after the TableGroup name "${g.name}".`); skipLineOrBlock(); return; }
    const open = next();
    let closed = false, guard = 0;
    while (!atEnd() && guard++ < 1000000) {
      skipNl();
      if (is('p', '}')) { i++; closed = true; break; }
      if (isKw('note') && (is('p', ':', 1) || is('p', '{', 1))) { i++; g.note = noteBlockValue() || ''; continue; }
      const t = dotted();
      if (!t) { err(peek(), `Expected a table name in TableGroup "${g.name}".`); skipLineOrBlock(); continue; }
      g.tables.push(t.parts.join('.'));
      if (!is('nl') && !is('p', '}') && !atEnd()) { err(peek(), `Unexpected "${tokText(peek())}" in TableGroup "${g.name}".`); skipToEol(); }
    }
    if (!closed) err(open, `TableGroup "${g.name}" has no closing }.`);
    model.groups.push(g);
  }

  function parseProject() {
    const nm = nameTok();
    const p = { name: nm ? nm.v : '', databaseType: '', note: '' };
    while (is('nl')) i++;
    if (!is('p', '{')) { err(peek(), 'Expected { after Project.'); skipLineOrBlock(); return; }
    const open = next();
    let closed = false, guard = 0;
    while (!atEnd() && guard++ < 100000) {
      skipNl();
      if (is('p', '}')) { i++; closed = true; break; }
      if (isKw('note') && (is('p', ':', 1) || is('p', '{', 1))) { i++; p.note = noteBlockValue() || ''; continue; }
      const k = nameTok();
      if (k && is('p', ':')) { i++; const v = stringValue(); if (k.v.toLowerCase() === 'database_type') p.databaseType = v || ''; skipToEol(); continue; }
      err(peek(), 'Expected key: value in the Project block.');
      skipLineOrBlock();
    }
    if (!closed) err(open, 'The Project block has no closing }.');
    model.project = p;
  }

  function parseStickyNote(kw) {
    const nm = nameTok();
    const note = { name: nm ? nm.v : `note_${model.notes.length + 1}`, text: '', line: kw.line, headerColor: '' };
    if (is('p', '[')) for (const s of settings()) { if (s.key === 'headercolor') note.headerColor = s.value && s.value.t ? s.value.v : ''; }
    while (is('nl')) i++;
    const v = noteBlockValue();
    if (v == null) { err(peek(), 'Expected { after the Note name.'); skipLineOrBlock(); return; }
    note.text = v;
    model.notes.push(note);
  }

  let guard = 0;
  while (!atEnd() && guard++ < LIMITS.maxTokens + 10) {
    skipNl();
    if (atEnd()) break;
    const t = peek();
    const before = i;
    if (t.t === 'id') {
      const kw = t.v.toLowerCase();
      if (kw === 'table') { i++; parseTable(t, false); }
      else if (kw === 'tablepartial') { i++; parseTable(t, true); }
      else if (kw === 'ref') { i++; parseRef(t); }
      else if (kw === 'enum') { i++; parseEnum(); }
      else if (kw === 'tablegroup') { i++; parseGroup(); }
      else if (kw === 'project') { i++; parseProject(); }
      else if (kw === 'note') { i++; parseStickyNote(t); }
      else if (kw === 'records') { i++; addSkipped(model, t.line, 'records block (sample rows)'); skipLineOrBlock(); }
      else { err(t, `Unknown keyword "${t.v}". Expected Table, Ref, Enum, TableGroup, Project or Note.`); skipLineOrBlock(); }
    } else if (t.t === 'p' && t.v === '}') { err(t, 'Unexpected }.'); i++; }
    else { err(t, `Unexpected "${tokText(t)}".`); skipLineOrBlock(); }
    if (i === before) i++;
  }

  // TablePartial injection (~name): columns, indexes and settings the table does not define itself
  for (const inj of pendingInject.reverse()) {
    const p = partials.get(inj.name);
    if (!p) { err(inj.tok, `Unknown TablePartial "${inj.name}".`); continue; }
    const own = new Set(inj.table.columns.map((c) => c.name));
    const add = p.columns.filter((c) => !own.has(c.name)).map((c) => ({ ...c, partial: p.name }));
    inj.table.columns.splice(inj.at, 0, ...add.slice(0, Math.max(0, LIMITS.maxColumns - inj.table.columns.length)));
    inj.table.indexes.push(...p.indexes);
    if (!inj.table.note && p.note) inj.table.note = p.note;
    if (!inj.table.headerColor && p.headerColor) inj.table.headerColor = p.headerColor;
  }
  // inline refs in partials point from the partial: re-home them is out of scope; drop refs whose table is a partial name
  model.refs = model.refs.filter((r) => !partials.has(r.from.table) || model.tables.some((t) => t.key === r.from.table));

  return finish(model);
}

function tokText(t) {
  if (!t) return '';
  if (t.t === 'q') return `"${t.v}"`;
  if (t.t === 's') return `'${t.v}'`;
  if (t.t === 'x') return `\`${t.v}\``;
  if (t.t === 'nl') return 'end of line';
  if (t.t === 'eof') return 'end of file';
  return t.v;
}

/** default: value -> { kind: 'string'|'number'|'expr'|'bool'|'null'|'word', value } */
function dfltValue(t) {
  if (t.t === 's') return { kind: 'string', value: t.v };
  if (t.t === 'n') return { kind: 'number', value: t.v };
  if (t.t === 'x') return { kind: 'expr', value: t.v };
  if (t.t === 'q') return { kind: 'string', value: t.v };
  if (t.t === 'id') { const l = t.v.toLowerCase(); if (l === 'true' || l === 'false') return { kind: 'bool', value: l }; if (l === 'null') return { kind: 'null', value: 'null' }; return { kind: 'word', value: t.v }; }
  return { kind: 'expr', value: t.v };
}

module.exports = { parseDbml, tokenize };
