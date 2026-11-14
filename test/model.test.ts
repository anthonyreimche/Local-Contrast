// The CPU side of the passes: darktable's struct and presets, the local
// laplacian's levels and atlas, the bilateral grid's sizes, and draw counts
// that cover every frame the passes can be given.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  LL_DRAWS,
  PRESETS,
  bilateralDraws,
  bilateralPlan,
  darktableParams,
  dl,
  drawCounts,
  gammaLevel,
  gridSize,
  laplacianLayout,
  numLevels,
  passSigmaS,
} from "../src/model";
import { bilateralGridSize } from "./reference/dtref";

describe("darktable's params", () => {
  it("packs the visible mode's sliders into sigma_r and sigma_s, as the module's GUI does", () => {
    const p = { ...DEFAULT_PARAMS, highlights: 1.2, shadows: 0.3, coarseness: 40, contrast: 12, detail: 0.7, midtone: 0.2 };
    expect(darktableParams(p)).toEqual({ mode: 1, sigmaR: 1.2, sigmaS: 0.3, detail: 0.7, midtone: 0.2 });
    expect(darktableParams({ ...p, mode: "bilateral" })).toEqual({ mode: 0, sigmaR: 12, sigmaS: 40, detail: 0.7, midtone: 0.2 });
  });

  it("has the module's two presets", () => {
    expect(PRESETS.map((p) => [p.label, p.params])).toEqual([
      ["Clarity", { mode: "laplacian", detail: 0.33, highlights: 0, shadows: 0, midtone: 0.5 }],
      ["HDR local tone mapping", { mode: "laplacian", detail: 1, highlights: 0, shadows: 0, midtone: 0.25 }],
    ]);
  });
});

describe("the local laplacian's pyramid", () => {
  it("halves sizes as dl() does and samples six reference levels", () => {
    expect([0, 1, 2, 3].map((l) => dl(6144, l))).toEqual([6144, 3072, 1536, 768]);
    expect(dl(4779, 1)).toBe(2390);
    expect([0, 1, 2, 3, 4, 5].map(gammaLevel)).toEqual([1 / 12, 3 / 12, 5 / 12, 7 / 12, 9 / 12, 11 / 12].map(Math.fround));
  });

  it("runs as many levels as halve the short side", () => {
    expect(numLevels(4096, 2731)).toBe(11);
    expect(numLevels(256, 192)).toBe(7);
    expect(numLevels(65535, 65535)).toBe(15);
  });

  it("pads by 2^(levels - 1) and keeps windows that cover the frame at every level", () => {
    const layout = laplacianLayout(4096, 2731);
    expect(layout.supp).toBe(1024);
    const l1 = layout.atlas[1];
    expect(l1.x).toEqual({ size: 3072, lo: 511, hi: 2561 });
    for (let l = 1; l <= layout.last; l++) {
      const a = layout.atlas[l];
      expect(a.x.lo).toBeLessThanOrEqual(Math.floor(layout.supp / 2 ** l));
      expect(a.x.hi).toBeGreaterThanOrEqual(Math.min(Math.ceil((layout.supp + 4096) / 2 ** l), a.x.size - 1));
      if (l > 1) expect(a.base).toBe(layout.atlas[l - 1].base + 2 * layout.atlas[l - 1].area);
    }
  });

  it("needs no more draws than the pass is given, for any short side under 65536", () => {
    for (const [w, h] of [[65535, 65535], [16384, 10923], [8192, 5461], [4096, 2731], [960, 640], [64, 64]]) {
      const layout = laplacianLayout(w, h);
      expect(layout.draws).toBe(2 * (numLevels(w, h) - 1));
      expect(layout.draws).toBeLessThanOrEqual(LL_DRAWS);
    }
  });
});

describe("the bilateral grid", () => {
  const sizes: [number, number][] = [[96, 64], [256, 192], [320, 200], [1000, 667], [4096, 2731], [2731, 4096], [7000, 3000]];
  const sigmas: [number, number][] = [[50, 20], [5, 10], [3, 3], [8, 1], [100, 100], [17.5, 7.3]];

  it.each(sizes)("sizes %i × %i's grid as dt_bilateral_grid_size() does", (w, h) => {
    for (const [s, r] of sigmas) {
      const g = gridSize(w, h, s, r);
      const want = bilateralGridSize(w, h, s, r);
      expect([g.sizeX, g.sizeY, g.sizeZ, g.sigmaS, g.invS, g.sigmaR, g.invR]).toEqual([
        want.sizeX,
        want.sizeY,
        want.sizeZ,
        want.sigmaS,
        want.invS,
        want.sigmaR,
        want.invR,
      ]);
    }
  });

  it("scales coarseness with the render, as darktable divides sigma_s by the pipe's scale", () => {
    expect(passSigmaS(50, 4096, 4096)).toBe(50);
    expect(passSigmaS(50, 6000, 4096)).toBeCloseTo(50 / (6000 / 4096), 5);
    expect(passSigmaS(50, 2000, 4096)).toBe(50);
  });

  it("keeps darktable's grid at the defaults in Develop and at full size", () => {
    expect(bilateralPlan(4096, 2731, passSigmaS(50, 6000, 4096), 20)?.widened).toBe(0);
    expect(bilateralPlan(6000, 4000, 3, 20)?.widened).toBe(0);
  });

  it("widens a grid the target can't hold, and never needs more draws than the bag gives", () => {
    let widened = 0;
    for (const [w, h] of [[64, 64], [96, 64], [200, 133], [960, 640], [2560, 1707], [4096, 2731], [8192, 5461], [16384, 10923]]) {
      for (const coarseness of [3, 5, 12, 50, 100]) {
        for (const contrast of [1, 2, 7, 20, 100]) {
          for (const source of [Math.max(w, h), 2 * Math.max(w, h), 6000]) {
            if (source < Math.max(w, h)) continue;
            const plan = bilateralPlan(w, h, passSigmaS(coarseness, source, Math.max(w, h)), contrast);
            expect(plan, `${w}×${h} at ${coarseness}/${contrast}`).not.toBeNull();
            if (!plan) continue;
            if (plan.widened > 0) widened++;
            expect(plan.draws, `${w}×${h} at ${coarseness}/${contrast}`).toBeLessThanOrEqual(bilateralDraws(coarseness, contrast));
          }
        }
      }
    }
    expect(widened).toBeGreaterThan(0);
  });

  it("takes 17 draws at the defaults in Develop, 29 given", () => {
    expect(bilateralPlan(4096, 2731, passSigmaS(50, 6000, 4096), 20)?.draws).toBe(17);
    expect(bilateralDraws(50, 20)).toBe(29);
  });
});

describe("draw counts", () => {
  it("are 0 while off, whatever the mode", () => {
    expect(drawCounts(DEFAULT_PARAMS)).toEqual({ llDraws: 0, blDraws: 0 });
    expect(drawCounts({ ...DEFAULT_PARAMS, mode: "bilateral" })).toEqual({ llDraws: 0, blDraws: 0 });
  });

  it("run only the mode in use", () => {
    expect(drawCounts({ ...DEFAULT_PARAMS, on: true })).toEqual({ llDraws: LL_DRAWS, blDraws: 0 });
    expect(drawCounts({ ...DEFAULT_PARAMS, on: true, mode: "bilateral" })).toEqual({ llDraws: 0, blDraws: bilateralDraws(50, 20) });
  });
});
