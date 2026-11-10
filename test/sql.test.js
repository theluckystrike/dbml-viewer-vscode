'use strict';
// The SQL DDL reader on the four dialects, plus the statements it skips.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseSql } = require('../src/core/sql');

const t = (m, k) => m.tables.find((x) => x.key === k);
const c = (m, k, n) => t(m, k).columns.find((x) => x.name === n);
const refs = (m) => m.refs.map((r) => `${r.from.table}.${r.from.columns}${r.rel}${r.to.table}.${r.to.columns}`).sort();

test('PostgreSQL: serial, identity, REFERENCES, ALTER TABLE FK, enum type, index, COMMENT ON, $$ bodies skipped', () => {
  const m = parseSql(fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.sql'), 'utf8') + `
CREATE TABLE IF NOT EXISTS public.audit (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamp with time zone DEFAULT now() NOT NULL, payload jsonb DEFAULT '{}'::jsonb);
CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN; CREATE TABLE fake (x int); RETURN NEW; END; $$ LANGUAGE plpgsql;
INSERT INTO tags (name) VALUES ('a;b');
`);
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.tables.map((x) => x.key), ['authors', 'posts', 'tags', 'post_tags', 'comments', 'audit']);
  assert.deepStrictEqual(refs(m), ['comments.author_id>authors.id', 'comments.post_id>posts.id', 'post_tags.post_id>posts.id', 'post_tags.tag_id>tags.id', 'posts.author_id>authors.id']);
  assert.strictEqual(m.refs.find((r) => r.from.table === 'posts').onDelete, 'cascade');
  assert.strictEqual(m.refs.find((r) => r.from.columns[0] === 'author_id' && r.from.table === 'comments').onDelete, 'set null');
  assert.ok(c(m, 'authors', 'id').increment && c(m, 'authors', 'id').pk);
  assert.ok(c(m, 'audit', 'id').increment && c(m, 'audit', 'id').pk);
  assert.strictEqual(c(m, 'audit', 'at').type, 'timestamp with time zone');
  assert.deepStrictEqual(c(m, 'audit', 'payload').dflt, { kind: 'string', value: '{}' });
  assert.deepStrictEqual(m.enums.map((e) => [e.key, e.values.map((v) => v.name)]), [['post_state', ['draft', 'published', 'archived']]]);
  assert.strictEqual(c(m, 'posts', 'state').enumRef, 'post_state');
  assert.strictEqual(t(m, 'posts').note, 'Articles, one row per version that was published');
  assert.deepStrictEqual(t(m, 'posts').indexes[0].columns.map((x) => x.name), ['author_id', 'published_at']);
  assert.ok(c(m, 'post_tags', 'post_id').pk && c(m, 'post_tags', 'tag_id').pk);
  assert.match(m.skippedSummary, /CREATE FUNCTION \(1\)/);
  assert.match(m.skippedSummary, /INSERT INTO \(1\)/);
  assert.ok(!m.tables.some((x) => x.key === 'fake'), 'a CREATE TABLE inside a function body is not a table');
});

test('MySQL: backticks, AUTO_INCREMENT, KEY, CONSTRAINT FOREIGN KEY, inline enum, COMMENT, DELIMITER', () => {
  const m = parseSql("SET NAMES utf8mb4;\nCREATE TABLE `store` (`store_id` tinyint unsigned NOT NULL AUTO_INCREMENT, PRIMARY KEY (`store_id`)) ENGINE=InnoDB;\n"
    + "CREATE TABLE `customer` (\n `customer_id` smallint unsigned NOT NULL AUTO_INCREMENT,\n `store_id` tinyint unsigned NOT NULL COMMENT 'home store',\n `status` enum('a','b') DEFAULT 'a',\n `key` varchar(10),\n PRIMARY KEY (`customer_id`),\n KEY `idx_fk_store_id` (`store_id`),\n UNIQUE KEY `uk` (`status`, `key`),\n CONSTRAINT `fk_customer_store` FOREIGN KEY (`store_id`) REFERENCES `store` (`store_id`) ON DELETE RESTRICT ON UPDATE CASCADE\n) ENGINE=InnoDB COMMENT='Customers';\n"
    + "DELIMITER ;;\nCREATE TRIGGER x BEFORE INSERT ON customer FOR EACH ROW BEGIN SET NEW.status = 'a'; END;;\nDELIMITER ;\n# a hash comment\nCREATE TABLE z (id int);\n");
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.tables.map((x) => x.key), ['store', 'customer', 'z']);
  assert.ok(c(m, 'customer', 'customer_id').increment && c(m, 'customer', 'customer_id').pk);
  assert.strictEqual(c(m, 'customer', 'store_id').note, 'home store');
  assert.strictEqual(c(m, 'customer', 'status').type, "enum('a', 'b')");
  assert.ok(c(m, 'customer', 'key'), 'a quoted column named key');
  assert.strictEqual(t(m, 'customer').note, 'Customers');
  assert.deepStrictEqual(t(m, 'customer').indexes.map((i) => [i.name, i.unique]), [['idx_fk_store_id', false], ['uk', true]]);
  assert.deepStrictEqual(refs(m), ['customer.store_id>store.store_id']);
  assert.deepStrictEqual([m.refs[0].onDelete, m.refs[0].onUpdate, m.refs[0].name], ['restrict', 'cascade', 'fk_customer_store']);
});

test('SQL Server: [names], dbo schema, IDENTITY, GO, WITH CHECK ADD CONSTRAINT, CLUSTERED keys', () => {
  const m = parseSql("CREATE TABLE [dbo].[Album](\n [AlbumId] [int] IDENTITY(1,1) NOT NULL,\n [Title] [nvarchar](160) NOT NULL,\n [ArtistId] [int] NOT NULL,\n CONSTRAINT [PK_Album] PRIMARY KEY CLUSTERED ([AlbumId] ASC) WITH (PAD_INDEX = OFF) ON [PRIMARY]\n) ON [PRIMARY]\nGO\n"
    + "CREATE TABLE [dbo].[Artist]([ArtistId] [int] NOT NULL, [Name] [nvarchar](120) NULL, CONSTRAINT [PK_Artist] PRIMARY KEY CLUSTERED ([ArtistId]))\nGO\n"
    + "CREATE NONCLUSTERED INDEX [IFK_AlbumArtistId] ON [dbo].[Album] ([ArtistId])\nGO\n"
    + "ALTER TABLE [dbo].[Album] WITH CHECK ADD CONSTRAINT [FK_AlbumArtistId] FOREIGN KEY([ArtistId]) REFERENCES [dbo].[Artist] ([ArtistId]) ON DELETE NO ACTION\nGO\nALTER TABLE [dbo].[Album] CHECK CONSTRAINT [FK_AlbumArtistId]\nGO\n");
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.tables.map((x) => x.key), ['Album', 'Artist']);
  assert.strictEqual(c(m, 'Album', 'Title').type, 'nvarchar(160)');
  assert.ok(c(m, 'Album', 'AlbumId').increment && c(m, 'Album', 'AlbumId').pk);
  assert.deepStrictEqual(refs(m), ['Album.ArtistId>Artist.ArtistId']);
  assert.strictEqual(m.refs[0].onDelete, 'no action');
  assert.strictEqual(t(m, 'Album').indexes[0].name, 'IFK_AlbumArtistId');
});

test('SQLite: AUTOINCREMENT, REFERENCES without columns, unique FK is one-to-one, WITHOUT ROWID', () => {
  const m = parseSql('CREATE TABLE b (id INTEGER PRIMARY KEY);\nCREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, b_id INTEGER NOT NULL UNIQUE REFERENCES b, name TEXT DEFAULT (\'x\')) WITHOUT ROWID;\nCREATE INDEX ix ON a (name DESC);');
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(refs(m), ['a.b_id-b.id']);
  assert.deepStrictEqual(c(m, 'a', 'name').dflt, { kind: 'string', value: 'x' });
  assert.ok(c(m, 'a', 'id').increment);
});

test('schemas other than the default keep their name; references across schemas resolve', () => {
  const m = parseSql('CREATE TABLE sales.orders (id int PRIMARY KEY, customer_id int REFERENCES crm.customers(id));\nCREATE TABLE crm.customers (id int PRIMARY KEY);');
  assert.deepStrictEqual(m.tables.map((x) => x.key), ['sales.orders', 'crm.customers']);
  assert.deepStrictEqual(refs(m), ['sales.orders.customer_id>crm.customers.id']);
});

test('references to tables that are not in the file are listed, not errors', () => {
  const m = parseSql('CREATE TABLE a (id int, x int REFERENCES elsewhere(id));\nALTER TABLE missing ADD CONSTRAINT f FOREIGN KEY (x) REFERENCES a(id);');
  assert.deepStrictEqual(m.errors, []);
  assert.strictEqual(m.refs.length, 0);
  assert.ok(m.skipped.some((s) => /elsewhere/.test(s.what)));
  assert.ok(m.skipped.some((s) => /missing/.test(s.what)));
});

test('unterminated string and comment are errors with a line; the rest is read', () => {
  const m = parseSql("CREATE TABLE a (id int);\nCREATE TABLE b (n text DEFAULT 'oops);\n");
  assert.ok(m.errors.some((e) => e.line === 2 && /no closing '/.test(e.message)));
  assert.ok(m.tables.some((x) => x.key === 'a'));
  const m2 = parseSql('CREATE TABLE a (id int); /* never closed');
  assert.ok(m2.errors.some((e) => /comment has no closing/.test(e.message)));
});
