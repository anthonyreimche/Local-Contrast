import { describe, expect, it } from "vitest";
import manifest from "../safelight.json";
import { PANEL_ID, activate, deactivate } from "../src/index";
import { DEFAULT_PARAMS, bilateralDraws, drawCounts } from "../src/model";
import { EXT_ID, STAGE_ID, qualified } from "../src/params";
import { fakeApi } from "./support/fake-api";

describe("activate", () => {
  it("registers the stage and a panel that also edits masks", () => {
    const rig = fakeApi();
    activate(rig.api);
    expect(rig.stages.map((s) => s.id)).toEqual([STAGE_ID]);
    expect(rig.panels.map((p) => p.id)).toEqual([PANEL_ID]);
    expect(rig.panels[0].mask?.owns).toEqual(expect.arrayContaining([qualified("on"), qualified("llDraws"), qualified("blDraws")]));
    deactivate();
  });

  it("names its contributions under the manifest's id", () => {
    expect(EXT_ID).toBe(manifest.id);
    expect(PANEL_ID.startsWith(`${manifest.id}.`)).toBe(true);
    expect(STAGE_ID.startsWith(`${manifest.id}.`)).toBe(true);
  });

  it("re-derives the draw counts of a pasted edit", () => {
    const rig = fakeApi();
    activate(rig.api);
    rig.replace({ [qualified("on")]: true, [qualified("mode")]: 0, [qualified("coarseness")]: 20 });
    expect(rig.params()[qualified("blDraws")]).toBe(bilateralDraws(20, 20));
    expect(rig.params()[qualified("llDraws")]).toBe(0);
    deactivate();
  });

  it("re-derives a mask's", () => {
    const rig = fakeApi();
    activate(rig.api);
    rig.setMasks([{ id: "m1", bag: { [qualified("on")]: true, [qualified("detail")]: 1 } }]);
    expect(rig.maskBag("m1")?.[qualified("llDraws")]).toBe(drawCounts({ ...DEFAULT_PARAMS, on: true, detail: 1 }).llDraws);
    deactivate();
  });

  it("stops re-deriving once deactivated", () => {
    const rig = fakeApi();
    activate(rig.api);
    deactivate();
    rig.replace({ [qualified("on")]: true });
    expect(rig.params()[qualified("llDraws")]).toBeUndefined();
  });

  it("resets the photo in one undo step", () => {
    const rig = fakeApi({ [qualified("on")]: true, [qualified("detail")]: 2 });
    activate(rig.api);
    rig.panels[0].onReset?.();
    expect(rig.params()[qualified("on")]).toBe(false);
    expect(rig.params()[qualified("detail")]).toBe(DEFAULT_PARAMS.detail);
    expect(rig.commits).toEqual(["Local Contrast reset"]);
    deactivate();
  });
});
