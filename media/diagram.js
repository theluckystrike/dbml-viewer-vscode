// ER diagram webview. Draws the schema model from the extension host as SVG built with DOM calls (every name, type
// and note goes in with textContent), routes relations with geometry.js, and handles zoom, pan, drag, search, hover
// and click-to-jump. No network: everything arrives by postMessage. Styles go through the CSSOM (CSP has no
// 'unsafe-inline').
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const G = window.ZovoGeom;
  const NS = 'http://www.w3.org/2000/svg';
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let view = saved.view || null; // { x, y, k }
  let model = null, pos = {}, pro = { show: true, licensed: false, tries: {} }, name = '', kind = 'dbml';
  let edges = []; // { r, g, line, mark, hit, a, b }
  const nodeEls = new Map();
  let ui = null;
  let searchHits = [], searchIdx = -1;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const sv = (tag, attrs, cls) => { const e = document.createElementNS(NS, tag); if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]); if (cls) e.setAttribute('class', cls); return e; };
  const post = (m) => vscode.postMessage(m);

  function buildUi() {
    app.textContent = '';
    const bar = el('div', 'bar');
    const search = el('input'); search.type = 'search'; search.placeholder = 'Find a table'; search.className = 'search'; search.setAttribute('aria-label', 'Find a table');
    const btn = (label, act, title) => { const b = el('button', '', label); b.dataset.act = act; if (title) b.title = title; return b; };
    const zoomLabel = el('span', 'zoom', '100%');
    bar.append(search, btn('Fit', 'fit', 'Fit the whole diagram in the window'), btn('−', 'zoomOut', 'Zoom out (Ctrl or Cmd + wheel)'), zoomLabel, btn('+', 'zoomIn', 'Zoom in'),
      btn('Reset layout', 'reset', 'Forget the positions you dragged and lay out the tables again'), btn('Copy SVG', 'copySvg', 'Copy the diagram as an SVG image (free)'));
    const proBox = el('span', 'protools');
    const sep = el('span', 'sep');
    const tool = (label, t) => { const b = el('button', '', label); b.dataset.tool = t; return b; };
    proBox.append(sep, tool('Export SQL', 'exportSql'), tool('Export image', 'exportImage'), tool('Compare schemas', 'diff'));
    bar.append(proBox);
    const status = el('span', 'status');
    bar.append(status);
    const msgs = el('div', 'msgs');
    msgs.hidden = true;
    const stage = el('div', 'stage');
    const svg = sv('svg', { role: 'img', 'aria-label': 'ER diagram' });
    const vp = sv('g', { class: 'vp' });
    const gEdges = sv('g', { class: 'edges' });
    const gNodes = sv('g', { class: 'nodes' });
    vp.append(gEdges, gNodes);
    svg.append(vp);
    const empty = el('div', 'empty');
    empty.hidden = true;
    const tip = el('div', 'tip');
    stage.append(svg, empty, tip);
    app.append(bar, msgs, stage);
    const ft = document.getElementById('zovo-footer');
    if (ft && ft.content) app.append(ft.content.cloneNode(true));
    ui = { bar, search, zoomLabel, proBox, status, msgs, stage, svg, vp, gEdges, gNodes, empty, tip };

    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) { post({ type: 'tool', tool: b.dataset.tool, pos: currentPos() }); return; }
      const a = b.dataset.act;
      if (a === 'fit') fit();
      else if (a === 'zoomIn') zoomAt(1.25);
      else if (a === 'zoomOut') zoomAt(0.8);
      else if (a === 'reset') post({ type: 'reset' });
      else if (a === 'copySvg') post({ type: 'copySvg', pos: currentPos() });
    });
    search.addEventListener('input', () => runSearch(search.value, false));
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(search.value, true, e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { search.value = ''; runSearch('', false); } });
    wirePanZoom();
  }

  // ---------------- view transform ----------------
  function applyView() {
    if (!view) return;
    ui.vp.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    ui.zoomLabel.textContent = `${Math.round(view.k * 100)}%`;
    vscode.setState({ view });
  }
  function bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k in pos) { const b = pos[k]; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 1, h: 1 };
  }
  function fit() {
    const r = ui.stage.getBoundingClientRect();
    const b = bounds();
    const W = Math.max(100, r.width), H = Math.max(100, r.height);
    const k = Math.max(0.05, Math.min(1.25, Math.min((W - 40) / Math.max(1, b.w + 40), (H - 40) / Math.max(1, b.h))));
    view = { k, x: (W - b.w * k) / 2 - b.x * k, y: (H - b.h * k) / 2 - b.y * k };
    applyView();
  }
  function zoomAt(f, cx, cy) {
    if (!view) fit();
    const r = ui.stage.getBoundingClientRect();
    if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
    const k = Math.max(0.05, Math.min(4, view.k * f));
    view = { k, x: cx - (cx - view.x) * (k / view.k), y: cy - (cy - view.y) * (k / view.k) };
    applyView();
  }
  function centerOn(key) {
    const b = pos[key];
    if (!b) return;
    const r = ui.stage.getBoundingClientRect();
    if (!view) fit();
    const k = Math.max(view.k, 0.8);
    view = { k, x: r.width / 2 - (b.x + b.w / 2) * k, y: r.height / 2 - (b.y + b.h / 2) * k };
    applyView();
  }

  function wirePanZoom() {
    let pan = null, drag = null;
    ui.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!view) fit();
      const r = ui.stage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
      else { view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY }; applyView(); }
    }, { passive: false });
    ui.svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const node = e.target.closest('.node');
      if (node) {
        const key = node.dataset.key;
        drag = { key, node, sx: e.clientX, sy: e.clientY, ox: pos[key].x, oy: pos[key].y, moved: false, row: e.target.closest('.row') };
        node.classList.add('dragging');
      } else pan = { sx: e.clientX, sy: e.clientY, vx: view ? view.x : 0, vy: view ? view.y : 0 };
      ui.svg.setPointerCapture(e.pointerId);
      if (pan) ui.stage.classList.add('panning');
    });
    ui.svg.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = (e.clientX - drag.sx) / view.k, dy = (e.clientY - drag.sy) / view.k;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4 / view.k) return;
        drag.moved = true;
        pos[drag.key] = { ...pos[drag.key], x: Math.round(drag.ox + dx), y: Math.round(drag.oy + dy) };
        drag.node.setAttribute('transform', `translate(${pos[drag.key].x} ${pos[drag.key].y})`);
        rerouteFor(drag.key);
        hideTip();
        return;
      }
      if (pan) { view = { ...view, x: pan.vx + e.clientX - pan.sx, y: pan.vy + e.clientY - pan.sy }; applyView(); return; }
      hover(e);
    });
    const end = (e) => {
      if (drag) {
        drag.node.classList.remove('dragging');
        if (drag.moved) post({ type: 'moved', key: drag.key, x: pos[drag.key].x, y: pos[drag.key].y });
        else post({ type: 'reveal', key: drag.key, row: drag.row ? Number(drag.row.dataset.row) : -1 });
      }
      drag = null; pan = null;
      ui.stage.classList.remove('panning');
      try { ui.svg.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
    };
    ui.svg.addEventListener('pointerup', end);
    ui.svg.addEventListener('pointercancel', end);
    ui.svg.addEventListener('pointerleave', () => { if (!drag && !pan) { hideTip(); unhighlight(); } });
    window.addEventListener('keydown', (e) => {
      if (e.target === ui.search) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); ui.search.focus(); ui.search.select(); }
      else if (e.key === '+' || e.key === '=') zoomAt(1.25);
      else if (e.key === '-') zoomAt(0.8);
      else if (e.key === '0') fit();
    });
    window.addEventListener('resize', () => { if (!view) fit(); });
  }

  // ---------------- hover: relation highlight and notes ----------------
  let hlEdge = null;
  function unhighlight() {
    if (!hlEdge) return;
    hlEdge.g.classList.remove('hl');
    for (const r of hlEdge.rows) r.classList.remove('hl');
    hlEdge = null;
  }
  function hover(e) {
    const g = e.target.closest('.rel');
    if (g) {
      const ed = edges[Number(g.dataset.i)];
      if (ed && hlEdge !== ed) {
        unhighlight();
        ed.g.classList.add('hl');
        ed.rows = [rowEl(ed.r.from.table, ed.ia), rowEl(ed.r.to.table, ed.ib)].filter(Boolean);
        for (const r of ed.rows) r.classList.add('hl');
        hlEdge = ed;
        const kindText = { '>': 'many-to-one', '<': 'one-to-many', '-': 'one-to-one', '<>': 'many-to-many' }[ed.r.rel] || ed.r.rel;
        showTip(e, `${ed.r.from.table}.${ed.r.from.columns.join(', ')} ${ed.r.rel} ${ed.r.to.table}.${ed.r.to.columns.join(', ')}\n${kindText}${ed.r.onDelete ? `, on delete ${ed.r.onDelete}` : ''}${ed.r.onUpdate ? `, on update ${ed.r.onUpdate}` : ''}`);
      } else if (ed) moveTip(e);
      return;
    }
    unhighlight();
    const row = e.target.closest('.row');
    const node = e.target.closest('.node');
    if (row && row.dataset.note) { showTip(e, row.dataset.note); return; }
    if (node && !row && node.dataset.note) { showTip(e, node.dataset.note); return; }
    hideTip();
  }
  function rowEl(key, idx) { const n = nodeEls.get(key); return n && idx >= 0 ? n.querySelector(`.row[data-row="${Math.min(idx, G.MAX_ROWS - 1)}"]`) : null; }
  function showTip(e, text) { ui.tip.textContent = text; ui.tip.style.setProperty('display', 'block'); moveTip(e); }
  function moveTip(e) {
    const r = ui.stage.getBoundingClientRect();
    const x = Math.min(e.clientX - r.left + 14, r.width - 300), y = Math.min(e.clientY - r.top + 16, r.height - 60);
    ui.tip.style.setProperty('left', `${Math.max(4, x)}px`); ui.tip.style.setProperty('top', `${Math.max(4, y)}px`);
  }
  function hideTip() { ui.tip.style.setProperty('display', 'none'); }

  // ---------------- search ----------------
  function runSearch(q, jump, dir = 1) {
    q = String(q || '').trim().toLowerCase();
    for (const n of nodeEls.values()) n.classList.remove('match', 'current', 'dim');
    for (const ed of edges) ed.g.classList.remove('dim');
    searchHits = [];
    if (!q) { searchIdx = -1; setStatus(); return; }
    for (const [k, n] of nodeEls) { const nm = (n.dataset.name || '').toLowerCase(); if (nm.includes(q) || k.toLowerCase().includes(q)) searchHits.push(k); }
    searchHits.sort((a, b) => (a.toLowerCase() === q ? -1 : b.toLowerCase() === q ? 1 : a.localeCompare(b)));
    for (const [k, n] of nodeEls) n.classList.add(searchHits.includes(k) ? 'match' : 'dim');
    for (const ed of edges) if (!searchHits.includes(ed.r.from.table) && !searchHits.includes(ed.r.to.table)) ed.g.classList.add('dim');
    if (!searchHits.length) { ui.status.textContent = 'No table matches.'; return; }
    if (jump) searchIdx = (searchIdx + dir + searchHits.length) % searchHits.length; else searchIdx = 0;
    const cur = nodeEls.get(searchHits[searchIdx]);
    if (cur) cur.classList.add('current');
    if (jump || searchHits.length === 1) centerOn(searchHits[searchIdx]);
    ui.status.textContent = `${searchHits.length} match${searchHits.length === 1 ? '' : 'es'}${searchHits.length > 1 ? ` (${searchIdx + 1} of ${searchHits.length}, Enter for the next)` : ''}`;
  }

  // ---------------- drawing ----------------
  function currentPos() { const o = {}; for (const k in pos) o[k] = { x: pos[k].x, y: pos[k].y }; return o; }

  function drawTable(t) {
    const b = pos[t.key];
    const box = G.tableBox(t);
    const g = sv('g', { transform: `translate(${b.x} ${b.y})`, 'data-key': t.key }, 'node table');
    g.dataset.key = t.key; g.dataset.name = t.name;
    if (t.note) g.dataset.note = t.note;
    g.append(sv('rect', { x: 0, y: 0, width: b.w, height: b.h, rx: 6 }, 'box'));
    const hc = G.headerColor(t, model.groups);
    const head = sv('path', { d: `M0 ${G.HEAD_H} V6 a6 6 0 0 1 6 -6 H${b.w - 6} a6 6 0 0 1 6 6 V${G.HEAD_H} Z` }, hc ? 'headc' : 'head');
    if (hc) head.setAttribute('fill', hc);
    const title = sv('text', { x: G.PAD, y: G.HEAD_H / 2 + 4 }, 'title');
    title.textContent = box.title;
    if (hc) { title.setAttribute('class', 'titlec'); title.setAttribute('fill', G.textOn(hc)); title.setAttribute('font-weight', 'bold'); }
    g.append(head, title);
    box.rows.forEach((row, k) => {
      const y = G.HEAD_H + k * G.ROW_H;
      const rg = sv('g', null, 'row');
      rg.dataset.row = String(k);
      if (row.col && row.col.note) rg.dataset.note = `${row.col.name}: ${row.col.note}`;
      else if (row.col && (row.col.dflt || row.col.enumRef)) rg.dataset.note = `${row.col.name}${row.col.dflt ? ` default ${row.col.dflt.kind === 'string' ? `'${row.col.dflt.value}'` : row.col.dflt.value}` : ''}${row.col.enumRef ? ` (enum ${row.col.enumRef})` : ''}`;
      if (k % 2 === 1) rg.append(sv('rect', { x: 1, y, width: b.w - 2, height: G.ROW_H }, 'zebra'));
      rg.append(sv('rect', { x: 1, y, width: b.w - 2, height: G.ROW_H }, 'rowbg'));
      const ty = y + G.ROW_H / 2 + 4;
      const n = sv('text', { x: G.PAD, y: ty }, `cname${row.col && row.col.pk ? ' pk' : ''}${row.more ? ' more' : ''}`);
      n.textContent = row.name;
      rg.append(n);
      if (row.type) { const tt = sv('text', { x: G.PAD + (box.nameChars + 2) * G.CHAR_W, y: ty }, 'ctype'); tt.textContent = row.type; rg.append(tt); }
      if (row.marks) { const mm = sv('text', { x: b.w - G.PAD, y: ty, 'text-anchor': 'end' }, 'cmark'); mm.textContent = row.marks; rg.append(mm); }
      g.append(rg);
    });
    return g;
  }

  function drawSimple(key, cls, titleText, lines, note) {
    const b = pos[key];
    const g = sv('g', { transform: `translate(${b.x} ${b.y})` }, `node ${cls}`);
    g.dataset.key = key; g.dataset.name = titleText;
    if (note) g.dataset.note = note;
    g.append(sv('rect', { x: 0, y: 0, width: b.w, height: b.h, rx: cls === 'note' ? 4 : 6 }, 'box'));
    if (cls === 'enum') g.append(sv('path', { d: `M0 ${G.HEAD_H} V6 a6 6 0 0 1 6 -6 H${b.w - 6} a6 6 0 0 1 6 6 V${G.HEAD_H} Z` }, 'head'));
    const t = sv('text', { x: G.PAD, y: G.HEAD_H / 2 + 4 }, cls === 'enum' ? 'title' : 'cname');
    t.textContent = titleText;
    if (cls === 'note') t.setAttribute('font-weight', 'bold');
    g.append(t);
    lines.forEach((l, k) => {
      const rg = sv('g', null, 'row'); rg.dataset.row = String(k);
      if (l.note) rg.dataset.note = l.note;
      const y = cls === 'note' ? G.HEAD_H + k * 18 + 10 : G.HEAD_H + k * G.ROW_H + G.ROW_H / 2 + 4;
      const tx = sv('text', { x: G.PAD, y }, 'cname'); tx.textContent = l.text; rg.append(tx);
      g.append(rg);
    });
    return g;
  }

  function draw() {
    ui.gEdges.textContent = ''; ui.gNodes.textContent = '';
    nodeEls.clear(); edges = []; hlEdge = null;
    const byKey = new Map(model.tables.map((t) => [t.key, t]));
    const frag = document.createDocumentFragment();
    for (const t of model.tables) { if (!pos[t.key]) continue; const g = drawTable(t); nodeEls.set(t.key, g); frag.append(g); }
    for (const e of model.enums) {
      const key = `enum:${e.key}`; if (!pos[key]) continue;
      const eb = G.enumBox(e);
      const g = drawSimple(key, 'enum', eb.title, eb.rows.map((r) => ({ text: r.name, note: r.note })), e.note);
      nodeEls.set(key, g); frag.append(g);
    }
    for (const n of model.notes) {
      const key = `note:${n.name}`; if (!pos[key]) continue;
      const nb = G.noteBox(n);
      const g = drawSimple(key, 'note', nb.title, nb.lines.map((l) => ({ text: l })), n.text);
      nodeEls.set(key, g); frag.append(g);
    }
    ui.gNodes.append(frag);
    const ef = document.createDocumentFragment();
    model.refs.forEach((r, i) => {
      const tA = byKey.get(r.from.table), tB = byKey.get(r.to.table);
      if (!tA || !tB || !pos[r.from.table] || !pos[r.to.table]) return;
      const geo = G.relation(r, tA, tB, pos[r.from.table], pos[r.to.table]);
      const g = sv('g', null, 'rel'); g.dataset.i = String(edges.length);
      const hit = sv('path', { d: geo.d }, 'hit');
      const line = sv('path', { d: geo.d }, 'line');
      const mark = sv('path', { d: geo.marks }, 'mark');
      g.append(hit, line, mark);
      ef.append(g);
      edges.push({ r, g, hit, line, mark, tA, tB, ia: geo.ia, ib: geo.ib, i });
    });
    ui.gEdges.append(ef);
  }

  function rerouteFor(key) {
    for (const ed of edges) {
      if (ed.r.from.table !== key && ed.r.to.table !== key) continue;
      const geo = G.relation(ed.r, ed.tA, ed.tB, pos[ed.r.from.table], pos[ed.r.to.table]);
      ed.hit.setAttribute('d', geo.d); ed.line.setAttribute('d', geo.d); ed.mark.setAttribute('d', geo.marks);
    }
  }

  function setStatus() {
    if (!model) return;
    const p = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
    ui.status.textContent = `${p(model.tables.length, 'table')}, ${p(model.refs.length, 'relation')}${model.enums.length ? `, ${p(model.enums.length, 'enum')}` : ''}`;
    ui.status.title = `${name} (${kind === 'sql' ? 'SQL' : kind === 'prisma' ? 'Prisma' : 'DBML'})`;
  }

  function showMessages() {
    const m = ui.msgs;
    m.textContent = '';
    const errs = model.errors || [];
    const lines = [];
    if (errs.length) {
      m.className = 'msgs err';
      const head = el('div', '', `${errs.length} problem${errs.length === 1 ? '' : 's'} in the file. The diagram shows what could be read.`);
      m.append(head);
      for (const e of errs.slice(0, 3)) {
        const d = el('div');
        const a = el('a', '', `Line ${e.line}`); a.dataset.line = String(e.line); a.dataset.col = String(e.col);
        a.addEventListener('click', () => post({ type: 'line', line: e.line, col: e.col }));
        d.append(a, document.createTextNode(`: ${e.message}`));
        m.append(d);
      }
      if (errs.length > 3) m.append(el('div', '', `and ${errs.length - 3} more (see the Problems panel).`));
    } else {
      m.className = 'msgs info';
      if (model.truncated) lines.push(model.truncated);
      if (model.skippedSummary) lines.push(`Not drawn (not part of a diagram): ${model.skippedSummary}.`);
      for (const l of lines) m.append(el('div', '', l));
    }
    if (model.truncated && errs.length) m.append(el('div', '', model.truncated));
    m.hidden = !m.childNodes.length;
  }

  function setPro(p) {
    pro = p || pro;
    ui.proBox.hidden = !pro.show;
    const titles = { exportSql: 'Export SQL: CREATE TABLE scripts for PostgreSQL, MySQL, SQL Server or SQLite, or DBML from SQL', exportImage: 'Export the diagram as PNG, SVG or PDF, or a Markdown data dictionary', diff: 'Compare with another schema and write migration SQL' };
    const keys = { exportSql: 'sql', exportImage: 'image', diff: 'diff' };
    for (const b of ui.proBox.querySelectorAll('[data-tool]')) {
      const left = pro.tries ? pro.tries[keys[b.dataset.tool]] : undefined;
      b.title = `${titles[b.dataset.tool]} (Zovo Pro tool${pro.licensed ? '' : left === undefined ? '' : `, ${left} free ${left === 1 ? 'try' : 'tries'} left`})`;
    }
  }

  // ---------------- PNG export: draw the host's SVG on a canvas ----------------
  function rasterize(m) {
    const img = new Image();
    const done = (data, error) => post({ type: 'png', id: m.id, data, error });
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = Math.round(m.width * m.scale); c.height = Math.round(m.height * m.scale);
        const ctx = c.getContext('2d');
        ctx.scale(m.scale, m.scale);
        ctx.drawImage(img, 0, 0, m.width, m.height);
        const url = c.toDataURL('image/png');
        c.width = 0; c.height = 0;
        done(url.slice(url.indexOf(',') + 1));
      } catch (e) { done(null, String(e && e.message || e)); }
    };
    img.onerror = () => done(null, 'The diagram could not be drawn as an image.');
    const bytes = new TextEncoder().encode(m.svg);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    img.src = `data:image/svg+xml;base64,${btoa(bin)}`;
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'model') {
      if (!ui) buildUi();
      const first = !model;
      model = m.model; pos = m.pos || {}; name = m.name || ''; kind = m.kind || 'dbml';
      document.title = name;
      draw();
      setPro(m.pro);
      setStatus();
      showMessages();
      const n = model.tables.length + model.enums.length + model.notes.length;
      ui.empty.hidden = n > 0;
      ui.empty.textContent = n ? '' : (kind === 'sql' ? 'No CREATE TABLE statement in this file yet.' : kind === 'prisma' ? 'No model in this file yet.' : 'No Table in this file yet. Add one, for example:  Table users { id integer [pk] }');
      if (first && !(view && m.keepView)) fit(); else if (m.fit) fit(); else applyView();
      if (ui.search.value) runSearch(ui.search.value, false);
      post({ type: 'rendered', tables: model.tables.length, errors: (model.errors || []).length });
    } else if (m.type === 'pro') { if (ui) setPro(m.pro); }
    else if (m.type === 'fit') { if (ui) fit(); }
    else if (m.type === 'focus') { if (ui) { centerOn(m.key); const n = nodeEls.get(m.key); if (n) { n.classList.add('current'); setTimeout(() => n.classList.remove('current'), 1500); } } }
    else if (m.type === 'rasterize') rasterize(m);
    else if (m.type === 'fatal') {
      if (!ui) buildUi();
      ui.msgs.className = 'msgs err'; ui.msgs.textContent = m.message; ui.msgs.hidden = false;
      post({ type: 'rendered', tables: 0, errors: 1, fatal: true });
    }
  });
  post({ type: 'ready' });
})();
