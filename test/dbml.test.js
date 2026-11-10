'use strict';
// The DBML reader: every construct of the language reference, errors with line and column, recovery.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseDbml } = require('../src/core/dbml');

const col = (m, t, c) => m.tables.find((x) => x.key === t).columns.find((x) => x.name === c);

test('sample.dbml: 6 tables, 7 relations, enum, groups, note, project, no error', () => {
  const m = parseDbml(fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.dbml'), 'utf8'));
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.tables.map((t) => t.key), ['users', 'countries', 'merchants', 'products', 'orders', 'order_items']);
  assert.strictEqual(m.refs.length, 7);
  assert.strictEqual(m.project.databaseType, 'PostgreSQL');
  assert.deepStrictEqual(m.enums[0].values.map((v) => v.name), ['created', 'paid', 'shipped', 'cancelled']);
  assert.strictEqual(m.enums[0].values[0].note, 'Waiting for payment');
  assert.deepStrictEqual(m.groups.map((g) => [g.name, g.tables]), [['sales', ['orders', 'order_items']], ['catalog', ['merchants', 'products']]]);
  assert.strictEqual(m.notes[0].name, 'shipping');
  assert.strictEqual(m.tables[0].alias, 'U');
  assert.ok(col(m, 'merchants', 'admin_id').fk, 'alias U resolves');
  assert.strictEqual(col(m, 'orders', 'status').enumRef, 'order_status');
  assert.deepStrictEqual(m.tables.find((t) => t.key === 'order_items').columns.filter((c) => c.pk).map((c) => c.name), ['order_id', 'product_id']);
  assert.strictEqual(m.tables.find((t) => t.key === 'products').group, 'catalog');
  const r = m.refs.find((x) => x.from.table === 'order_items' && x.from.columns[0] === 'product_id');
  assert.strictEqual(r.onDelete, 'cascade');
});

test('columns: settings, defaults, types with spaces, arrays, schemas, quoted names', () => {
  const m = parseDbml(`
Table "my schema"."user accounts" [headercolor: #3498DB, note: 'All users'] {
  "user id" int [pk, increment, note: 'the key']
  email varchar(255) [not null, unique, default: 'a@b.c']
  score decimal(10, 2) [default: -1.5]
  created "timestamp with time zone" [default: \`now()\`, null]
  tags text[]
  active boolean [default: true]
}`);
  assert.deepStrictEqual(m.errors, []);
  const t = m.tables[0];
  assert.strictEqual(t.key, 'my schema.user accounts');
  assert.strictEqual(t.headerColor, '#3498DB');
  assert.strictEqual(t.note, 'All users');
  assert.deepStrictEqual(t.columns.map((c) => c.type), ['int', 'varchar(255)', 'decimal(10, 2)', 'timestamp with time zone', 'text[]', 'boolean']);
  assert.ok(t.columns[0].pk && t.columns[0].increment && t.columns[0].note === 'the key');
  assert.ok(t.columns[1].notNull && t.columns[1].unique);
  assert.deepStrictEqual(t.columns[1].dflt, { kind: 'string', value: 'a@b.c' });
  assert.deepStrictEqual(t.columns[2].dflt, { kind: 'number', value: '-1.5' });
  assert.deepStrictEqual(t.columns[3].dflt, { kind: 'expr', value: 'now()' });
  assert.ok(t.columns[3].nullable);
  assert.deepStrictEqual(t.columns[5].dflt, { kind: 'bool', value: 'true' });
});

test('Ref: short and long form, all four relation types, composite keys, actions, names', () => {
  const m = parseDbml(`
Table a { id int [pk]
 x int
 y int }
Table b { id int [pk]
 a_id int
 x int
 y int }
Ref named_ref: b.a_id > a.id [delete: set null, update: cascade]
Ref { a.id < b.x }
Ref: a.x - b.y
Ref: a.y <> b.id
Ref: b.(x, y) > a.(x, y)
`);
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.refs.map((r) => r.rel), ['>', '<', '-', '<>', '>']);
  assert.strictEqual(m.refs[0].name, 'named_ref');
  assert.strictEqual(m.refs[0].onDelete, 'set null');
  assert.strictEqual(m.refs[0].onUpdate, 'cascade');
  assert.deepStrictEqual(m.refs[4].from.columns, ['x', 'y']);
  assert.ok(col(m, 'b', 'x').fk, '< marks the right side as the foreign key');
});

test('indexes block: single, composite, expressions, pk, unique, name, type', () => {
  const m = parseDbml(`
Table p {
  id int
  a int
  b int
  indexes {
    (id, a) [pk]
    b [unique, name: 'b_idx', type: hash]
    \`lower(b)\`
    (a, \`a*2\`) [note: 'mixed']
  }
}`);
  assert.deepStrictEqual(m.errors, []);
  const ix = m.tables[0].indexes;
  assert.strictEqual(ix.length, 4);
  assert.ok(ix[0].pk);
  assert.deepStrictEqual([ix[1].unique, ix[1].name, ix[1].type], [true, 'b_idx', 'hash']);
  assert.deepStrictEqual(ix[2].columns, [{ expr: 'lower(b)' }]);
  assert.ok(m.tables[0].columns[0].pk && m.tables[0].columns[1].pk);
});

test('notes: multi-line strings, Note blocks, sticky notes, project note, escaped quotes', () => {
  const m = parseDbml(`
Project p {
  Note {
    'about it'
  }
}
Table t {
  id int [note: 'it\\'s the key']
  Note: '''
    line one
      line two
  '''
}
Note sticky [headercolor: #ffcc00] {
  'remember'
}`);
  assert.deepStrictEqual(m.errors, []);
  assert.strictEqual(m.project.note, 'about it');
  assert.strictEqual(m.tables[0].note, 'line one\n  line two');
  assert.strictEqual(m.tables[0].columns[0].note, "it's the key");
  assert.deepStrictEqual([m.notes[0].name, m.notes[0].text, m.notes[0].headerColor], ['sticky', 'remember', '#ffcc00']);
});

test('TablePartial and ~injection; comments everywhere', () => {
  const m = parseDbml(`
/* block
   comment */
TablePartial stamps {
  created_at timestamp // when
  updated_at timestamp
}
Table t {
  id int [pk] // key
  ~stamps
  /* inline */ name text
}`);
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.tables.map((t) => t.key), ['t']);
  assert.deepStrictEqual(m.tables[0].columns.map((c) => c.name), ['id', 'created_at', 'updated_at', 'name']);
});

test('errors carry line and column and reading goes on', () => {
  const m = parseDbml('Table a {\n  id int [pk\n}\nTabel b { x int }\nTable c {\n  x int [ref: > zz.id]\n  y\n}\nRef: c.nope > a.id\n');
  const msgs = m.errors.map((e) => `${e.line}:${e.col} ${e.message}`);
  assert.ok(msgs.some((x) => /^2:\d+ This \[ has no closing \]/.test(x)), msgs.join('\n'));
  assert.ok(msgs.some((x) => /^4:1 Unknown keyword "Tabel"/.test(x)), msgs.join('\n'));
  assert.ok(msgs.some((x) => /unknown table "zz"/.test(x)), msgs.join('\n'));
  assert.ok(msgs.some((x) => /^7:\d+ Column "y" in table "c" has no type/.test(x)), msgs.join('\n'));
  assert.ok(msgs.some((x) => /^9:\d+ Column "nope" is not in table "c"/.test(x)), msgs.join('\n'));
  assert.deepStrictEqual(m.tables.map((t) => t.key), ['a', 'c'], 'tables around the errors are still read');
});

test('a table defined twice and a TableGroup naming an unknown table are errors', () => {
  const m = parseDbml('Table a { id int }\nTable a { id int }\nTableGroup g { a\n nope }');
  assert.ok(m.errors.some((e) => /defined twice/.test(e.message)));
  assert.ok(m.errors.some((e) => e.line === 3 && /unknown table "nope"/.test(e.message)));
});

test('positions of tables and columns are recorded for go to definition', () => {
  const m = parseDbml('\n  Table   users {\n    id int\n}');
  assert.deepStrictEqual([m.tables[0].line, m.tables[0].col, m.tables[0].len], [2, 11, 5]);
  assert.deepStrictEqual([m.tables[0].columns[0].line, m.tables[0].columns[0].col], [3, 5]);
});
