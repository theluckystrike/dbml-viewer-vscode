'use strict';
// Writers: CREATE TABLE scripts for PostgreSQL, MySQL, SQL Server and SQLite; DBML from any model; a Markdown data
// dictionary. Pure functions over the schema model.

const DIALECTS = {
  postgres: { label: 'PostgreSQL', q: (s) => `"${String(s).replace(/"/g, '""')}"` },
  mysql: { label: 'MySQL', q: (s) => `\`${String(s).replace(/`/g, '``')}\`` },
  mssql: { label: 'SQL Server', q: (s) => `[${String(s).replace(/]/g, ']]')}]` },
  sqlite: { label: 'SQLite', q: (s) => `"${String(s).replace(/"/g, '""')}"` },
};

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const plainName = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

function qTable(D, t) { return t.schema && !/^(public|dbo|main)$/i.test(t.schema) ? `${D.q(t.schema)}.${D.q(t.name)}` : D.q(t.name); }
function qKey(D, model, key) { const t = model.tables.find((x) => x.key === key); return t ? qTable(D, t) : D.q(key); }
function slug(s) { return String(s).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'x'; }

function mapType(type, dialect, c) {
  let t = String(type || '').trim() || 'text';
  const low = t.toLowerCase();
  if (dialect === 'postgres') {
    if (c && c.increment) { if (/^(bigint|int8|bigserial)$/.test(low)) return 'bigserial'; if (/^(smallint|int2|smallserial)$/.test(low)) return 'smallserial'; if (/^(int|integer|int4|serial)$/.test(low)) return 'serial'; }
    if (low === 'datetime') return 'timestamp';
    if (/^(nvarchar|nchar)/.test(low)) return t.replace(/^n/i, '');
    if (low === 'tinyint') return 'smallint';
    if (low === 'double') return 'double precision';
    return t;
  }
  if (dialect === 'mysql') {
    if (/^(big|small)?serial$/.test(low)) return low.startsWith('big') ? 'bigint' : low.startsWith('small') ? 'smallint' : 'int';
    if (low === 'timestamptz' || /^timestamp with/.test(low)) return 'timestamp';
    if (low === 'boolean' || low === 'bool') return 'tinyint(1)';
    if (low === 'uuid') return 'char(36)';
    if (low === 'jsonb') return 'json';
    if (low === 'bytea') return 'blob';
    if (/\[\]$/.test(low)) return 'json';
    if (/^double precision$/.test(low)) return 'double';
    return t;
  }
  if (dialect === 'mssql') {
    if (/^(big|small)?serial$/.test(low)) return low.startsWith('big') ? 'bigint' : low.startsWith('small') ? 'smallint' : 'int';
    if (low === 'timestamptz' || /^timestamp with/.test(low)) return 'datetimeoffset';
    if (low === 'timestamp' || low === 'datetime') return 'datetime2';
    if (low === 'boolean' || low === 'bool') return 'bit';
    if (low === 'uuid') return 'uniqueidentifier';
    if (low === 'text' || low === 'json' || low === 'jsonb' || /\[\]$/.test(low)) return 'nvarchar(max)';
    if (low === 'bytea' || low === 'blob') return 'varbinary(max)';
    if (low === 'double' || low === 'double precision') return 'float';
    return t;
  }
  // sqlite: type affinity, keep the written type when it is a plain word
  if (/^(big|small)?serial$/.test(low)) return 'INTEGER';
  if (c && c.increment && c.pk) return 'INTEGER';
  if (/\[\]$/.test(low)) return 'TEXT';
  return t;
}

function dflt(d, dialect) {
  if (!d) return '';
  if (d.kind === 'string') return sqlStr(d.value);
  if (d.kind === 'number') return String(d.value);
  if (d.kind === 'bool') return dialect === 'mssql' || dialect === 'mysql' || dialect === 'sqlite' ? (d.value === 'true' ? '1' : '0') : d.value.toUpperCase();
  if (d.kind === 'null') return 'NULL';
  if (d.kind === 'expr') return dialect === 'sqlite' && !/^[A-Za-z_]+$/.test(d.value) ? `(${d.value})` : d.value;
  return String(d.value);
}

/** CREATE scripts. Returns the SQL text. */
function toSql(model, dialect = 'postgres') {
  const D = DIALECTS[dialect] || DIALECTS.postgres;
  const out = [];
  out.push(`-- ${D.label} schema written by DBML Viewer & ER Diagram from ${model.kind === 'sql' ? 'SQL' : model.kind === 'prisma' ? 'a Prisma schema' : 'DBML'}`);
  if (model.project && model.project.name) out.push(`-- Project: ${model.project.name.replace(/\n/g, ' ')}`);
  out.push('');
  const enumByKey = new Map(model.enums.map((e) => [e.key, e]));
  if (dialect === 'postgres') {
    const schemas = new Set(model.tables.map((t) => t.schema).concat(model.enums.map((e) => e.schema)).filter((s) => s && !/^(public)$/i.test(s)));
    for (const s of schemas) out.push(`CREATE SCHEMA IF NOT EXISTS ${D.q(s)};`);
    if (schemas.size) out.push('');
    for (const e of model.enums) out.push(`CREATE TYPE ${qTable(D, e)} AS ENUM (${e.values.map((v) => sqlStr(v.name)).join(', ')});`);
    if (model.enums.length) out.push('');
  }
  const after = [];
  const comments = [];
  const tables = model.tables;
  // one-to-one: the foreign key columns must be unique in SQL, or the relation reads back as many-to-one
  const uniqueCols = new Set(); // "tableKey\u0000col" for single columns
  const uniqueSets = []; // { table, columns } for composite keys
  for (const r of model.refs) {
    if (r.rel !== '-') continue;
    const fk = fkSide(r);
    const t = tables.find((x) => x.key === fk.child.table);
    if (!t) continue;
    const cols = fk.child.columns;
    const lc = cols.map((c) => String(c).toLowerCase());
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name.toLowerCase());
    const already = (lc.length === 1 && t.columns.some((c) => c.name.toLowerCase() === lc[0] && (c.unique || (c.pk && pk.length === 1))))
      || t.indexes.some((ix) => (ix.unique || ix.pk) && ix.columns.length === lc.length && ix.columns.every((c) => c.name && lc.includes(c.name.toLowerCase())))
      || (pk.length === lc.length && pk.every((c) => lc.includes(c)));
    if (already) continue;
    if (cols.length === 1) uniqueCols.add(`${t.key}\u0000${cols[0]}`);
    else uniqueSets.push({ table: t, columns: cols });
  }
  const usedNames = new Set(tables.map((t) => String(t.name).toLowerCase()));
  for (const t of tables) {
    const lines = [];
    const pkCols = t.columns.filter((c) => c.pk);
    const compositePk = t.indexes.find((ix) => ix.pk && ix.columns.length > 1);
    const pkList = compositePk ? compositePk.columns.map((c) => c.name).filter(Boolean) : pkCols.map((c) => c.name);
    const inlinePk = pkList.length === 1;
    for (const c of t.columns) {
      const en = c.enumRef ? enumByKey.get(c.enumRef) : null;
      let type = mapType(c.type, dialect, c);
      let check = '';
      if (en && dialect !== 'postgres') {
        if (dialect === 'mysql') type = `ENUM(${en.values.map((v) => sqlStr(v.name)).join(', ')})`;
        else { type = dialect === 'mssql' ? 'nvarchar(255)' : 'TEXT'; check = ` CHECK (${D.q(c.name)} IN (${en.values.map((v) => sqlStr(v.name)).join(', ')}))`; }
      } else if (en) type = qTable(D, en);
      let s = `  ${D.q(c.name)} ${type}`;
      if (c.increment) {
        if (dialect === 'mysql') s += ' AUTO_INCREMENT';
        else if (dialect === 'mssql') s += ' IDENTITY(1,1)';
      }
      if (inlinePk && pkList[0] === c.name) {
        s += ' PRIMARY KEY';
        if (dialect === 'sqlite' && c.increment) s += ' AUTOINCREMENT';
      }
      if (c.notNull && !(inlinePk && pkList[0] === c.name)) s += ' NOT NULL';
      if ((c.unique && !c.pk) || uniqueCols.has(`${t.key}\u0000${c.name}`)) s += ' UNIQUE';
      if (c.dflt) s += ` DEFAULT ${dflt(c.dflt, dialect)}`;
      s += check;
      if (c.note && dialect === 'mysql') s += ` COMMENT ${sqlStr(c.note)}`;
      lines.push(s);
      if (c.note && dialect === 'postgres') comments.push(`COMMENT ON COLUMN ${qTable(D, t)}.${D.q(c.name)} IS ${sqlStr(c.note)};`);
    }
    if (pkList.length > 1) lines.push(`  PRIMARY KEY (${pkList.map(D.q).join(', ')})`);
    // SQLite has no ALTER TABLE ADD CONSTRAINT: foreign keys go inside CREATE TABLE
    if (dialect === 'sqlite') {
      for (const r of model.refs) {
        const fk = fkSide(r);
        if (!fk || fk.child.table !== t.key) continue;
        lines.push(`  FOREIGN KEY (${fk.child.columns.map(D.q).join(', ')}) REFERENCES ${qKey(D, model, fk.parent.table)} (${fk.parent.columns.map(D.q).join(', ')})${actions(r)}`);
      }
    }
    let head = `CREATE TABLE ${qTable(D, t)} (\n${lines.join(',\n')}\n)`;
    if (dialect === 'mysql' && t.note) head += ` COMMENT=${sqlStr(t.note)}`;
    out.push(head + ';');
    if (t.note && dialect === 'postgres') comments.push(`COMMENT ON TABLE ${qTable(D, t)} IS ${sqlStr(t.note)};`);
    if (t.note && (dialect === 'mssql' || dialect === 'sqlite')) out.push(`-- ${qTable(D, t)}: ${t.note.replace(/\n/g, ' ')}`);
    out.push('');
    t.indexes.forEach((ix, n) => {
      if (ix.pk) return;
      const cols = ix.columns.map((c) => (c.name ? D.q(c.name) : dialect === 'mysql' ? `(${c.expr})` : c.expr));
      if (!cols.length) return;
      const name = ix.name || `${slug(t.name)}_${ix.columns.map((c) => slug(c.name || 'expr')).join('_')}_idx${n ? n : ''}`;
      const using = ix.type && dialect === 'postgres' && /^(hash|btree|gin|gist|brin|spgist)$/i.test(ix.type) ? ` USING ${ix.type.toUpperCase()}` : '';
      after.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${D.q(name)} ON ${qTable(D, t)}${using} (${cols.join(', ')});`);
    });
  }
  for (const u of uniqueSets) after.push(`CREATE UNIQUE INDEX ${D.q(`${slug(u.table.name)}_${u.columns.map(slug).join('_')}_one_to_one`)} ON ${qTable(D, u.table)} (${u.columns.map(D.q).join(', ')});`);
  // many-to-many: a junction table
  for (const r of model.refs) {
    if (r.rel !== '<>') continue;
    const a = model.tables.find((x) => x.key === r.from.table), b = model.tables.find((x) => x.key === r.to.table);
    if (!a || !b) continue;
    let jt = `${slug(a.name)}_${slug(b.name)}`;
    for (let k = 2; usedNames.has(jt.toLowerCase()); k++) jt = `${slug(a.name)}_${slug(b.name)}_${k}`;
    usedNames.add(jt.toLowerCase());
    const ca = r.from.columns.map((c) => ({ n: `${slug(a.name)}_${slug(c)}`, src: c, t: (a.columns.find((x) => x.name === c) || {}).type }));
    const cb = r.to.columns.map((c) => ({ n: `${slug(b.name)}_${slug(c)}`, src: c, t: (b.columns.find((x) => x.name === c) || {}).type }));
    for (const c of cb) if (ca.some((x) => x.n === c.n)) c.n += '_2'; // a table related to itself
    const cols = [...ca, ...cb].map((c) => `  ${D.q(c.n)} ${mapType(c.t, dialect, null)} NOT NULL`);
    cols.push(`  PRIMARY KEY (${[...ca, ...cb].map((c) => D.q(c.n)).join(', ')})`);
    if (dialect === 'sqlite') {
      cols.push(`  FOREIGN KEY (${ca.map((c) => D.q(c.n)).join(', ')}) REFERENCES ${qTable(D, a)} (${ca.map((c) => D.q(c.src)).join(', ')})`);
      cols.push(`  FOREIGN KEY (${cb.map((c) => D.q(c.n)).join(', ')}) REFERENCES ${qTable(D, b)} (${cb.map((c) => D.q(c.src)).join(', ')})`);
    } else {
      after.push(`ALTER TABLE ${D.q(jt)} ADD FOREIGN KEY (${ca.map((c) => D.q(c.n)).join(', ')}) REFERENCES ${qTable(D, a)} (${ca.map((c) => D.q(c.src)).join(', ')});`);
      after.push(`ALTER TABLE ${D.q(jt)} ADD FOREIGN KEY (${cb.map((c) => D.q(c.n)).join(', ')}) REFERENCES ${qTable(D, b)} (${cb.map((c) => D.q(c.src)).join(', ')});`);
    }
    out.push(`-- many-to-many ${a.name} <> ${b.name}`);
    out.push(`CREATE TABLE ${D.q(jt)} (\n${cols.join(',\n')}\n);`, '');
  }
  if (dialect !== 'sqlite') {
    for (const r of model.refs) {
      const fk = fkSide(r);
      if (!fk) continue;
      const name = r.name || `fk_${slug(model.tables.find((x) => x.key === fk.child.table)?.name || fk.child.table)}_${fk.child.columns.map(slug).join('_')}`;
      after.push(`ALTER TABLE ${qKey(D, model, fk.child.table)} ADD CONSTRAINT ${D.q(name)} FOREIGN KEY (${fk.child.columns.map(D.q).join(', ')}) REFERENCES ${qKey(D, model, fk.parent.table)} (${fk.parent.columns.map(D.q).join(', ')})${actions(r)};`);
    }
  }
  if (after.length) out.push(...after, '');
  if (comments.length) out.push(...comments, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The table that holds the foreign key (child) and the one it points at (parent). n-n: null. */
function fkSide(r) {
  if (r.rel === '<>') return null;
  if (r.rel === '<') return { child: r.to, parent: r.from };
  return { child: r.from, parent: r.to };
}

function actions(r) {
  let s = '';
  const ok = (a) => /^(cascade|restrict|set null|set default|no action)$/i.test(a);
  if (r.onDelete && ok(r.onDelete)) s += ` ON DELETE ${r.onDelete.toUpperCase()}`;
  if (r.onUpdate && ok(r.onUpdate)) s += ` ON UPDATE ${r.onUpdate.toUpperCase()}`;
  return s;
}

// ---------------- DBML ----------------
const dName = (s) => (plainName(s) ? s : `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
const dStr = (s) => (String(s).includes('\n') ? `'''${String(s).replace(/'''/g, "\\'''")}'''` : `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
function dTable(t) { return t.schema && !/^(public|dbo|main)$/i.test(t.schema) ? `${dName(t.schema)}.${dName(t.name)}` : dName(t.name); }
function dType(type) {
  const t = String(type || 'text').trim() || 'text';
  return /^[A-Za-z_][\w.]*(\([\w\s,']*\))?(\[\])?$/.test(t) ? t.replace(/\s+/g, ' ').replace(/, /g, ',') : `"${t.replace(/"/g, '\\"')}"`;
}
function dDefault(d) {
  if (!d) return '';
  if (d.kind === 'string') return dStr(d.value);
  if (d.kind === 'number') return d.value;
  if (d.kind === 'bool' || d.kind === 'null') return d.value;
  return `\`${String(d.value).replace(/`/g, '\\`')}\``;
}

function toDbml(model) {
  const out = [];
  if (model.project && (model.project.name || model.project.databaseType)) {
    out.push(`Project ${dName(model.project.name || 'schema')} {`);
    if (model.project.databaseType) out.push(`  database_type: ${dStr(model.project.databaseType)}`);
    if (model.project.note) out.push(`  Note: ${dStr(model.project.note)}`);
    out.push('}', '');
  }
  for (const e of model.enums) {
    out.push(`Enum ${dTable(e)} {`);
    for (const v of e.values) out.push(`  ${dName(v.name)}${v.note ? ` [note: ${dStr(v.note)}]` : ''}`);
    out.push('}', '');
  }
  for (const t of model.tables) {
    const ts = [];
    if (t.headerColor) ts.push(`headercolor: ${t.headerColor}`);
    out.push(`Table ${dTable(t)}${t.alias ? ` as ${dName(t.alias)}` : ''}${ts.length ? ` [${ts.join(', ')}]` : ''} {`);
    const compositePk = t.indexes.some((ix) => ix.pk && ix.columns.length > 1);
    for (const c of t.columns) {
      const s = [];
      if (c.pk && !compositePk) s.push('pk');
      if (c.increment) s.push('increment');
      if (c.unique && !c.pk) s.push('unique');
      if (c.notNull && !c.pk) s.push('not null');
      if (c.dflt) s.push(`default: ${dDefault(c.dflt)}`);
      if (c.note) s.push(`note: ${dStr(c.note)}`);
      const type = c.enumRef ? (model.enums.find((e) => e.key === c.enumRef) ? dTable(model.enums.find((e) => e.key === c.enumRef)) : dType(c.type)) : dType(c.type);
      out.push(`  ${dName(c.name)} ${type}${s.length ? ` [${s.join(', ')}]` : ''}`);
    }
    if (t.indexes.length) {
      out.push('', '  indexes {');
      for (const ix of t.indexes) {
        const cols = ix.columns.map((c) => (c.name ? dName(c.name) : `\`${c.expr}\``));
        if (!cols.length) continue;
        const s = [];
        if (ix.pk) s.push('pk');
        if (ix.unique) s.push('unique');
        if (ix.name) s.push(`name: ${dStr(ix.name)}`);
        if (ix.type) s.push(`type: ${/^\w+$/.test(ix.type) ? ix.type : dStr(ix.type)}`);
        if (ix.note) s.push(`note: ${dStr(ix.note)}`);
        out.push(`    ${cols.length > 1 ? `(${cols.join(', ')})` : cols[0]}${s.length ? ` [${s.join(', ')}]` : ''}`);
      }
      out.push('  }');
    }
    if (t.note) out.push('', `  Note: ${dStr(t.note)}`);
    out.push('}', '');
  }
  const tByKey = new Map(model.tables.map((t) => [t.key, t]));
  const ep = (e) => { const t = tByKey.get(e.table); const tn = t ? dTable(t) : dName(e.table); return e.columns.length > 1 ? `${tn}.(${e.columns.map(dName).join(', ')})` : `${tn}.${dName(e.columns[0])}`; };
  for (const r of model.refs) {
    const s = [];
    if (r.onDelete) s.push(`delete: ${r.onDelete}`);
    if (r.onUpdate) s.push(`update: ${r.onUpdate}`);
    out.push(`Ref${r.name ? ` ${dName(r.name)}` : ''}: ${ep(r.from)} ${r.rel} ${ep(r.to)}${s.length ? ` [${s.join(', ')}]` : ''}`);
  }
  if (model.refs.length) out.push('');
  for (const g of model.groups) {
    out.push(`TableGroup ${dName(g.name)}${g.color ? ` [color: ${g.color}]` : ''} {`);
    for (const k of g.tables) { const t = tByKey.get(k); out.push(`  ${t ? dTable(t) : dName(k)}`); }
    if (g.note) out.push(`  Note: ${dStr(g.note)}`);
    out.push('}', '');
  }
  for (const n of model.notes) out.push(`Note ${dName(n.name)} {`, `  ${dStr(n.text)}`, '}', '');
  return out.join('\n');
}

// ---------------- Markdown data dictionary ----------------
const mdCell = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function dictionary(model, title) {
  const out = [];
  out.push(`# Data dictionary: ${mdCell(title || (model.project && model.project.name) || 'schema')}`, '');
  if (model.project && model.project.note) out.push(mdCell(model.project.note), '');
  out.push(`${model.tables.length} tables, ${model.refs.length} relations${model.enums.length ? `, ${model.enums.length} enums` : ''}.`, '');
  const refsOf = (t) => model.refs.filter((r) => r.from.table === t.key || r.to.table === t.key);
  const tByKey = new Map(model.tables.map((t) => [t.key, t]));
  for (const t of model.tables) {
    out.push(`## ${mdCell(t.schema && !/^(public|dbo|main)$/i.test(t.schema) ? `${t.schema}.${t.name}` : t.name)}`, '');
    if (t.note) out.push(mdCell(t.note), '');
    if (t.group) out.push(`Group: ${mdCell(t.group)}`, '');
    out.push('| Column | Type | Keys | Nullable | Default | Note |', '|---|---|---|---|---|---|');
    for (const c of t.columns) {
      const keys = [c.pk ? 'PK' : '', c.fk ? 'FK' : '', c.unique && !c.pk ? 'unique' : '', c.increment ? 'auto increment' : ''].filter(Boolean).join(', ');
      const nullable = c.pk || c.notNull ? 'no' : 'yes';
      out.push(`| ${mdCell(c.name)} | ${mdCell(c.type)} | ${keys} | ${nullable} | ${c.dflt ? mdCell(c.dflt.kind === 'string' ? `'${c.dflt.value}'` : c.dflt.value) : ''} | ${mdCell(c.note)} |`);
    }
    out.push('');
    const ix = t.indexes.filter((x) => x.columns.length);
    if (ix.length) {
      out.push('Indexes:', '');
      for (const x of ix) out.push(`- ${mdCell(x.name || '(no name)')}: ${x.columns.map((c) => mdCell(c.name || c.expr)).join(', ')}${x.pk ? ' (primary key)' : x.unique ? ' (unique)' : ''}`);
      out.push('');
    }
    const rs = refsOf(t);
    if (rs.length) {
      out.push('Relations:', '');
      for (const r of rs) {
        const other = r.from.table === t.key ? r.to : r.from;
        const mine = r.from.table === t.key ? r.from : r.to;
        const kind = { '>': 'many-to-one', '<': 'one-to-many', '-': 'one-to-one', '<>': 'many-to-many' }[r.rel] || r.rel;
        out.push(`- ${mine.columns.map(mdCell).join(', ')} → ${mdCell((tByKey.get(other.table) || {}).name || other.table)}.${other.columns.map(mdCell).join(', ')} (${r.from.table === t.key ? kind : reverseKind(r.rel)}${r.onDelete ? `, on delete ${r.onDelete}` : ''})`);
      }
      out.push('');
    }
  }
  if (model.enums.length) {
    out.push('## Enums', '');
    for (const e of model.enums) out.push(`- ${mdCell(e.name)}: ${e.values.map((v) => mdCell(v.name)).join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}
function reverseKind(rel) { return { '>': 'one-to-many', '<': 'many-to-one', '-': 'one-to-one', '<>': 'many-to-many' }[rel] || rel; }

module.exports = { toSql, toDbml, dictionary, DIALECTS, mapType, fkSide, actions, dflt, sqlStr, qTable };
