// Head and neck CT anatomy trainer: linked slice views + 3D model, explore and quiz modes.
// RESEARCH / EDUCATION PROTOTYPE ONLY. NOT FOR CLINICAL USE.
import { loadVolume, VIEWS, WINDOWS } from './volume.js';
import { createScene } from './scene3d.js';
import { makeRound, gradeFind, toCsv, summarise, TOLERANCE_MM, POINT_TOLERANCE_MM } from './quiz.js';
import { detectMode, chooseScans, moduleOf, orderedModules, groupState, setGroup, toggleOne, showOnly, restore, splitFirstSentence,
         migrateReview, stageOf, studentVisible, overlayStage, reviewerNames, REVIEW_FILTERS, defaultFilter, matchesFilter, reviewProgress } from './modes.js';

const $ = (sel) => document.querySelector(sel);
const ASSETS = 'assets/anatomy';
const STORE = 'anatomy-quiz-results-v1';
const LINE = { axial: '#4cc9f0', coronal: '#6fdc8c', sagittal: '#ffa94d' };

const state = {
  mode: 'explore', cross: [0, 0, 0], selected: 0, win: 'soft', outlines: true,
  smooth: true, sharpen: false,
  hidden: new Set(),            // structure ids hidden via their group
  quiz: null,                   // { round, n, score, phase:'ask'|'answered', startedAt, session }
};
let vol, meta, content = {}, scene3d, byId = {}, colors = {};
let scanId = '', landmarks = [], catalog = [];   // landmarks: hand-placed named points, ids from 1000
const PIN_COLOR = [255, 209, 102];
// "context" structures are plain 3D background (the unnamed skeleton): never listed, selected, quizzed, outlined or reviewed
const allItems = () => [...meta.structures.filter((s) => !s.context), ...landmarks];
// Student mode (default) shows only items whose outline a reviewer accepted; ?author=1 shows everything.
const BUILD = (document.querySelector('meta[name="anat-build"]') || {}).content || '';   // set by pipeline/anatomy_bundle.py
const MODE = detectMode(location.search, BUILD);
const LOCAL_KEY = (scan) => `anat-review:${scan}`;
let review = { items: {} };
const student = MODE.student;
const openGroups = new Set(); let groupsInit = false, savedHidden = null;   // list state, in memory only
// Two review stages per item: the author's pre-check and the reviewer's sign-off. Only the second reaches students.
let rvStage = BUILD === 'review' || new URLSearchParams(location.search).get('review') === 'signoff' ? 'signoff' : 'author';
const stage = (s, st) => stageOf(review.items, s.key, st);
const allowed = (s) => !s.context && (!student || studentVisible(review.items, s.key));
const items = () => allItems().filter(allowed);                // everything that can be selected or asked about
// Text shown for an item: the reviewer's accepted wording wins; authors also see their own accepted wording.
function textFor(s) {
  // shared text, unless this scan has its own wording for the structure (content[key].scans[scanId])
  const shared = content[s.key] || {};
  const base = s.point ? s : { ...shared, ...((shared.scans || {})[scanId] || {}) };
  const r = stage(s, 'signoff'), a = student ? {} : stage(s, 'author');
  const ok = r.text === 'accept', v = ok ? r : a.text === 'accept' ? a : {};
  return { summary: v.summary || base.summary || '', ct_tip: v.ct_tip || base.ct_tip || '',
           reviewed: ok || !!base.reviewed, reviewer: ok ? r.reviewer : '' };
}
const panes = {};               // view -> { el, canvas, ctx, off, offCtx, image, fit }

// ------------------------------------------------------------------ boot
async function boot() {
  const loading = $('#loading');
  try {
    let scans = [], titles = {};
    try { const ix = await (await fetch(`${ASSETS}/index.json`)).json(); scans = ix.scans || []; titles = ix.titles || {}; } catch { /* handled below */ }
    if (!scans.length) throw new Error('No scan has been built yet.\nRun:  python -m pipeline.anatomy_build\nthen reload this page.');
    const picked = chooseScans(scans, titles, MODE, new URLSearchParams(location.search).get('scan'));
    const scan = picked.current;
    const sel = $('#scan-select');
    sel.innerHTML = picked.list.map((s) => `<option value="${s.id}" ${s.id === scan ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    sel.onchange = () => { const q = new URLSearchParams(location.search); q.set('scan', sel.value); location.search = `?${q}`; };

    try { content = await (await fetch(`${ASSETS}/content.json`)).json(); } catch { content = {}; }
    ({ meta, volume: vol } = await loadVolume(`${ASSETS}/${scan}`));
    scanId = scan;
    try { catalog = await (await fetch(`${ASSETS}/landmark_catalog.json`)).json(); } catch { catalog = []; }
    let stored = [];
    try { const r = await fetch(`${ASSETS}/landmarks/${scan}.json`); if (r.ok) stored = (await r.json()).landmarks || []; } catch { /* none placed yet */ }
    setLandmarkList(stored, false);
    try { const r = await fetch(`${ASSETS}/reviews/${scan}.json`); if (r.ok) review = { items: migrateReview((await r.json()).items) }; } catch { /* not reviewed yet */ }
    if (BUILD === 'review') try { review.items = overlayStage(review.items, JSON.parse(localStorage.getItem(LOCAL_KEY(scan)) || '{}')); } catch { /* nothing kept in this browser */ }
    byId = Object.fromEntries(allItems().map((s) => [s.id, s]));
    colors = Object.fromEntries(meta.structures.map((s) => [s.id, s.color]));
    $('#synthetic-badge').hidden = !meta.synthetic;
    $('#source-note').textContent = `Scan ${meta.patient || scan}: ${meta.source}.`;
    $('#about-note').textContent = meta.note || '';
    const d = meta.defaults || {};
    if (WINDOWS[d.window]) state.win = d.window;
    // students get the one-line version; the full note is in author mode and in "About and credits"
    $('#scan-note').textContent = student ? splitFirstSentence(meta.note).first : meta.note || ''; $('#scan-note').hidden = !meta.note;

    scene3d = await createScene($('#canvas3d'), meta, `${ASSETS}/${scan}/structures.glb`);
    scene3d.onPick((id) => { if (state.mode !== 'quiz') select(id, true); });
    scene3d.setLandmarks(landmarks);

    // students start with a calm 3D view: bone only; the other groups appear when ticked or when a structure is selected
    if (student) state.hidden = new Set(items().filter((s) => moduleOf(s) !== 'Bones').map((s) => s.id));
    setupPanes(); setupPanel(); setupQuiz(); setupLandmarks(); setupReview();
    applyMode();
    if (d.skull_opacity !== undefined) { $('#skull-opacity').value = Math.round(d.skull_opacity * 100); scene3d.setOpacity('Skull', d.skull_opacity); scene3d.setOpacity('Bones', d.skull_opacity); }
    const start = byId[11] || meta.structures[0];          // open on the mandible if present
    setCross(start ? start.voxel : [vol.nx >> 1, vol.ny >> 1, vol.nz >> 1]);
    loading.hidden = true;
    window.anat.ready = true;
  } catch (err) {
    loading.classList.add('error'); loading.textContent = String(err.message || err);
    window.anat.error = String(err.message || err);
    console.error(err);
  }
}

// ------------------------------------------------------------------ slice panes
function setupPanes() {
  for (const view of VIEWS) {
    const el = document.querySelector(`.pane[data-view="${view}"]`);
    const canvas = el.querySelector('canvas');
    const [w, h] = vol.dims(view);
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const p = panes[view] = { el, canvas, ctx: canvas.getContext('2d'), off, offCtx: off.getContext('2d'),
                              image: new ImageData(w, h), fit: null, pos: el.querySelector('.pos'),
                              zoom: 1, cu: w / 2, cv: h / 2 };          // zoom factor and the image point at the pane centre
    const fromEvent = (e) => {
      const r = canvas.getBoundingClientRect(), f = p.fit;
      const u = Math.floor((e.clientX - r.left - f.x) / f.s), v = Math.floor((e.clientY - r.top - f.y) / f.s);
      if (u < 0 || v < 0 || u >= w || v >= h) return null;
      return vol.pixelToVoxel(view, u, v, state.cross);
    };
    let dragging = false, panning = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2 || e.button === 1 || e.altKey) {                 // right / middle / Alt-drag pans a zoomed view
        panning = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); return;
      }
      const vox = fromEvent(e); if (!vox) return;
      dragging = true; canvas.setPointerCapture(e.pointerId);
      setCross(vox);
      if (state.mode !== 'quiz') {
        const r = canvas.getBoundingClientRect();
        const pin = pinAt(view, e.clientX - r.left, e.clientY - r.top);
        const hit = pin ? pin.id : vol.label(...vox);
        if (state.mode === 'review') { const k = rvItems().findIndex((s) => s.id === hit); if (k >= 0) { storeReviewFields(); showReview(k); } }
        else select(byId[hit] && allowed(byId[hit]) ? hit : 0, false);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (panning) {
        p.cu -= (e.clientX - panning[0]) / p.fit.s; p.cv -= (e.clientY - panning[1]) / p.fit.s;
        panning = [e.clientX, e.clientY]; draw(view);
      } else if (dragging) { const vox = fromEvent(e); if (vox) setCross(vox); }
    });
    canvas.addEventListener('pointerup', () => { dragging = false; panning = null; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dblclick', () => zoomPane(view, 0));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {                                       // pinch or Ctrl/Cmd + wheel zooms at the pointer
        const r = canvas.getBoundingClientRect();
        zoomPane(view, Math.exp(-e.deltaY * 0.01), [e.clientX - r.left, e.clientY - r.top]);
        return;
      }
      const c = state.cross.slice(); c[vol.axis(view)] += (e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 5 : 1);
      setCross(c);
    }, { passive: false });
    el.querySelector('.zoom').onclick = (e) => {
      const z = e.target.dataset.zoom; if (z) zoomPane(view, z === 'in' ? 1.5 : z === 'out' ? 1 / 1.5 : 0);
    };
    new ResizeObserver(() => draw(view)).observe(el);
  }
}

// factor 0 resets. `at` = pane pixel that should stay put (default: the crosshair, else the pane centre).
function zoomPane(view, factor, at) {
  const p = panes[view], [w, h] = vol.dims(view);
  if (!factor) { p.zoom = 1; p.cu = w / 2; p.cv = h / 2; draw(view); return; }
  const f = p.fit, cw = p.el.clientWidth, ch = p.el.clientHeight;
  if (!at) { const [u, v] = vol.voxelToPixel(view, state.cross); at = [f.x + (u + 0.5) * f.s, f.y + (v + 0.5) * f.s]; }
  const iu = (at[0] - f.x) / f.s, iv = (at[1] - f.y) / f.s;              // image point under `at`
  const zoom = Math.min(Math.max(p.zoom * factor, 1), 12), s = (f.s / p.zoom) * zoom;
  p.zoom = zoom; p.cu = iu - (at[0] - cw / 2) / s; p.cv = iv - (at[1] - ch / 2) / s;
  draw(view);
}

// Landmarks to draw in a slice view: those within 1.5 mm of the slice, respecting the quiz state.
function visiblePins(view) {
  const q = state.quiz, question = state.mode === 'quiz' && q ? q.round[q.n] : null;
  if (state.mode === 'quiz') {
    if (!question || (question.kind === 'find' && q.phase === 'ask')) return [];
    return landmarks.filter((l) => l.id === question.id);
  }
  if (state.mode === 'review') return landmarks.filter((l) => l.id === state.selected);
  const a = vol.axis(view), reach = 1.5 / vol.h;
  return landmarks.filter(allowed).filter((l) => !state.hidden.has(l.id) && Math.abs(l.voxel[a] - state.cross[a]) <= reach);
}

function pinAt(view, x, y) {
  const f = panes[view].fit;
  for (const l of visiblePins(view)) {
    const [u, v] = vol.voxelToPixel(view, l.voxel);
    if (Math.hypot(f.x + (u + 0.5) * f.s - x, f.y + (v + 0.5) * f.s - y) <= 9) return l;
  }
  return null;
}

function renderOptions() {
  const q = state.quiz, asking = state.mode === 'quiz' && q && q.phase === 'ask';
  const question = state.mode === 'quiz' && q ? q.round[q.n] : null;
  if (state.mode === 'quiz') {
    if (!question) return { outlines: false, only: 0, highlight: 0 };
    if (question.kind === 'find' && asking) return { outlines: false, only: 0, highlight: 0 };
    return { outlines: false, only: question.id, highlight: question.id };
  }
  if (state.mode === 'review') return { outlines: false, only: state.selected, highlight: 0 };   // edge only: nothing hides the anatomy
  return { outlines: state.outlines, only: 0, highlight: state.selected };
}

function draw(view) {
  const p = panes[view]; if (!p || !vol) return;
  const o = renderOptions();
  vol.render(view, state.cross, { win: WINDOWS[state.win], colors, hidden: hiddenIds(), sharpen: state.sharpen ? 0.8 : 0, ...o }, p.image.data);
  p.offCtx.putImageData(p.image, 0, 0);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = p.el.clientWidth, ch = p.el.clientHeight; if (!cw || !ch) return;
  if (p.canvas.width !== Math.round(cw * dpr) || p.canvas.height !== Math.round(ch * dpr)) {
    p.canvas.width = Math.round(cw * dpr); p.canvas.height = Math.round(ch * dpr);
  }
  const [w, h] = vol.dims(view);
  const s = Math.min(cw / w, ch / h) * p.zoom;
  // keep the image on screen: centred when it fits, otherwise never showing empty space past an edge
  p.cu = w * s <= cw ? w / 2 : Math.min(Math.max(p.cu, cw / 2 / s), w - cw / 2 / s);
  p.cv = h * s <= ch ? h / 2 : Math.min(Math.max(p.cv, ch / 2 / s), h - ch / 2 / s);
  const x = cw / 2 - p.cu * s, y = ch / 2 - p.cv * s;
  p.fit = { s, x, y };
  const ctx = p.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = state.smooth; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(p.off, x, y, w * s, h * s);
  // crosshair: each line is coloured like the view whose slice it marks
  const [u, v] = vol.voxelToPixel(view, state.cross);
  const px = x + (u + 0.5) * s, py = y + (v + 0.5) * s;
  const [vertical, horizontal] = view === 'axial' ? ['sagittal', 'coronal'] : view === 'coronal' ? ['sagittal', 'axial'] : ['coronal', 'axial'];
  ctx.lineWidth = 1; ctx.globalAlpha = 0.75;
  const gap = 9;
  ctx.strokeStyle = LINE[vertical]; ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px, py - gap); ctx.moveTo(px, py + gap); ctx.lineTo(px, y + h * s); ctx.stroke();
  ctx.strokeStyle = LINE[horizontal]; ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(px - gap, py); ctx.moveTo(px + gap, py); ctx.lineTo(x + w * s, py); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.font = '600 11px -apple-system, "Segoe UI", sans-serif'; ctx.textBaseline = 'middle';
  for (const l of visiblePins(view)) {
    const [lu, lv] = vol.voxelToPixel(view, l.voxel), lx = x + (lu + 0.5) * s, ly = y + (lv + 0.5) * s;
    const sel = l.id === state.selected || state.mode === 'quiz';
    ctx.beginPath(); ctx.arc(lx, ly, sel ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = sel ? '#ff4d6d' : '#ffd166'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#10151b'; ctx.stroke();
    if (state.mode !== 'quiz') {
      const tw = ctx.measureText(l.name).width;
      ctx.fillStyle = 'rgba(16, 21, 27, 0.8)'; ctx.fillRect(lx + 9, ly - 8, tw + 8, 16);
      ctx.fillStyle = '#ffe9b0'; ctx.fillText(l.name, lx + 13, ly);
    }
  }
  const a = vol.axis(view), n = [vol.nx, vol.ny, vol.nz][a];
  p.pos.textContent = `${state.cross[a] + 1} / ${n}${p.zoom > 1.01 ? `  ·  ${p.zoom.toFixed(1)}x` : ''}`;
}

function drawAll() { for (const v of VIEWS) draw(v); }

// ids not drawn on slices: groups switched off, plus everything unreviewed in student view
function hiddenIds() {
  const h = new Set(state.mode === 'quiz' ? [] : state.hidden);       // the quiz must be able to show what it asks about
  for (const s of meta.structures) if (s.context) h.add(s.id);
  if (!student) return h;
  for (const s of allItems()) if (!allowed(s)) h.add(s.id);
  return h;
}
const contextIds = () => new Set(meta.structures.filter((s) => s.context).map((s) => s.id));

function setCross(vox) {
  state.cross = vol.clamp(vox);
  scene3d.setCross(vol.toMm(state.cross));
  drawAll();
}

// ------------------------------------------------------------------ explore
function select(id, jump) {
  state.selected = byId[id] && !byId[id].context ? id : 0;
  if (state.selected) {
    openGroups.add(moduleOf(byId[id]));
    if (state.hidden.has(id)) { state.hidden = toggleOne(id, state.hidden); }      // selecting a hidden structure shows it again
    syncVisibility(false); renderList();
  }
  scene3d.select(state.selected);
  if (state.selected && jump) setCross(byId[id].voxel); else drawAll();
  renderInfo();
  document.querySelectorAll('.s-item').forEach((b) => b.classList.toggle('selected', Number(b.dataset.id) === state.selected));
}

function swatch(s) { return `<i style="background: rgb(${s.color.join(',')})"></i>`; }

function renderInfo() {
  const card = $('#info-card'), s = byId[state.selected];
  if (!s) {
    card.innerHTML = items().length || !student ? '<p class="muted">Click a structure on a slice, in the 3D view or in the list below.</p>'
      : '<p class="muted">No reviewed structures yet.</p>';
    return;
  }
  // author mode keeps the working details; students see name, one line, one tip
  const detail = student ? '' : s.point
    ? `<div class="meta">Landmark · placed by hand${s.placed_by ? ` (${esc(s.placed_by)})` : ''} ${pills(s)}</div>`
    : `<div class="meta">${esc(moduleOf(s))} · ${s.volume_cm3} cm³ in this scan ${pills(s)}${s.derived ? '<span class="pill auto">outlined automatically</span>' : ''}</div>`;
  card.innerHTML = `
    <h2>${swatch(s)}<span>${esc(s.name)}</span></h2>
    ${detail}
    ${cardText(s)}
    <div class="btn-row card-actions"><button class="ghost" id="btn-only">Show only this</button><button class="ghost" id="btn-all" ${savedHidden ? '' : 'disabled'}>Show all</button></div>`;
}

function pills(s) {
  const t = textFor(s), what = s.point ? 'position' : 'outline', word = { accept: 'correct', fix: 'needs fixing', reject: 'wrong' };
  const pill = (who, v) => (v.outline ? `<span class="pill ${v.outline === 'accept' ? 'reviewed' : 'unreviewed'}">${who}: ${what} ${word[v.outline]}</span>` : '');
  return `${pill('author', stage(s, 'author'))}${pill('reviewer', stage(s, 'signoff'))}${t.reviewed ? '<span class="pill reviewed">text signed off</span>' : '<span class="pill unreviewed">unreviewed draft</span>'}`;
}

// One line of description and one "On CT" line; anything longer sits behind "More".
function cardText(s) {
  const t = textFor(s);
  if (student && !t.reviewed) return '';                          // unreviewed wording is never shown to students
  if (!t.summary && !t.ct_tip) return student ? '' : '<p class="muted">No description written yet.</p>';
  const a = splitFirstSentence(t.summary), b = splitFirstSentence(t.ct_tip);
  const more = [a.rest, b.rest].filter(Boolean);
  return `${a.first ? `<p>${esc(a.first)}</p>` : ''}${b.first ? `<p class="tip"><strong>On CT:</strong> ${esc(b.first)}</p>` : ''}
    ${more.length ? `<details class="more"><summary>More</summary>${a.rest ? `<p>${esc(a.rest)}</p>` : ''}${b.rest ? `<p class="tip">${esc(b.rest)}</p>` : ''}</details>` : ''}`;
}

// Push the visibility state (eye toggles, group checkboxes, student filter) to the 3D view and the slices.
function syncVisibility(redrawList = true) {
  const ctx = contextIds();
  scene3d.setHiddenIds([...hiddenIds()].filter((id) => !ctx.has(id)));                 // background stays visible in 3D
  if (redrawList) renderList();
  drawAll();
}

function setupPanel() {
  // window presets
  const wb = $('#window-buttons');
  wb.innerHTML = Object.entries(WINDOWS).map(([k, w]) => `<button data-win="${k}" class="${k === state.win ? 'active' : ''}">${w.label}</button>`).join('');
  wb.onclick = (e) => {
    const k = e.target.dataset.win; if (!k) return;
    state.win = k; wb.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.win === k)); drawAll();
  };
  $('#chk-outlines').onchange = (e) => { state.outlines = e.target.checked; drawAll(); };
  $('#chk-smooth').onchange = (e) => { state.smooth = e.target.checked; drawAll(); };
  $('#chk-sharpen').onchange = (e) => { state.sharpen = e.target.checked; drawAll(); };
  $('#chk-planes').onchange = (e) => scene3d.setPlanes(e.target.checked);
  $('#skull-opacity').oninput = (e) => { scene3d.setOpacity('Skull', Number(e.target.value) / 100); scene3d.setOpacity('Bones', Number(e.target.value) / 100); };

  // structure list: one collapsible group per module, a checkbox per group, an eye per structure
  const list = $('#structure-list');
  renderList();
  list.onclick = (e) => {
    const eye = e.target.closest('.eye');
    if (eye) { state.hidden = toggleOne(Number(eye.dataset.eye), state.hidden); savedHidden = null; syncVisibility(); renderInfo(); return; }
    const name = e.target.closest('.g-name');
    if (name) { const g = name.dataset.g; openGroups.has(g) ? openGroups.delete(g) : openGroups.add(g); renderList(); return; }
    const b = e.target.closest('.s-item'); if (b) select(Number(b.dataset.id), true);
  };
  list.onchange = (e) => {
    const g = e.target.dataset.group; if (!g) return;
    state.hidden = setGroup(items().filter((s) => moduleOf(s) === g).map((s) => s.id), state.hidden, e.target.checked);
    savedHidden = null; syncVisibility(); renderInfo();
  };
  $('#info-card').onclick = (e) => {
    if (e.target.id === 'btn-only' && state.selected) ({ hidden: state.hidden, saved: savedHidden } = showOnly(items().map((s) => s.id), state.selected, state.hidden, savedHidden));
    else if (e.target.id === 'btn-all') ({ hidden: state.hidden, saved: savedHidden } = restore(savedHidden));
    else return;
    syncVisibility(); renderInfo();
  };
  // header menu and the About dialog
  $('#btn-menu').onclick = (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
  document.addEventListener('click', () => { $('#menu').hidden = true; });
  $('#btn-about').onclick = () => $('#about').showModal();

  // mode tabs, help, 3D view buttons
  document.querySelectorAll('.tab[data-mode]').forEach((t) => { t.onclick = () => setMode(t.dataset.mode); });
  $('#btn-help').onclick = () => $('#help').showModal();
  const dirs = { front: [0, -1, 0.12], back: [0, 1, 0.12], left: [1, 0, 0.12], right: [-1, 0, 0.12], top: [0, -0.01, 1] };
  document.querySelector('.views').onclick = (e) => { const d = dirs[e.target.dataset.look]; if (d) scene3d.lookFrom(d); };
}

function esc(t) { return String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const EYE = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>';

function renderList() {
  const all = items(), groups = orderedModules(all), box = $('#structure-list');
  if (!all.length) { box.innerHTML = `<p class="muted" id="list-empty">${student ? 'No reviewed structures yet.' : 'This scan has no structures.'}</p>`; return; }
  if (!groupsInit) { openGroups.add(groups[0]); groupsInit = true; }             // only the first group starts open
  box.innerHTML = groups.map((g) => {
    const rows = all.filter((s) => moduleOf(s) === g).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const open = openGroups.has(g);
    return `<div class="grp" data-g="${esc(g)}">
      <div class="g-head"><button class="g-name" data-g="${esc(g)}" aria-expanded="${open}"><span class="caret">${open ? '▾' : '▸'}</span>${esc(g)}<small>${rows.length}</small></button>
        <input type="checkbox" class="g-check" data-group="${esc(g)}" data-state="${groupState(rows.map((s) => s.id), state.hidden)}" title="Show or hide every structure in this group" aria-label="Show ${esc(g)}"></div>
      <div class="g-body" ${open ? '' : 'hidden'}>${rows.map((s) => `<div class="s-row"><button class="s-item ${s.id === state.selected ? 'selected' : ''}" data-id="${s.id}">${swatch(s)}${esc(s.name)}</button><button class="eye ${state.hidden.has(s.id) ? 'off' : ''}" data-eye="${s.id}" aria-pressed="${!state.hidden.has(s.id)}" title="Show or hide this structure" aria-label="Show ${esc(s.name)}">${EYE}</button></div>`).join('')}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.g-check').forEach((c) => { c.checked = c.dataset.state !== 'none'; c.indeterminate = c.dataset.state === 'mixed'; });
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab[data-mode]').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('#mode-explore').hidden = mode !== 'explore';
  $('#mode-quiz').hidden = mode !== 'quiz';
  $('#mode-landmarks').hidden = mode !== 'landmarks';
  $('#mode-review').hidden = mode !== 'review';
  if (mode === 'review') buildReviewList();
  if (mode !== 'quiz') { state.quiz = null; showQuizStage('start'); }
  if (mode !== 'review') scene3d.setOnly(0);
  syncVisibility(false);
  syncQuizView();
}

// ------------------------------------------------------------------ review (two stages: author, then reviewer)
const STAGE_LABEL = { author: 'Author', signoff: 'Reviewer' };
const OUTLINE_WORD = { accept: 'Correct', fix: 'Needs fixing', reject: 'Wrong' }, TEXT_WORD = { accept: 'correct', edit: 'needs rewriting' };
let rvIndex = 0, rvList = [], rvFilter = defaultFilter(rvStage);     // rvList: ids in the current filter, fixed until the filter changes
const rvNames = { author: '', signoff: '' };
function reviewOrder() {
  const groups = [...new Set(allItems().map((s) => s.group))];
  return [...allItems()].sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.name.localeCompare(b.name));
}
const rvItems = () => { const by = new Map(allItems().map((s) => [s.id, s])); return rvList.map((id) => by.get(id)).filter(Boolean); };

// Rebuild the list for the current filter; stay on `keepId` if it is still listed, else go to the first item without a verdict.
function buildReviewList(keepId) {
  rvList = reviewOrder().filter((s) => matchesFilter(review.items, s.key, rvFilter)).map((s) => s.id);
  const order = rvItems();
  let k = order.findIndex((s) => s.id === keepId);
  if (k < 0) k = Math.max(order.findIndex((s) => !stage(s, rvStage).outline), 0);
  showReview(k);
}

function stageLine(s, st) {
  const v = stage(s, st), who = [v.reviewer, v.at ? new Date(v.at).toLocaleDateString() : ''].filter(Boolean).join(', ');
  const body = v.outline || v.text || v.comment
    ? `${v.outline ? `Outline: <strong>${OUTLINE_WORD[v.outline]}</strong>` : 'Outline: no verdict'} · Text: ${v.text ? TEXT_WORD[v.text] : 'no verdict'}`
      + (v.comment ? `<br><em>“${esc(v.comment)}”</em>` : '')
    : st === 'author' ? 'not yet checked' : 'not yet signed off';
  return `<p class="rv-stage-line${st === rvStage ? ' current' : ''}" data-stage="${st}"><strong>${STAGE_LABEL[st]}</strong>${who ? ` <span class="muted">(${esc(who)})</span>` : ''}: ${body}</p>`;
}

function showReview(k) {
  const order = rvItems(), all = reviewOrder();
  const p = reviewProgress(review.items, all.map((s) => s.key));
  $('#rv-progress').textContent = `Author checked ${p.author}/${p.total} · Reviewer signed off ${p.signoff}/${p.total}`;
  $('#rv-stage').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === rvStage));
  $('#rv-filter').value = rvFilter;
  $('#rv-intro').textContent = rvStage === 'signoff'
    ? 'Final sign-off. Students see a structure only after you mark its outline Correct here.'
    : 'Pre-check before the reviewer. Nothing marked here is shown to students.';
  const done = order.filter((s) => stage(s, rvStage).outline).length;
  $('#rv-bar').max = Math.max(order.length, 1); $('#rv-bar').value = done;
  $('#rv-done').textContent = order.length ? `${done} done in this list` : '';
  $('#rv-empty').hidden = order.length > 0; $('#rv-item').hidden = !order.length;
  if (!order.length) { rvIndex = 0; $('#rv-count').textContent = '0 items'; select(0, false); scene3d.setOnly(0); return; }
  rvIndex = Math.min(Math.max(k, 0), order.length - 1);
  const s = order[rvIndex], v = stage(s, rvStage), other = stage(s, rvStage === 'author' ? 'signoff' : 'author');
  const base = s.point ? s : { ...(content[s.key] || {}), ...(((content[s.key] || {}).scans || {})[scanId] || {}) };
  select(s.id, true);
  scene3d.setOnly(s.id);
  $('#rv-count').textContent = `${rvIndex + 1} of ${order.length}`;
  $('#rv-name').innerHTML = `${swatch(s)}<span>${esc(s.name)}</span>`;
  $('#rv-kind').textContent = s.point ? 'Landmark point: is the dot in the right place?' : s.derived ? 'Outlined automatically: is the outline right?' : 'Outline from the data set: is it right?';
  $('#rv-stages').innerHTML = stageLine(s, 'author') + stageLine(s, 'signoff');
  $('#rv-summary').value = v.summary || other.summary || base.summary || ''; $('#rv-tip').value = v.ct_tip || other.ct_tip || base.ct_tip || '';
  $('#rv-comment').value = v.comment || '';
  $('#rv-comment').placeholder = `Comment as ${STAGE_LABEL[rvStage].toLowerCase()} (optional)`;
  for (const [box, val] of [['#rv-outline', v.outline], ['#rv-text', v.text]])
    $(box).querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === val));
  $('#rv-prev').disabled = rvIndex === 0;
  $('#rv-next').textContent = rvIndex + 1 < order.length ? 'Save and next' : 'Save';
}

function setVerdict(field, value) {
  const s = rvItems()[rvIndex]; if (!s) return;
  const cur = stage(s, rvStage);
  storeReviewFields({ [field]: cur[field] === value ? null : value });   // pressing the active button again clears it
  showReview(rvIndex);
}

// Write the form into the selected stage only. Name and time are stamped only when something actually changed.
function storeReviewFields(change = {}) {
  const s = rvItems()[rvIndex]; if (!s) return;
  const item = review.items[s.key] || {}, old = item[rvStage] || {};
  const next = { outline: old.outline || null, text: old.text || null, ...change,
                 summary: $('#rv-summary').value.trim(), ct_tip: $('#rv-tip').value.trim(), comment: $('#rv-comment').value.trim() };
  const has = !!(next.outline || next.text || next.comment);
  const same = ['outline', 'text', 'summary', 'ct_tip', 'comment'].every((f) => (old[f] || '') === (next[f] || ''));
  if (has && same) return;
  if (has) item[rvStage] = { ...next, reviewer: $('#rv-reviewer').value.trim().slice(0, 80), at: new Date().toISOString() };
  else delete item[rvStage];
  if (Object.keys(item).length) review.items[s.key] = item; else delete review.items[s.key];
  keepLocal();
}

// Reviewer's copy (no server): keep the work in this browser after every change.
function keepLocal() {
  if (BUILD !== 'review') return;
  try { localStorage.setItem(LOCAL_KEY(scanId), JSON.stringify(review.items)); } catch { /* storage unavailable: the download still works */ }
}
function downloadReview() {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ scan: scanId, items: review.items }, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${scanId}.json` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

async function saveReview() {
  const status = $('#rv-status'), body = JSON.stringify({ scan: scanId, items: review.items });
  if (BUILD === 'review') {
    keepLocal();
    status.textContent = 'Kept in this browser. When you have finished, press "Download review file" and send the file back.'; status.className = 'muted';
    return { local: true };
  }
  try {
    const res = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    status.textContent = `Saved to ${out.path}.`; status.className = 'muted';
    return out;
  } catch (err) {
    downloadReview();
    status.textContent = `Could not save through the server (${err.message}). The file was downloaded: put it in web/assets/anatomy/reviews/.`;
    status.className = 'warning';
    return { downloaded: true };
  }
}

function setupReview() {
  for (const st of ['author', 'signoff'])                       // last name used in each stage
    rvNames[st] = Object.values(review.items).map((it) => it[st]).filter((v) => v && v.reviewer).sort((a, b) => String(b.at).localeCompare(String(a.at))).map((v) => v.reviewer)[0] || '';
  $('#rv-download').onclick = () => { storeReviewFields(); downloadReview(); };
  if (BUILD === 'review') { $('.rv-who').hidden = true; $('#rv-status').textContent = 'Your verdicts are kept in this browser as you go.'; }
  $('#rv-filter').innerHTML = REVIEW_FILTERS.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join('');
  $('#rv-reviewer').value = rvNames[rvStage];
  $('#rv-reviewer').oninput = (e) => { rvNames[rvStage] = e.target.value; };
  $('#rv-stage').onclick = (e) => {
    const st = e.target.dataset.v; if (!st || st === rvStage) return;
    storeReviewFields();
    rvStage = st; rvFilter = defaultFilter(st); $('#rv-reviewer').value = rvNames[st];
    buildReviewList(state.selected);
  };
  $('#rv-filter').onchange = (e) => { storeReviewFields(); rvFilter = e.target.value; buildReviewList(state.selected); };
  $('#rv-outline').onclick = (e) => { if (e.target.dataset.v) setVerdict('outline', e.target.dataset.v); };
  $('#rv-text').onclick = (e) => { if (e.target.dataset.v) setVerdict('text', e.target.dataset.v); };
  $('#rv-prev').onclick = () => { storeReviewFields(); showReview(rvIndex - 1); };
  $('#rv-next').onclick = async () => { storeReviewFields(); await saveReview(); showReview(rvIndex + 1); };
  $('#rv-open').onclick = () => {
    storeReviewFields();
    const order = rvItems(), open = (s) => !stage(s, rvStage).outline, k = order.findIndex((s, i) => i > rvIndex && open(s));
    showReview(k >= 0 ? k : Math.max(order.findIndex(open), 0));
  };
}

// Student mode: Explore and Quiz only, accepted items only, no working badges. Author mode: everything.
function applyMode() {
  document.body.classList.toggle('author', MODE.author);
  document.querySelectorAll('.tab[data-mode="landmarks"], .tab[data-mode="review"]').forEach((t) => { t.hidden = student; });
  if (BUILD === 'review') document.querySelector('.tab[data-mode="landmarks"]').hidden = true;
  if (BUILD === 'review') $('#author-badge').textContent = 'REVIEW COPY';      // placing points needs the local server
  if (BUILD) document.querySelectorAll('#menu a').forEach((a) => a.remove());                          // packaged builds contain only the trainer
  const names = reviewerNames(review.items);
  $('#about-review').textContent = names.length ? `Outlines and text shown to students were checked by: ${names.join('; ')}.` : 'No structure has been signed off by a reviewer yet.';
  document.querySelector('.tabs').classList.toggle('two', student); document.querySelector('.tabs').classList.toggle('four', !student && BUILD !== 'review'); document.querySelector('.tabs').classList.toggle('three', BUILD === 'review');
  document.querySelectorAll('.author-only').forEach((el) => { el.hidden = student; });
  if (!allowed(byId[state.selected] || {})) state.selected = 0;
  renderQuizModules();
  renderInfo(); scene3d.select(state.selected); syncVisibility();
}

// Quiz: "All" plus every module that has something to ask about.
function quizPool() {
  const m = $('#quiz-module').value;
  return items().filter((s) => !m || moduleOf(s) === m);
}
function renderQuizModules() {
  const sel = $('#quiz-module'), keep = sel.value, mods = orderedModules(items());
  sel.innerHTML = `<option value="">All (${items().length})</option>` + mods.map((m) => `<option value="${esc(m)}">${esc(m)} (${items().filter((s) => moduleOf(s) === m).length})</option>`).join('');
  sel.value = mods.includes(keep) ? keep : '';
  const n = quizPool().length;
  $('#quiz-begin').disabled = n < 2;
  $('#quiz-need').hidden = n >= 2;
  $('#quiz-need').textContent = items().length ? 'Not enough structures in this module for a quiz yet.' : student ? 'No reviewed structures yet.' : 'This scan has no structures.';
}

// ------------------------------------------------------------------ landmarks (hand-placed named points)
// Stored in patient millimetres, so they survive a rebuild of the scan at another resolution.
function setLandmarkList(list, refresh = true) {
  landmarks = list.map((l, n) => ({
    ...l, id: 1000 + n, group: 'Landmarks', color: PIN_COLOR, point: true, accept: [], voxel: vol.toVoxel(l.mm),
  }));
  if (!refresh) return;
  byId = Object.fromEntries(allItems().map((s) => [s.id, s]));
  scene3d.setLandmarks(landmarks);
  if (!byId[state.selected]) state.selected = 0;
  renderList(); renderPlaced(); renderInfo(); renderQuizModules(); syncVisibility(false);
}

const plain = (l) => ({ key: l.key, name: l.name, side: l.side || '', mm: l.mm, summary: l.summary || '', ct_tip: l.ct_tip || '',
                        placed_by: l.placed_by || '', reviewed: !!l.reviewed });

// Put a catalogue landmark (or a custom name) at the crosshair. Paired landmarks get their side from the crosshair.
function placeLandmark(catalogKey, customName) {
  const c = catalog.find((e) => e.key === catalogKey);
  const base = c ? c.name : String(customName || '').trim();
  if (!base) return { error: 'Choose a landmark from the list or type a name.' };
  const mm = vol.toMm(state.cross);
  let side = '', name = base, key = c ? c.key : 'custom-' + base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  if (!key || key === 'custom-') return { error: 'The name needs at least one letter or digit.' };
  if (c && c.paired) {
    side = state.cross[0] >= (vol.nx - 1) / 2 ? 'L' : 'R';                      // +x is the patient's left
    name = `${side === 'L' ? 'Left' : 'Right'} ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
    key = `${key}-${side === 'L' ? 'Lt' : 'Rt'}`;
  }
  const entry = { key, name, side, mm: mm.map((v) => Math.round(v * 100) / 100), summary: c ? c.summary : '', ct_tip: c ? c.ct_tip : '',
                  placed_by: $('#lm-author').value.trim().slice(0, 80), reviewed: false };
  const replaced = landmarks.some((l) => l.key === key);
  setLandmarkList([...landmarks.filter((l) => l.key !== key).map(plain), entry]);
  select(landmarks.find((l) => l.key === key).id, false);
  markDirty(true);
  return { key, name, replaced };
}

function removeLandmark(key) { setLandmarkList(landmarks.filter((l) => l.key !== key).map(plain)); markDirty(true); }

function markDirty(on) {
  $('#lm-status').textContent = on ? 'Unsaved changes.' : $('#lm-status').textContent;
  $('#lm-status').className = on ? 'warning' : 'muted';
}

function renderPlaced() {
  const box = $('#lm-placed');
  box.innerHTML = landmarks.length ? [...landmarks].sort((a, b) => a.name.localeCompare(b.name)).map((l) =>
    `<div class="lm-row"><button class="s-item" data-id="${l.id}">${swatch(l)}${esc(l.name)}</button><button class="ghost lm-del" data-key="${esc(l.key)}" title="Remove this landmark">&times;</button></div>`).join('')
    : '<p class="muted">None placed on this scan yet.</p>';
  $('#lm-count').textContent = `${landmarks.length} placed`;
  const done = new Set(landmarks.map((l) => l.key.replace(/-(Lt|Rt)$/, '')));
  const chosen = $('#lm-select').value;                    // keep the choice: the other side is usually placed next
  $('#lm-select').innerHTML = '<option value="">Choose a landmark ...</option>' + catalog.map((c) =>
    `<option value="${c.key}">${done.has(c.key) ? '✓ ' : ''}${esc(c.name)}${c.paired ? ' (left / right)' : ''}</option>`).join('') + '<option value="__custom">Other (type a name) ...</option>';
  $('#lm-select').value = chosen;
  showCatalogTip();
}

function showCatalogTip() {
  const v = $('#lm-select').value, c = catalog.find((e) => e.key === v);
  $('#lm-custom').hidden = v !== '__custom';
  $('#lm-tip').hidden = !c;
  if (c) $('#lm-tip').innerHTML = `<p>${esc(c.summary)}</p><p class="tip"><strong>Where to put it:</strong> ${esc(c.ct_tip)}</p>`;
}

async function saveLandmarks() {
  const body = JSON.stringify({ scan: scanId, landmarks: landmarks.map(plain) });
  const status = $('#lm-status');
  try {
    const res = await fetch('/api/landmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    status.textContent = `Saved ${out.saved} landmarks to ${out.path}.`; status.className = 'muted';
    return out;
  } catch (err) {
    // plain static server: hand the file to the user instead
    const url = URL.createObjectURL(new Blob([JSON.stringify({ scan: scanId, frame: 'LPS mm', landmarks: landmarks.map(plain) }, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${scanId}.json` });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    status.textContent = `Could not save through the server (${err.message}). The file was downloaded: put it in web/assets/anatomy/landmarks/.`;
    status.className = 'warning';
    return { downloaded: true };
  }
}

function setupLandmarks() {
  renderPlaced();
  $('#lm-select').onchange = showCatalogTip;
  $('#lm-place').onclick = () => {
    const v = $('#lm-select').value;
    const r = placeLandmark(v === '__custom' ? '' : v, $('#lm-custom').value);
    $('#lm-msg').textContent = r.error || `${r.replaced ? 'Moved' : 'Placed'}: ${r.name}.`;
    $('#lm-msg').className = r.error ? 'error' : 'muted';
  };
  $('#lm-placed').onclick = (e) => {
    const del = e.target.closest('.lm-del'); if (del) { removeLandmark(del.dataset.key); return; }
    const b = e.target.closest('.s-item'); if (b) select(Number(b.dataset.id), true);
  };
  $('#lm-save').onclick = saveLandmarks;
}

// ------------------------------------------------------------------ quiz
function saved() { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } }
function save(rows) { try { localStorage.setItem(STORE, JSON.stringify(rows)); } catch { /* private window: results just are not kept */ } }

function showQuizStage(which) {
  $('#quiz-start').hidden = which !== 'start'; $('#quiz-run').hidden = which !== 'run'; $('#quiz-done').hidden = which !== 'done';
}

function syncQuizView() {
  const q = state.quiz, question = q ? q.round[q.n] : null;
  const inQuiz = state.mode === 'quiz' && question;
  const hide3d = inQuiz && question.kind === 'find' && q.phase === 'ask';
  $('#cover3d').hidden = !hide3d;
  scene3d.setReveal(!hide3d);
  scene3d.setOnly(inQuiz ? question.id : state.mode === 'review' ? state.selected : 0);
  scene3d.select(inQuiz ? (hide3d ? 0 : question.id) : state.selected);
  drawAll();
  const rows = saved(), right = rows.filter((r) => r.correct).length;
  $('#quiz-history').textContent = rows.length ? `Saved in this browser: ${rows.length} answers, ${right} correct (${Math.round(100 * right / rows.length)} %).` : 'No saved answers yet.';
}

function startRound(seed) {
  const pool = quizPool();                                         // one question per structure in the chosen module
  state.quiz = { round: makeRound(pool, pool.length, seed ?? Date.now()), n: 0, score: 0, phase: 'ask', session: new Date().toISOString(), rows: [] };
  showQuizStage('run'); ask();
}

function ask() {
  const q = state.quiz, question = q.round[q.n];
  q.phase = 'ask'; q.startedAt = performance.now();
  $('#quiz-count').textContent = `Question ${q.n + 1} of ${q.round.length}`;
  $('#quiz-score').textContent = `Score ${q.score}`;
  $('#quiz-prompt').textContent = question.prompt;
  $('#quiz-feedback').hidden = true; $('#quiz-next').hidden = true;
  const box = $('#quiz-choices'); box.innerHTML = '';
  $('#quiz-check').hidden = question.kind !== 'find';
  if (question.kind === 'name') {
    setCross(byId[question.id].voxel);
    box.innerHTML = question.choices.map((c) => `<button data-id="${c.id}">${c.name}</button>`).join('');
  }
  syncQuizView();
}

function answer(result) {
  const q = state.quiz, question = q.round[q.n], s = byId[question.id];
  if (q.phase !== 'ask') return;
  q.phase = 'answered';
  if (result.correct) q.score++;
  const row = { session: q.session, question: q.n + 1, kind: question.kind, structure: s.key, correct: result.correct ? 1 : 0,
                distance_mm: result.distance_mm ?? '', seconds: Math.round((performance.now() - q.startedAt) / 100) / 10, answered_at: new Date().toISOString() };
  q.rows.push(row); save([...saved(), row]);
  const c = textFor(s);
  const fb = $('#quiz-feedback');
  fb.hidden = false; fb.className = `card ${result.correct ? 'good' : 'poor'}`;
  const head = result.correct ? 'Correct.' : question.kind === 'find'
    ? `Not quite: the crosshair was ${result.distance_mm} mm from the ${s.name.toLowerCase()}.` : `No, this is the ${s.name.toLowerCase()}.`;
  fb.innerHTML = `<strong>${esc(head)}</strong><p>${student && !c.reviewed ? '' : esc(c.ct_tip || c.summary)}</p>`;
  $('#quiz-check').hidden = true; $('#quiz-next').hidden = false;
  $('#quiz-next').textContent = q.n + 1 < q.round.length ? 'Next' : 'Finish';
  $('#quiz-score').textContent = `Score ${q.score}`;
  if (question.kind === 'find' && !result.correct) setCross(s.voxel);       // show where it is
  syncQuizView();
}

function finish() {
  const q = state.quiz;
  $('#quiz-final').textContent = `Round finished: ${q.score} of ${q.round.length}`;
  const missed = q.rows.filter((r) => !r.correct).map((r) => items().find((s) => s.key === r.structure)).filter(Boolean);
  $('#quiz-missed').innerHTML = missed.length
    ? `<p class="muted">Worth another look (click to open in Explore):</p>${missed.map((s) => `<button class="s-item" data-id="${s.id}">${swatch(s)}${s.name}</button>`).join('')}`
    : '<p class="muted">Nothing missed.</p>';
  state.quiz = null; showQuizStage('done'); syncQuizView();
}

function setupQuiz() {
  $('#quiz-begin').onclick = () => startRound();
  $('#quiz-module').onchange = renderQuizModules;
  $('#quiz-again').onclick = () => startRound();
  $('#quiz-check').onclick = () => {
    const question = state.quiz.round[state.quiz.n], s = byId[question.id];
    if (s.point) answer(gradeFind(Math.hypot(...s.voxel.map((v, i) => v - state.cross[i])) * vol.h, POINT_TOLERANCE_MM));
    else answer(gradeFind(vol.distanceTo([s.id, ...s.accept], state.cross)));
  };
  $('#quiz-choices').onclick = (e) => {
    const id = Number(e.target.dataset.id); if (!id || state.quiz.phase !== 'ask') return;
    const question = state.quiz.round[state.quiz.n];
    $('#quiz-choices').querySelectorAll('button').forEach((b) => {
      const bid = Number(b.dataset.id); b.disabled = true;
      if (bid === question.id) b.classList.add('right'); else if (bid === id) b.classList.add('wrong');
    });
    answer({ correct: id === question.id });
  };
  $('#quiz-next').onclick = () => { const q = state.quiz; if (q.n + 1 < q.round.length) { q.n++; ask(); } else finish(); };
  $('#quiz-missed').onclick = (e) => { const b = e.target.closest('.s-item'); if (b) { setMode('explore'); select(Number(b.dataset.id), true); } };
  $('#quiz-csv').onclick = () => {
    const url = URL.createObjectURL(new Blob([toCsv(saved())], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'anatomy_quiz_results.csv' });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  $('#quiz-clear').onclick = () => { if (confirm('Delete all quiz results saved in this browser?')) { save([]); syncQuizView(); } };
}

// ------------------------------------------------------------------ small API for the tests and the console
window.anat = {
  ready: false, state,
  get volume() { return vol; }, get meta() { return meta; }, get scene() { return scene3d; },
  setCross, select, setMode, startRound, zoomPane, showReview, saveReview,
  get review() { return review; }, get reviewStage() { return rvStage; }, reviewList: () => rvItems().map((s) => s.key), get student() { return student; }, mode: MODE, visibleItems: () => items().map((s) => s.key),
  get hidden() { return [...state.hidden]; }, groups: () => orderedModules(items()), moduleOf,
  placeLandmark, removeLandmark, saveLandmarks,
  get landmarks() { return landmarks; }, get catalog() { return catalog; },
  paneView(view) { const p = panes[view]; return { zoom: p.zoom, cu: p.cu, cv: p.cv, scale: p.fit.s }; },
  savedResults: saved, summary: () => summarise(saved()), toleranceMm: TOLERANCE_MM,
  // client pixel of a voxel in a slice view
  pixelOf(view, vox) {
    const p = panes[view], r = p.canvas.getBoundingClientRect(), [u, v] = vol.voxelToPixel(view, vox);
    return [r.left + p.fit.x + (u + 0.5) * p.fit.s, r.top + p.fit.y + (v + 0.5) * p.fit.s];
  },
};

boot();
