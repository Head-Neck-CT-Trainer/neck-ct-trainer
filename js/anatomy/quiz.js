// Quiz logic for the anatomy trainer. No DOM here, so the tests can run it under Node.
// RESEARCH / EDUCATION PROTOTYPE ONLY. NOT FOR CLINICAL USE.

export const TOLERANCE_MM = 2.0;     // a click this close to the structure still counts
export const POINT_TOLERANCE_MM = 5.0;   // landmarks are single points, so the allowance is larger

// Small deterministic random generator so a round can be reproduced from its seed.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function shuffle(a, rand) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}

// structures: meta.structures. Returns `count` questions alternating between the two kinds.
export function makeRound(structures, count = 10, seed = Date.now()) {
  const rand = rng(seed);
  const pool = shuffle(structures, rand);
  const out = [];
  for (let n = 0; n < count; n++) {
    const s = pool[n % pool.length];
    if (n % 2 === 0) {
      out.push({ kind: 'find', id: s.id, key: s.key, prompt: `Find the ${lower(s.name)} on the slices, put the crosshair on it, then press Check.` });
    } else {
      // distractors: prefer the same group, and always offer the other side if there is one
      const twin = structures.find((t) => t.id !== s.id && t.side && s.side && t.key.slice(0, -2) === s.key.slice(0, -2));
      const same = shuffle(structures.filter((t) => t.id !== s.id && t !== twin && t.group === s.group), rand);
      const rest = shuffle(structures.filter((t) => t.id !== s.id && t !== twin && t.group !== s.group), rand);
      const wrong = [twin, ...same, ...rest].filter(Boolean).slice(0, 3);
      out.push({ kind: 'name', id: s.id, key: s.key, prompt: 'Which structure is highlighted?',
                 choices: shuffle([s, ...wrong], rand).map((t) => ({ id: t.id, name: t.name })) });
    }
  }
  return out;
}

function lower(name) { return name.charAt(0).toLowerCase() + name.slice(1); }

// Marks a "find" answer. `distanceMm` = distance from the crosshair to the structure (0 if inside).
export function gradeFind(distanceMm, toleranceMm = TOLERANCE_MM) {
  return { correct: distanceMm <= toleranceMm, distance_mm: Math.round(distanceMm * 10) / 10 };
}

export function toCsv(rows) {
  const cols = ['session', 'question', 'kind', 'structure', 'correct', 'distance_mm', 'seconds', 'answered_at'];
  const esc = (v) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

export function summarise(rows) {
  const by = {};
  for (const r of rows) {
    const s = by[r.structure] || (by[r.structure] = { asked: 0, correct: 0 });
    s.asked++; if (r.correct) s.correct++;
  }
  return by;
}
