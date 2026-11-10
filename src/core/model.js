'use strict';
// The schema model shared by the DBML, SQL and Prisma readers, the diagram, the exports and the diff.
//
// model = {
//   kind: 'dbml' | 'sql' | 'prisma',
//   project: { name, databaseType, note } | null,
//   tables: [{ key, name, schema, alias, note, headerColor, group, line, col, len, partial?,
//              columns: [{ name, type, pk, increment, unique, notNull, nullable, dflt, note, line, col, len, enumRef? }],
//              indexes: [{ columns: [{ name, expr }], pk, unique, name, type, note }] }],
//   refs: [{ name, from: { table, columns }, to: { table, columns }, rel: '>'|'<'|'-'|'<>', onDelete, onUpdate, line, col, inline }],
//   enums: [{ key, name, schema, note, values: [{ name, note }], line, col, len }],
//   groups: [{ name, tables: [key], color, note, line }],
//   notes: [{ name, text, line, headerColor }],
//   errors: [{ line, col, message }],      // 1-based, at most MAX_ERRORS
//   skipped: [{ line, what }],             // statements or blocks the reader does not know (not errors)
//   truncated: '' | message
// }
// Table and enum keys are "schema.name" when a schema other than the default is given, else "name".

const LIMITS = {
  maxText: 8 * 1024 * 1024,   // characters
  maxTokens: 3000000,
  maxTables: 10000,
  maxColumns: 2000,           // per table
  maxRefs: 50000,
  maxEnums: 5000,
  maxEnumValues: 2000,
  maxErrors: 200,
  maxSkipped: 500,
  maxStringLen: 200000,
};

const DEFAULT_SCHEMAS = new Set(['public', 'dbo', 'main']);

function emptyModel(kind) {
  return { kind, project: null, tables: [], refs: [], enums: [], groups: [], notes: [], errors: [], skipped: [], truncated: '' };
}

function tableKey(schema, name) {
  return schema && !DEFAULT_SCHEMAS.has(String(schema).toLowerCase()) ? `${schema}.${name}` : String(name);
}

/** Find a table by a written name (with or without schema, or an alias). Case-sensitive first, then insensitive. */
function makeResolver(model) {
  const exact = new Map();
  const lower = new Map();
  const byName = new Map();
  const inDefault = new Map(); // tables with no schema or the default one, by lower-case name
  for (const t of model.tables) if ((!t.schema || DEFAULT_SCHEMAS.has(String(t.schema).toLowerCase())) && !inDefault.has(t.name.toLowerCase())) inDefault.set(t.name.toLowerCase(), t);
  const add = (k, t) => { if (!exact.has(k)) exact.set(k, t); const l = k.toLowerCase(); if (!lower.has(l)) lower.set(l, t); };
  for (const t of model.tables) {
    add(t.key, t);
    if (t.schema) add(`${t.schema}.${t.name}`, t);
    if (t.alias) add(t.alias, t);
    const n = t.name.toLowerCase();
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(t);
  }
  return (written) => {
    if (!written) return null;
    const w = String(written);
    if (exact.has(w)) return exact.get(w);
    if (lower.has(w.toLowerCase())) return lower.get(w.toLowerCase());
    const m = /^"?(public|dbo|main)"?\.(.+)$/i.exec(w); // the default schema written out: public.users = users
    if (m && !m[2].includes('.')) { const t = inDefault.get(m[2].replace(/^"|"$/g, '').toLowerCase()); if (t) return t; }
    const dot = w.lastIndexOf('.');
    const bare = (dot >= 0 ? w.slice(dot + 1) : w).toLowerCase();
    const list = byName.get(bare);
    return list && list.length === 1 ? list[0] : null;
  };
}

/** After reading: resolve ref endpoints to table keys, drop refs to unknown tables (with an error), mark FK columns. */
function finish(model, opts = {}) {
  const resolve = makeResolver(model);
  const out = [];
  for (const r of model.refs) {
    const a = resolve(r.from.table), b = resolve(r.to.table);
    if (!a || !b) {
      const missing = !a ? r.from.table : r.to.table;
      if (opts.unknownRefIsError !== false) addError(model, r.line, r.col, `Ref to an unknown table "${missing}".`);
      else addSkipped(model, r.line, `reference to ${missing} (table not in this file)`);
      continue;
    }
    r.from.table = a.key; r.to.table = b.key;
    for (const [end, t] of [[r.from, a], [r.to, b]]) {
      for (const c of end.columns) {
        if (!t.columns.some((x) => x.name === c) && !t.columns.some((x) => x.name.toLowerCase() === String(c).toLowerCase())) {
          if (opts.unknownColumnIsError !== false) addError(model, r.line, r.col, `Column "${c}" is not in table "${t.key}".`);
        }
      }
      end.columns = end.columns.map((c) => (t.columns.find((x) => x.name === c) || t.columns.find((x) => x.name.toLowerCase() === String(c).toLowerCase()) || { name: c }).name);
    }
    out.push(r);
  }
  model.refs = out;
  // FK markers: the "many" side of > and <, the first side of a one-to-one
  const byKey = new Map(model.tables.map((t) => [t.key, t]));
  for (const r of model.refs) {
    const fkEnd = r.rel === '<' ? r.to : r.rel === '<>' ? null : r.from;
    if (!fkEnd) continue;
    const t = byKey.get(fkEnd.table);
    for (const c of fkEnd.columns) { const col = t && t.columns.find((x) => x.name === c); if (col) col.fk = true; }
  }
  // enum types used by columns
  const enumKeys = new Map();
  for (const e of model.enums) { enumKeys.set(e.key.toLowerCase(), e.key); enumKeys.set(e.name.toLowerCase(), e.key); }
  for (const t of model.tables) for (const c of t.columns) {
    const base = String(c.type || '').replace(/\[\]$/, '').replace(/^"|"$/g, '').toLowerCase();
    if (enumKeys.has(base)) c.enumRef = enumKeys.get(base);
  }
  // groups: resolve names to keys
  for (const g of model.groups) {
    const keys = [];
    for (const n of g.tables) {
      const t = resolve(n);
      if (!t) { addError(model, g.line, 1, `TableGroup "${g.name}" names an unknown table "${n}".`); continue; }
      if (!keys.includes(t.key)) keys.push(t.key);
      if (!t.group) t.group = g.name;
    }
    g.tables = keys;
  }
  return model;
}

function addError(model, line, col, message) {
  if (model.errors.length < LIMITS.maxErrors) model.errors.push({ line: line || 1, col: col || 1, message });
  else if (model.errors.length === LIMITS.maxErrors) model.errors.push({ line: line || 1, col: col || 1, message: 'More errors follow; only the first 200 are listed.' });
}

function addSkipped(model, line, what) {
  if (model.skipped.length < LIMITS.maxSkipped) model.skipped.push({ line: line || 1, what });
}

/** A short summary for the status line: "12 tables, 14 relations, 2 enums". */
function summary(model) {
  const p = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
  const parts = [p(model.tables.length, 'table'), p(model.refs.length, 'relation')];
  if (model.enums.length) parts.push(p(model.enums.length, 'enum'));
  return parts.join(', ');
}

module.exports = { LIMITS, DEFAULT_SCHEMAS, emptyModel, tableKey, makeResolver, finish, addError, addSkipped, summary };
