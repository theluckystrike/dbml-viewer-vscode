'use strict';
// Standalone SVG of the diagram (Copy as SVG, Export SVG, and the source of the PNG export). Every name, type and
// note is escaped; no script, no external reference, fonts are generic families.
const G = require('../../media/geometry');
const { bounds } = require('./layout');

const THEMES = {
  light: { bg: '#FFFFFF', box: '#FFFFFF', border: '#9AA5B1', head: '#2F3B4C', headText: '#FFFFFF', text: '#1F2328', type: '#5A6570', mark: '#9A6700', line: '#6E7781', zebra: '#F4F6F8', enumHead: '#6E5494', noteBg: '#FFF8C5', noteBorder: '#D4A72C' },
  dark: { bg: '#1E1E1E', box: '#252526', border: '#5A5A5A', head: '#3A4556', headText: '#FFFFFF', text: '#D4D4D4', type: '#9CA3AB', mark: '#D7BA7D', line: '#8B949E', zebra: '#2B2B2C', enumHead: '#6E5494', noteBg: '#3B3520', noteBorder: '#8A7A3A' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** pos: { key: {x,y,w,h} } (from layout + saved positions). opts: { theme: 'light'|'dark', margin, title } */
function toSvg(model, pos, opts = {}) {
  const T = THEMES[opts.theme] || THEMES.light;
  const margin = opts.margin == null ? 24 : opts.margin;
  const bb = bounds(pos);
  const W = Math.ceil(bb.w + 2 * margin + 40), H = Math.ceil(bb.h + 2 * margin);
  const ox = margin - bb.x, oy = margin - bb.y;
  const F = `font-family="Menlo, Consolas, 'DejaVu Sans Mono', 'Courier New', monospace" font-size="${G.FONT}"`;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  if (opts.title) out.push(`<title>${esc(opts.title)}</title>`);
  out.push(`<rect width="100%" height="100%" fill="${T.bg}"/>`);
  out.push(`<g transform="translate(${ox} ${oy})" ${F}>`);
  const byKey = new Map(model.tables.map((t) => [t.key, t]));
  // relations under the boxes
  out.push(`<g fill="none" stroke="${T.line}" stroke-width="1.4">`);
  for (const r of model.refs) {
    const tA = byKey.get(r.from.table), tB = byKey.get(r.to.table);
    const bA = pos[r.from.table], bB = pos[r.to.table];
    if (!tA || !tB || !bA || !bB) continue;
    const g = G.relation(r, tA, tB, bA, bB);
    out.push(`<path d="${g.d}"/><path d="${g.marks}"/>`);
  }
  out.push('</g>');
  for (const t of model.tables) {
    const b = pos[t.key];
    if (!b) continue;
    const box = G.tableBox(t);
    const hc = G.headerColor(t, model.groups) || T.head;
    const ht = G.headerColor(t, model.groups) ? G.textOn(hc) : T.headText;
    out.push(`<g>`);
    if (t.note) out.push(`<title>${esc(t.note)}</title>`);
    out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${T.box}" stroke="${T.border}"/>`);
    out.push(`<path d="M${b.x} ${b.y + G.HEAD_H} V${b.y + 6} a6 6 0 0 1 6 -6 H${b.x + b.w - 6} a6 6 0 0 1 6 6 V${b.y + G.HEAD_H} Z" fill="${hc}"/>`);
    out.push(`<text x="${b.x + G.PAD}" y="${b.y + G.HEAD_H / 2 + 4}" fill="${ht}" font-weight="bold">${esc(box.title)}</text>`);
    box.rows.forEach((row, k) => {
      const y = b.y + G.HEAD_H + k * G.ROW_H;
      if (k % 2 === 1) out.push(`<rect x="${b.x + 1}" y="${y}" width="${b.w - 2}" height="${G.ROW_H}" fill="${T.zebra}"/>`);
      const ty = y + G.ROW_H / 2 + 4;
      out.push(`<text x="${b.x + G.PAD}" y="${ty}" fill="${T.text}"${row.col && row.col.pk ? ' font-weight="bold"' : ''}${row.more ? ' font-style="italic"' : ''}>${row.col && row.col.note ? `<title>${esc(row.col.note)}</title>` : ''}${esc(row.name)}</text>`);
      if (row.type) out.push(`<text x="${b.x + G.PAD + (box.nameChars + 2) * G.CHAR_W}" y="${ty}" fill="${T.type}">${esc(row.type)}</text>`);
      if (row.marks) out.push(`<text x="${b.x + b.w - G.PAD}" y="${ty}" fill="${T.mark}" text-anchor="end" font-size="10">${esc(row.marks)}</text>`);
    });
    out.push('</g>');
  }
  for (const e of model.enums) {
    const b = pos[`enum:${e.key}`];
    if (!b) continue;
    const box = G.enumBox(e);
    out.push(`<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${T.box}" stroke="${T.border}" stroke-dasharray="4 3"/>`);
    out.push(`<path d="M${b.x} ${b.y + G.HEAD_H} V${b.y + 6} a6 6 0 0 1 6 -6 H${b.x + b.w - 6} a6 6 0 0 1 6 6 V${b.y + G.HEAD_H} Z" fill="${T.enumHead}"/>`);
    out.push(`<text x="${b.x + G.PAD}" y="${b.y + G.HEAD_H / 2 + 4}" fill="#FFFFFF" font-weight="bold">${esc(box.title)}</text>`);
    box.rows.forEach((row, k) => { out.push(`<text x="${b.x + G.PAD}" y="${b.y + G.HEAD_H + k * G.ROW_H + G.ROW_H / 2 + 4}" fill="${T.text}">${row.note ? `<title>${esc(row.note)}</title>` : ''}${esc(row.name)}</text>`); });
    out.push('</g>');
  }
  for (const n of model.notes) {
    const b = pos[`note:${n.name}`];
    if (!b) continue;
    const box = G.noteBox(n);
    out.push(`<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4" fill="${T.noteBg}" stroke="${T.noteBorder}"/>`);
    out.push(`<text x="${b.x + G.PAD}" y="${b.y + G.HEAD_H / 2 + 4}" fill="${T.text}" font-weight="bold">${esc(box.title)}</text>`);
    box.lines.forEach((l, k) => { out.push(`<text x="${b.x + G.PAD}" y="${b.y + G.HEAD_H + k * 18 + 10}" fill="${T.text}">${esc(l)}</text>`); });
    out.push('</g>');
  }
  out.push('</g></svg>');
  return { svg: out.join('\n'), width: W, height: H };
}

module.exports = { toSvg, esc, THEMES };
