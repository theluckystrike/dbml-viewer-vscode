'use strict';
// Schema diff: tables, columns, indexes, relations and enums added, removed and changed between an old and a new
// schema (DBML or SQL, any mix), a Markdown report and migration SQL (ALTER TABLE ...) for one dialect.
const gen = require('./gen');

const low = (s) => String(s).toLowerCase();
const TYPE_ALIASES = { integer: 'int', int4: 'int', serial: 'int', serial4: 'int', int8: 'bigint', bigserial: 'bigint', serial8: 'bigint', int2: 'smallint', smallserial: 'smallint', bool: 'boolean', 'character varying': 'varchar', 'double precision': 'double', float8: 'double', float4: 'real', timestamptz: 'timestamp with time zone' };
const normType = (t) => { const s = String(t || '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim(); const m = /^([a-z ]+?)(\(.*\))?(\[\])?$/.exec(s); return m ? (TYPE_ALIASES[m[1]] || m[1]) + (m[2] || '') + (m[3] || '') : s; };
const dfltText = (d) => (d ? `${d.kind === 'string' ? `'${d.value}'` : d.value}` : '');
const ixSig = (ix) => `${ix.pk ? 'pk' : ix.unique ? 'u' : 'i'}:${ix.columns.map((c) => low(c.name || c.expr)).join(',')}`;
function refSig(r) {
  // the same relation written from either side (a > b and b < a) has one signature
  let a = r.from, b = r.to, rel = r.rel;
  if (rel === '<') { [a, b] = [b, a]; rel = '>'; }
  return `${low(a.table)}(${a.columns.map(low).join(',')})${rel}${low(b.table)}(${b.columns.map(low).join(',')})`;
}

function compare(A, B) {
  const tA = new Map(A.tables.map((t) => [low(t.key), t]));
  const tB = new Map(B.tables.map((t) => [low(t.key), t]));
  const d = { tablesAdded: [], tablesRemoved: [], tablesChanged: [], refsAdded: [], refsRemoved: [], enumsAdded: [], enumsRemoved: [], enumsChanged: [] };
  for (const [k, t] of tB) if (!tA.has(k)) d.tablesAdded.push(t);
  for (const [k, t] of tA) if (!tB.has(k)) d.tablesRemoved.push(t);
  for (const [k, a] of tA) {
    const b = tB.get(k);
    if (!b) continue;
    const ca = new Map(a.columns.map((c) => [low(c.name), c]));
    const cb = new Map(b.columns.map((c) => [low(c.name), c]));
    const ch = { table: b, old: a, columnsAdded: [], columnsRemoved: [], columnsChanged: [], indexesAdded: [], indexesRemoved: [], noteChanged: (a.note || '') !== (b.note || '') };
    for (const [n, c] of cb) if (!ca.has(n)) ch.columnsAdded.push(c);
    for (const [n, c] of ca) if (!cb.has(n)) ch.columnsRemoved.push(c);
    for (const [n, x] of ca) {
      const y = cb.get(n);
      if (!y) continue;
      const what = [];
      if (normType(x.type) !== normType(y.type)) what.push({ what: 'type', from: x.type, to: y.type });
      if (!!(x.notNull || x.pk) !== !!(y.notNull || y.pk)) what.push({ what: 'not null', from: !!(x.notNull || x.pk), to: !!(y.notNull || y.pk) });
      if (!!x.pk !== !!y.pk) what.push({ what: 'primary key', from: !!x.pk, to: !!y.pk });
      if (!!x.unique !== !!y.unique) what.push({ what: 'unique', from: !!x.unique, to: !!y.unique });
      if (dfltText(x.dflt) !== dfltText(y.dflt)) what.push({ what: 'default', from: dfltText(x.dflt), to: dfltText(y.dflt) });
      if ((x.note || '') !== (y.note || '')) what.push({ what: 'note', from: x.note || '', to: y.note || '' });
      if (what.length) ch.columnsChanged.push({ name: y.name, old: x, col: y, what });
    }
    const ia = new Map(a.indexes.filter((x) => !x.pk).map((x) => [ixSig(x), x]));
    const ib = new Map(b.indexes.filter((x) => !x.pk).map((x) => [ixSig(x), x]));
    for (const [s, x] of ib) if (!ia.has(s)) ch.indexesAdded.push(x);
    for (const [s, x] of ia) if (!ib.has(s)) ch.indexesRemoved.push(x);
    if (ch.columnsAdded.length || ch.columnsRemoved.length || ch.columnsChanged.length || ch.indexesAdded.length || ch.indexesRemoved.length || ch.noteChanged) d.tablesChanged.push(ch);
  }
  const ra = new Map(A.refs.map((r) => [refSig(r), r]));
  const rb = new Map(B.refs.map((r) => [refSig(r), r]));
  for (const [s, r] of rb) if (!ra.has(s)) d.refsAdded.push(r);
  for (const [s, r] of ra) if (!rb.has(s)) d.refsRemoved.push(r);
  const ea = new Map(A.enums.map((e) => [low(e.key), e]));
  const eb = new Map(B.enums.map((e) => [low(e.key), e]));
  for (const [k, e] of eb) if (!ea.has(k)) d.enumsAdded.push(e);
  for (const [k, e] of ea) if (!eb.has(k)) d.enumsRemoved.push(e);
  for (const [k, e] of ea) {
    const f = eb.get(k);
    if (!f) continue;
    const va = e.values.map((v) => v.name), vb = f.values.map((v) => v.name);
    const added = vb.filter((v) => !va.includes(v)), removed = va.filter((v) => !vb.includes(v));
    if (added.length || removed.length) d.enumsChanged.push({ old: e, enum: f, added, removed });
  }
  d.count = d.tablesAdded.length + d.tablesRemoved.length + d.tablesChanged.reduce((s, c) => s + c.columnsAdded.length + c.columnsRemoved.length + c.columnsChanged.length + c.indexesAdded.length + c.indexesRemoved.length + (c.noteChanged ? 1 : 0), 0) + d.refsAdded.length + d.refsRemoved.length + d.enumsAdded.length + d.enumsRemoved.length + d.enumsChanged.length;
  return d;
}

function migration(d, A, B, dialect = 'postgres') {
  const D = gen.DIALECTS[dialect] || gen.DIALECTS.postgres;
  const q = D.q;
  const qt = (t) => gen.qTable(D, t);
  const out = [`-- Migration (${D.label}) from the old schema to the new one, written by DBML Viewer & ER Diagram.`, '-- Read it before you run it: renames show up as a drop plus an add, and dropped columns lose their data.', ''];
  const sub = (tables, refs, enums) => ({ ...B, tables, refs, enums: enums || [], groups: [], notes: [], project: null });
  const colDef = (c) => {
    const en = c.enumRef ? B.enums.find((e) => e.key === c.enumRef) : null;
    let s = `${q(c.name)} ${en && dialect === 'postgres' ? qt(en) : gen.mapType(c.type, dialect, c)}`;
    if (c.notNull || c.pk) s += ' NOT NULL';
    if (c.unique && !c.pk) s += ' UNIQUE';
    if (c.dflt) s += ` DEFAULT ${gen.dflt(c.dflt, dialect)}`;
    return s;
  };
  if (dialect === 'postgres') {
    for (const e of d.enumsAdded) out.push(`CREATE TYPE ${qt(e)} AS ENUM (${e.values.map((v) => gen.sqlStr(v.name)).join(', ')});`);
    for (const e of d.enumsChanged) for (const v of e.added) out.push(`ALTER TYPE ${qt(e.enum)} ADD VALUE ${gen.sqlStr(v)};`);
    for (const e of d.enumsChanged) if (e.removed.length) out.push(`-- ${e.enum.name}: PostgreSQL cannot drop enum values (${e.removed.join(', ')}); recreate the type if you need that.`);
  }
  // drop relations first, then tables, then add
  const fkName = (r) => {
    const fk = gen.fkSide(r);
    return r.name || (fk ? `fk_${String(fk.child.table).split('.').pop()}_${fk.child.columns.join('_')}` : 'fk');
  };
  for (const r of d.refsRemoved) {
    const fk = gen.fkSide(r);
    if (!fk) continue;
    const t = A.tables.find((x) => x.key === fk.child.table);
    if (!t || d.tablesRemoved.includes(t)) continue;
    if (dialect === 'sqlite') out.push(`-- SQLite cannot drop a foreign key in place: rebuild ${q(t.name)} without the key on (${fk.child.columns.join(', ')}).`);
    else out.push(`ALTER TABLE ${qt(t)} DROP ${dialect === 'mysql' ? 'FOREIGN KEY' : 'CONSTRAINT'} ${q(fkName(r))};`);
  }
  for (const t of d.tablesRemoved) out.push(`DROP TABLE ${qt(t)};`);
  if (d.tablesAdded.length) {
    const addedKeys = new Set(d.tablesAdded.map((t) => t.key));
    const refs = dialect === 'sqlite' ? B.refs.filter((r) => { const fk = gen.fkSide(r); return fk && addedKeys.has(fk.child.table); }) : [];
    const sql = gen.toSql(sub(d.tablesAdded, refs, dialect === 'postgres' ? [] : B.enums.filter((e) => d.tablesAdded.some((t) => t.columns.some((c) => c.enumRef === e.key)))), dialect);
    out.push(...sql.split('\n').filter((l) => !/^-- (PostgreSQL|MySQL|SQL Server|SQLite) schema|^-- Project:/.test(l)));
  }
  for (const ch of d.tablesChanged) {
    const T = qt(ch.table);
    for (const ix of ch.indexesRemoved) {
      if (!ix.name) { out.push(`-- ${ch.table.name}: an index on (${ix.columns.map((c) => c.name || c.expr).join(', ')}) was removed; it has no name, drop it by hand.`); continue; }
      out.push(dialect === 'mysql' || dialect === 'mssql' ? `DROP INDEX ${q(ix.name)} ON ${T};` : `DROP INDEX ${q(ix.name)};`);
    }
    for (const c of ch.columnsRemoved) out.push(`ALTER TABLE ${T} DROP COLUMN ${q(c.name)};`);
    for (const c of ch.columnsAdded) out.push(`ALTER TABLE ${T} ADD ${dialect === 'mssql' ? '' : 'COLUMN '}${colDef(c)};`);
    for (const cc of ch.columnsChanged) {
      const c = cc.col, C = q(c.name);
      const kinds = new Set(cc.what.map((w) => w.what));
      if (dialect === 'sqlite' && (kinds.has('type') || kinds.has('not null') || kinds.has('default') || kinds.has('primary key'))) { out.push(`-- SQLite cannot change ${ch.table.name}.${c.name} in place (${[...kinds].join(', ')}): rebuild the table.`); continue; }
      if (dialect === 'mysql' && (kinds.has('type') || kinds.has('not null') || kinds.has('default'))) out.push(`ALTER TABLE ${T} MODIFY COLUMN ${colDef(c).replace(/ UNIQUE/, '')};`);
      if (dialect === 'postgres') {
        if (kinds.has('type')) out.push(`ALTER TABLE ${T} ALTER COLUMN ${C} TYPE ${gen.mapType(c.type, dialect, null)} USING ${C}::${gen.mapType(c.type, dialect, null)};`);
        if (kinds.has('not null')) out.push(`ALTER TABLE ${T} ALTER COLUMN ${C} ${c.notNull || c.pk ? 'SET' : 'DROP'} NOT NULL;`);
        if (kinds.has('default')) out.push(c.dflt ? `ALTER TABLE ${T} ALTER COLUMN ${C} SET DEFAULT ${gen.dflt(c.dflt, dialect)};` : `ALTER TABLE ${T} ALTER COLUMN ${C} DROP DEFAULT;`);
      }
      if (dialect === 'mssql') {
        if (kinds.has('type') || kinds.has('not null')) out.push(`ALTER TABLE ${T} ALTER COLUMN ${C} ${gen.mapType(c.type, dialect, null)}${c.notNull || c.pk ? ' NOT NULL' : ' NULL'};`);
        if (kinds.has('default')) out.push(`-- ${ch.table.name}.${c.name}: the default changed to ${c.dflt ? gen.dflt(c.dflt, dialect) : 'none'}; SQL Server keeps defaults as named constraints, change it by name.`);
      }
      if (kinds.has('unique')) {
        if (c.unique) out.push(`CREATE UNIQUE INDEX ${q(`${String(ch.table.name).replace(/\W+/g, '_')}_${c.name}_key`)} ON ${T} (${C});`);
        else out.push(`-- ${ch.table.name}.${c.name} is no longer unique: drop its unique constraint by name.`);
      }
      if (kinds.has('primary key')) out.push(`-- ${ch.table.name}.${c.name}: the primary key changed; change it by hand (drop and add the PRIMARY KEY constraint).`);
    }
    for (const ix of ch.indexesAdded) {
      const cols = ix.columns.map((c) => (c.name ? q(c.name) : c.expr));
      const name = ix.name || `${String(ch.table.name).replace(/\W+/g, '_')}_${ix.columns.map((c) => String(c.name || 'expr').replace(/\W+/g, '_')).join('_')}_idx`;
      out.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${T} (${cols.join(', ')});`);
    }
  }
  for (const r of d.refsAdded) {
    const fk = gen.fkSide(r);
    if (!fk) { out.push(`-- many-to-many ${r.from.table} <> ${r.to.table}: add a junction table.`); continue; }
    const child = B.tables.find((x) => x.key === fk.child.table), parent = B.tables.find((x) => x.key === fk.parent.table);
    if (!child || !parent) continue;
    if (d.tablesAdded.includes(child) && dialect === 'sqlite') continue; // already inside CREATE TABLE
    if (dialect === 'sqlite') { out.push(`-- SQLite cannot add a foreign key in place: rebuild ${q(child.name)} with FOREIGN KEY (${fk.child.columns.join(', ')}) REFERENCES ${parent.name} (${fk.parent.columns.join(', ')}).`); continue; }
    out.push(`ALTER TABLE ${qt(child)} ADD CONSTRAINT ${q(fkName(r))} FOREIGN KEY (${fk.child.columns.map(q).join(', ')}) REFERENCES ${qt(parent)} (${fk.parent.columns.map(q).join(', ')})${gen.actions(r)};`);
  }
  if (dialect === 'postgres') for (const e of d.enumsRemoved) out.push(`DROP TYPE ${qt(e)};`);
  if (out.length === 3) out.push('-- No change.');
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

const md = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/</g, '&lt;');

function report(d, nameA, nameB, sql, dialect) {
  const out = [`# Schema diff: ${md(nameA)} → ${md(nameB)}`, ''];
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  out.push(d.count ? `${pl(d.count, 'change')}: ${pl(d.tablesAdded.length, 'table')} added, ${d.tablesRemoved.length} removed, ${d.tablesChanged.length} changed; ${pl(d.refsAdded.length, 'relation')} added, ${d.refsRemoved.length} removed.` : 'The two schemas have the same tables, columns, indexes, relations and enums.', '');
  if (d.tablesAdded.length) { out.push('## Tables added', ''); for (const t of d.tablesAdded) out.push(`- ${md(t.key)} (${t.columns.length} columns)`); out.push(''); }
  if (d.tablesRemoved.length) { out.push('## Tables removed', ''); for (const t of d.tablesRemoved) out.push(`- ${md(t.key)}`); out.push(''); }
  if (d.tablesChanged.length) {
    out.push('## Tables changed', '');
    for (const c of d.tablesChanged) {
      out.push(`### ${md(c.table.key)}`, '');
      out.push('| Change | Column or index | Old | New |', '|---|---|---|---|');
      for (const x of c.columnsAdded) out.push(`| column added | ${md(x.name)} |  | ${md(x.type)} |`);
      for (const x of c.columnsRemoved) out.push(`| column removed | ${md(x.name)} | ${md(x.type)} |  |`);
      for (const x of c.columnsChanged) for (const w of x.what) out.push(`| ${md(w.what)} changed | ${md(x.name)} | ${md(w.from)} | ${md(w.to)} |`);
      for (const x of c.indexesAdded) out.push(`| index added | ${md(x.name || x.columns.map((k) => k.name || k.expr).join(', '))} |  | ${x.unique ? 'unique' : 'index'} |`);
      for (const x of c.indexesRemoved) out.push(`| index removed | ${md(x.name || x.columns.map((k) => k.name || k.expr).join(', '))} | ${x.unique ? 'unique' : 'index'} |  |`);
      if (c.noteChanged) out.push(`| note changed | (table) | ${md(c.old.note)} | ${md(c.table.note)} |`);
      out.push('');
    }
  }
  const rs = (r) => `${md(r.from.table)}.${r.from.columns.map(md).join(',')} ${r.rel} ${md(r.to.table)}.${r.to.columns.map(md).join(',')}`;
  if (d.refsAdded.length || d.refsRemoved.length) {
    out.push('## Relations', '');
    for (const r of d.refsAdded) out.push(`- added: ${rs(r)}`);
    for (const r of d.refsRemoved) out.push(`- removed: ${rs(r)}`);
    out.push('');
  }
  if (d.enumsAdded.length || d.enumsRemoved.length || d.enumsChanged.length) {
    out.push('## Enums', '');
    for (const e of d.enumsAdded) out.push(`- added: ${md(e.key)} (${e.values.map((v) => md(v.name)).join(', ')})`);
    for (const e of d.enumsRemoved) out.push(`- removed: ${md(e.key)}`);
    for (const e of d.enumsChanged) out.push(`- ${md(e.enum.key)}: ${e.added.length ? `added ${e.added.map(md).join(', ')}` : ''}${e.added.length && e.removed.length ? '; ' : ''}${e.removed.length ? `removed ${e.removed.map(md).join(', ')}` : ''}`);
    out.push('');
  }
  out.push(`## Migration SQL (${gen.DIALECTS[dialect] ? gen.DIALECTS[dialect].label : dialect})`, '', '```sql', sql.trimEnd(), '```', '');
  return out.join('\n');
}

module.exports = { compare, migration, report, refSig };
