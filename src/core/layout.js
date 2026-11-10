'use strict';
// Automatic layout: tables in layers by reference direction (referenced tables on the left, the tables that point
// at them to the right), ordered by the barycentre of their neighbours, tall layers split into columns. Tables with no
// relation, enums and sticky notes go in a grid below. 200 tables or more: a grid ordered by group and by relation
// (breadth first), which stays fast and readable. Boxes never overlap: every box gets its own slot.
const G = require('../../media/geometry');

const GAP_X = 96, GAP_Y = 34, SUB_GAP = 56;

function nodeKey(kind, key) { return kind === 'table' ? key : `${kind}:${key}`; }

function boxesOf(model) {
  const nodes = [];
  for (const t of model.tables) { const b = G.tableBox(t); nodes.push({ key: t.key, kind: 'table', w: b.w, h: b.h, group: t.group || '', name: t.name }); }
  for (const e of model.enums) { const b = G.enumBox(e); nodes.push({ key: nodeKey('enum', e.key), kind: 'enum', w: b.w, h: b.h, group: '', name: e.name }); }
  for (const n of model.notes) { const b = G.noteBox(n); nodes.push({ key: nodeKey('note', n.name), kind: 'note', w: b.w, h: b.h, group: '', name: n.name }); }
  return nodes;
}

function gridPlace(list, x0, y0, cols, pos) {
  let y = y0, maxW = 0;
  const colW = [];
  for (let k = 0; k < list.length; k++) { const c = k % cols; colW[c] = Math.max(colW[c] || 0, list[k].w); }
  const colX = []; let cx = x0;
  for (let c = 0; c < cols; c++) { colX[c] = cx; cx += (colW[c] || 0) + GAP_X * 0.6; }
  for (let r = 0; r * cols < list.length; r++) {
    const row = list.slice(r * cols, r * cols + cols);
    let rh = 0;
    row.forEach((n, c) => { pos[n.key] = { x: Math.round(colX[c]), y: Math.round(y), w: n.w, h: n.h }; rh = Math.max(rh, n.h); });
    y += rh + GAP_Y;
  }
  maxW = cx - x0;
  return { w: maxW, h: y - y0 };
}

function layout(model, opts = {}) {
  const nodes = boxesOf(model);
  const pos = {};
  const tables = nodes.filter((n) => n.kind === 'table');
  const others = nodes.filter((n) => n.kind !== 'table');
  const idx = new Map(tables.map((n, k) => [n.key, k]));
  const parents = tables.map(() => new Set()), children = tables.map(() => new Set());
  for (const r of model.refs) {
    let p = r.to.table, c = r.from.table;
    if (r.rel === '<') { p = r.from.table; c = r.to.table; }
    const pi = idx.get(p), ci = idx.get(c);
    if (pi === undefined || ci === undefined || pi === ci) continue;
    parents[ci].add(pi); children[pi].add(ci);
  }
  const grid = tables.length >= (opts.gridFrom || 200);
  let width = 0, height = 0;

  if (grid) {
    // breadth-first over relations so related tables sit near each other; groups first
    const order = [];
    const seen = new Uint8Array(tables.length);
    const byGroup = [...tables.keys()].sort((a, b) => (tables[a].group || '￿').localeCompare(tables[b].group || '￿') || tables[a].name.localeCompare(tables[b].name));
    for (const s of byGroup) {
      if (seen[s]) continue;
      const q = [s]; seen[s] = 1;
      for (let h = 0; h < q.length; h++) {
        order.push(q[h]);
        for (const nb of [...children[q[h]], ...parents[q[h]]]) if (!seen[nb]) { seen[nb] = 1; q.push(nb); }
      }
    }
    const cols = Math.max(1, Math.ceil(Math.sqrt(order.length * 1.4)));
    const r = gridPlace(order.map((k) => tables[k]), 0, 0, cols, pos);
    width = r.w; height = r.h;
  } else {
    const connected = tables.map((_, k) => parents[k].size + children[k].size > 0);
    // break cycles: iterative DFS, drop edges to nodes on the stack
    const state = new Uint8Array(tables.length); // 0 new, 1 on stack, 2 done
    const P = parents.map((s) => new Set(s));
    const C = children.map((s) => new Set(s));
    for (let s = 0; s < tables.length; s++) {
      if (state[s] || !connected[s]) continue;
      const stack = [[s, [...C[s]], 0]];
      state[s] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top[2] >= top[1].length) { state[top[0]] = 2; stack.pop(); continue; }
        const nb = top[1][top[2]++];
        if (state[nb] === 1) { C[top[0]].delete(nb); P[nb].delete(top[0]); continue; }
        if (state[nb] === 0) { state[nb] = 1; stack.push([nb, [...C[nb]], 0]); }
      }
    }
    // longest path layering (Kahn)
    const layer = new Int32Array(tables.length);
    const indeg = P.map((s) => s.size);
    const q = [];
    for (let k = 0; k < tables.length; k++) if (connected[k] && indeg[k] === 0) q.push(k);
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (const v of C[u]) { layer[v] = Math.max(layer[v], layer[u] + 1); if (--indeg[v] === 0) q.push(v); }
    }
    const layers = [];
    for (let k = 0; k < tables.length; k++) if (connected[k]) (layers[layer[k]] = layers[layer[k]] || []).push(k);
    for (let L = 0; L < layers.length; L++) if (!layers[L]) layers[L] = [];
    for (const L of layers) L.sort((a, b) => (tables[a].group || '').localeCompare(tables[b].group || '') || tables[a].name.localeCompare(tables[b].name));
    // barycentre sweeps
    const rank = new Float64Array(tables.length);
    const setRank = () => { for (const L of layers) L.forEach((k, r) => { rank[k] = r; }); };
    setRank();
    for (let sweep = 0; sweep < 6; sweep++) {
      const down = sweep % 2 === 0;
      const seq = down ? layers.slice(1) : layers.slice(0, -1).reverse();
      for (const L of seq) {
        const bc = new Map();
        for (const k of L) {
          const nb = down ? [...parents[k]] : [...children[k]];
          bc.set(k, nb.length ? nb.reduce((s, x) => s + rank[x], 0) / nb.length : rank[k]);
        }
        L.sort((a, b) => bc.get(a) - bc.get(b));
        L.forEach((k, r) => { rank[k] = r; });
      }
    }
    // place layers as columns; split a tall layer into sub-columns
    const totalArea = tables.reduce((s, n) => s + (n.w + GAP_X) * (n.h + GAP_Y), 0);
    const maxH = Math.max(900, Math.sqrt(totalArea) * 1.1);
    let x = 0;
    const colsOut = [];
    for (const L of layers) {
      if (!L.length) continue;
      let sub = [], subH = 0;
      const subs = [];
      for (const k of L) {
        const h = tables[k].h + GAP_Y;
        if (sub.length && subH + h > maxH) { subs.push(sub); sub = []; subH = 0; }
        sub.push(k); subH += h;
      }
      if (sub.length) subs.push(sub);
      for (const s of subs) {
        const w = Math.max(...s.map((k) => tables[k].w));
        const h = s.reduce((acc, k) => acc + tables[k].h + GAP_Y, -GAP_Y);
        colsOut.push({ x, w, h, s });
        x += w + (subs.length > 1 && s !== subs[subs.length - 1] ? SUB_GAP : GAP_X);
      }
    }
    const tallest = Math.max(0, ...colsOut.map((c) => c.h));
    for (const c of colsOut) {
      let y = Math.round((tallest - c.h) / 2);
      for (const k of c.s) { pos[tables[k].key] = { x: Math.round(c.x), y, w: tables[k].w, h: tables[k].h }; y += tables[k].h + GAP_Y; }
    }
    width = colsOut.length ? x - GAP_X : 0;
    height = tallest;
    // tables with no relation: a grid below (or alone)
    const lone = tables.filter((_, k) => !connected[k]);
    if (lone.length) {
      const y0 = height ? height + GAP_Y * 2 : 0;
      const cols = Math.max(1, Math.min(lone.length, Math.max(Math.ceil(Math.sqrt(lone.length * 1.5)), Math.floor(Math.max(width, 900) / 260))));
      const r = gridPlace(lone, 0, y0, cols, pos);
      width = Math.max(width, r.w); height = y0 + r.h;
    }
  }
  if (others.length) {
    const y0 = height ? height + GAP_Y * 2 : 0;
    const cols = Math.max(1, Math.min(others.length, Math.floor(Math.max(width, 900) / 240)));
    const r = gridPlace(others, 0, y0, cols, pos);
    width = Math.max(width, r.w); height = y0 + r.h;
  }
  return { pos, width: Math.round(width), height: Math.round(height) };
}

/** Saved positions (dragged boxes) over the automatic layout; unknown keys are dropped, sizes always recomputed. */
function merge(auto, saved) {
  const pos = {};
  for (const [k, b] of Object.entries(auto.pos)) {
    const s = saved && saved[k];
    pos[k] = s && Number.isFinite(s.x) && Number.isFinite(s.y) ? { x: Math.round(s.x), y: Math.round(s.y), w: b.w, h: b.h } : b;
  }
  return pos;
}

function bounds(pos) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of Object.values(pos)) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function overlaps(pos) {
  const list = Object.entries(pos).sort((a, b) => a[1].x - b[1].x);
  const out = [];
  for (let a = 0; a < list.length; a++) {
    const A = list[a][1];
    for (let b = a + 1; b < list.length && list[b][1].x < A.x + A.w; b++) {
      const B = list[b][1];
      if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) out.push([list[a][0], list[b][0]]);
    }
  }
  return out;
}

module.exports = { layout, merge, bounds, overlaps, nodeKey, boxesOf };
