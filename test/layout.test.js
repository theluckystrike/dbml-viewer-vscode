'use strict';
// Layout: no overlapping boxes (small, cyclic, self references, groups, 200+ grid, 5,000 tables), stable sizes, merge.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseDbml } = require('../src/core/dbml');
const { parseSql } = require('../src/core/sql');
const { layout, merge, overlaps, bounds } = require('../src/core/layout');
const G = require('../media/geometry');
const { bigDbml, bigSql } = require('./build');

test('sample: referenced tables left of the tables that point at them; no overlap', () => {
  const m = parseDbml(fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.dbml'), 'utf8'));
  const { pos } = layout(m);
  assert.deepStrictEqual(overlaps(pos), []);
  assert.ok(pos.countries.x < pos.users.x && pos.users.x < pos.orders.x && pos.orders.x < pos.order_items.x);
  assert.ok(pos['enum:order_status'] && pos['note:shipping']);
  for (const t of m.tables) { const b = G.tableBox(t); assert.deepStrictEqual([pos[t.key].w, pos[t.key].h], [b.w, b.h]); }
});

test('cycles, self references and many-to-many lay out without overlap', () => {
  const m = parseDbml('Table a { id int\n b_id int [ref: > b.id]\n parent int [ref: > a.id] }\nTable b { id int\n c_id int [ref: > c.id] }\nTable c { id int\n a_id int [ref: > a.id] }\nTable d { id int }\nRef: d.id <> a.id');
  assert.deepStrictEqual(m.errors, []);
  const { pos } = layout(m);
  assert.deepStrictEqual(overlaps(pos), []);
  assert.strictEqual(Object.keys(pos).length, 4);
});

test('200 tables or more: grid with no overlap; 5,000 tables in under 3 s', () => {
  for (const n of [199, 200, 1000]) {
    const m = parseDbml(bigDbml(n));
    const { pos } = layout(m);
    assert.strictEqual(Object.keys(pos).length, n);
    assert.deepStrictEqual(overlaps(pos), [], `n=${n}`);
  }
  const t0 = Date.now();
  const m = parseSql(bigSql(5000));
  const { pos } = layout(m);
  assert.strictEqual(Object.keys(pos).length, 5000);
  assert.deepStrictEqual(overlaps(pos), []);
  const b = bounds(pos);
  assert.ok(b.w < b.h * 4 && b.h < b.w * 4, 'roughly square');
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

test('a long chain of 150 tables is split into columns; still no overlap', () => {
  const m = parseDbml(bigDbml(150, 6));
  const { pos } = layout(m);
  assert.deepStrictEqual(overlaps(pos), []);
  const b = bounds(pos);
  assert.ok(b.w < 60000);
});

test('merge: saved positions win, sizes come from the model, unknown keys are dropped', () => {
  const m = parseDbml('Table a { id int }\nTable b { id int\n a int [ref: > a.id] }');
  const auto = layout(m);
  const p = merge(auto, { a: { x: 500, y: 600 }, gone: { x: 1, y: 2 }, b: { x: 'x', y: 1 } });
  assert.deepStrictEqual([p.a.x, p.a.y, p.a.w], [500, 600, auto.pos.a.w]);
  assert.deepStrictEqual(p.b, auto.pos.b);
  assert.ok(!('gone' in p));
});

test('geometry: routes are orthogonal and end on the box sides; crow\'s foot on the many side', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 }, b = { x: 300, y: 50, w: 100, h: 80 };
  const r = G.route(a, 40, b, 70);
  for (let k = 1; k < r.points.length; k++) assert.ok(r.points[k][0] === r.points[k - 1][0] || r.points[k][1] === r.points[k - 1][1]);
  assert.deepStrictEqual([r.points[0], r.points[r.points.length - 1]], [[100, 40], [300, 70]]);
  const self = G.route(a, 40, a, 60, true);
  assert.strictEqual(self.points[0][0], 100);
  assert.deepStrictEqual(G.ends('>'), [true, false]);
  assert.deepStrictEqual(G.ends('<>'), [true, true]);
  assert.match(G.endMark([0, 0], 1, true), /M14 0 L0 -7/);
  assert.strictEqual(G.textOn('#FFFFFF'), '#111111');
  assert.strictEqual(G.headerColor({ group: 'g' }, [{ name: 'g', color: 'red;}' }]), G.GROUP_COLORS[0], 'bad color values are not used');
});
