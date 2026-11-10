// Diagram geometry shared by the webview (live diagram) and the extension host (layout, SVG, PNG and PDF export):
// box sizes, column anchors, orthogonal relation routes and crow's foot ends. Plain functions, no DOM, no vscode.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZovoGeom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const G = {
    FONT: 12,            // px, monospace
    CHAR_W: 7.25,        // advance of one monospace character at 12 px (Menlo 7.22, Consolas 6.6, Courier 7.2)
    ROW_H: 22,
    HEAD_H: 30,
    PAD: 10,
    MIN_W: 150,
    MAX_W: 460,
    MAX_ROWS: 80,        // more columns: the box shows the first 80 and a "+ n more" row
    STUB: 18,
  };

  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; }

  function markers(c) {
    let m = '';
    if (c.pk) m += 'PK ';
    if (c.fk) m += 'FK ';
    if (c.unique && !c.pk) m += 'U ';
    if (c.notNull && !c.pk) m += 'NN ';
    return m.trim();
  }

  /** Text layout of a table box: { w, h, title, rows: [{ name, type, marks, more? }] } */
  function tableBox(t) {
    const title = (t.schema && !/^(public|dbo|main)$/i.test(t.schema) ? t.schema + '.' : '') + t.name;
    const cols = t.columns || [];
    const shown = cols.length > G.MAX_ROWS ? cols.slice(0, G.MAX_ROWS - 1) : cols;
    const nameLen = Math.min(28, Math.max(4, ...shown.map((c) => String(c.name).length)));
    const typeLen = Math.min(24, Math.max(0, ...shown.map((c) => String(c.type || '').length)));
    const markLen = Math.max(0, ...shown.map((c) => markers(c).length));
    const rowChars = nameLen + 2 + typeLen + (markLen ? 2 + markLen : 0);
    const chars = Math.max(rowChars, Math.min(40, title.length + 2));
    const w = Math.round(Math.min(G.MAX_W, Math.max(G.MIN_W, chars * G.CHAR_W + 2 * G.PAD)));
    const avail = Math.floor((w - 2 * G.PAD) / G.CHAR_W);
    const rows = shown.map((c) => ({ name: clip(c.name, nameLen), type: clip(c.type || '', Math.max(4, avail - nameLen - 2 - (markLen ? markLen + 2 : 0))), marks: markers(c), col: c }));
    if (cols.length > shown.length) rows.push({ name: `+ ${cols.length - shown.length} more columns`, type: '', marks: '', more: true });
    const h = G.HEAD_H + Math.max(1, rows.length) * G.ROW_H + 4;
    return { w, h, title: clip(title, Math.floor((w - 2 * G.PAD) / G.CHAR_W)), rows, nameChars: nameLen };
  }

  function enumBox(e) {
    const title = 'enum ' + ((e.schema && !/^(public|dbo|main)$/i.test(e.schema) ? e.schema + '.' : '') + e.name);
    const vals = (e.values || []).slice(0, G.MAX_ROWS);
    const chars = Math.max(Math.min(40, title.length + 2), ...vals.map((v) => Math.min(40, String(v.name).length)));
    const w = Math.round(Math.min(G.MAX_W, Math.max(120, chars * G.CHAR_W + 2 * G.PAD)));
    const rows = vals.map((v) => ({ name: clip(v.name, 40), type: '', marks: '', note: v.note }));
    if ((e.values || []).length > vals.length) rows.push({ name: `+ ${e.values.length - vals.length} more values`, more: true });
    return { w, h: G.HEAD_H + Math.max(1, rows.length) * G.ROW_H + 4, title: clip(title, 40), rows };
  }

  function noteBox(n) {
    const lines = String(n.text || '').split('\n').slice(0, 12).map((l) => clip(l, 48));
    const chars = Math.max(Math.min(40, String(n.name).length + 2), ...lines.map((l) => l.length));
    const w = Math.round(Math.min(G.MAX_W, Math.max(140, chars * G.CHAR_W + 2 * G.PAD)));
    return { w, h: G.HEAD_H + Math.max(1, lines.length) * 18 + 10, title: clip(n.name, 40), lines };
  }

  /** y of a column row centre inside a box (row index; -1 = the header) */
  function rowY(box, idx) {
    if (idx < 0 || idx == null) return box.y + G.HEAD_H / 2;
    const r = Math.min(idx, G.MAX_ROWS - 1);
    return box.y + G.HEAD_H + r * G.ROW_H + G.ROW_H / 2;
  }

  /**
   * Orthogonal route between two boxes. a, b: { x, y, w, h }; ya, yb: anchor y. Returns
   * { points: [[x,y]...], da, db } where da/db is the side (-1 left, +1 right) where the line leaves a / enters b.
   */
  function route(a, ya, b, yb, self) {
    const S = G.STUB;
    if (self || a === b) {
      const x = a.x + a.w;
      const off = S + 10;
      if (Math.abs(ya - yb) < 4) yb = ya + 8;
      return { points: [[x, ya], [x + off, ya], [x + off, yb], [x, yb]], da: 1, db: 1 };
    }
    const aR = a.x + a.w, bR = b.x + b.w;
    if (b.x >= aR + 2 * S) { // b right of a: the vertical part runs in the free gap just before b
      const mx = Math.round(Math.max((aR + b.x) / 2, b.x - S - 14));
      return { points: [[aR, ya], [mx, ya], [mx, yb], [b.x, yb]], da: 1, db: -1 };
    }
    if (a.x >= bR + 2 * S) { // b left of a: the vertical part runs in the free gap just after b
      const mx = Math.round(Math.min((a.x + bR) / 2, bR + S + 14));
      return { points: [[a.x, ya], [mx, ya], [mx, yb], [bR, yb]], da: -1, db: 1 };
    }
    // overlapping in x: go around on the right side of both
    const ox = Math.max(aR, bR) + S + 6;
    return { points: [[aR, ya], [ox, ya], [ox, yb], [bR, yb]], da: 1, db: 1 };
  }

  /** SVG path data of a polyline with small rounded corners */
  function pathD(points) {
    let d = `M${points[0][0]} ${points[0][1]}`;
    for (let k = 1; k < points.length; k++) d += ` L${points[k][0]} ${points[k][1]}`;
    return d;
  }

  /**
   * Crow's foot end at point p on a box side (side -1 left, +1 right; the line leaves outward).
   * many: three prongs meeting 14 px out; one: a bar 9 px out. Returns path data.
   */
  function endMark(p, side, many) {
    const [x, y] = p;
    if (many) {
      const tip = x + side * 14;
      return `M${tip} ${y} L${x} ${y - 7} M${tip} ${y} L${x} ${y} M${tip} ${y} L${x} ${y + 7} M${x + side * 18} ${y - 6} L${x + side * 18} ${y + 6}`;
    }
    return `M${x + side * 9} ${y - 6} L${x + side * 9} ${y + 6} M${x + side * 14} ${y - 6} L${x + side * 14} ${y + 6}`;
  }

  /** many/one at each end for a relation type: > many-to-one, < one-to-many, - one-to-one, <> many-to-many */
  function ends(rel) {
    if (rel === '>') return [true, false];
    if (rel === '<') return [false, true];
    if (rel === '<>') return [true, true];
    return [false, false];
  }

  const GROUP_COLORS = ['#3B82C4', '#2E9E6B', '#B5651D', '#8E5BB5', '#C2405A', '#2A9BA8', '#6B7A1F', '#A0522D', '#4F6BD8', '#7A7A7A'];
  function validColor(c) { return typeof c === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c) ? c : ''; }
  /** Header colour: the table's own headercolor, its group's color, a colour per group, or '' (theme default). */
  function headerColor(t, groups) {
    const own = validColor(t.headerColor);
    if (own) return own;
    if (!t.group) return '';
    const gi = (groups || []).findIndex((g) => g.name === t.group);
    const g = gi >= 0 ? groups[gi] : null;
    return validColor(g && g.color) || GROUP_COLORS[Math.max(0, gi) % GROUP_COLORS.length];
  }
  /** Black or white text on a header colour */
  function textOn(hex) {
    if (!hex) return '';
    let h = hex.slice(1); if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#111111' : '#FFFFFF';
  }

  /** Route of one relation: tables tA/tB (model), boxes bA/bB ({x,y,w,h}). Returns { d, marks, a: [x,y], b: [x,y] }. */
  function relation(r, tA, tB, bA, bB) {
    const ia = tA.columns.findIndex((c) => c.name === r.from.columns[0]);
    const ib = tB.columns.findIndex((c) => c.name === r.to.columns[0]);
    const ya = rowY(bA, ia), yb = rowY(bB, ib);
    const rt = route(bA, ya, bB, yb, tA === tB);
    const [ma, mb] = ends(r.rel);
    const pA = rt.points[0], pB = rt.points[rt.points.length - 1];
    return { d: pathD(rt.points), marks: endMark(pA, rt.da, ma) + ' ' + endMark(pB, rt.db, mb), a: pA, b: pB, ia, ib };
  }

  return Object.assign(G, { relation, clip, markers, tableBox, enumBox, noteBox, rowY, route, pathD, endMark, ends, headerColor, textOn, validColor, GROUP_COLORS });
});
