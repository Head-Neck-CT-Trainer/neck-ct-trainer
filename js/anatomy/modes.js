// Student / author modes, scan list, module grouping and visibility state for the anatomy trainer.
// Pure functions (no DOM), so the tests run them under Node.
// RESEARCH / EDUCATION PROTOTYPE ONLY. NOT FOR CLINICAL USE.

// Student mode is the default. ?author=1 shows everything (unreviewed items, badges, Landmarks and Review tabs,
// all scans). ?dev=1 keeps the student interface but lists every scan.
// A packaged build fixes the mode: "student" ignores ?author and ?dev; "review" is the reviewer's copy (no server).
export function detectMode(search, build = '') {
  const q = new URLSearchParams(search || '');
  if (build === 'student') return { author: false, dev: false, student: true, build };
  if (build === 'review') return { author: true, dev: false, student: false, build };
  const author = q.get('author') === '1';
  return { author, dev: q.get('dev') === '1', student: !author, build: '' };
}

export const STUDENT_SCANS = [
  { id: 'cta060', label: 'Main scan (CT angiogram)' },
  // the skull base scan is hidden from students for now (author and ?dev=1 still list it); to bring it back:
  // { id: 'skullbase', label: 'Bone detail (skull base)' },
];

// Which scans the picker offers and which one opens. `available` and `titles` come from index.json.
// Students get the curated scan(s) (when built); if neither exists (a fresh or test setup) everything is listed.
export function chooseScans(available, titles, mode, wanted) {
  const all = available.map((id) => ({ id, label: (titles && titles[id]) || `Scan ${id}` }));
  const curated = STUDENT_SCANS.filter((s) => available.includes(s.id));
  const list = mode.author || mode.dev || !curated.length
    ? [...curated.map((c) => (mode.author ? all.find((a) => a.id === c.id) : c)), ...all.filter((a) => !curated.some((c) => c.id === a.id))]
    : curated;
  const current = list.some((s) => s.id === wanted) ? wanted : list.length ? list[0].id : null;
  return { list, current };
}

// One list group per module, in teaching order. Older scans only have a "group"; map those onto the same modules.
export const MODULE_ORDER = ['Bones', 'Airway', 'Neck vessels', 'Brain vessels', 'Glands and muscles', 'Orbit', 'Brain'];
const ALIAS = {
  'Bones and levels': 'Bones', Bone: 'Bones', 'Airway and chest': 'Airway', Vessels: 'Neck vessels', Glands: 'Glands and muscles',
  'Eye and ear': 'Orbit', 'Brain and nerves': 'Brain', 'Other (unnamed remainder)': 'Other',
};
export function moduleOf(s) {
  const raw = String(s.module || s.group || 'Other').replace(/^\d+\s+/, '');
  return ALIAS[raw] || raw;
}
export function orderedModules(items) {
  const present = [...new Set(items.map(moduleOf))];
  const rank = (m) => { const i = MODULE_ORDER.indexOf(m); return i >= 0 ? i : MODULE_ORDER.length + (m === 'Landmarks' ? 2 : m === 'Other' ? 1 : 0); };
  return present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ---- visibility: a Set of hidden ids, kept in memory only
export function groupState(ids, hidden) {
  const off = ids.filter((id) => hidden.has(id)).length;
  return off === 0 ? 'all' : off === ids.length ? 'none' : 'mixed';
}
export function setGroup(ids, hidden, visible) {
  const h = new Set(hidden);
  for (const id of ids) visible ? h.delete(id) : h.add(id);
  return h;
}
export function toggleOne(id, hidden) {
  const h = new Set(hidden);
  h.has(id) ? h.delete(id) : h.add(id);
  return h;
}
// "Show only this": hide everything else and remember what was hidden, so "Show all" can put it back.
export function showOnly(allIds, id, hidden, saved) {
  return { hidden: new Set(allIds.filter((x) => x !== id)), saved: saved || new Set(hidden) };
}
export function restore(saved) {
  return { hidden: new Set(saved || []), saved: null };
}

// ---- card text: first sentence up front, the rest behind "More"
export function splitFirstSentence(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(.*?[.!?])\s+(?=[A-Z(])([\s\S]*)$/);
  return m ? { first: m[1], rest: m[2].trim() } : { first: t, rest: '' };
}

// ---- two-stage review: "author" is the pre-check, "radiologist" the reviewer's final sign-off (shown as "Reviewer");
// both are kept side by side
export const STAGES = ['author', 'radiologist'];
// Older files held one verdict per structure; that verdict was the author's.
export function migrateReview(items) {
  const out = {};
  for (const [key, v] of Object.entries(items || {})) {
    if (!v || typeof v !== 'object') continue;
    if (STAGES.some((st) => st in v)) { out[key] = {}; for (const st of STAGES) if (v[st] && typeof v[st] === 'object') out[key][st] = { ...v[st] }; }
    else out[key] = { author: { ...v } };
  }
  return out;
}
export const stageOf = (items, key, stage) => ((items || {})[key] || {})[stage] || {};
// Only the reviewer's "Correct" makes a structure visible to students.
export const studentVisible = (items, key) => stageOf(items, key, 'radiologist').outline === 'accept';
export const REVIEW_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'author-open', label: 'Author: not yet checked' },
  { id: 'rad-ready', label: 'Author: Correct, awaiting reviewer' },
  { id: 'rad-open', label: 'Reviewer: not yet signed off' },
  { id: 'problems', label: 'Needs fixing / Wrong' },
];
export const defaultFilter = (stage) => (stage === 'radiologist' ? 'rad-ready' : 'all');
export function matchesFilter(items, key, filter) {
  const a = stageOf(items, key, 'author').outline, r = stageOf(items, key, 'radiologist').outline;
  const bad = (v) => v === 'fix' || v === 'reject';
  switch (filter) {
    case 'author-open': return !a;
    case 'rad-ready': return a === 'accept' && !r;
    case 'rad-open': return !r;
    case 'problems': return bad(a) || bad(r);
    default: return true;
  }
}
// "Checked" / "signed off" = that stage has given an outline verdict, whatever it is.
export function reviewProgress(items, keys) {
  const n = (stage) => keys.filter((k) => !!stageOf(items, k, stage).outline).length;
  return { author: n('author'), radiologist: n('radiologist'), total: keys.length };
}

// Reviewer's copy without a server: second-stage verdicts kept in the browser are laid over the published file.
export function overlayStage(items, local, stage = 'radiologist') {
  const out = { ...items };
  for (const [key, v] of Object.entries(migrateReview(local))) if (v[stage]) out[key] = { ...(out[key] || {}), [stage]: v[stage] };
  return out;
}
// Names of the people whose second-stage "Correct" is what students see.
export function reviewerNames(items) {
  return [...new Set(Object.values(items || {}).map((v) => v.radiologist).filter((r) => r && r.outline === 'accept' && r.reviewer).map((r) => r.reviewer))];
}
