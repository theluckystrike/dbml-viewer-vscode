'use strict';
// Writers: SQL for 4 dialects (read back by the SQL reader), DBML round trips, the data dictionary, SVG, PDF, diff.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseDbml } = require('../src/core/dbml');
const { parseSql } = require('../src/core/sql');
const gen = require('../src/core/gen');
const diff = require('../src/core/diff');
const { layout } = require('../src/core/layout');
const { toSvg } = require('../src/core/svg');
const { toPdf, pdfText } = require('../src/core/pdf');
const { XSS } = require('./build');

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.dbml'), 'utf8');
const shape = (m) => ({
  tables: m.tables.map((t) => `${t.key}(${t.columns.map((c) => `${c.name}${c.pk ? '*' : ''}${c.notNull && !c.pk ? '!' : ''}`).join(',')})`).sort(),
  refs: m.refs.map((r) => diff.refSig(r)).sort(),
});

test('DBML -> SQL for each dialect -> read back: same tables, columns, keys and relations', () => {
  const m = parseDbml(SAMPLE);
  for (const d of ['postgres', 'mysql', 'mssql', 'sqlite']) {
    const sql = gen.toSql(m, d);
    const back = parseSql(sql);
    assert.deepStrictEqual(back.errors, [], d);
    assert.deepStrictEqual(back.skipped.filter((s) => !/^SET/.test(s.what)), [], `${d}: nothing skipped`);
    assert.deepStrictEqual(shape(back).tables, shape(m).tables, d);
    assert.deepStrictEqual(shape(back).refs, shape(m).refs, d);
  }
  const pg = gen.toSql(m, 'postgres');
  assert.match(pg, /CREATE TYPE "order_status" AS ENUM \('created', 'paid', 'shipped', 'cancelled'\);/);
  assert.match(pg, /"id" serial PRIMARY KEY/);
  assert.match(pg, /PRIMARY KEY \("order_id", "product_id"\)/);
  assert.match(pg, /ON DELETE CASCADE/);
  assert.match(pg, /COMMENT ON TABLE "users" IS 'People who can sign in and place orders';/);
  assert.match(gen.toSql(m, 'mysql'), /`id` integer AUTO_INCREMENT PRIMARY KEY/);
  assert.match(gen.toSql(m, 'mysql'), /`status` ENUM\('created', 'paid', 'shipped', 'cancelled'\)/);
  assert.match(gen.toSql(m, 'mssql'), /\[id\] integer IDENTITY\(1,1\) PRIMARY KEY/);
  assert.match(gen.toSql(m, 'sqlite'), /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(gen.toSql(m, 'sqlite'), /CHECK \("status" IN \('created'/);
});

test('round trip DBML -> SQL -> DBML -> model keeps the schema', () => {
  const m = parseDbml(SAMPLE);
  const again = parseDbml(gen.toDbml(parseSql(gen.toSql(m, 'postgres'))));
  assert.deepStrictEqual(again.errors, []);
  assert.deepStrictEqual(shape(again), shape(m));
  assert.strictEqual(again.enums.length, 1);
  const direct = parseDbml(gen.toDbml(m));
  assert.deepStrictEqual(direct.errors, []);
  assert.deepStrictEqual(shape(direct), shape(m));
  assert.deepStrictEqual(direct.groups.map((g) => g.name), ['sales', 'catalog']);
});

test('SQL DDL -> DBML keeps types, defaults, notes and indexes; names that need quotes get them', () => {
  const m = parseSql(`CREATE TABLE "Order Lines" ("Line No" int PRIMARY KEY, sku varchar(20) NOT NULL DEFAULT 'none', qty numeric(10,2) DEFAULT 1);
COMMENT ON COLUMN "Order Lines".sku IS 'it''s the SKU';
CREATE UNIQUE INDEX ol_sku ON "Order Lines" (sku, qty);`);
  const d = gen.toDbml(m);
  assert.match(d, /Table "Order Lines" \{/);
  assert.match(d, /"Line No" int \[pk\]/);
  assert.match(d, /sku varchar\(20\) \[not null, default: 'none', note: 'it\\'s the SKU'\]/);
  assert.match(d, /\(sku, qty\) \[unique, name: 'ol_sku'\]/);
  const back = parseDbml(d);
  assert.deepStrictEqual(back.errors, []);
  assert.strictEqual(back.tables[0].columns[1].note, "it's the SKU");
});

test('many-to-many becomes a junction table in SQL', () => {
  const m = parseDbml('Table a { id int [pk] }\nTable b { id int [pk] }\nRef: a.id <> b.id');
  const sql = gen.toSql(m, 'postgres');
  assert.match(sql, /CREATE TABLE "a_b" \(\n  "a_id" int NOT NULL,\n  "b_id" int NOT NULL,\n  PRIMARY KEY \("a_id", "b_id"\)/);
  assert.strictEqual(parseSql(sql).refs.length, 2);
});

test('data dictionary: one Markdown table per database table; pipes and HTML in names are escaped', () => {
  const m = parseDbml(`Table "a|b" { id int [pk, note: '${XSS} | x'] \n name text [not null, default: 'n'] }`);
  const md = gen.dictionary(m, 'demo');
  assert.match(md, /^# Data dictionary: demo/);
  assert.match(md, /## a\\\|b/);
  assert.match(md, /\| Column \| Type \| Keys \| Nullable \| Default \| Note \|/);
  assert.match(md, /\| id \| int \| PK \| no \|  \| &lt;img src=x onerror=alert\(1\)&gt; \\\| x \|/);
  assert.match(md, /\| name \| text \|  \| no \| 'n' \|  \|/);
  assert.ok(!md.includes('<img'));
});

test('SVG export: escaped text, no script, every table drawn, relations under the boxes', () => {
  const m = parseDbml(`Table "${XSS}" [note: '<script>x</script>'] { id int [pk] }\nTable t2 { id int \n x int [ref: > "${XSS}".id] }`);
  assert.deepStrictEqual(m.errors, []);
  const s = toSvg(m, layout(m).pos, { theme: 'dark', title: 'a & b' }).svg;
  assert.ok(!/<script|<img|onerror=/i.test(s.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'no live markup');
  assert.match(s, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(s, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.strictEqual((s.match(/<path d="M[^"]*" ?\/>/g) || []).length >= 2, true);
  assert.ok(s.indexOf('fill="none" stroke') < s.indexOf('t2'), 'lines first');
});

test('PDF export: a valid one-page PDF with Courier, xref offsets that match, text escaped', () => {
  const m = parseDbml(SAMPLE);
  const { buffer, width, height } = toPdf(m, layout(m).pos, { title: 'shop (demo)' });
  const s = buffer.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.match(s, /\/BaseFont \/Courier/);
  assert.match(s, /\/MediaBox \[0 0 \d+ \d+\]/);
  assert.ok(width > 500 && height > 200);
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.strictEqual(s.slice(xref, xref + 4), 'xref');
  const offs = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((x) => Number(x[1]));
  offs.forEach((o, k) => assert.strictEqual(s.slice(o, o + `${k + 1} 0 obj`.length), `${k + 1} 0 obj`));
  assert.match(s, /\(order_items\) Tj/);
  assert.strictEqual(pdfText('a(b)\\c é 中'), 'a\\(b\\)\\\\c \\351 ?');
  assert.match(s, /\/Title \(shop \\\(demo\\\)\)/);
});

test('diff: added, removed and changed tables, columns, indexes, relations, enums; migration per dialect', () => {
  const A = parseDbml(SAMPLE);
  const B = parseDbml(SAMPLE
    .replace('full_name varchar(120)', 'full_name varchar(200) [not null]\n  phone varchar(30)')
    .replace(/Table countries \{[^}]*\}/, '')
    .replace(/country_code char\(2\) \[ref: > countries\.code\]/g, 'country_code char(2)')
    .replace("    name\n  }", "    name\n    price [name: 'price_idx']\n  }")
    .replace('  cancelled\n', '  cancelled\n  refunded\n')
    + '\nTable reviews {\n  id int [pk]\n  product_id int [ref: > products.id]\n}\n');
  assert.deepStrictEqual(B.errors, []);
  const d = diff.compare(A, B);
  assert.deepStrictEqual(d.tablesAdded.map((t) => t.key), ['reviews']);
  assert.deepStrictEqual(d.tablesRemoved.map((t) => t.key), ['countries']);
  const u = d.tablesChanged.find((c) => c.table.key === 'users');
  assert.deepStrictEqual(u.columnsAdded.map((c) => c.name), ['phone']);
  assert.deepStrictEqual(u.columnsChanged[0].what.map((w) => w.what), ['type', 'not null']);
  assert.deepStrictEqual(d.tablesChanged.find((c) => c.table.key === 'products').indexesAdded.map((i) => i.name), ['price_idx']);
  assert.strictEqual(d.refsAdded.length, 1);
  assert.strictEqual(d.refsRemoved.length, 2);
  assert.deepStrictEqual(d.enumsChanged[0].added, ['refunded']);
  const pg = diff.migration(d, A, B, 'postgres');
  for (const re of [/ALTER TABLE "users" DROP CONSTRAINT "fk_users_country_code";/, /DROP TABLE "countries";/, /CREATE TABLE "reviews"/, /ALTER TABLE "users" ADD COLUMN "phone" varchar\(30\);/,
    /ALTER TABLE "users" ALTER COLUMN "full_name" TYPE varchar\(200\)/, /ALTER TABLE "users" ALTER COLUMN "full_name" SET NOT NULL;/, /CREATE INDEX "price_idx" ON "products" \("price"\);/,
    /ALTER TABLE "reviews" ADD CONSTRAINT "fk_reviews_product_id" FOREIGN KEY \("product_id"\) REFERENCES "products" \("id"\);/, /ALTER TYPE "order_status" ADD VALUE 'refunded';/]) assert.match(pg, re);
  assert.match(diff.migration(d, A, B, 'mysql'), /ALTER TABLE `users` MODIFY COLUMN `full_name` varchar\(200\) NOT NULL;/);
  assert.match(diff.migration(d, A, B, 'mysql'), /DROP FOREIGN KEY/);
  assert.match(diff.migration(d, A, B, 'mssql'), /ALTER TABLE \[users\] ALTER COLUMN \[full_name\] varchar\(200\) NOT NULL;/);
  assert.match(diff.migration(d, A, B, 'sqlite'), /SQLite cannot change users\.full_name in place/);
  const md = diff.report(d, 'old.dbml', 'new.dbml', pg, 'postgres');
  assert.match(md, /^# Schema diff: old\.dbml → new\.dbml/);
  assert.match(md, /\| type changed \| full_name \| varchar\(120\) \| varchar\(200\) \|/);
  assert.match(md, /```sql\n-- Migration \(PostgreSQL\)/);
});

test('diff: DBML against the same schema in SQL has no change; a ref written from the other side is the same ref', () => {
  const A = parseDbml(SAMPLE);
  const B = parseSql(gen.toSql(A, 'postgres'));
  const d = diff.compare(A, B);
  assert.strictEqual(d.count, d.tablesChanged.reduce((s, c) => s + (c.noteChanged ? 1 : 0) + c.columnsChanged.filter((x) => x.what.every((w) => w.what === 'note' || w.what === 'default')).length + c.indexesAdded.length + c.indexesRemoved.length, 0));
  assert.strictEqual(d.tablesAdded.length + d.tablesRemoved.length + d.refsAdded.length + d.refsRemoved.length, 0);
  const x = parseDbml('Table a { id int }\nTable b { a_id int }\nRef: b.a_id > a.id');
  const y = parseDbml('Table a { id int }\nTable b { a_id int }\nRef: a.id < b.a_id');
  assert.strictEqual(diff.compare(x, y).count, 0);
  assert.match(diff.migration(diff.compare(x, x), x, x, 'postgres'), /-- No change\./);
});
