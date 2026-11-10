'use strict';
// A vector PDF of the diagram: one page sized to the diagram, Courier (a PDF base font, so nothing is embedded),
// boxes, relation lines and crow's foot ends as paths. Text outside Windows-1252 is written as "?".
const G = require('../../media/geometry');
const { bounds } = require('./layout');
const { THEMES } = require('./svg');

const MAX_PT = 14400; // PDF page size limit (200 inches)

function rgb(hex) {
  let h = String(hex || '#000000').slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((k) => (parseInt(h.slice(k, k + 2), 16) / 255).toFixed(3)).join(' ');
}

const CP1252 = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
function pdfText(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    let b;
    if (c >= 0x20 && c < 0x7F) b = c;
    else if (c >= 0xA0 && c <= 0xFF) b = c;
    else if (CP1252[c]) b = CP1252[c];
    else b = 0x3F;
    if (b === 0x28 || b === 0x29 || b === 0x5C) out += '\\' + String.fromCharCode(b);
    else if (b < 0x80) out += String.fromCharCode(b);
    else out += '\\' + b.toString(8).padStart(3, '0');
  }
  return out;
}

/** Returns a Buffer with the PDF. */
function toPdf(model, pos, opts = {}) {
  const T = THEMES.light;
  const margin = 24;
  const bb = bounds(pos);
  const W0 = bb.w + 2 * margin + 40, H0 = bb.h + 2 * margin;
  const k = Math.min(1, MAX_PT / Math.max(W0, H0, 1));
  const W = Math.max(72, Math.ceil(W0 * k)), H = Math.max(72, Math.ceil(H0 * k));
  const ox = margin - bb.x, oy = margin - bb.y;
  const c = []; // content stream, in diagram pixels; the cm below scales and flips
  c.push(`${k.toFixed(5)} 0 0 ${(-k).toFixed(5)} 0 ${H} cm`);
  c.push(`${rgb(T.bg)} rg 0 0 ${W0.toFixed(1)} ${H0.toFixed(1)} re f`);
  c.push(`1 0 0 1 ${ox.toFixed(1)} ${oy.toFixed(1)} cm`);
  const text = (x, y, s, color, size = G.FONT, bold = false) => {
    // flip back for text so glyphs are upright
    c.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg 1 0 0 -1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${pdfText(s)}) Tj ET`);
  };
  const pathOps = (d) => d.replace(/M(-?[\d.]+) (-?[\d.]+)/g, '$1 $2 m').replace(/L(-?[\d.]+) (-?[\d.]+)/g, '$1 $2 l');
  const byKey = new Map(model.tables.map((t) => [t.key, t]));
  c.push(`${rgb(T.line)} RG 1.2 w`);
  for (const r of model.refs) {
    const tA = byKey.get(r.from.table), tB = byKey.get(r.to.table);
    const bA = pos[r.from.table], bB = pos[r.to.table];
    if (!tA || !tB || !bA || !bB) continue;
    const g = G.relation(r, tA, tB, bA, bB);
    c.push(`${pathOps(g.d)} S`, `${pathOps(g.marks)} S`);
  }
  const box = (b, head, dashed) => {
    c.push(`${rgb(T.box)} rg ${b.x} ${b.y} ${b.w} ${b.h} re f`);
    c.push(`${rgb(head)} rg ${b.x} ${b.y} ${b.w} ${G.HEAD_H} re f`);
    c.push(`${dashed ? '[4 3] 0 d ' : ''}${rgb(T.border)} RG 1 w ${b.x} ${b.y} ${b.w} ${b.h} re S${dashed ? ' [] 0 d' : ''}`);
  };
  for (const t of model.tables) {
    const b = pos[t.key];
    if (!b) continue;
    const tb = G.tableBox(t);
    const hc = G.headerColor(t, model.groups) || T.head;
    box(b, hc, false);
    text(b.x + G.PAD, b.y + G.HEAD_H / 2 + 4, tb.title, G.headerColor(t, model.groups) ? G.textOn(hc) : T.headText, G.FONT, true);
    tb.rows.forEach((row, n) => {
      const y = b.y + G.HEAD_H + n * G.ROW_H;
      if (n % 2 === 1) c.push(`${rgb(T.zebra)} rg ${b.x + 1} ${y} ${b.w - 2} ${G.ROW_H} re f`);
      const ty = y + G.ROW_H / 2 + 4;
      text(b.x + G.PAD, ty, row.name, T.text, G.FONT, !!(row.col && row.col.pk));
      if (row.type) text(b.x + G.PAD + (tb.nameChars + 2) * G.CHAR_W, ty, row.type, T.type);
      if (row.marks) text(b.x + b.w - G.PAD - row.marks.length * 6, ty, row.marks, T.mark, 10);
    });
  }
  for (const e of model.enums) {
    const b = pos[`enum:${e.key}`];
    if (!b) continue;
    const eb = G.enumBox(e);
    box(b, T.enumHead, true);
    text(b.x + G.PAD, b.y + G.HEAD_H / 2 + 4, eb.title, '#FFFFFF', G.FONT, true);
    eb.rows.forEach((row, n) => text(b.x + G.PAD, b.y + G.HEAD_H + n * G.ROW_H + G.ROW_H / 2 + 4, row.name, T.text));
  }
  for (const n of model.notes) {
    const b = pos[`note:${n.name}`];
    if (!b) continue;
    const nb = G.noteBox(n);
    c.push(`${rgb(T.noteBg)} rg ${b.x} ${b.y} ${b.w} ${b.h} re f ${rgb(T.noteBorder)} RG ${b.x} ${b.y} ${b.w} ${b.h} re S`);
    text(b.x + G.PAD, b.y + G.HEAD_H / 2 + 4, nb.title, T.text, G.FONT, true);
    nb.lines.forEach((l, m) => text(b.x + G.PAD, b.y + G.HEAD_H + m * 18 + 10, l, T.text));
  }
  const stream = c.join('\n');
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`;
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';
  objs[6] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  objs[7] = `<< /Title (${pdfText(opts.title || 'ER diagram')}) /Producer (DBML Viewer & ER Diagram) >>`;
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offs = [];
  for (let n = 1; n < objs.length; n++) { offs[n] = Buffer.byteLength(pdf, 'latin1'); pdf += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) pdf += `${String(offs[n]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { buffer: Buffer.from(pdf, 'latin1'), width: W, height: H, scale: k };
}

module.exports = { toPdf, pdfText };
