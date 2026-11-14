// The stage on the real renderer. Run via `npm run test:gpu` (run.cjs copies
// this file into a SafeLight checkout and runs it under its headless
// Chromium + SwiftShader rig). What the CPU suite cannot check:
//  • both passes compile with the host's namespacing and run the bag's draw
//    counts, idle draws first;
//  • an untouched photo, and a switched-off edit, leave the frame as it was;
//  • on half-float targets, the local laplacian's atlas and the bilateral
//    grid land on darktable's result, here the CPU transcription
//    test/reference/dtref.ts, which dtref.test.ts holds to darktable's output;
//  • a* and b* stay where they were;
//  • a frame too small for the atlas renders unchanged.

import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, bilateralPlan, darktableParams, type Params } from "@lc/model";
import { bagPatch, qualified, resetPatch } from "@lc/params";
import { localContrastStage } from "@lc/stage";
import { localContrast, rgbToLab } from "@lc-test/reference/dtref";
import { bilateralModel } from "@lc-test/reference/gpumodel";
import { scenePixel } from "@lc-test/support/scene";
import { CURRENT_PROCESS_VERSION } from "@/catalog/process-version";
import type { ProcessingStageContribution } from "@/extensions/types";
import { OPEN_PROBE, builtinStages, floatImage, identityParams, withRenderer } from "@/rendering/webgl/webgl.test-support";

const W = 320;
const H = 200;
const AS_DRAWN = { encoding: "perceptual", primaries: "rec709" } as const;

const sceneOf = (w: number, h: number) => floatImage(w, h, (x, y) => scenePixel(x, y, w, h));

const CASES: [string, Partial<Params>][] = [
  ["laplacian defaults", { mode: "laplacian" }],
  ["laplacian HDR preset", { mode: "laplacian", detail: 1, highlights: 0, shadows: 0, midtone: 0.25 }],
  ["laplacian detail 300%, highlights 150%, shadows 20%, midtone 0.1", { mode: "laplacian", detail: 2, highlights: 1.5, shadows: 0.2, midtone: 0.1 }],
  ["laplacian detail 0%, midtone 1", { mode: "laplacian", detail: -1, highlights: 2, shadows: 1, midtone: 1 }],
  ["bilateral defaults", { mode: "bilateral" }],
  ["bilateral coarseness 8, contrast 10, detail 200%", { mode: "bilateral", coarseness: 8, contrast: 10, detail: 1 }],
  ["bilateral coarseness 20, contrast 3, detail 0%", { mode: "bilateral", coarseness: 20, contrast: 3, detail: -1 }],
];

type Frames = Record<string, Float32Array>;

function render(
  bags: Record<string, Record<string, unknown>>,
  stages: ProcessingStageContribution[] = [localContrastStage()],
  w = W,
  h = H,
): Frames {
  const frames: Frames = {};
  withRenderer({ stages: [...builtinStages(), ...stages], pipeline: OPEN_PROBE }, (renderer) => {
    renderer.setImage(sceneOf(w, h));
    renderer.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
    for (const [name, bag] of Object.entries(bags)) {
      renderer.setContributedParams(bag);
      const frame = renderer.readFloatFrame("pre-output", Infinity, AS_DRAWN);
      if (!frame) throw new Error(`no frame for ${name}`);
      frames[name] = frame.data;
    }
  });
  return frames;
}

const decode = (v: number): number => {
  const a = Math.abs(v);
  return Math.sign(v) * (a < 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4);
};

/** A captured frame (perceptual Rec.709, RGBA) as linear Rec.709 RGB. */
function linear(frame: Float32Array, w = W, h = H): Float32Array {
  const out = new Float32Array(w * h * 3);
  for (let k = 0; k < w * h; k++) for (let c = 0; c < 3; c++) out[3 * k + c] = decode(frame[4 * k + c]);
  return out;
}

const full = (p: Partial<Params>): Params => ({ ...DEFAULT_PARAMS, ...p, on: true });

interface Stats {
  p50: number;
  p99: number;
  max: number;
}

function stats(e: number[]): Stats {
  e.sort((a, b) => a - b);
  return { p50: e[Math.floor(0.5 * (e.length - 1))], p99: e[Math.floor(0.99 * (e.length - 1))], max: e[e.length - 1] };
}

describe("Local Contrast on the GPU", () => {
  const bags: Record<string, Record<string, unknown>> = { identity: resetPatch() };
  for (const [name, p] of CASES) bags[name] = bagPatch(full(p));
  const frames = render(bags);
  const input = { width: W, height: H, data: linear(frames.identity) };

  // Outside the live view the stage stays in the program while idle, and its
  // conversion into linear Rec.709 and back rounds in the last bits.
  it("leaves the frame as it was while off, to float rounding", () => {
    const without = render({ identity: {} }, []).identity;
    let worst = 0;
    for (let i = 0; i < without.length; i++) worst = Math.max(worst, Math.abs(frames.identity[i] - without[i]));
    expect(worst).toBeLessThan(1e-5);
  });

  it.each(CASES)("matches darktable's L*: %s", (name, p) => {
    const ref = localContrast(input, darktableParams(full(p)));
    const gpu = linear(frames[name]);
    const dL: number[] = [];
    const moved: number[] = [];
    const dab: number[] = [];
    for (let k = 0; k < W * H; k++) {
      const lab = rgbToLab(gpu[3 * k], gpu[3 * k + 1], gpu[3 * k + 2]);
      const was = rgbToLab(input.data[3 * k], input.data[3 * k + 1], input.data[3 * k + 2]);
      dL.push(Math.abs(lab[0] - ref.Lout[k]));
      moved.push(Math.abs(ref.Lout[k] - ref.L[k]));
      dab.push(Math.max(Math.abs(lab[1] - was[1]), Math.abs(lab[2] - was[2])));
    }
    const e = stats(dL);
    console.log(`${name}: |ΔL*| p50 ${e.p50.toExponential(2)} p99 ${e.p99.toExponential(2)} max ${e.max.toExponential(2)}`);
    expect(stats(moved).p99, "the case changes the image").toBeGreaterThan(0.5);
    expect(e.p50).toBeLessThan(0.01);
    expect(e.p99).toBeLessThan(0.03);
    expect(e.max).toBeLessThan(0.1);
    expect(stats(dab).p99).toBeLessThan(0.01);
  });

  it("runs the local laplacian however many idle draws come first", () => {
    const p = full({ mode: "laplacian", detail: 1 });
    const fewer = render({ fewer: { ...bagPatch(p), [qualified("llDraws")]: 12 } }).fewer;
    const many = render({ many: bagPatch(p) }).many;
    let worst = 0;
    for (let i = 0; i < many.length; i++) worst = Math.max(worst, Math.abs(fewer[i] - many[i]));
    expect(worst).toBeLessThan(1e-6);
  });

  it("runs the bilateral grid however many idle draws come first", () => {
    const p = full({ mode: "bilateral", coarseness: 8, contrast: 10, detail: 1 });
    const q = darktableParams(p);
    const exact = bilateralPlan(W, H, q.sigmaS, q.sigmaR)!.draws;
    expect(exact).toBeLessThan(Number(bagPatch(p)[qualified("blDraws")]));
    const fewer = render({ fewer: { ...bagPatch(p), [qualified("blDraws")]: exact } }).fewer;
    let worst = 0;
    for (let i = 0; i < fewer.length; i++) worst = Math.max(worst, Math.abs(fewer[i] - frames["bilateral coarseness 8, contrast 10, detail 200%"][i]));
    expect(worst).toBeLessThan(1e-6);
  });

  it("widens a grid too large for the target as the model does", () => {
    const w = 96;
    const h = 64;
    const p = full({ mode: "bilateral", coarseness: 3, contrast: 2, detail: 1 });
    const q = darktableParams(p);
    const small = render({ off: resetPatch(), on: bagPatch(p) }, undefined, w, h);
    const before = linear(small.off, w, h);
    const after = linear(small.on, w, h);
    const L = new Float32Array(w * h);
    for (let k = 0; k < w * h; k++) L[k] = rgbToLab(before[3 * k], before[3 * k + 1], before[3 * k + 2])[0];
    const model = bilateralModel(L, w, h, q.sigmaS, q.sigmaR, q.detail, { halfStorage: true })!;
    expect(model.widened).toBeGreaterThan(0);
    const e: number[] = [];
    for (let k = 0; k < w * h; k++) {
      const got = rgbToLab(after[3 * k], after[3 * k + 1], after[3 * k + 2])[0];
      e.push(Math.abs(got - Math.max(L[k] + 100 * model.delta[k], 0)));
    }
    const s = stats(e);
    expect(s.p99).toBeLessThan(0.01);
    expect(s.max).toBeLessThan(0.05);
  });

  it("leaves the frame alone when the draw count is too small", () => {
    const p = full({ mode: "laplacian", detail: 1 });
    const short = render({ short: { ...bagPatch(p), [qualified("llDraws")]: 11 } }).short;
    let worst = 0;
    for (let i = 0; i < short.length; i++) worst = Math.max(worst, Math.abs(short[i] - frames.identity[i]));
    expect(worst).toBeLessThan(1e-5);
  });

  it("leaves a frame too small for the atlas unchanged", () => {
    const w = 20;
    const h = 14;
    const tiny = render({ off: resetPatch(), on: bagPatch(full({ mode: "laplacian", detail: 1 })) }, undefined, w, h);
    let worst = 0;
    for (let i = 0; i < tiny.on.length; i++) worst = Math.max(worst, Math.abs(tiny.on[i] - tiny.off[i]));
    expect(worst).toBeLessThan(1e-5);
  });
});
