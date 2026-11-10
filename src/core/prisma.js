'use strict';
// Prisma schema reader for the ER diagram: model (scalar fields, @id, @@id, @unique, @@unique, @@index, @default,
// @db.* types, optional and list types, /// doc comments as notes), @relation(fields, references, onDelete,
// onUpdate) and enum. Relation fields themselves are not columns. datasource, generator, view and type blocks are
// skipped. Line based, bounded by the line count.
const { LIMITS, emptyModel, finish, addError, addSkipped } = require('./model');

const SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes', 'Unsupported']);

function stripComment(line) {
  let q = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === '"' && line[k - 1] !== '\\') q = !q;
    if (!q && c === '/' && line[k + 1] === '/') return line.slice(0, k);
  }
  return line;
}

/** @attr(args) list of a field line: [{ name, args }] with args as raw text */
function attrs(s) {
  const out = [];
  const re = /@{1,2}([\w.]+)/g;
  let m;
  let guard = 0;
  while ((m = re.exec(s)) && guard++ < 50) {
    let args = '';
    let k = m.index + m[0].length;
    if (s[k] === '(') {
      let d = 0, q = false, j = k;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === '"' && s[j - 1] !== '\\') q = !q;
        if (q) continue;
        if (c === '(') d++;
        if (c === ')') { d--; if (d === 0) break; }
      }
      args = s.slice(k + 1, j);
      re.lastIndex = j + 1;
    }
    out.push({ name: m[1], args });
  }
  return out;
}
const listArg = (args, key) => { const m = new RegExp(`${key ? key + '\\s*:\\s*' : '^\\s*'}\\[([^\\]]*)\\]`).exec(args); return m ? m[1].split(',').map((x) => x.trim().replace(/\(.*$/, '')).filter(Boolean) : null; };
const namedArg = (args, key) => { const m = new RegExp(`${key}\\s*:\\s*("([^"]*)"|[\\w.]+)`).exec(args); return m ? (m[2] !== undefined ? m[2] : m[1]) : ''; };

function parsePrisma(text) {
  const model = emptyModel('prisma');
  text = String(text == null ? '' : text);
  if (text.length > LIMITS.maxText) { model.truncated = `The file has ${text.length.toLocaleString('en-US')} characters; the first ${LIMITS.maxText.toLocaleString('en-US')} are read.`; text = text.slice(0, LIMITS.maxText); }
  const lines = text.split(/\r?\n/);
  const models = [];
  let cur = null, doc = [];
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const ln = n + 1;
    const t = raw.trim();
    if (t.startsWith('///')) { doc.push(t.slice(3).trim()); continue; }
    const s = stripComment(raw).trim();
    if (!s) { if (!t.startsWith('//')) doc = []; continue; }
    if (!cur) {
      const m = /^(model|enum|view|type|datasource|generator)\s+(\w+)\s*\{\s*(\})?$/.exec(s);
      if (!m) { addError(model, ln, 1, `Expected model, enum, datasource or generator, found "${s.slice(0, 40)}".`); doc = []; continue; }
      cur = { kind: m[1], name: m[2], line: ln, col: raw.indexOf(m[2]) + 1, fields: [], block: [], note: doc.join('\n') };
      doc = [];
      if (m[3]) { if (cur.kind === 'model') models.push(cur); cur = null; }
      continue;
    }
    if (s === '}') {
      if (cur.kind === 'model') models.push(cur);
      else if (cur.kind === 'enum') {
        if (model.enums.length < LIMITS.maxEnums) model.enums.push({ key: cur.name, name: cur.name, schema: '', note: cur.note, values: cur.fields.slice(0, LIMITS.maxEnumValues).map((f) => ({ name: f.name, note: f.note })), line: cur.line, col: cur.col, len: cur.name.length });
      } else if (cur.kind === 'datasource') {
        const p = cur.block.find((b) => /^provider\s*=/.test(b));
        if (p) model.project = { name: '', databaseType: (/"([^"]*)"/.exec(p) || [])[1] || '', note: '' };
      } else addSkipped(model, cur.line, `${cur.kind} ${cur.name}`);
      cur = null; doc = [];
      continue;
    }
    if (cur.kind === 'enum') {
      const m = /^(\w+)/.exec(s);
      if (m) cur.fields.push({ name: m[1], note: doc.join('\n') });
      doc = [];
      continue;
    }
    if (cur.kind !== 'model') { cur.block.push(s); continue; }
    if (s.startsWith('@@')) { cur.block.push({ s, line: ln }); doc = []; continue; }
    const m = /^(\w+)\s+([\w.]+)(\[\])?(\?)?\s*(.*)$/.exec(s);
    if (!m) { addError(model, ln, 1, `Expected a field in model ${cur.name}, found "${s.slice(0, 40)}".`); doc = []; continue; }
    if (cur.fields.length < LIMITS.maxColumns) cur.fields.push({ name: m[1], type: m[2], list: !!m[3], optional: !!m[4], attrs: attrs(m[5] || ''), line: ln, col: raw.indexOf(m[1]) + 1, note: doc.join('\n') });
    doc = [];
  }
  if (cur) { addError(model, cur.line, 1, `${cur.kind} ${cur.name} has no closing }.`); if (cur.kind === 'model') models.push(cur); }
  const modelNames = new Set(models.map((m) => m.name));
  const enumNames = new Set(model.enums.map((e) => e.name));
  for (const md of models.slice(0, LIMITS.maxTables)) {
    const table = { key: md.name, name: md.name, schema: '', alias: '', note: md.note, headerColor: '', group: '', line: md.line, col: md.col, len: md.name.length, columns: [], indexes: [] };
    for (const f of md.fields) {
      if (modelNames.has(f.type)) continue; // relation field
      const at = (n) => f.attrs.find((a) => a.name === n);
      const dbt = f.attrs.find((a) => a.name.startsWith('db.'));
      const type = (dbt ? dbt.name.slice(3) + (dbt.args ? `(${dbt.args})` : '') : f.type) + (f.list ? '[]' : '');
      const d = at('default');
      let dflt = null, increment = false;
      if (d) {
        const v = d.args.trim();
        if (/^autoincrement\(\)$/.test(v)) increment = true;
        else if (/^".*"$/.test(v)) dflt = { kind: 'string', value: v.slice(1, -1) };
        else if (/^-?\d+(\.\d+)?$/.test(v)) dflt = { kind: 'number', value: v };
        else if (v === 'true' || v === 'false') dflt = { kind: 'bool', value: v };
        else dflt = { kind: 'expr', value: v };
      }
      if (!SCALARS.has(f.type) && !enumNames.has(f.type) && !/^Unsupported/.test(f.type)) addError(model, f.line, f.col, `Unknown type "${f.type}" for field ${md.name}.${f.name}.`);
      table.columns.push({ name: f.name, type, pk: !!at('id'), increment, unique: !!at('unique'), notNull: !f.optional && !f.list, nullable: f.optional, dflt, note: f.note, line: f.line, col: f.col, len: f.name.length });
    }
    for (const b of md.block) {
      const a = attrs(b.s)[0];
      if (!a) continue;
      const cols = listArg(a.args, 'fields') || listArg(a.args, '');
      if (a.name === 'id' && cols) { for (const c of cols) { const x = table.columns.find((y) => y.name === c); if (x) x.pk = true; } if (cols.length > 1) table.indexes.push({ columns: cols.map((name) => ({ name })), pk: true, unique: false, name: namedArg(a.args, 'name'), type: '', note: '' }); }
      else if ((a.name === 'unique' || a.name === 'index') && cols) table.indexes.push({ columns: cols.map((name) => ({ name })), pk: false, unique: a.name === 'unique', name: namedArg(a.args, 'name') || namedArg(a.args, 'map'), type: namedArg(a.args, 'type'), note: '' });
      else if (a.name === 'map') table.note = table.note ? `${table.note}\nTable: ${(/"([^"]*)"/.exec(a.args) || [])[1] || ''}` : `Table: ${(/"([^"]*)"/.exec(a.args) || [])[1] || ''}`;
    }
    model.tables.push(table);
  }
  // relations: the side with fields/references holds the foreign key
  for (const md of models) {
    for (const f of md.fields) {
      if (!modelNames.has(f.type)) continue;
      const rel = f.attrs.find((a) => a.name === 'relation');
      if (!rel) continue;
      const fields = listArg(rel.args, 'fields'), refs = listArg(rel.args, 'references');
      if (!fields || !refs) continue;
      const t = model.tables.find((x) => x.key === md.name);
      const unique = fields.length === 1 && t && t.columns.find((c) => c.name === fields[0] && (c.unique || c.pk));
      const r = { name: namedArg(rel.args, 'name') || ((/^\s*"([^"]*)"/.exec(rel.args) || [])[1] || ''), from: { table: md.name, columns: fields }, to: { table: f.type, columns: refs }, rel: unique ? '-' : '>', onDelete: namedArg(rel.args, 'onDelete').toLowerCase().replace(/^setnull$/, 'set null').replace(/^setdefault$/, 'set default').replace(/^noaction$/, 'no action'), onUpdate: namedArg(rel.args, 'onUpdate').toLowerCase().replace(/^setnull$/, 'set null').replace(/^setdefault$/, 'set default').replace(/^noaction$/, 'no action'), line: f.line, col: f.col, inline: true };
      if (model.refs.length < LIMITS.maxRefs) model.refs.push(r);
    }
  }
  // implicit many-to-many: two list fields pointing at each other with no fields/references
  const seen = new Set();
  for (const md of models) {
    for (const f of md.fields) {
      if (!f.list || !modelNames.has(f.type) || f.attrs.some((a) => a.name === 'relation' && /fields\s*:/.test(a.args))) continue;
      const other = models.find((x) => x.name === f.type);
      const back = other && other.fields.find((g) => g.list && g.type === md.name);
      const key = [md.name, f.type].sort().join('|');
      if (!back || seen.has(key) || md.name === f.type) continue;
      seen.add(key);
      const pkA = (model.tables.find((t) => t.key === md.name) || { columns: [] }).columns.filter((c) => c.pk).map((c) => c.name);
      const pkB = (model.tables.find((t) => t.key === f.type) || { columns: [] }).columns.filter((c) => c.pk).map((c) => c.name);
      if (pkA.length === 1 && pkB.length === 1) model.refs.push({ name: '', from: { table: md.name, columns: pkA }, to: { table: f.type, columns: pkB }, rel: '<>', onDelete: '', onUpdate: '', line: f.line, col: f.col, inline: true });
    }
  }
  return finish(model);
}

module.exports = { parsePrisma };
