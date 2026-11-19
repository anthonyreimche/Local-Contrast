// The panel draws core's Slider and the kit's controls over the scope's bag.
// A drag writes the value and the draw counts; letting go is one undo step.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { activate, deactivate } from "../src/index";
import { LL_DRAWS, bilateralDraws } from "../src/model";
import { LocalContrastPanel } from "../src/Panel";
import { qualified } from "../src/params";
import { React } from "../src/rt";
import { fakeApi } from "./support/fake-api";

function setup(params: Record<string, unknown> = {}) {
  const rig = fakeApi(params);
  activate(rig.api);
  const view = render(<LocalContrastPanel />);
  const labels = () => rig.sliders(view.container).map((s) => s.label);
  const slider = (label: string) => {
    const found = rig.sliders(view.container).find((s) => s.label === label);
    if (!found) throw new Error(`no slider ${label}`);
    return found;
  };
  const toggle = () => {
    const found = view.container.querySelector("label input");
    if (!found) throw new Error("no toggle");
    return found;
  };
  const button = (label: string) => {
    const found = [...view.container.querySelectorAll("button")].find((b) => b.textContent === label);
    if (!found) throw new Error(`no button ${label}`);
    return found;
  };
  const presets = () => {
    const found = view.container.querySelector("select");
    if (!found) throw new Error("no preset menu");
    return found;
  };
  return { rig, view, labels, slider, toggle, button, presets };
}

afterEach(() => {
  cleanup();
  deactivate();
});

describe("the panel", () => {
  it("shows the switch, the two modes and the local laplacian's sliders", () => {
    const { labels, view } = setup();
    expect(view.container.querySelector("label")?.textContent).toBe("Enabled");
    expect([...view.container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Local laplacian", "Bilateral grid"]);
    expect(labels()).toEqual(["Detail", "Highlights", "Shadows", "Midtone range"]);
  });

  it("shows detail as darktable does, 100 % for no change, and highlights and shadows as percentages", () => {
    const { slider } = setup();
    expect(slider("Detail")).toMatchObject({ value: 125, min: 0, max: 500, defaultValue: 125, step: 1 });
    expect(slider("Highlights")).toMatchObject({ value: 50, min: 0, max: 200, defaultValue: 50 });
    expect(slider("Shadows")).toMatchObject({ value: 50, min: 0, max: 200 });
    expect(slider("Midtone range")).toMatchObject({ value: 0.5, min: 0.001, max: 1, step: 0.001 });
  });

  it("switches on in one undo step, and only then draws", () => {
    const { rig, toggle } = setup();
    expect(rig.params()[qualified("llDraws")]).toBeUndefined();
    act(() => void fireEvent.click(toggle()));
    expect(rig.params()[qualified("on")]).toBe(true);
    expect(rig.params()[qualified("llDraws")]).toBe(LL_DRAWS);
    expect(rig.commits).toEqual(["Local Contrast: on"]);
  });

  it("writes darktable's value and the draw counts as a slider moves, and one undo step on release", () => {
    const { rig, slider } = setup({ [qualified("on")]: true });
    act(() => slider("Detail").onChange(300));
    expect(rig.params()[qualified("detail")]).toBe(2);
    expect(rig.params()[qualified("llDraws")]).toBe(LL_DRAWS);
    act(() => slider("Highlights").onChange(150));
    expect(rig.params()[qualified("highlights")]).toBe(1.5);
    act(() => slider("Highlights").onCommit?.());
    expect(rig.commits).toEqual(["Local Contrast: highlights"]);
  });

  it("switches on when a slider moves while off, as darktable does", () => {
    const { rig, slider } = setup();
    act(() => slider("Detail").onChange(300));
    expect(rig.params()[qualified("on")]).toBe(true);
    expect(rig.params()[qualified("detail")]).toBe(2);
    expect(rig.params()[qualified("llDraws")]).toBe(LL_DRAWS);
  });

  it("switches on when the mode changes while off", () => {
    const { rig, button } = setup();
    act(() => void fireEvent.click(button("Bilateral grid")));
    expect(rig.params()[qualified("on")]).toBe(true);
    expect(rig.params()[qualified("blDraws")]).toBe(bilateralDraws(50, 20));
  });

  it("switches to the bilateral grid's sliders and its draws, keeping the other mode's values", () => {
    const { rig, labels, button, slider } = setup({ [qualified("on")]: true, [qualified("highlights")]: 1.2 });
    act(() => void fireEvent.click(button("Bilateral grid")));
    expect(labels()).toEqual(["Detail", "Coarseness", "Contrast"]);
    expect(slider("Coarseness")).toMatchObject({ value: 50, min: 3, max: 100, step: 1 });
    expect(slider("Contrast")).toMatchObject({ value: 20, min: 1, max: 100 });
    expect(rig.params()).toMatchObject({ [qualified("mode")]: 0, [qualified("llDraws")]: 0, [qualified("blDraws")]: bilateralDraws(50, 20) });
    act(() => slider("Contrast").onChange(5));
    expect(rig.params()[qualified("blDraws")]).toBe(bilateralDraws(50, 5));
    act(() => void fireEvent.click(button("Local laplacian")));
    expect(slider("Highlights").value).toBe(120);
    expect(rig.commits).toEqual(["Local Contrast: mode", "Local Contrast: mode"]);
  });

  it("applies a preset in one undo step, switching the module on", () => {
    const { rig, presets, slider } = setup({ [qualified("mode")]: 0, [qualified("coarseness")]: 10 });
    act(() => void fireEvent.change(presets(), { target: { value: "hdr" } }));
    expect(rig.params()).toMatchObject({
      [qualified("on")]: true,
      [qualified("mode")]: 1,
      [qualified("detail")]: 1,
      [qualified("highlights")]: 0,
      [qualified("shadows")]: 0,
      [qualified("midtone")]: 0.25,
      [qualified("coarseness")]: 10,
      [qualified("llDraws")]: LL_DRAWS,
    });
    expect(slider("Detail").value).toBe(200);
    expect(rig.commits).toEqual(["Local Contrast: HDR local tone mapping"]);
  });

  it("clamps a typed value to the module's limits", () => {
    const { rig, slider } = setup();
    act(() => slider("Midtone range").onChange(0));
    expect(rig.params()[qualified("midtone")]).toBe(0.001);
  });
});
