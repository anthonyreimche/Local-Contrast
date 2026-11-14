// darktable's local contrast as darktable's CPU path computes it, in float32:
// a transcription of bilat.c process(), locallaplacian.c
// local_laplacian_internal() with no boundary, bilateral.c's grid, and the
// pixelpipe's Lab conversions (colorspaces_inline_conversions.h). The GPU spec
// compares the stage against it; dtref.test.ts holds it to darktable's output.
//
// Copyright (C) 2012-2026 darktable developers (GPL-3.0-or-later).

import { MAX_LEVELS, NUM_GAMMA, type DarktableParams } from "../../src/model";

const f = Math.fround;

export interface RGBImage {
  width: number;
  height: number;
  /** Linear Rec.709, three floats a pixel. */
  data: Float32Array;
}

// ── Lab ──────────────────────────────────────────────────────────────────────

/** Linear Rec.709 to XYZ (D50, Bradford), the working profile's matrix. */
export const XYZ_FROM_709: readonly (readonly number[])[] = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
];

function invert3(m: readonly (readonly number[])[]): number[][] {
  const [a, b, c] = m;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  return [
    [(b[1] * c[2] - b[2] * c[1]) / det, (a[2] * c[1] - a[1] * c[2]) / det, (a[1] * b[2] - a[2] * b[1]) / det],
    [(b[2] * c[0] - b[0] * c[2]) / det, (a[0] * c[2] - a[2] * c[0]) / det, (a[2] * b[0] - a[0] * b[2]) / det],
    [(b[0] * c[1] - b[1] * c[0]) / det, (a[1] * c[0] - a[0] * c[1]) / det, (a[0] * b[1] - a[1] * b[0]) / det],
  ];
}

export const RGB709_FROM_XYZ = invert3(XYZ_FROM_709);

const D50 = [0.9642, 1.0, 0.8249];
const EPSILON = f(216 / 24389);
const KAPPA = f(24389 / 27);
const EPSILON_F = f(0.20689655172413796);

const labF = (x: number): number => (x > EPSILON ? f(Math.cbrt(x)) : f(f(f(KAPPA * x) + 16) / 116));
const labFInv = (x: number): number => (x > EPSILON_F ? f(f(x * x) * x) : f(f(f(116 * x) - 16) / KAPPA));

/** dt_XYZ_to_Lab() of the matrix's XYZ. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const m = XYZ_FROM_709;
  const fx = labF(f(f(m[0][0] * r + m[0][1] * g + m[0][2] * b) / D50[0]));
  const fy = labF(f(m[1][0] * r + m[1][1] * g + m[1][2] * b));
  const fz = labF(f(f(m[2][0] * r + m[2][1] * g + m[2][2] * b) / D50[2]));
  return [f(f(116 * fy) - 16), f(500 * f(fx - fy)), f(-200 * f(fz - fy))];
}

/** dt_Lab_to_XYZ() and the matrix back to linear Rec.709. */
export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = f(f(L + 16) / 116);
  const fx = f(fy + f(a / 500));
  const fz = f(fy - f(b / 200));
  const X = D50[0] * labFInv(fx);
  const Y = labFInv(fy);
  const Z = D50[2] * labFInv(fz);
  const m = RGB709_FROM_XYZ;
  return [
    f(m[0][0] * X + m[0][1] * Y + m[0][2] * Z),
    f(m[1][0] * X + m[1][1] * Y + m[1][2] * Z),
    f(m[2][0] * X + m[2][1] * Y + m[2][2] * Z),
  ];
}

// ── Local laplacian ──────────────────────────────────────────────────────────

const dl = (size: number, level: number): number => {
  let s = size;
  for (let l = 0; l < level; l++) s = Math.floor((s - 1) / 2) + 1;
  return s;
};

const u32 = new Uint32Array(1);
const asFloat = new Float32Array(u32.buffer);

/** dt_fast_expf(): (int)(0x3f800000 + x * (0x402DF854 - 0x3f800000)) read as a float. */
export function fastExpf(x: number): number {
  const k = f(1065353216 + f(f(x) * 11401300));
  if (!(k > 0)) return 0;
  u32[0] = Math.trunc(k);
  return asFloat[0];
}

/** curve_scalar(). */
export function curveScalar(x: number, g: number, sigma: number, shadows: number, highlights: number, clarity: number): number {
  const c = f(x - g);
  let val: number;
  const s2 = f(2 * sigma);
  if (c > s2) val = f(f(g + sigma) + f(shadows * f(c - sigma)));
  else if (c < -s2) val = f(f(g - sigma) + f(highlights * f(c + sigma)));
  else if (c > 0) {
    const t = Math.min(Math.max(f(c / s2), 0), 1);
    const t2 = f(t * t);
    const mt = f(1 - t);
    val = f(f(g + f(f(f(sigma * 2) * mt) * t)) + f(t2 * f(sigma + f(sigma * shadows))));
  } else {
    const t = Math.min(Math.max(f(-c / s2), 0), 1);
    const t2 = f(t * t);
    const mt = f(1 - t);
    val = f(f(g - f(f(f(sigma * 2) * mt) * t)) + f(t2 * f(-sigma - f(sigma * highlights))));
  }
  const denom = f(f(f(2 * sigma) * sigma) / 3);
  return f(val + f(f(clarity * c) * fastExpf(f(f(-c * c) / denom))));
}

/** ll_expand_gaussian() at a clamped (i, j) of a wd × ht level. */
function expandGaussian(coarse: Float32Array, i: number, j: number, wd: number): number {
  const cw = Math.floor((wd - 1) / 2) + 1;
  const ind = (j >> 1) * cw + (i >> 1);
  const C = (o: number) => coarse[ind + o];
  switch ((i & 1) + 2 * (j & 1)) {
    case 0:
      return (4 / 256) * f(
        f(6 * f(f(f(f(C(-cw) + C(-1)) + f(6 * C(0))) + C(1)) + C(cw))) + C(-cw - 1) + C(-cw + 1) + C(cw - 1) + C(cw + 1),
      );
    case 1:
      return f((4 / 256) * (24 * f(C(0) + C(1)) + 4 * f(f(f(C(-cw) + C(-cw + 1)) + C(cw)) + C(cw + 1))));
    case 2:
      return f((4 / 256) * (24 * f(C(0) + C(cw)) + 4 * f(f(f(C(-1) + C(1)) + C(cw - 1)) + C(cw + 1))));
    default:
      return f(0.25 * f(f(f(C(0) + C(1)) + C(cw)) + C(cw + 1)));
  }
}

/** gauss_reduce(): the 5 × 5 B3 kernel at even texels, one texel of border copied. */
function gaussReduce(input: Float32Array, wd: number, ht: number): Float32Array {
  const cw = Math.floor((wd - 1) / 2) + 1;
  const ch = Math.floor((ht - 1) / 2) + 1;
  const out = new Float32Array(cw * ch);
  const w = [1, 4, 6, 4, 1];
  for (let j = 1; j < ch - 1; j++) {
    for (let i = 1; i < cw - 1; i++) {
      let sum = 0;
      for (let jj = 0; jj < 5; jj++) {
        let row = 0;
        for (let ii = 0; ii < 5; ii++) row = f(row + w[ii] * input[(2 * j - 2 + jj) * wd + 2 * i - 2 + ii]);
        sum = f(sum + f(w[jj] * row));
      }
      out[j * cw + i] = f(sum / 256);
    }
  }
  for (let j = 1; j < ch - 1; j++) {
    out[j * cw] = out[j * cw + 1];
    out[j * cw + cw - 1] = out[j * cw + cw - 2];
  }
  for (let i = 0; i < cw; i++) {
    out[i] = out[cw + i];
    out[(ch - 1) * cw + i] = out[(ch - 2) * cw + i];
  }
  return out;
}

/** gauss_expand() into a wd × ht level. */
function gaussExpand(coarse: Float32Array, wd: number, ht: number): Float32Array {
  const fine = new Float32Array(wd * ht);
  for (let j = 1; j < ((ht - 1) & ~1); j++) for (let i = 1; i < ((wd - 1) & ~1); i++) fine[j * wd + i] = expandGaussian(coarse, i, j, wd);
  for (let j = 1; j < ht - 1; j++) fine[j * wd] = fine[j * wd + 1];
  if (wd & 1) for (let j = 1; j < ht - 1; j++) fine[j * wd + wd - 1] = fine[j * wd + wd - 2];
  else for (let j = 1; j < ht - 1; j++) fine[j * wd + wd - 1] = fine[j * wd + wd - 2] = fine[j * wd + wd - 3];
  for (let i = 0; i < wd; i++) fine[i] = fine[wd + i];
  if (!(ht & 1)) for (let i = 0; i < wd; i++) fine[(ht - 2) * wd + i] = fine[(ht - 3) * wd + i];
  for (let i = 0; i < wd; i++) fine[(ht - 1) * wd + i] = fine[(ht - 2) * wd + i];
  return fine;
}

const clamps = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** local_laplacian_internal(input, out, wd, ht, sigma, shadows, highlights, clarity, 0),
 *  on L* alone: L* in, L* out. */
export function localLaplacian(
  L: Float32Array,
  wd: number,
  ht: number,
  sigma: number,
  shadows: number,
  highlights: number,
  clarity: number,
): Float32Array {
  const result = new Float32Array(L);
  if (wd <= 1 || ht <= 1) return result;
  const numLevels = Math.min(MAX_LEVELS, 31 - Math.clz32(Math.min(wd, ht)));
  const last = numLevels - 1;
  const supp = 1 << last;
  const w = wd + 2 * supp;
  const h = ht + 2 * supp;

  const padded: Float32Array[] = [];
  padded[0] = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const sj = clamps(j - supp, 0, ht - 1);
    for (let i = 0; i < w; i++) padded[0][j * w + i] = f(L[sj * wd + clamps(i - supp, 0, wd - 1)] * f(0.01));
  }
  const output: Float32Array[] = [];
  for (let l = 1; l < last; l++) padded[l] = gaussReduce(padded[l - 1], dl(w, l - 1), dl(h, l - 1));
  output[last] = gaussReduce(padded[last - 1], dl(w, last - 1), dl(h, last - 1));

  const gamma = Array.from({ length: NUM_GAMMA }, (_, k) => f(f(k + 0.5) / NUM_GAMMA));
  const buf: Float32Array[][] = [];
  for (let k = 0; k < NUM_GAMMA; k++) {
    buf[k] = [];
    const b0 = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) b0[i] = curveScalar(padded[0][i], gamma[k], sigma, shadows, highlights, clarity);
    buf[k][0] = b0;
    for (let l = 1; l <= last; l++) buf[k][l] = gaussReduce(buf[k][l - 1], dl(w, l - 1), dl(h, l - 1));
  }

  for (let l = last - 1; l >= 0; l--) {
    const pw = dl(w, l);
    const ph = dl(h, l);
    const out = gaussExpand(output[l + 1], pw, ph);
    const ci = (i: number) => clamps(i, 1, ((pw - 1) & ~1) - 1);
    const cj = (j: number) => clamps(j, 1, ((ph - 1) & ~1) - 1);
    for (let j = 0; j < ph; j++) {
      for (let i = 0; i < pw; i++) {
        const v = padded[l][j * pw + i];
        let hi = 1;
        for (; hi < NUM_GAMMA - 1 && gamma[hi] <= v; hi++);
        const lo = hi - 1;
        const a = clamps(f(f(v - gamma[lo]) / f(gamma[hi] - gamma[lo])), 0, 1);
        const l0 = f(buf[lo][l][j * pw + i] - expandGaussian(buf[lo][l + 1], ci(i), cj(j), pw));
        const l1 = f(buf[hi][l][j * pw + i] - expandGaussian(buf[hi][l + 1], ci(i), cj(j), pw));
        out[j * pw + i] = f(out[j * pw + i] + f(f(l0 * f(1 - a)) + f(l1 * a)));
      }
    }
    output[l] = out;
  }
  for (let j = 0; j < ht; j++) for (let i = 0; i < wd; i++) result[j * wd + i] = f(100 * output[0][(j + supp) * w + supp + i]);
  return result;
}

// ── Bilateral grid ───────────────────────────────────────────────────────────

export interface BilateralGrid {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  sigmaS: number;
  sigmaR: number;
  invS: number;
  invR: number;
}

/** dt_bilateral_grid_size(b, width, height, 100, sigma_s, sigma_r). */
export function bilateralGridSize(width: number, height: number, sigmaSIn: number, sigmaR: number): BilateralGrid {
  const sigmaS = f(sigmaSIn) < 0.5 ? 0.5 : f(sigmaSIn);
  const x = clamps(Math.floor(f(width / sigmaS) + 0.5), 4, 3000);
  const y = clamps(Math.floor(f(height / sigmaS) + 0.5), 4, 3000);
  const z = clamps(Math.floor(f(100 / f(sigmaR)) + 0.5), 4, 50);
  const s = Math.max(f(height / y), f(width / x));
  const r = f(100 / z);
  const invS = f(1 / s);
  const invR = f(1 / r);
  return {
    sigmaS: s,
    sigmaR: r,
    invS,
    invR,
    sizeX: Math.ceil(f(width * invS)) + 1,
    sizeY: Math.ceil(f(height * invS)) + 1,
    sizeZ: Math.ceil(f(100 * invR)) + 1,
  };
}

/** dt_bilateral_init/splat/blur/slice on L*: L* in, L* out. */
export function bilateral(L: Float32Array, width: number, height: number, sigmaS: number, sigmaR: number, detail: number): Float32Array {
  const g = bilateralGridSize(width, height, sigmaS, sigmaR);
  const { sizeX, sizeY, sizeZ } = g;
  const ox = sizeZ;
  const oy = sizeX * sizeZ;
  const buf = new Float32Array(sizeX * sizeY * sizeZ);
  const ss = f(g.sigmaS * g.sigmaS);
  const toGrid = (v: number, inv: number, size: number) => {
    const x = clamps(f(v * inv), 0, size - 1);
    const xi = Math.min(Math.trunc(x), size - 2);
    return [xi, f(x - xi)] as const;
  };
  for (let j = 0; j < height; j++) {
    const [yi, yf] = toGrid(j, g.invS, sizeY);
    for (let i = 0; i < width; i++) {
      const Lv = L[j * width + i];
      const [xi, xf] = toGrid(i, g.invS, sizeX);
      const [zi, zf] = toGrid(Lv, g.invR, sizeZ);
      const gi = xi * ox + yi * oy + zi;
      const c = [
        f(f(f(f(1 - xf) * f(1 - yf)) * 100) / ss),
        f(f(f(xf * f(1 - yf)) * 100) / ss),
        f(f(f(f(1 - xf) * yf) * 100) / ss),
        f(f(f(xf * yf) * 100) / ss),
      ];
      const offs = [0, ox, oy, ox + oy];
      for (let k = 0; k < 4; k++) {
        buf[gi + offs[k]] = f(buf[gi + offs[k]] + f(c[k] * f(1 - zf)));
        buf[gi + offs[k] + 1] = f(buf[gi + offs[k] + 1] + f(c[k] * zf));
      }
    }
  }
  const blurLine = (o1: number, o2: number, o3: number, s1: number, s2: number, s3: number) => {
    for (let k = 0; k < s1; k++) {
      for (let j = 0; j < s2; j++) {
        const at = (i: number) => k * o1 + j * o2 + i * o3;
        const line = Array.from({ length: s3 }, (_, i) => buf[at(i)]);
        const v = (i: number) => (i >= 0 && i < s3 ? line[i] : 0);
        for (let i = 0; i < s3; i++) {
          buf[at(i)] = f(f(f(v(i) * f(6 / 16)) + f(f(4 / 16) * f(v(i + 1) + v(i - 1)))) + f(f(1 / 16) * f(v(i + 2) + v(i - 2))));
        }
      }
    }
  };
  const blurLineZ = (o1: number, o2: number, o3: number, s1: number, s2: number, s3: number) => {
    for (let k = 0; k < s1; k++) {
      for (let j = 0; j < s2; j++) {
        const at = (i: number) => k * o1 + j * o2 + i * o3;
        const line = Array.from({ length: s3 }, (_, i) => buf[at(i)]);
        const v = (i: number) => (i >= 0 && i < s3 ? line[i] : 0);
        for (let i = 0; i < s3; i++) {
          buf[at(i)] = f(f(f(4 / 16) * f(v(i + 1) - v(i - 1))) + f(f(2 / 16) * f(v(i + 2) - v(i - 2))));
        }
      }
    }
  };
  blurLine(1, oy, ox, sizeZ, sizeY, sizeX);
  blurLine(1, ox, oy, sizeZ, sizeX, sizeY);
  blurLineZ(ox, oy, 1, sizeX, sizeY, sizeZ);

  const norm = f(f(-detail * g.sigmaR) * f(0.04));
  const out = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const [yi, yf] = toGrid(j, g.invS, sizeY);
    for (let i = 0; i < width; i++) {
      const Lv = L[j * width + i];
      const [xi, xf] = toGrid(i, g.invS, sizeX);
      const [zi, zf] = toGrid(Lv, g.invR, sizeZ);
      const gi = xi * ox + yi * oy + zi;
      const sum =
        buf[gi] * (1 - xf) * (1 - yf) * (1 - zf) +
        buf[gi + ox] * xf * (1 - yf) * (1 - zf) +
        buf[gi + oy] * (1 - xf) * yf * (1 - zf) +
        buf[gi + ox + oy] * xf * yf * (1 - zf) +
        buf[gi + 1] * (1 - xf) * (1 - yf) * zf +
        buf[gi + ox + 1] * xf * (1 - yf) * zf +
        buf[gi + oy + 1] * (1 - xf) * yf * zf +
        buf[gi + ox + oy + 1] * xf * yf * zf;
      out[j * width + i] = Math.max(0, f(Lv + f(norm * f(sum))));
    }
  }
  return out;
}

// ── The module ───────────────────────────────────────────────────────────────

export interface Result {
  out: RGBImage;
  /** L* before and after. */
  L: Float32Array;
  Lout: Float32Array;
}

/** process() on a linear Rec.709 image through the pipe's Lab conversion and
 *  back. `scale` is fmaxf(iscale / roi_in->scale, 1). */
export function localContrast(input: RGBImage, p: DarktableParams, scale = 1): Result {
  const { width, height, data } = input;
  const n = width * height;
  const L = new Float32Array(n);
  const ab = new Float32Array(2 * n);
  for (let k = 0; k < n; k++) {
    const [l, a, b] = rgbToLab(data[3 * k], data[3 * k + 1], data[3 * k + 2]);
    L[k] = l;
    ab[2 * k] = a;
    ab[2 * k + 1] = b;
  }
  const Lout =
    p.mode === 1
      ? localLaplacian(L, width, height, p.midtone, p.sigmaS, p.sigmaR, p.detail)
      : bilateral(L, width, height, f(f(p.sigmaS) / Math.max(f(scale), 1)), p.sigmaR, p.detail);
  const out = new Float32Array(3 * n);
  for (let k = 0; k < n; k++) out.set(labToRgb(Lout[k], ab[2 * k], ab[2 * k + 1]), 3 * k);
  return { out: { width, height, data: out }, L, Lout };
}
