'use strict';
// Regressions found by reading real public schemas (Sakila for SQL Server and PostgreSQL, the dbml-core examples):
// each case is rebuilt here in a few synthetic lines, so the test needs no downloaded file.
const test = require('node:test');
const assert = require('node:assert');
const { parseDbml } = require('../src/core/dbml');
const { parseSql } = require('../src/core/sql');
const gen = require('../src/core/gen');
const diff = require('../src/core/diff');

test('SQL Server: CREATE TABLE statements with no ; or GO between them are read one by one', () => {
  const m = parseSql('CREATE TABLE film_text (\n  film_id INT NOT NULL,\n  PRIMARY KEY NONCLUSTERED (film_id),\n)\n\nCREATE TABLE inventory (\n  inventory_id INT NOT NULL IDENTITY,\n  film_id INT NOT NULL REFERENCES film_text (film_id),\n  PRIMARY KEY NONCLUSTERED (inventory_id)\n)\nGO\n ALTER TABLE inventory ADD CONSTRAINT [DF_x] DEFAULT (getdate()) FOR film_id\nGO\n');
  assert.deepStrictEqual(m.tables.map((t) => t.key), ['film_text', 'inventory']);
  assert.strictEqual(m.refs.length, 1);
  assert.deepStrictEqual(m.errors, []);
  // a line that starts with ON DELETE SET NULL stays inside the statement
  const m2 = parseSql('ALTER TABLE a ADD CONSTRAINT f FOREIGN KEY (b_id) REFERENCES b (id)\n  ON DELETE SET NULL;\nCREATE TABLE a (id int, b_id int);\nCREATE TABLE b (id int primary key);');
  assert.strictEqual(m2.refs.length, 1);
  assert.strictEqual(m2.refs[0].onDelete.toLowerCase(), 'set null');
});

test('PostgreSQL: a column called fulltext is a column; INHERITS copies the parent columns', () => {
  const m = parseSql('CREATE TABLE film (film_id serial PRIMARY KEY, title text NOT NULL, fulltext tsvector NOT NULL);\nCREATE INDEX film_fulltext_idx ON film USING gist (fulltext);\nCREATE TABLE payment (payment_id serial PRIMARY KEY, customer_id int NOT NULL, amount numeric(5,2));\nCREATE TABLE payment_p2007_01 (CONSTRAINT c CHECK (amount > 0)) INHERITS (payment);\nCREATE INDEX p1 ON payment_p2007_01 (customer_id);');
  assert.deepStrictEqual(m.tables.find((t) => t.key === 'film').columns.map((c) => c.name), ['film_id', 'title', 'fulltext']);
  const part = m.tables.find((t) => t.key === 'payment_p2007_01');
  assert.deepStrictEqual(part.columns.map((c) => [c.name, c.pk]), [['payment_id', false], ['customer_id', false], ['amount', false]]);
  assert.deepStrictEqual(parseDbml(gen.toDbml(m)).errors, []);
  // MySQL FULLTEXT KEY is still an index
  const my = parseSql('CREATE TABLE t (id int PRIMARY KEY, body text, FULLTEXT KEY ft_body (body));');
  assert.deepStrictEqual(my.tables[0].columns.map((c) => c.name), ['id', 'body']);
  assert.strictEqual(my.tables[0].indexes.length, 1);
});

test('DBML: optional relation marks (<?, ?<?, -?), public.name in a TableGroup and a checks block read with no error', () => {
  const m = parseDbml([
    'Table a { id int [pk] }', 'Table b { id int [pk]\n  a_id int\n  Checks {\n    `a_id > 0` [name: \'ck\']\n  }\n  Indexes {\n    a_id\n  }\n}',
    'Table schemaA.a { id int [pk] }',
    'Ref: a.id <? b.a_id', 'Ref: b.id ?<? schemaA.a.id', 'Ref: a.id -? schemaA.a.id',
    'TableGroup g {\n  public.a\n  b\n}',
  ].join('\n'));
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.refs.map((r) => r.rel), ['<', '<', '-']);
  assert.deepStrictEqual(m.groups[0].tables, ['a', 'b']);
  assert.strictEqual(m.tables.find((t) => t.key === 'b').indexes.length, 1);
  assert.ok(m.skipped.some((s) => /checks block/.test(s.what)));
});

test('SQL export: a one-to-one ref makes the FK unique so it reads back one-to-one; junction names never clash', () => {
  const m = parseDbml('Table father { id char(50) [pk] }\nTable child {\n  id char(50) [pk]\n  father_id char(50) [ref: - father.id]\n}\nTable p { a int\n  b int\n  indexes { (a, b) [pk] } }\nTable q { a int\n  b int\n  pa int\n  pb int }\nRef: q.(pa, pb) - p.(a, b)');
  for (const d of ['postgres', 'mysql', 'mssql', 'sqlite']) {
    const sql = gen.toSql(m, d);
    const back = parseSql(sql);
    assert.deepStrictEqual(back.errors, [], d);
    assert.deepStrictEqual(back.refs.map((r) => r.rel), ['-', '-'], d);
    assert.strictEqual(diff.compare(m, back).refsAdded.length, 0, d);
  }
  const nn = parseDbml('Table t1 { id int [pk]\n  ref_id int }\nTable t2 { id int [pk]\n  ref_id int }\nTable t1_t2 { x int }\nRef: t1.id <> t2.id\nRef: t1.ref_id <> t2.ref_id\nTable person { id int [pk] }\nRef: person.id <> person.id');
  for (const d of ['postgres', 'mysql', 'mssql', 'sqlite']) {
    const back = parseSql(gen.toSql(nn, d));
    assert.deepStrictEqual(back.errors, [], d);
    assert.deepStrictEqual(back.tables.map((t) => t.key).sort(), ['person', 'person_person', 't1', 't1_t2', 't1_t2_2', 't1_t2_3', 't2'], d);
    assert.deepStrictEqual(back.tables.find((t) => t.key === 'person_person').columns.map((c) => c.name), ['person_id', 'person_id_2'], d);
  }
});
