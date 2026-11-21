// The stage contract the host relies on, and what a draw may cost. Unit tests
// can't run GLSL; the GPU spec (test/gpu) renders it.

import { describe, expect, it } from "vitest";
import {
  BL_GLSL,
  BL_HELPERS,
  BL_STEP_CALLS,
  INLINE_GLSL,
  INLINE_HELPERS,
  LL_GLSL,
  LL_HELPERS,
  LL_STEP_CALLS,
  REGION_GLSL,
  glslLiteral,
} from "../src/glsl";
import { DEFAULT_PARAMS, MAX_DRAWS, SPLAT_TAPS } from "../src/model";
import { DRAW_KEYS, EDIT_KEYS, LABELS, STAGE_ID, bagValue } from "../src/params";
import { BILATERAL_KEYS, LAPLACIAN_KEYS, PRIORITY, localContrastStage } from "../src/stage";
import { inlineFetches } from "./support/fetch-budget";

const stage = localContrastStage();
const [laplacian, bilateral] = stage.passes ?? [];

describe("the stage", () => {
  it("reads the edited image in linear Rec.709 after the display tools", () => {
    expect(stage).toMatchObject({
      id: STAGE_ID,
      name: "Local Contrast",
      phase: "display-adjust",
      reads: "current",
      space: { encoding: "linear", primaries: "rec709" },
    });
  });

  it("runs ahead of the display phase's colour tools, as darktable runs it before its colour modules", () => {
    expect(PRIORITY).toBeLessThan(100);
    expect(stage.priority).toBe(PRIORITY);
  });

  it("runs one four-channel pass per mode, each for as many draws as the bag says", () => {
    expect(stage.passes).toHaveLength(2);
    expect(laplacian).toMatchObject({ channels: 4, iterations: { key: "llDraws", max: MAX_DRAWS }, region: REGION_GLSL });
    expect(bilateral).toMatchObject({ channels: 4, iterations: { key: "blDraws", max: MAX_DRAWS }, region: REGION_GLSL });
  });

  it("gives each pass only the keys it reads, so the other mode's sliders rerun nothing", () => {
    expect(laplacian.uniforms?.map((u) => u.key)).toEqual([...LAPLACIAN_KEYS]);
    expect(bilateral.uniforms?.map((u) => u.key)).toEqual([...BILATERAL_KEYS]);
  });

  it("declares every edit key and the draw counts in the stage's own uniforms, which presets and paste read", () => {
    expect(stage.uniforms.map((u) => u.key)).toEqual([...EDIT_KEYS, ...DRAW_KEYS]);
    const inline = new Map(stage.uniforms.map((u) => [u.key, u]));
    for (const u of [...(laplacian.uniforms ?? []), ...(bilateral.uniforms ?? [])]) expect(inline.get(u.key)).toEqual(u);
    for (const u of stage.uniforms) {
      const key = EDIT_KEYS.find((k) => k === u.key);
      expect(u.default).toBe(key ? bagValue(DEFAULT_PARAMS, key) : 0);
    }
  });

  it("labels every control, each differently, as the preset dialog lists them flat", () => {
    const labels = stage.uniforms.filter((u) => !(DRAW_KEYS as readonly string[]).includes(u.key)).map((u) => u.label);
    expect(labels).toEqual(EDIT_KEYS.map((k) => LABELS[k]));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("is dormant while neither pass draws", () => {
    expect(stage.dormantWhen).toEqual({ llDraws: 0, blDraws: 0 });
  });

  it("changes nothing until a pass has drawn", () => {
    expect(INLINE_GLSL.trim().startsWith("if (llDraws > 0 || blDraws > 0) {")).toBe(true);
  });

  it("can run inside masks", () => {
    expect(stage.mask).toEqual({ maskable: true });
  });
});

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("a draw's cost", () => {
  // Every draw starts from its own texel (the host's fetchPrev4), then runs one
  // step. The bilateral pass also reads the grid's constants, four texels.
  const ll = (call: string) => 1 + inlineFetches(call, LL_HELPERS);
  const bl = (call: string) => 1 + 4 + inlineFetches(call, BL_HELPERS);
  const fn = (name: string, helpers: string) => inlineFetches(`${name}();`, helpers);

  it("builds a level from 25 texels, of the frame or of the level below", () => {
    expect(fn("lcBuildFromInput", LL_HELPERS)).toBe(25);
    expect(fn("lcBuildFromLevel", LL_HELPERS)).toBe(25);
    expect(LL_HELPERS).toMatch(/if \(l == 1\) \{\s*s = lcBuildFromInput/);
  });

  it("assembles a level from its own texel and the 3 × 3 stencil a level up, in both planes", () => {
    expect(ll(LL_STEP_CALLS.assemble)).toBe(1 + 1 + 18);
    expect(ll(LL_STEP_CALLS.final)).toBe(1 + 1 + 18);
  });

  it("splats 24 texels a draw, blurs from 5 and slices from 12", () => {
    expect(bl(BL_STEP_CALLS.splatX)).toBe(5 + SPLAT_TAPS);
    expect(bl(BL_STEP_CALLS.splatY)).toBe(5 + SPLAT_TAPS);
    expect(bl(BL_STEP_CALLS.blurX)).toBe(5 + 5);
    expect(bl(BL_STEP_CALLS.blurY)).toBe(5 + 5);
    expect(bl(BL_STEP_CALLS.slice)).toBe(5 + 1 + 12);
    expect(bl(BL_STEP_CALLS.plan)).toBe(5);
  });

  // A build draw runs one branch of lcBuild, so it counts the larger.
  it("reads at most 30 texels in any draw", () => {
    const build = 1 + Math.max(fn("lcBuildFromInput", LL_HELPERS), fn("lcBuildFromLevel", LL_HELPERS));
    expect(build).toBeLessThanOrEqual(30);
    for (const call of [LL_STEP_CALLS.assemble, LL_STEP_CALLS.final]) expect(ll(call)).toBeLessThanOrEqual(30);
    for (const call of Object.values(BL_STEP_CALLS)) expect(bl(call)).toBeLessThanOrEqual(30);
  });

  it("dispatches each step from one call site", () => {
    for (const [glsl, calls] of [[LL_GLSL, LL_STEP_CALLS], [BL_GLSL, BL_STEP_CALLS]] as const) {
      for (const call of Object.values(calls)) expect(glsl.split(call).length - 1).toBe(1);
    }
  });

  // On D3D11, ANGLE turns a const array into indexable registers that FXC
  // fills for every pixel of every draw, and a local array indexed in a loop
  // the same per call site. The passes index nothing.
  it("declares no arrays and indexes nothing", () => {
    for (const src of [LL_HELPERS, LL_GLSL, BL_HELPERS, BL_GLSL, INLINE_HELPERS, INLINE_GLSL]) expect(code(src)).not.toMatch(/\[/);
  });

  // A gradient sample reached from a loop makes ANGLE flatten every branch
  // around it on D3D11, so every draw would run every step.
  it("reads only through fetchPrev4 and fetchInput, and takes no derivatives", () => {
    for (const src of [LL_HELPERS, LL_GLSL, BL_HELPERS, BL_GLSL]) {
      expect(code(src)).not.toMatch(/\b(texture|textureLod|textureGrad|textureProj|readPrev4?|readSource|dFdx|dFdy|fwidth)\s*\(/);
    }
  });

  it("uses only GLSL ES 3.00", () => {
    for (const src of [LL_HELPERS, LL_GLSL, BL_HELPERS, BL_GLSL, INLINE_HELPERS, INLINE_GLSL]) {
      expect(code(src)).not.toMatch(/\b(findMSB|findLSB|bitCount|bitfieldExtract|bitfieldInsert|bitfieldReverse|ldexp|frexp|umulExtended|imulExtended|uaddCarry|usubBorrow|packUnorm4x8|fma)\s*\(/);
    }
  });

  // The host declares only highp float, so a plain int is mediump: 16 bits on
  // Mesa's radeonsi, where atlas indices past 32767 wrap and lcPow2's shift
  // comes out 0. D3D11, desktop GL and SwiftShader ignore it. The pass helpers
  // follow the host's uniforms in both programs, so the uniforms keep the
  // precision both programs agree on.
  it("computes every pass index in highp ints", () => {
    for (const src of [LL_HELPERS, BL_HELPERS]) {
      expect(code(src).trimStart()).toMatch(/^precision highp int;/);
      expect(code(src)).not.toMatch(/\b(mediump|lowp)\b/);
    }
  });

  it("names no GLSL built-in, reserved word or uniform as a local", () => {
    const reserved = ["step", "smooth", "filter", "active", "input", "output", "sample", "half", "fixed", "common", "partition", "union", "long", "short"];
    const keys = [...EDIT_KEYS, ...DRAW_KEYS];
    for (const src of [LL_HELPERS + LL_GLSL, BL_HELPERS + BL_GLSL, INLINE_HELPERS + INLINE_GLSL]) {
      for (const name of [...reserved, ...keys]) {
        expect(src).not.toMatch(new RegExp(`\b(int|float|bool|vec[234]|ivec[234]|uint)\s+${name}\b`));
      }
    }
  });

  it("places each draw by its region, computed in a vertex program", () => {
    for (const src of [LL_HELPERS, BL_HELPERS]) {
      expect(src).toMatch(/ivec4 lcRegion\(\)/);
      expect(code(src)).not.toMatch(/gl_FragCoord|discard/);
    }
  });

  it("writes float literals GLSL ES accepts", () => {
    expect(glslLiteral(1)).toBe("1.0");
    expect(glslLiteral(2 ** -14)).toContain(".");
    for (const src of [LL_HELPERS, BL_HELPERS, INLINE_HELPERS]) expect(code(src)).not.toMatch(/[^\w.]\d+e-?\d/);
  });
});
