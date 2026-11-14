// What the passes compute, in TypeScript: the atlas the local laplacian keeps
// in the target (windows, quantized P, the residuals r and the differences D)
// and the bilateral grid gathered instead of splatted, both with the target's
// half-float storage. gpumodel.test.ts holds them to dtref.ts, which is held to
// darktable; glsl.ts is the same arithmetic per draw.

import {
  NUM_GAMMA,
  SPLAT_TAPS,
  bilateralPlan,
  gammaLevel,
  laplacianLayout,
  splatSpan,
  type AtlasLevel,
  type Grid,
} from "../../src/model";
import { curveScalar } from "./dtref";

const f = Math.fround;

/** A float32 rounded to the nearest half float (ties to even), as a float
 *  render target stores it. */
export function half(v: number): number {
  if (!Number.isFinite(v) || v === 0) return v;
  const a = Math.abs(v);
  if (a >= 65520) return Math.sign(v) * Infinity;
  const e = Math.max(Math.floor(Math.log2(a)), -14);
  const ulp = 2 ** (e - 10);
  const q = a / ulp;
  let r = Math.round(q);
  if (Math.abs(q - Math.trunc(q) - 0.5) < 1e-12) r = Math.trunc(q) % 2 === 0 ? Math.trunc(q) : Math.trunc(q) + 1;
  return Math.sign(v) * r * ulp;
}

/** A value kept as a half float and the half float of what that leaves: about
 *  22 bits, as the last draw hands the inline its result in x and y. */
export const split = (v: number): number => {
  const hi = half(v);
  return f(hi + half(f(v - hi)));
};

const u32 = new Uint32Array(1);
const asFloat = new Float32Array(u32.buffer);

/** P with 11 significant bits, which a half float holds exactly; 0 below
 *  half's normal range. */
export function quantize(v: number): number {
  if (Math.abs(v) < 2 ** -14) return 0;
  asFloat[0] = v;
  u32[0] = ((u32[0] + 0x1000) & 0xffffe000) >>> 0;
  return asFloat[0];
}

export interface ModelOptions {
  /** Round what the target stores to half floats (the GPU); false keeps float32. */
  halfStorage: boolean;
  /** Store P at full float32 precision instead of quantized, to prove the
   *  layout apart from the quantization. */
  exactP?: boolean;
}

/** The six remapping curves less the identity: E_k(v) = curve_k(v) − v. */
function remap(v: number, k: number, sigma: number, shadows: number, highlights: number, clarity: number): number {
  return f(curveScalar(v, gammaLevel(k), sigma, shadows, highlights, clarity) - v);
}

/** bins(): the two copies that bracket v, and the weight of the upper. */
function bins(v: number): { lo: number; hi: number; a: number } {
  let hi = 1;
  for (; hi < NUM_GAMMA - 1 && gammaLevel(hi) <= v; hi++);
  const lo = hi - 1;
  const a = Math.min(Math.max(f(f(v - gammaLevel(lo)) / f(gammaLevel(hi) - gammaLevel(lo))), 0), 1);
  return { lo, hi, a };
}

/** The 1-D expand weights at a fine index, for coarse offsets −1, 0, 1. */
const expandWeights = (i: number): [number, number, number] => (i & 1 ? [0, 0.5, 0.5] : [0.125, 0.75, 0.125]);

/** D[0] (ΔL* / 100) the local laplacian pass leaves for the inline, from the
 *  frame's L*; null when the frame is too small to run. */
export function laplacianModel(
  L: Float32Array,
  width: number,
  height: number,
  sigma: number,
  shadows: number,
  highlights: number,
  clarity: number,
  options: ModelOptions,
): Float32Array | null {
  const layout = laplacianLayout(width, height);
  if (!layout.fits) return null;
  const { last, supp, atlas } = layout;
  const keep = (v: number) => v;
  const storeR = options.halfStorage ? half : keep;
  const storeD = options.halfStorage ? half : keep;
  const storeResult = options.halfStorage ? split : keep;
  const target = new Float32Array(width * height * 4);
  const E = (v: number, k: number) => remap(v, k, sigma, shadows, highlights, clarity);
  const input = (px: number, py: number) =>
    f(L[Math.min(Math.max(py - supp, 0), height - 1) * width + Math.min(Math.max(px - supp, 0), width - 1)] * f(0.01));

  const texel = (lv: AtlasLevel, plane: number, px: number, py: number): number => {
    const x = Math.min(Math.max(px, lv.x.lo), lv.x.hi) - lv.x.lo;
    const y = Math.min(Math.max(py, lv.y.lo), lv.y.hi) - lv.y.lo;
    const n = lv.base + plane * lv.area + y * (lv.x.hi - lv.x.lo + 1) + x;
    if (n < 0 || n >= lv.base + 2 * lv.area || n >= width * height) throw new Error(`read outside level ${lv.level}`);
    return 4 * n;
  };

  const B3 = [1, 4, 6, 4, 1];
  for (let l = 1; l <= last; l++) {
    const lv = atlas[l];
    for (let plane = 0; plane < 2; plane++) {
      for (let py = lv.y.lo; py <= lv.y.hi; py++) {
        for (let px = lv.x.lo; px <= lv.x.hi; px++) {
          const X = Math.min(Math.max(px, 1), lv.x.size - 2);
          const Y = Math.min(Math.max(py, 1), lv.y.size - 2);
          let P = 0;
          const e = [0, 0, 0];
          for (let j = 0; j < 5; j++) {
            for (let i = 0; i < 5; i++) {
              const w = B3[i] * B3[j];
              const fx = 2 * X - 2 + i;
              const fy = 2 * Y - 2 + j;
              let v: number;
              let ev: number[];
              if (l === 1) {
                v = input(fx, fy);
                ev = [0, 1, 2].map((m) => E(v, 3 * plane + m));
              } else {
                const t = texel(atlas[l - 1], plane, fx, fy);
                v = target[t];
                ev = [0, 1, 2].map((m) => f(target[t + 1 + m] + E(v, 3 * plane + m)));
              }
              P += w * v;
              for (let m = 0; m < 3; m++) e[m] += w * ev[m];
            }
          }
          const Pq = options.exactP ? f(P / 256) : quantize(f(P / 256));
          const out = texel(lv, plane, px, py);
          target[out] = Pq;
          for (let m = 0; m < 3; m++) target[out + 1 + m] = storeR(f(f(e[m] / 256) - E(Pq, 3 * plane + m)));
        }
      }
    }
  }

  // e_k of a texel of a level, rebuilt from P and its residual.
  const pick = (lv: AtlasLevel, px: number, py: number, k: number): number => {
    const a = texel(lv, 0, px, py);
    const r = k < 3 ? target[a + 1 + k] : target[texel(lv, 1, px, py) + 1 + (k - 3)];
    return f(r + E(target[a], k));
  };

  /** The expand at level l + 1 of D, e_lo and e_hi, for fine texel (px, py) of level l. */
  const expand = (l: number, px: number, py: number, lo: number, hi: number) => {
    const fine = l === 0 ? null : atlas[l];
    const sizeX = fine ? fine.x.size : width + 2 * supp;
    const sizeY = fine ? fine.y.size : height + 2 * supp;
    const ci = Math.min(Math.max(px, 1), ((sizeX - 1) & ~1) - 1);
    const cj = Math.min(Math.max(py, 1), ((sizeY - 1) & ~1) - 1);
    const wx = expandWeights(ci);
    const wy = expandWeights(cj);
    const coarse = atlas[l + 1];
    let D = 0;
    let eLo = 0;
    let eHi = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const w = wx[i + 1] * wy[j + 1];
        if (w === 0) continue;
        const cx = (ci >> 1) + i;
        const cy = (cj >> 1) + j;
        D += w * (l + 1 === last ? 0 : target[texel(coarse, 1, cx, cy)]);
        eLo += w * pick(coarse, cx, cy, lo);
        eHi += w * pick(coarse, cx, cy, hi);
      }
    }
    return { D, eLo, eHi };
  };

  for (let l = last - 1; l >= 1; l--) {
    const lv = atlas[l];
    const written: [number, number][] = [];
    for (let py = lv.y.lo; py <= lv.y.hi; py++) {
      for (let px = lv.x.lo; px <= lv.x.hi; px++) {
        const v = target[texel(lv, 0, px, py)];
        const { lo, hi, a } = bins(v);
        const x = expand(l, px, py, lo, hi);
        const D = x.D + (1 - a) * (pick(lv, px, py, lo) - x.eLo) + a * (pick(lv, px, py, hi) - x.eHi);
        written.push([texel(lv, 1, px, py), storeD(f(D))]);
      }
    }
    for (const [at, v] of written) target[at] = v;
  }

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = f(L[y * width + x] * f(0.01));
      const { lo, hi, a } = bins(v);
      const e = expand(0, x + supp, y + supp, lo, hi);
      out[y * width + x] = storeResult(f(e.D + (1 - a) * (E(v, lo) - e.eLo) + a * (E(v, hi) - e.eHi)));
    }
  }
  return out;
}

// ── Bilateral grid ───────────────────────────────────────────────────────────

/** A pixel's tent weight to a node along one axis, as darktable's
 *  image_to_grid() places it. */
export function tent(coord: number, inv: number, size: number, node: number): number {
  const x = Math.min(Math.max(f(coord * inv), 0), size - 1);
  const xi = Math.min(Math.trunc(x), size - 2);
  const xf = f(x - xi);
  if (xi === node) return f(1 - xf);
  if (xi + 1 === node) return xf;
  return 0;
}

/** The first pixel a node's splat reads, and how many. */
export function splatWindow(node: number, sigmaS: number): { first: number; span: number } {
  return { first: Math.max(Math.floor((node - 1) * sigmaS) - 1, 0), span: splatSpan(sigmaS) };
}

/** ΔL* / 100 the bilateral pass leaves for the inline (before the inline's
 *  max(0, L* + ΔL*)), from the frame's L*; null when no grid fits. */
export function bilateralModel(
  L: Float32Array,
  width: number,
  height: number,
  sigmaS: number,
  sigmaR: number,
  detail: number,
  options: ModelOptions,
): { delta: Float32Array; grid: Grid; widened: number } | null {
  const plan = bilateralPlan(width, height, sigmaS, sigmaR);
  if (!plan) return null;
  const { grid } = plan;
  const { sizeX, sizeY, sizeZ, invS, invR } = grid;
  const store = options.halfStorage ? half : (v: number) => v;
  const nz = 4 * grid.quads;
  const Sx = new Float32Array(sizeX * height * nz);
  for (let y = 0; y < height; y++) {
    for (let gx = 0; gx < sizeX; gx++) {
      const { first, span } = splatWindow(gx, grid.sigmaS);
      const acc = new Float64Array(nz);
      for (let chunk = 0; chunk * SPLAT_TAPS < span; chunk++) {
        const part = new Float64Array(nz);
        for (let t = 0; t < SPLAT_TAPS && chunk * SPLAT_TAPS + t < span; t++) {
          const x = first + chunk * SPLAT_TAPS + t;
          if (x >= width) continue;
          const w = tent(x, invS, sizeX, gx);
          if (w === 0) continue;
          const Lv = L[y * width + x];
          const z = Math.min(Math.max(f(Lv * invR), 0), sizeZ - 1);
          const zi = Math.min(Math.trunc(z), sizeZ - 2);
          const zf = f(z - zi);
          part[zi] += w * (1 - zf);
          part[zi + 1] += w * zf;
        }
        for (let z = 0; z < nz; z++) acc[z] = store(f(acc[z] + part[z]));
      }
      for (let x = 0; x < width; x++) {
        if (tent(x, invS, sizeX, gx) !== 0 && (x < first || x >= first + span)) throw new Error(`pixel ${x} outside node ${gx}'s window`);
      }
      Sx.set(acc, (y * sizeX + gx) * nz);
    }
  }
  const B = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  // The x-blur, in place on the x-splat (a draw per quad on the GPU).
  const SxB = new Float32Array(Sx.length);
  for (let y = 0; y < height; y++)
    for (let gx = 0; gx < sizeX; gx++)
      for (let z = 0; z < nz; z++) {
        let s = 0;
        for (let d = -2; d <= 2; d++) if (gx + d >= 0 && gx + d < sizeX) s += B[d + 2] * Sx[(y * sizeX + gx + d) * nz + z];
        SxB[(y * sizeX + gx) * nz + z] = store(f(s));
      }
  const S = new Float32Array(sizeX * sizeY * nz);
  for (let gy = 0; gy < sizeY; gy++) {
    const { first, span } = splatWindow(gy, grid.sigmaS);
    for (let y = 0; y < height; y++) {
      if (tent(y, invS, sizeY, gy) !== 0 && (y < first || y >= first + span)) throw new Error(`row ${y} outside node ${gy}'s window`);
    }
    for (let gx = 0; gx < sizeX; gx++) {
      const acc = new Float64Array(nz);
      for (let chunk = 0; chunk * SPLAT_TAPS < span; chunk++) {
        const part = new Float64Array(nz);
        for (let t = 0; t < SPLAT_TAPS && chunk * SPLAT_TAPS + t < span; t++) {
          const y = first + chunk * SPLAT_TAPS + t;
          if (y >= height) continue;
          const w = tent(y, invS, sizeY, gy);
          if (w === 0) continue;
          for (let z = 0; z < nz; z++) part[z] += w * SxB[(y * sizeX + gx) * nz + z];
        }
        for (let z = 0; z < nz; z++) acc[z] = store(f(acc[z] + part[z]));
      }
      S.set(acc, (gy * sizeX + gx) * nz);
    }
  }
  const B2 = new Float32Array(S.length);
  for (let gy = 0; gy < sizeY; gy++)
    for (let gx = 0; gx < sizeX; gx++)
      for (let z = 0; z < nz; z++) {
        let s = 0;
        for (let d = -2; d <= 2; d++) if (gy + d >= 0 && gy + d < sizeY) s += B[d + 2] * S[((gy + d) * sizeX + gx) * nz + z];
        B2[(gy * sizeX + gx) * nz + z] = store(f(s));
      }
  const bin = (gx: number, gy: number, z: number) => (z < 0 || z >= sizeZ ? 0 : B2[(gy * sizeX + gx) * nz + z]);
  const dz = (gx: number, gy: number, z: number) => 0.25 * (bin(gx, gy, z + 1) - bin(gx, gy, z - 1)) + 0.125 * (bin(gx, gy, z + 2) - bin(gx, gy, z - 2));
  const norm = f(f(-detail * grid.sigmaR) * f(0.04));
  const scale = f(100 / f(grid.sigmaS * grid.sigmaS));
  const delta = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const ys = Math.min(Math.max(f(y * invS), 0), sizeY - 1);
    const yi = Math.min(Math.trunc(ys), sizeY - 2);
    const yf = f(ys - yi);
    for (let x = 0; x < width; x++) {
      const Lv = L[y * width + x];
      const xs = Math.min(Math.max(f(x * invS), 0), sizeX - 1);
      const xi = Math.min(Math.trunc(xs), sizeX - 2);
      const xf = f(xs - xi);
      const zs = Math.min(Math.max(f(Lv * invR), 0), sizeZ - 1);
      const zi = Math.min(Math.trunc(zs), sizeZ - 2);
      const zf = f(zs - zi);
      let sum = 0;
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const w = (i ? xf : 1 - xf) * (j ? yf : 1 - yf);
          sum += w * ((1 - zf) * dz(xi + i, yi + j, zi) + zf * dz(xi + i, yi + j, zi + 1));
        }
      delta[y * width + x] = (options.halfStorage ? split : (v: number) => v)(f((norm * scale * sum) / 100));
    }
  }
  return { delta, grid, widened: plan.widened };
}
