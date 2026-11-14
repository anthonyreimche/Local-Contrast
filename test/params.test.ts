// The bag contract: the edit under the stage's qualified keys, darktable's
// mode enum, and draw counts that follow the edit.

import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, LL_DRAWS, bilateralDraws } from "../src/model";
import { DRAW_KEYS, EDIT_KEYS, STAGE_ID, bagPatch, editPatch, qualified, readParams, rederivePatch, resetPatch } from "../src/params";

describe("the bag", () => {
  it("keys every value under the stage", () => {
    expect(qualified("detail")).toBe(`${STAGE_ID}.detail`);
    expect(Object.keys(resetPatch()).sort()).toEqual([...EDIT_KEYS, ...DRAW_KEYS].map(qualified).sort());
  });

  it("reads darktable's defaults from an empty bag, switched off", () => {
    expect(readParams({})).toEqual(DEFAULT_PARAMS);
    expect(DEFAULT_PARAMS).toMatchObject({ on: false, mode: "laplacian", detail: 0.25, highlights: 0.5, shadows: 0.5, midtone: 0.5, coarseness: 50, contrast: 20 });
  });

  it("keeps the mode as darktable's enum: 1 the local laplacian, 0 the bilateral grid", () => {
    expect(bagPatch({ ...DEFAULT_PARAMS, mode: "bilateral" })[qualified("mode")]).toBe(0);
    expect(bagPatch(DEFAULT_PARAMS)[qualified("mode")]).toBe(1);
    expect(readParams({ [qualified("mode")]: 0 }).mode).toBe("bilateral");
  });

  it("clamps values to the sliders' limits and ignores ones that aren't numbers", () => {
    const p = readParams({ [qualified("detail")]: 9, [qualified("midtone")]: 0, [qualified("coarseness")]: "x", [qualified("on")]: 1 });
    expect(p).toMatchObject({ detail: 4, midtone: 0.001, coarseness: 50, on: true });
  });

  it("draws nothing while off, and only the mode in use while on", () => {
    expect(resetPatch()).toMatchObject({ [qualified("llDraws")]: 0, [qualified("blDraws")]: 0 });
    const ll = bagPatch({ ...DEFAULT_PARAMS, on: true });
    expect(ll).toMatchObject({ [qualified("llDraws")]: LL_DRAWS, [qualified("blDraws")]: 0 });
    const bl = bagPatch({ ...DEFAULT_PARAMS, on: true, mode: "bilateral", coarseness: 30, contrast: 5 });
    expect(bl).toMatchObject({ [qualified("llDraws")]: 0, [qualified("blDraws")]: bilateralDraws(30, 5) });
  });

  it("writes a control's keys with the draw counts", () => {
    expect(editPatch({ ...DEFAULT_PARAMS, on: true, detail: 1 }, ["detail"])).toEqual({
      [qualified("detail")]: 1,
      [qualified("llDraws")]: LL_DRAWS,
      [qualified("blDraws")]: 0,
    });
  });

  it("re-derives draw counts a paste left behind, and only then", () => {
    const pasted = { [qualified("on")]: true, [qualified("mode")]: 0, [qualified("contrast")]: 10 };
    expect(rederivePatch(pasted)).toEqual({ [qualified("llDraws")]: 0, [qualified("blDraws")]: bilateralDraws(50, 10) });
    expect(rederivePatch({ ...pasted, ...rederivePatch(pasted) })).toBeNull();
    expect(rederivePatch({ "other.stage.key": 1 })).toBeNull();
  });
});
