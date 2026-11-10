'use strict';
// Hostile input: every reader ends quickly with a message, never throws, never hangs, and names stay data.
const test = require('node:test');
const assert = require('node:assert');
const { parseDbml } = require('../src/core/dbml');
const { parseSql } = require('../src/core/sql');
const { parsePrisma } = require('../src/core/prisma');
const { parse } = require('../src/core');
const { layout, overlaps } = require('../src/core/layout');
const { runParse, stop } = require('../src/runner');
const { bigDbml, bigSql, XSS } = require('./build');

const timed = (fn) => { const t0 = Date.now(); const r = fn(); return [r, Date.now() - t0]; };

test('1 MB of nested braces, brackets and parentheses: errors, no stack overflow, under 3 s each', () => {
  for (const s of ['{'.repeat(1 << 20), '['.repeat(1 << 20), 'Table a {\n  id int [' + '('.repeat(1 << 20), 'Ref: a.(' + 'x,'.repeat(300000), '}'.repeat(1 << 20)]) {
    for (const p of [parseDbml, parseSql, parsePrisma]) {
      const [m, ms] = timed(() => p(s));
      assert.ok(Array.isArray(m.errors) && m.errors.length <= 201, `${p.name} errors capped`);
      assert.ok(ms < 3000, `${p.name} ${ms} ms`);
    }
  }
});

test('5,000 tables (DBML and SQL) read and lay out in a few seconds', () => {
  const [m, ms] = timed(() => parseDbml(bigDbml(5000)));
  assert.deepStrictEqual([m.tables.length, m.refs.length, m.errors.length], [5000, 4999, 0]);
  const [s, ms2] = timed(() => parseSql(bigSql(5000)));
  assert.deepStrictEqual([s.tables.length, s.refs.length, s.errors.length], [5000, 4999, 0]);
  const [lay, ms3] = timed(() => layout(m));
  assert.deepStrictEqual(overlaps(lay.pos), []);
  assert.ok(ms + ms2 + ms3 < 6000, `${ms} + ${ms2} + ${ms3} ms`);
});

test('cyclic and self references: read, laid out, no loop', () => {
  const src = [];
  for (let i = 0; i < 300; i++) src.push(`Table t${i} { id int [pk]\n next int [ref: > t${(i + 1) % 300}.id]\n me int [ref: > t${i}.id] }`);
  const [m, ms] = timed(() => parseDbml(src.join('\n')));
  assert.deepStrictEqual([m.tables.length, m.refs.length, m.errors.length], [300, 600, 0]);
  assert.deepStrictEqual(overlaps(layout(m).pos), []);
  assert.ok(ms < 2000);
});

test('HTML in names, types and notes stays text in the model', () => {
  const m = parseDbml(`Table "${XSS}" [note: '${XSS}'] { "${XSS}" "${XSS}" [note: '${XSS}'] }`);
  assert.deepStrictEqual(m.errors, []);
  assert.strictEqual(m.tables[0].name, XSS);
  assert.strictEqual(m.tables[0].columns[0].type, XSS);
  const s = parseSql(`CREATE TABLE "${XSS}" ("${XSS}" int); COMMENT ON TABLE "${XSS}" IS '${XSS}';`);
  assert.strictEqual(s.tables[0].note, XSS);
});

test('unterminated strings, comments and blocks of every kind end with a message', () => {
  const cases = ["Table a { id int [note: 'x", 'Table a { id int [note: """', "Note n { '''never", 'Table a { /* never', 'Table "a', 'Table a { id `now(', 'Enum e { a', 'Ref { a.id > b.id', 'Project p {', 'TableGroup g {'];
  for (const c of cases) {
    const m = parseDbml(c);
    assert.ok(m.errors.length >= 1, c);
  }
  for (const c of ["CREATE TABLE a (x text DEFAULT 'oops", 'CREATE TABLE "a (x int)', 'CREATE TABLE a (x int', '$$ never', 'CREATE TABLE [a (x int);']) {
    const m = parseSql(c);
    assert.ok(Array.isArray(m.tables), c);
  }
});

test('huge counts: columns, enum values, refs and errors are capped with a note', () => {
  const cols = Array.from({ length: 2500 }, (_, k) => `  c${k} int`).join('\n');
  const m = parseDbml(`Table wide {\n${cols}\n}`);
  assert.strictEqual(m.tables[0].columns.length, 2000);
  assert.ok(m.errors.some((e) => /more than 2000 columns/.test(e.message)));
  const bad = parseDbml(Array.from({ length: 1000 }, () => 'oops').join('\n'));
  assert.strictEqual(bad.errors.length, 201);
  assert.match(bad.errors[200].message, /only the first 200/);
});

test('random bytes and binary data do not throw', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let k = 0; k < 200; k++) {
    let s = '';
    const n = rnd() % 4000;
    const alphabet = 'Table Ref Enum { } [ ] ( ) , : . > < - <> \' " ` \n /* */ // CREATE TABLE PRIMARY KEY REFERENCES model @relation @@id ~ # $$ x1 _ 0';
    for (let i = 0; i < n; i++) s += rnd() % 3 ? alphabet[rnd() % alphabet.length] : String.fromCharCode(rnd() % 0xffff);
    for (const kind of ['dbml', 'sql', 'prisma']) {
      const m = parse(s, kind);
      layout(m);
    }
  }
});

test('the worker: parses off the host thread and the watchdog stops a job that runs too long', async () => {
  const r = await runParse('Table a { id int [pk] }', 'dbml');
  assert.strictEqual(r.model.tables[0].key, 'a');
  assert.ok(r.layout.pos.a);
  await assert.rejects(runParse(bigDbml(5000), 'dbml', { budgetMs: 5 }), (e) => e.code === 'TIMEOUT');
  const again = await runParse('Table b { id int }', 'dbml');
  assert.strictEqual(again.model.tables[0].key, 'b', 'a new worker answers after the watchdog');
  stop();
});
