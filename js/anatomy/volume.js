// Voxel volume helpers for the anatomy trainer. Pure functions, no DOM: also run under Node by the tests.
// Layout (see meta.json): index = i + nx * (j + ny * k); i -> patient left, j -> posterior, k -> superior.
// RESEARCH / EDUCATION PROTOTYPE ONLY. NOT FOR CLINICAL USE.

export const VIEWS = ['axial', 'coronal', 'sagittal'];

export const WINDOWS = {
  soft: { label: 'Soft tissue', center: 40, width: 400 },
  bone: { label: 'Bone', center: 500, width: 2000 },
  brain: { label: 'Brain', center: 40, width: 80 },
};

export class Volume {
  constructor(meta, ct, labels) {
    [this.nx, this.ny, this.nz] = meta.shape_xyz;
    this.h = meta.spacing_mm;
    this.origin = meta.origin_mm;
    const n = this.nx * this.ny * this.nz;
    if (ct.length !== n || labels.length !== n) throw new Error(`volume size mismatch: ${ct.length}, ${labels.length}, expected ${n}`);
    this.ct = ct; this.labels = labels;
  }
  index(i, j, k) { return i + this.nx * (j + this.ny * k); }
  inside(i, j, k) { return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz; }
  hu(i, j, k) { return this.ct[this.index(i, j, k)]; }
  label(i, j, k) { return this.inside(i, j, k) ? this.labels[this.index(i, j, k)] : 0; }
  clamp(v) {
    return [Math.min(Math.max(Math.round(v[0]), 0), this.nx - 1),
            Math.min(Math.max(Math.round(v[1]), 0), this.ny - 1),
            Math.min(Math.max(Math.round(v[2]), 0), this.nz - 1)];
  }
  toMm(v) { return [this.origin[0] + v[0] * this.h, this.origin[1] + v[1] * this.h, this.origin[2] + v[2] * this.h]; }
  toVoxel(mm) { return this.clamp([(mm[0] - this.origin[0]) / this.h, (mm[1] - this.origin[1]) / this.h, (mm[2] - this.origin[2]) / this.h]); }

  // Size [w, h] of a slice image. Screen conventions are radiological:
  // axial: patient right on screen left, anterior up. coronal: right on screen left, head up.
  // sagittal: anterior on screen left, head up.
  dims(view) {
    if (view === 'axial') return [this.nx, this.ny];
    if (view === 'coronal') return [this.nx, this.nz];
    return [this.ny, this.nz];
  }
  // Which voxel axis a view scrolls through.
  axis(view) { return view === 'axial' ? 2 : view === 'coronal' ? 1 : 0; }

  // Pixel (u, v) of a view at the crosshair voxel -> voxel [i, j, k].
  pixelToVoxel(view, u, v, cross) {
    if (view === 'axial') return [u, v, cross[2]];
    if (view === 'coronal') return [u, cross[1], this.nz - 1 - v];
    return [cross[0], u, this.nz - 1 - v];
  }
  voxelToPixel(view, vox) {
    if (view === 'axial') return [vox[0], vox[1]];
    if (view === 'coronal') return [vox[0], this.nz - 1 - vox[2]];
    return [vox[1], this.nz - 1 - vox[2]];
  }

  // Raw slice (HU and labels) through the crosshair, row-major in screen order.
  extract(view, cross) {
    const [w, h] = this.dims(view);
    const hu = new Int16Array(w * h), lab = new Uint8Array(w * h);
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const p = this.pixelToVoxel(view, u, v, cross);
        const q = this.index(p[0], p[1], p[2]);
        hu[u + w * v] = this.ct[q]; lab[u + w * v] = this.labels[q];
      }
    }
    return { w, h, hu, lab };
  }

  // Unsharp mask on a raw slice: v + amount * (v - mean of the 3x3 neighbourhood). Edges only; a flat area is unchanged.
  static sharpen(hu, w, h, amount) {
    const out = new Float32Array(hu.length);
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const q = u + w * v;
        if (u === 0 || v === 0 || u === w - 1 || v === h - 1) { out[q] = hu[q]; continue; }
        const mean = (hu[q - w - 1] + hu[q - w] + hu[q - w + 1] + hu[q - 1] + hu[q] + hu[q + 1] + hu[q + w - 1] + hu[q + w] + hu[q + w + 1]) / 9;
        out[q] = hu[q] + amount * (hu[q] - mean);
      }
    }
    return out;
  }

  // RGBA image of a slice. opts: { win:{center,width}, outlines:bool, colors:{id:[r,g,b]}, hidden:Set<id>, highlight:id|0, only:id|0, sharpen:number }
  // `only` draws just that structure's outline (used by the quiz).
  render(view, cross, opts, out) {
    const raw = this.extract(view, cross);
    const { w, h, lab } = raw;
    const hu = opts.sharpen ? Volume.sharpen(raw.hu, w, h, opts.sharpen) : raw.hu;
    const rgba = out && out.length === w * h * 4 ? out : new Uint8ClampedArray(w * h * 4);
    const lo = opts.win.center - opts.win.width / 2, scale = 255 / opts.win.width;
    const colors = opts.colors || {}, hidden = opts.hidden || new Set();
    const vis = (id) => id !== 0 && !hidden.has(id) && (!opts.only || id === opts.only);
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const q = u + w * v, o = q * 4;
        let g = (hu[q] - lo) * scale; g = g < 0 ? 0 : g > 255 ? 255 : g;
        let r = g, gg = g, b = g;
        const id = lab[q];
        if (opts.highlight && id === opts.highlight) {
          const c = colors[id] || [255, 220, 0];
          r = r * 0.5 + c[0] * 0.5; gg = gg * 0.5 + c[1] * 0.5; b = b * 0.5 + c[2] * 0.5;
        }
        if (opts.outlines || opts.only) {
          const right = u + 1 < w ? lab[q + 1] : id, down = v + 1 < h ? lab[q + w] : id;
          let e = 0;
          if (right !== id) e = vis(id) ? id : vis(right) ? right : 0;
          if (!e && down !== id) e = vis(id) ? id : vis(down) ? down : 0;
          if (e) { const c = colors[e] || [255, 220, 0]; r = c[0]; gg = c[1]; b = c[2]; }
        }
        rgba[o] = r; rgba[o + 1] = gg; rgba[o + 2] = b; rgba[o + 3] = 255;
      }
    }
    return { w, h, rgba };
  }

  // Distance in mm from a voxel to the nearest voxel carrying one of `ids` (0 if it is one). Infinity if absent.
  distanceTo(ids, vox) {
    const want = new Uint8Array(256); for (const id of ids) want[id] = 1;
    if (want[this.label(vox[0], vox[1], vox[2])]) return 0;
    let best = Infinity; const { nx, ny, nz, labels } = this;
    for (let k = 0; k < nz; k++) {
      const dk = (k - vox[2]) ** 2; if (dk >= best) continue;
      for (let j = 0; j < ny; j++) {
        const djk = dk + (j - vox[1]) ** 2; if (djk >= best) continue;
        const row = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          if (want[labels[row + i]]) { const d = djk + (i - vox[0]) ** 2; if (d < best) best = d; }
        }
      }
    }
    return Math.sqrt(best) * this.h;
  }
}

export async function fetchGz(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function loadVolume(base) {
  const meta = await (await fetch(`${base}/meta.json`)).json();
  const [ct, lab] = await Promise.all([fetchGz(`${base}/ct.i16.gz`), fetchGz(`${base}/labels.u8.gz`)]);
  return { meta, volume: new Volume(meta, new Int16Array(ct), new Uint8Array(lab)) };
}
