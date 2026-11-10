'use strict';
// SQL DDL reader for PostgreSQL, MySQL / MariaDB, SQL Server and SQLite dumps and migration files.
// Reads CREATE TABLE (columns, types, PRIMARY KEY, NOT NULL, UNIQUE, DEFAULT, REFERENCES, AUTO_INCREMENT / IDENTITY /
// SERIAL / GENERATED AS IDENTITY, COMMENT), table constraints (PRIMARY KEY, UNIQUE, FOREIGN KEY, KEY / INDEX),
// ALTER TABLE ... ADD [CONSTRAINT] FOREIGN KEY / PRIMARY KEY / UNIQUE / COLUMN, CREATE TYPE ... AS ENUM,
// CREATE [UNIQUE] INDEX, COMMENT ON TABLE / COLUMN. Quoted names with "", ``, [] ; comments --, #, /* */ ;
// strings '', E'', N'', $$...$$ ; GO and DELIMITER. Every other statement is skipped and listed (not an error).
// Iterative and bounded like the DBML reader.
const { LIMITS, emptyModel, tableKey, finish, addError, addSkipped } = require('./model');

function tokenize(text, model) {
  const toks = [];
  const n = text.length;
  let i = 0, line = 1, lineStart = 0, delim = ';';
  const push = (t, v, s, l, c) => toks.push({ t, v, pos: s, line: l, col: c, end: i });
  const word = (ch) => /[A-Za-z0-9_$@#À-￿]/.test(ch);
  const atLineStart = (k) => { let j = k - 1; while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--; return j < 0 || text[j] === '\n'; };
  while (i < n) {
    if (toks.length >= LIMITS.maxTokens) { model.truncated = `The file has more than ${LIMITS.maxTokens.toLocaleString('en-US')} tokens; the rest is not read.`; break; }
    const ch = text[i];
    const col = i - lineStart + 1;
    if (ch === '\n') { i++; line++; lineStart = i; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '﻿') { i++; continue; }
    if (delim !== ';' && text.startsWith(delim, i)) { const s = i; i += delim.length; push('end', delim, s, line, col); continue; }
    if ((ch === '-' && text[i + 1] === '-') || (ch === '#' && (atLineStart(i) || text[i + 1] === ' '))) { while (i < n && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const sl = line, sc = col; i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') { line++; lineStart = i + 1; } i++; }
      if (i >= n) addError(model, sl, sc, 'This /* comment has no closing */.');
      i += 2; continue;
    }
    // GO on its own line (SQL Server batch separator)
    if ((ch === 'G' || ch === 'g') && atLineStart(i) && /^go\s*(\r?\n|$)/i.test(text.slice(i, i + 4))) { push('end', 'GO', i, line, col); i += 2; continue; }
    // DELIMITER $$ (MySQL client)
    if ((ch === 'D' || ch === 'd') && atLineStart(i) && /^delimiter[ \t]+\S/i.test(text.slice(i, i + 12))) {
      let j = i + 9; while (text[j] === ' ' || text[j] === '\t') j++;
      let k = j; while (k < n && !/\s/.test(text[k])) k++;
      delim = text.slice(j, k) || ';';
      i = k; continue;
    }
    if (ch === ';') { i++; push(delim === ';' ? 'end' : 'p', ';', i - 1, line, col); continue; }
    if (ch === '$') { // $tag$ ... $tag$
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0], s = i, sl = line, sc = col;
        const e = text.indexOf(tag, i + tag.length);
        const stop = e < 0 ? n : e + tag.length;
        for (let k = i; k < stop; k++) if (text[k] === '\n') { line++; lineStart = k + 1; }
        if (e < 0) addError(model, sl, sc, `This ${tag} string has no closing ${tag}.`);
        i = stop; push('s', text.slice(s + tag.length, e < 0 ? n : e).slice(0, LIMITS.maxStringLen), s, sl, sc); continue;
      }
    }
    if (ch === "'" || ((ch === 'N' || ch === 'n' || ch === 'E' || ch === 'e' || ch === 'X' || ch === 'x' || ch === 'B' || ch === 'b') && text[i + 1] === "'" && !word(text[i - 1] || ' '))) {
      const s = i, sl = line, sc = col;
      if (ch !== "'") i++;
      i++;
      let buf = '', closed = false;
      while (i < n) {
        const c = text[i];
        if (c === '\\' && i + 1 < n) { buf += text[i + 1] === 'n' ? '\n' : text[i + 1]; if (text[i + 1] === '\n') { line++; lineStart = i + 2; } i += 2; continue; }
        if (c === "'") { if (text[i + 1] === "'") { buf += "'"; i += 2; continue; } closed = true; i++; break; }
        if (c === '\n') { line++; lineStart = i + 1; }
        if (buf.length < LIMITS.maxStringLen) buf += c;
        i++;
      }
      if (!closed) addError(model, sl, sc, "This string has no closing '.");
      push('s', buf, s, sl, sc); continue;
    }
    if (ch === '"' || ch === '`') {
      const s = i, sl = line, sc = col; i++;
      let buf = '', closed = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === ch) { if (text[i + 1] === ch) { buf += ch; i += 2; continue; } closed = true; i++; break; }
        buf += text[i]; i++;
      }
      if (!closed) addError(model, sl, sc, `This quoted name has no closing ${ch}.`);
      push('q', buf.slice(0, 512), s, sl, sc); continue;
    }
    if (ch === '[') {
      if (text[i + 1] === ']') { i += 2; push('p', '[]', i - 2, line, col); continue; }
      const win = text.slice(i + 1, i + 514); // a quoted [name] is short and on one line: never scan far
      const cw = win.indexOf(']');
      const close = cw < 0 ? -1 : i + 1 + cw;
      const nlw = win.indexOf('\n');
      if (close > 0 && (nlw < 0 || cw < nlw) && !/^\d*$/.test(text.slice(i + 1, close))) { const s = i; i = close + 1; push('q', text.slice(s + 1, close).slice(0, 512), s, line, col); continue; }
      i++; push('p', '[', i - 1, line, col); continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      const s = i;
      while (i < n && /[0-9.eE]/.test(text[i])) { if ((text[i] === 'e' || text[i] === 'E') && /[+-]/.test(text[i + 1] || '')) i++; i++; }
      if (i < n && word(text[i])) { while (i < n && word(text[i])) i++; push('w', text.slice(s, i), s, line, col); continue; }
      push('n', text.slice(s, i), s, line, col); continue;
    }
    if (word(ch)) {
      const s = i;
      while (i < n && word(text[i])) i++;
      push('w', text.slice(s, i), s, line, col); continue;
    }
    i++; push('p', ch, i - 1, line, col);
  }
  return toks;
}

const COL_STOP = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'DEFAULT', 'REFERENCES', 'CHECK', 'AUTO_INCREMENT', 'AUTOINCREMENT',
  'IDENTITY', 'GENERATED', 'COMMENT', 'COLLATE', 'CHARSET', 'ON', 'AS', 'SPARSE', 'ROWGUIDCOL', 'FILESTREAM', 'MASKED', 'VISIBLE', 'INVISIBLE',
  'STORAGE', 'COLUMN_FORMAT', 'KEY', 'ENCODE', 'DISTKEY', 'SORTKEY', 'COMPRESSION', 'ENGINE_ATTRIBUTE']);
const TABLE_ITEM = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'EXCLUDE', 'PERIOD', 'LIKE']);

function parseSql(text) {
  const model = emptyModel('sql');
  let byKey = null, byKeyN = -1; // findTable cache
  text = String(text == null ? '' : text);
  if (text.length > LIMITS.maxText) {
    model.truncated = `The file has ${text.length.toLocaleString('en-US')} characters; the first ${LIMITS.maxText.toLocaleString('en-US')} are read.`;
    text = text.slice(0, LIMITS.maxText);
  }
  const toks = tokenize(text, model);
  // split into statements
  const stmts = [];
  let cur = [];
  for (const t of toks) {
    if (t.t === 'end') { if (cur.length) stmts.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) stmts.push(cur);

  const later = [];
  const skippedKinds = new Map();
  const skip = (st, why) => {
    const head = st.filter((t) => t.t === 'w').slice(0, 2).map((t) => t.v.toUpperCase()).join(' ') || 'statement';
    skippedKinds.set(head, (skippedKinds.get(head) || 0) + 1);
    addSkipped(model, st[0].line, why || head);
  };
  for (const st of stmts) {
    const U = (k) => (st[k] && st[k].t === 'w' ? st[k].v.toUpperCase() : '');
    if (U(0) === 'CREATE') {
      let k = 1;
      while (['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'EXTERNAL', 'SHARDED', 'TRANSIENT'].includes(U(k)) && k < 8) k++;
      if (U(k) === 'TABLE') { createTable(st, k + 1); continue; }
      if (U(k) === 'TYPE') { createType(st, k + 1); continue; }
      let j = k;
      if (U(j) === 'UNIQUE') j++;
      if (U(j) === 'CLUSTERED' || U(j) === 'NONCLUSTERED' || U(j) === 'BITMAP' || U(j) === 'FULLTEXT' || U(j) === 'SPATIAL') j++;
      if (U(j) === 'INDEX') { later.push(st); continue; }
      skip(st);
      continue;
    }
    if (U(0) === 'ALTER' && U(1) === 'TABLE') { later.push(st); continue; }
    if (U(0) === 'COMMENT' && U(1) === 'ON') { later.push(st); continue; }
    skip(st);
  }
  for (const st of later) {
    const U = (k) => (st[k] && st[k].t === 'w' ? st[k].v.toUpperCase() : '');
    if (U(0) === 'ALTER') alterTable(st);
    else if (U(0) === 'COMMENT') commentOn(st);
    else createIndex(st);
  }
  // FK without a column list: the parent's primary key
  for (const r of model.refs) {
    if (!r.to.columns.length) {
      const p = findTable(r.to.table);
      const pk = p ? p.columns.filter((c) => c.pk).map((c) => c.name) : [];
      r.to.columns = pk.length ? pk : ['id'];
    }
  }
  // one-to-one when the FK columns are unique in the child
  for (const r of model.refs) {
    const c = findTable(r.from.table);
    if (!c) continue;
    const cols = r.from.columns.map((x) => String(x).toLowerCase());
    const single = cols.length === 1 && c.columns.find((x) => x.name.toLowerCase() === cols[0]);
    const pkCols = c.columns.filter((x) => x.pk).map((x) => x.name.toLowerCase());
    const uniqIdx = c.indexes.some((ix) => (ix.unique || ix.pk) && ix.columns.length === cols.length && ix.columns.every((x) => x.name && cols.includes(x.name.toLowerCase())));
    if ((single && single.unique) || uniqIdx || (pkCols.length === cols.length && pkCols.every((x) => cols.includes(x)))) r.rel = '-';
  }
  function findTable(written) {
    const w = String(written).toLowerCase();
    if (!byKey || byKeyN !== model.tables.length) { byKey = new Map(model.tables.map((t) => [t.key.toLowerCase(), t])); byKeyN = model.tables.length; }
    if (byKey.has(w)) return byKey.get(w);
    const bare = w.slice(w.lastIndexOf('.') + 1);
    const list = model.tables.filter((t) => t.name.toLowerCase() === bare);
    return list.length === 1 ? list[0] : null;
  }
  if (skippedKinds.size) model.skippedSummary = [...skippedKinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(', ');
  return finish(model, { unknownRefIsError: false, unknownColumnIsError: false });

  // ---------------- statement readers ----------------
  function qname(st, k) { // [db.]schema.name or name; returns { parts, next, tok }
    const parts = [];
    const tok = st[k];
    let guard = 0;
    while (k < st.length && guard++ < 4) {
      const t = st[k];
      if (t.t === 'w' || t.t === 'q') parts.push(t.v); else break;
      k++;
      if (st[k] && st[k].t === 'p' && st[k].v === '.') k++; else break;
    }
    return parts.length ? { parts, next: k, tok } : null;
  }
  function group(st, k) { // st[k] is '(' : returns [items as token arrays], next index after ')'
    const items = [];
    let depth = 0, curr = [];
    let j = k;
    for (; j < st.length; j++) {
      const t = st[j];
      if (t.t === 'p' && t.v === '(') { depth++; if (depth === 1) continue; }
      if (t.t === 'p' && t.v === ')') { depth--; if (depth === 0) { if (curr.length) items.push(curr); return { items, next: j + 1 }; } }
      if (depth === 1 && t.t === 'p' && t.v === ',') { items.push(curr); curr = []; continue; }
      curr.push(t);
    }
    if (curr.length) items.push(curr);
    addError(model, st[k].line, st[k].col, 'This ( has no closing ).');
    return { items, next: j };
  }
  function colList(st, k) {
    if (!(st[k] && st[k].t === 'p' && st[k].v === '(')) return { cols: [], next: k };
    const g = group(st, k);
    const cols = [];
    for (const it of g.items) {
      const first = it.find((t) => t.t === 'w' || t.t === 'q');
      if (it.length && first && (it.length === 1 || it.slice(1).every((t) => t.t === 'w' && /^(ASC|DESC|NULLS|FIRST|LAST|COLLATE)$/i.test(t.v)) || (it[1] && it[1].t === 'p' && it[1].v === '('  && /^\d+$/.test((it[2] || {}).v || '')))) cols.push({ name: first.v });
      else cols.push({ expr: text.slice(it[0].pos, it[it.length - 1].end).replace(/\s+/g, ' ') });
    }
    return { cols, next: g.next };
  }
  function nameToKey(parts) {
    const name = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : '';
    return { name, schema, key: tableKey(schema, name) };
  }
  function getTable(parts) {
    const { key } = nameToKey(parts);
    return model.tables.find((t) => t.key === key) || model.tables.find((t) => t.key.toLowerCase() === key.toLowerCase()) || findTable(parts.join('.'));
  }

  function createTable(st, k) {
    const W = (j) => (st[j] && st[j].t === 'w' ? st[j].v.toUpperCase() : '');
    if (W(k) === 'IF' && W(k + 1) === 'NOT' && W(k + 2) === 'EXISTS') k += 3;
    const qn = qname(st, k);
    if (!qn) { addError(model, st[0].line, st[0].col, 'CREATE TABLE without a table name.'); return; }
    k = qn.next;
    if (!(st[k] && st[k].t === 'p' && st[k].v === '(')) { skip(st, `CREATE TABLE ${qn.parts.join('.')} ${W(k) || ''} (no column list)`); return; }
    if (model.tables.length >= LIMITS.maxTables) { if (!model.truncated) model.truncated = `Only the first ${LIMITS.maxTables.toLocaleString('en-US')} tables are read.`; return; }
    const { name, schema, key } = nameToKey(qn.parts);
    const table = { key, name, schema, alias: '', note: '', headerColor: '', group: '', line: qn.tok.line, col: qn.tok.col, len: (qn.tok.end || qn.tok.pos) - qn.tok.pos || name.length, columns: [], indexes: [] };
    const g = group(st, k);
    for (const it of g.items) {
      if (!it.length) continue;
      const head = it[0].t === 'w' ? it[0].v.toUpperCase() : '';
      if (TABLE_ITEM.has(head) && !((head === 'KEY' || head === 'INDEX' || head === 'PERIOD' || head === 'CHECK') && isTypeWord(it[1]))) { tableConstraint(table, it); continue; }
      column(table, it);
    }
    // table options: COMMENT='...' (MySQL)
    for (let j = g.next; j < st.length; j++) if (st[j].t === 'w' && st[j].v.toUpperCase() === 'COMMENT') { const s = st[j + 1] && st[j + 1].v === '=' ? st[j + 2] : st[j + 1]; if (s && s.t === 's') table.note = s.v; }
    if (model.tables.some((t) => t.key.toLowerCase() === key.toLowerCase())) { addError(model, qn.tok.line, qn.tok.col, `Table "${key}" is created twice.`); return; }
    model.tables.push(table);
  }
  function isTypeWord(t) { return !!t && t.t === 'w' && /^(int|integer|bigint|smallint|tinyint|mediumint|varchar|nvarchar|char|nchar|text|uuid|date|datetime|datetime2|timestamp|timestamptz|time|boolean|bool|bit|serial|bigserial|numeric|decimal|float|double|real|json|jsonb|blob|bytea|money|enum)$/i.test(t.v); }

  function column(table, it) {
    const nt = it[0];
    if (!(nt.t === 'w' || nt.t === 'q')) { addError(model, nt.line, nt.col, `Expected a column name in table "${table.name}", found "${nt.v}".`); return; }
    const col = { name: nt.v, type: '', pk: false, increment: false, unique: false, notNull: false, nullable: false, dflt: null, note: '', line: nt.line, col: nt.col, len: nt.v.length + (nt.t === 'q' ? 2 : 0) };
    let j = 1, depth = 0;
    const typeToks = [];
    for (; j < it.length; j++) {
      const t = it[j];
      if (depth === 0 && t.t === 'w') {
        const u = t.v.toUpperCase();
        if (COL_STOP.has(u) && !(u === 'NOT' && false)) {
          if (u === 'CHARACTER' ) break;
          break;
        }
        if (u === 'CHARACTER' && it[j + 1] && /^SET$/i.test(it[j + 1].v)) break;
        if (u === 'WITH' || u === 'WITHOUT') { if (!(it[j + 1] && /^(TIME|LOCAL)$/i.test(it[j + 1].v))) break; }
      }
      if (t.t === 'p' && t.v === '(') depth++;
      if (t.t === 'p' && t.v === ')') depth--;
      typeToks.push(t);
    }
    col.type = joinType(typeToks);
    if (/^(small|big)?serial[248]?$/i.test(col.type)) col.increment = true;
    if (!col.type && j === 1) col.type = '';
    // constraints
    while (j < it.length) {
      const u = it[j].t === 'w' ? it[j].v.toUpperCase() : it[j].v;
      const W = (d) => (it[j + d] && it[j + d].t === 'w' ? it[j + d].v.toUpperCase() : '');
      if (u === 'CONSTRAINT') { j += 2; continue; }
      if (u === 'PRIMARY' && W(1) === 'KEY') { col.pk = true; j += 2; continue; }
      if (u === 'NOT' && W(1) === 'NULL') { col.notNull = true; j += 2; continue; }
      if (u === 'NULL') { col.nullable = true; j++; continue; }
      if (u === 'UNIQUE') { col.unique = true; j++; if (W(0) === 'KEY') j++; continue; }
      if (u === 'KEY') { j++; continue; }
      if (u === 'AUTO_INCREMENT' || u === 'AUTOINCREMENT') { col.increment = true; j++; continue; }
      if (u === 'IDENTITY') { col.increment = true; j++; if (it[j] && it[j].v === '(') j = skipGroup(it, j); continue; }
      if (u === 'GENERATED') {
        let e = j + 1; while (e < it.length && it[e].t === 'w' && /^(ALWAYS|BY|DEFAULT|AS)$/i.test(it[e].v)) e++;
        if (it[e] && it[e].t === 'w' && /^IDENTITY$/i.test(it[e].v)) { col.increment = true; j = e + 1; if (it[j] && it[j].v === '(') j = skipGroup(it, j); continue; }
        if (it[e] && it[e].v === '(') { const s = e; e = skipGroup(it, e); col.note = col.note || `Computed: ${it.slice(s, e).map(tokSql).join(' ')}`; j = e; continue; }
        j = e; continue;
      }
      if (u === 'AS' && it[j + 1] && it[j + 1].v === '(') { const s = j + 1; const e = skipGroup(it, j + 1); col.note = col.note || `Computed: ${it.slice(s, e).map(tokSql).join(' ')}`; j = e; continue; }
      if (u === 'DEFAULT') {
        j++;
        const s = j;
        let d = 0;
        while (j < it.length) {
          const t = it[j];
          if (d === 0 && t.t === 'w' && COL_STOP.has(t.v.toUpperCase()) && t.v.toUpperCase() !== 'NULL' && j > s) break;
          if (d === 0 && t.t === 'w' && t.v.toUpperCase() === 'NULL' && j > s) break;
          if (t.v === '(') d++;
          if (t.v === ')') d--;
          j++;
        }
        col.dflt = sqlDefault(it.slice(s, j));
        continue;
      }
      if (u === 'REFERENCES') {
        const qn = qname(it, j + 1);
        if (!qn) { j++; continue; }
        const cl = colList(it, qn.next);
        const r = { name: '', from: { table: table.key, columns: [col.name] }, to: { table: qn.parts.join('.'), columns: cl.cols.map((c) => c.name).filter(Boolean) }, rel: '>', onDelete: '', onUpdate: '', line: it[j].line, col: it[j].col, inline: true };
        j = actions(it, cl.next, r);
        if (model.refs.length < LIMITS.maxRefs) model.refs.push(r);
        continue;
      }
      if (u === 'CHECK') { j++; if (it[j] && it[j].v === '(') j = skipGroup(it, j); continue; }
      if (u === 'COMMENT') { const s = it[j + 1]; if (s && s.t === 's') col.note = s.v; j += 2; continue; }
      if (u === 'COLLATE' || u === 'CHARSET' || u === 'ENCODE' || u === 'COMPRESSION') { j += 2; continue; }
      if (u === 'CHARACTER' && W(1) === 'SET') { j += 3; continue; }
      if (u === 'ON' && W(1) === 'UPDATE') { j += 3; if (it[j] && it[j].v === '(') j = skipGroup(it, j); continue; }
      j++;
    }
    if (table.columns.length < LIMITS.maxColumns) table.columns.push(col);
  }

  function actions(it, j, r) {
    while (j < it.length) {
      const W = (d) => (it[j + d] && it[j + d].t === 'w' ? it[j + d].v.toUpperCase() : '');
      if (W(0) === 'ON' && (W(1) === 'DELETE' || W(1) === 'UPDATE')) {
        const which = W(1);
        let a = W(2);
        let step = 3;
        if ((a === 'SET' || a === 'NO') && W(3)) { a += ' ' + W(3); step = 4; }
        if (which === 'DELETE') r.onDelete = a.toLowerCase(); else r.onUpdate = a.toLowerCase();
        j += step; continue;
      }
      if (W(0) === 'MATCH' || W(0) === 'DEFERRABLE' || W(0) === 'INITIALLY' || W(0) === 'NOT' || W(0) === 'IMMEDIATE' || W(0) === 'DEFERRED' || W(0) === 'FULL' || W(0) === 'SIMPLE' || W(0) === 'PARTIAL' || W(0) === 'FOR' || W(0) === 'REPLICATION') { j++; continue; }
      break;
    }
    return j;
  }

  function tableConstraint(table, it) {
    let j = 0;
    let cname = '';
    const W = (d) => (it[j + d] && it[j + d].t === 'w' ? it[j + d].v.toUpperCase() : '');
    if (W(0) === 'CONSTRAINT') { cname = it[1] ? it[1].v : ''; j = 2; }
    const u = W(0);
    if (u === 'PRIMARY' && W(1) === 'KEY') {
      j += 2; while (W(0) === 'CLUSTERED' || W(0) === 'NONCLUSTERED' || W(0) === 'USING' || (it[j] && it[j].t === 'w' && it[j].v.toUpperCase() === 'BTREE')) j++;
      const cl = colList(it, j);
      for (const c of cl.cols) { const x = c.name && table.columns.find((y) => y.name.toLowerCase() === c.name.toLowerCase()); if (x) x.pk = true; }
      if (cl.cols.length > 1) table.indexes.push({ columns: cl.cols, pk: true, unique: false, name: cname, type: '', note: '' });
      return;
    }
    if (u === 'UNIQUE') {
      j++; if (W(0) === 'KEY' || W(0) === 'INDEX') j++;
      while (W(0) === 'CLUSTERED' || W(0) === 'NONCLUSTERED') j++;
      let iname = cname;
      if (it[j] && (it[j].t === 'w' || it[j].t === 'q') && !(it[j].v === '(')) { iname = iname || it[j].v; j++; }
      const cl = colList(it, j);
      if (cl.cols.length === 1 && cl.cols[0].name) { const x = table.columns.find((y) => y.name.toLowerCase() === cl.cols[0].name.toLowerCase()); if (x) x.unique = true; }
      else table.indexes.push({ columns: cl.cols, pk: false, unique: true, name: iname, type: '', note: '' });
      return;
    }
    if (u === 'FOREIGN' && W(1) === 'KEY') {
      j += 2;
      if (it[j] && (it[j].t === 'w' || it[j].t === 'q') && W(0) !== 'REFERENCES') j++; // MySQL: FOREIGN KEY name (cols)
      const cl = colList(it, j);
      j = cl.next;
      if (W(0) !== 'REFERENCES') { addError(model, it[0].line, it[0].col, 'FOREIGN KEY without REFERENCES.'); return; }
      const qn = qname(it, j + 1);
      if (!qn) return;
      const pl = colList(it, qn.next);
      const r = { name: cname, from: { table: table.key, columns: cl.cols.map((c) => c.name).filter(Boolean) }, to: { table: qn.parts.join('.'), columns: pl.cols.map((c) => c.name).filter(Boolean) }, rel: '>', onDelete: '', onUpdate: '', line: it[0].line, col: it[0].col, inline: false };
      actions(it, pl.next, r);
      if (model.refs.length < LIMITS.maxRefs) model.refs.push(r);
      return;
    }
    if (u === 'KEY' || u === 'INDEX' || u === 'FULLTEXT' || u === 'SPATIAL') {
      j++; if (W(0) === 'KEY' || W(0) === 'INDEX') j++;
      let iname = '';
      if (it[j] && (it[j].t === 'w' || it[j].t === 'q')) { iname = it[j].v; j++; }
      if (W(0) === 'USING') j += 2;
      const cl = colList(it, j);
      table.indexes.push({ columns: cl.cols, pk: false, unique: false, name: iname, type: u === 'FULLTEXT' || u === 'SPATIAL' ? u.toLowerCase() : '', note: '' });
      return;
    }
    // CHECK, EXCLUDE, PERIOD, LIKE: not part of the diagram
  }

  function createType(st, k) {
    const qn = qname(st, k);
    const W = (j) => (st[j] && st[j].t === 'w' ? st[j].v.toUpperCase() : '');
    if (!qn || W(qn.next) !== 'AS' || W(qn.next + 1) !== 'ENUM') { skip(st, 'CREATE TYPE (not an enum)'); return; }
    const g = st[qn.next + 2] && st[qn.next + 2].v === '(' ? group(st, qn.next + 2) : { items: [] };
    const { name, schema, key } = nameToKey(qn.parts);
    const values = g.items.map((x) => x.find((t) => t.t === 's')).filter(Boolean).slice(0, LIMITS.maxEnumValues).map((t) => ({ name: t.v, note: '' }));
    if (model.enums.length < LIMITS.maxEnums) model.enums.push({ key, name, schema, note: '', values, line: qn.tok.line, col: qn.tok.col, len: name.length });
  }

  function createIndex(st) {
    const W = (j) => (st[j] && st[j].t === 'w' ? st[j].v.toUpperCase() : '');
    let j = 1; let unique = false;
    if (W(j) === 'UNIQUE') { unique = true; j++; }
    let type = '';
    if (W(j) === 'CLUSTERED' || W(j) === 'NONCLUSTERED' || W(j) === 'BITMAP' || W(j) === 'FULLTEXT' || W(j) === 'SPATIAL') { if (W(j) === 'FULLTEXT' || W(j) === 'SPATIAL') type = W(j).toLowerCase(); j++; }
    j++; // INDEX
    if (W(j) === 'CONCURRENTLY') j++;
    if (W(j) === 'IF' && W(j + 1) === 'NOT' && W(j + 2) === 'EXISTS') j += 3;
    let iname = '';
    if (W(j) !== 'ON') { const qn = qname(st, j); if (qn) { iname = qn.parts[qn.parts.length - 1]; j = qn.next; } }
    if (W(j) !== 'ON') { skip(st, 'CREATE INDEX (no ON)'); return; }
    j++;
    if (W(j) === 'ONLY') j++;
    const qn = qname(st, j);
    if (!qn) { skip(st, 'CREATE INDEX (no table)'); return; }
    j = qn.next;
    if (W(j) === 'USING') { type = (st[j + 1] && st[j + 1].v || '').toLowerCase(); j += 2; }
    const cl = colList(st, j);
    const t = getTable(qn.parts);
    if (!t) { addSkipped(model, st[0].line, `index on ${qn.parts.join('.')} (table not in this file)`); return; }
    if (unique && cl.cols.length === 1 && cl.cols[0].name) { const c = t.columns.find((x) => x.name.toLowerCase() === cl.cols[0].name.toLowerCase()); if (c) c.unique = true; }
    t.indexes.push({ columns: cl.cols, pk: false, unique, name: iname, type, note: '' });
  }

  function alterTable(st) {
    const W = (j) => (st[j] && st[j].t === 'w' ? st[j].v.toUpperCase() : '');
    let j = 2;
    if (W(j) === 'ONLY') j++;
    if (W(j) === 'IF' && W(j + 1) === 'EXISTS') j += 2;
    const qn = qname(st, j);
    if (!qn) { skip(st); return; }
    j = qn.next;
    const t = getTable(qn.parts);
    // split actions at top-level commas
    const acts = [];
    let cur2 = [], depth = 0;
    for (; j < st.length; j++) {
      const x = st[j];
      if (x.v === '(') depth++;
      if (x.v === ')') depth--;
      if (depth === 0 && x.t === 'p' && x.v === ',') { acts.push(cur2); cur2 = []; continue; }
      cur2.push(x);
    }
    if (cur2.length) acts.push(cur2);
    for (let a of acts) {
      while (a.length && a[0].t === 'w' && /^(WITH|CHECK|NOCHECK)$/i.test(a[0].v) && a[1] && a[1].t === 'w' && /^(CHECK|NOCHECK|ADD)$/i.test(a[1].v)) a = a.slice(1);
      while (a.length && a[0].t === 'w' && /^(WITH|NOCHECK)$/i.test(a[0].v)) a = a.slice(1);
      if (!(a[0] && a[0].t === 'w' && a[0].v.toUpperCase() === 'ADD')) { addSkipped(model, (a[0] || st[0]).line, `ALTER TABLE ${qn.parts.join('.')} ${a.slice(0, 3).map((x) => x.v).join(' ')}`); continue; }
      let rest = a.slice(1);
      if (!t) { addSkipped(model, st[0].line, `ALTER TABLE ${qn.parts.join('.')} (table not in this file)`); continue; }
      const h = rest[0] && rest[0].t === 'w' ? rest[0].v.toUpperCase() : '';
      if (h === 'COLUMN') rest = rest.slice(1);
      if (h === 'CONSTRAINT' || TABLE_ITEM.has(h)) tableConstraint(t, rest);
      else {
        if (rest[0] && /^IF$/i.test(rest[0].v)) rest = rest.slice(3);
        column(t, rest);
      }
    }
  }

  function commentOn(st) {
    const W = (j) => (st[j] && st[j].t === 'w' ? st[j].v.toUpperCase() : '');
    const what = W(2);
    const qn = qname(st, 3);
    const isIdx = st.findIndex((x) => x.t === 'w' && x.v.toUpperCase() === 'IS');
    const s = isIdx > 0 ? st[isIdx + 1] : null;
    if (!qn || !s || s.t !== 's') { skip(st); return; }
    if (what === 'TABLE') { const t = getTable(qn.parts); if (t) t.note = s.v; return; }
    if (what === 'COLUMN') { const t = getTable(qn.parts.slice(0, -1)); const c = t && t.columns.find((x) => x.name.toLowerCase() === qn.parts[qn.parts.length - 1].toLowerCase()); if (c) c.note = s.v; return; }
    skip(st);
  }
}

function skipGroup(it, j) {
  let d = 0;
  for (; j < it.length; j++) { if (it[j].v === '(') d++; if (it[j].v === ')') { d--; if (d === 0) return j + 1; } }
  return j;
}

function tokSql(t) { return t.t === 's' ? `'${t.v.replace(/'/g, "''")}'` : t.t === 'q' ? `"${t.v}"` : t.v; }

function joinType(toks) {
  let s = '';
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const v = t.t === 's' ? `'${t.v}'` : t.v;
    if (k && t.t === 'w' && (toks[k - 1].t === 'w' || toks[k - 1].t === 'q' || toks[k - 1].v === ')')) s += ' ';
    s += v;
    if (t.v === ',') s += ' ';
  }
  return s.replace(/\s+/g, ' ').trim();
}

function sqlDefault(toks) {
  if (!toks.length) return null;
  if (toks.length === 1) {
    const t = toks[0];
    if (t.t === 's') return { kind: 'string', value: t.v };
    if (t.t === 'n') return { kind: 'number', value: t.v };
    const l = t.v.toLowerCase();
    if (l === 'true' || l === 'false') return { kind: 'bool', value: l };
    if (l === 'null') return { kind: 'null', value: 'null' };
    return { kind: 'expr', value: t.v };
  }
  if (toks.length === 2 && toks[0].v === '-' && toks[1].t === 'n') return { kind: 'number', value: '-' + toks[1].v };
  // ('x') or (0) in SQL Server dumps
  if (toks[0].v === '(' && toks[toks.length - 1].v === ')') {
    const inner = toks.slice(1, -1);
    if (inner.length && inner.every((t) => t.v === '(' || t.v === ')' || t === inner.find((x) => x.v !== '(' && x.v !== ')'))) return sqlDefault(inner.filter((t) => t.v !== '(' && t.v !== ')'));
  }
  // 'x'::type (PostgreSQL)
  if (toks[0].t === 's' && toks[1] && toks[1].v === ':') return { kind: 'string', value: toks[0].v };
  return { kind: 'expr', value: joinType(toks).replace(/ \(/g, '(').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/ ?: ?: ?/g, '::') };
}

module.exports = { parseSql, tokenize };
