// The passes' arithmetic (gpumodel.ts) against the transcription of darktable
// (dtref.ts). With float32 storage (and P unquantized) the atlas, its windows
// and the D recursion must give darktable's numbers to float rounding, so the
// layout is proven before any GLSL runs. As the GPU keeps them, with P
// quantized to what a half float holds exactly and the rest stored as half
// floats, within the budget docs/SPEC.md sets: P's quantization moves the
// pair of curves a coarse texel blends by up to about 7e-4, which is most of
// the error.

import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, bilateralPlan, darktableParams, laplacianLayout, type Params } from "../../src/model";
import { sceneRGB } from "../support/scene";
import { bilateral, localLaplacian, rgbToLab } from "./dtref";
import { bilateralModel, half, laplacianModel, quantize } from "./gpumodel";

function lightness(w: number, h: number): Float32Array {
  const rgb = sceneRGB(w, h);
  const L = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) L[k] = rgbToLab(rgb[3 * k], rgb[3 * k + 1], rgb[3 * k + 2])[0];
  return L;
}

interface Errors {
  max: number;
  p99: number;
}

function errors(model: Float32Array, L: Float32Array, want: Float32Array, clampAtZero: boolean): Errors {
  const e: number[] = [];
  for (let k = 0; k < L.length; k++) {
    const got = L[k] + 100 * model[k];
    e.push(Math.abs((clampAtZero ? Math.max(got, 0) : got) - want[k]));
  }
  e.sort((a, b) => a - b);
  return { max: e[e.length - 1], p99: e[Math.floor(0.99 * (e.length - 1))] };
}

const SIZES: [number, number][] = [
  [96, 64],
  [64, 64],
  [101, 77],
  [64, 150],
  [256, 192],
  [300, 81],
];

const LAPLACIAN: [string, Partial<Params>][] = [
  ["defaults", {}],
  ["HDR preset", { detail: 1, highlights: 0, shadows: 0, midtone: 0.25 }],
  ["strong, narrow midtones", { detail: 2, highlights: 1.5, shadows: 0.2, midtone: 0.1 }],
  ["smoothing, wide midtones", { detail: -1, highlights: 2, shadows: 1, midtone: 1 }],
];

const BILATERAL: [string, Partial<Params>][] = [
  ["defaults", { mode: "bilateral" }],
  ["coarseness 5, contrast 10, detail 200%", { mode: "bilateral", coarseness: 5, contrast: 10, detail: 1 }],
  ["coarseness 3, contrast 3, detail 0%", { mode: "bilateral", coarseness: 3, contrast: 3, detail: -1 }],
  ["coarseness 12, contrast 50, detail 400%", { mode: "bilateral", coarseness: 12, contrast: 50, detail: 3 }],
];

describe("half floats", () => {
  it("round to nearest, ties to even", () => {
    expect(half(1 + 2 ** -11)).toBe(1);
    expect(half(1 + 3 * 2 ** -11)).toBe(1 + 2 ** -9);
    expect(half(0.1)).toBeCloseTo(0.0999755859375, 12);
    expect(half(-3.14159)).toBe(-3.140625);
  });

  it("hold a quantized P exactly", () => {
    for (let k = 0; k < 2000; k++) {
      const v = (k / 1999) * 3 - 0.5 + 1e-7 * k;
      expect(half(quantize(v))).toBe(quantize(v));
      expect(Math.abs(quantize(v) - v)).toBeLessThanOrEqual(Math.max(Math.abs(v) * 2 ** -11, 2 ** -14));
    }
  });
});

describe("the local laplacian atlas", () => {
  it.each(SIZES)("fits a %i × %i frame", (w, h) => {
    const layout = laplacianLayout(w, h);
    expect(layout.fits).toBe(true);
    expect(layout.texels).toBeLessThanOrEqual(w * h);
  });

  it("takes about two thirds of a large frame", () => {
    const layout = laplacianLayout(4096, 2731);
    expect(layout.levels).toBe(11);
    expect(layout.draws).toBe(20);
    expect(layout.texels / (4096 * 2731)).toBeGreaterThan(0.6);
    expect(layout.texels / (4096 * 2731)).toBeLessThan(0.7);
  });

  it("runs on frames down to 64 px on the short side, and on none too small to hold it", () => {
    for (let s = 64; s < 400; s += 7) {
      expect(laplacianLayout(s, s).fits, `${s}²`).toBe(true);
      expect(laplacianLayout(3 * s, s).fits, `${3 * s} × ${s}`).toBe(true);
    }
    expect(laplacianLayout(2, 2).fits).toBe(false);
  });

  describe.each(SIZES)("on %i × %i", (w, h) => {
    const L = lightness(w, h);
    it.each(LAPLACIAN)("matches darktable with float32 storage: %s", (_n, p) => {
      const q = darktableParams({ ...DEFAULT_PARAMS, ...p, on: true });
      const want = localLaplacian(L, w, h, q.midtone, q.sigmaS, q.sigmaR, q.detail);
      const model = laplacianModel(L, w, h, q.midtone, q.sigmaS, q.sigmaR, q.detail, { halfStorage: false, exactP: true });
      expect(model).not.toBeNull();
      expect(errors(model!, L, want, false).max).toBeLessThan(2e-4);
    });

    it.each(LAPLACIAN)("stays within 0.03 L* of darktable as the GPU stores it: %s", (_n, p) => {
      const q = darktableParams({ ...DEFAULT_PARAMS, ...p, on: true });
      const want = localLaplacian(L, w, h, q.midtone, q.sigmaS, q.sigmaR, q.detail);
      const model = laplacianModel(L, w, h, q.midtone, q.sigmaS, q.sigmaR, q.detail, { halfStorage: true });
      const e = errors(model!, L, want, false);
      expect(e.p99).toBeLessThan(0.02);
      expect(e.max).toBeLessThan(0.03);
    });
  });
});

describe("the bilateral grid, gathered", () => {
  describe.each(SIZES)("on %i × %i", (w, h) => {
    const L = lightness(w, h);
    it.each(BILATERAL)("matches darktable with float32 storage: %s", (_n, p) => {
      const q = darktableParams({ ...DEFAULT_PARAMS, ...p, on: true });
      const plan = bilateralPlan(w, h, q.sigmaS, q.sigmaR);
      const want = bilateral(L, w, h, q.sigmaS, q.sigmaR, q.detail);
      const model = bilateralModel(L, w, h, q.sigmaS, q.sigmaR, q.detail, { halfStorage: false });
      expect(model).not.toBeNull();
      if (plan?.widened) return;
      expect(errors(model!.delta, L, want, true).max).toBeLessThan(2e-3);
    });

    it.each(BILATERAL)("stays within 0.05 L* of darktable with half-float storage: %s", (_n, p) => {
      const q = darktableParams({ ...DEFAULT_PARAMS, ...p, on: true });
      const model = bilateralModel(L, w, h, q.sigmaS, q.sigmaR, q.detail, { halfStorage: true });
      if (model!.widened) return;
      const want = bilateral(L, w, h, q.sigmaS, q.sigmaR, q.detail);
      const e = errors(model!.delta, L, want, true);
      expect(e.p99).toBeLessThan(0.02);
      expect(e.max).toBeLessThan(0.05);
    });
  });
});
