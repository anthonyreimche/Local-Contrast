// The panel, in the order of the module it ports: the switch, the mode, the
// detail both modes share, then the mode's own sliders, and the module's two
// presets. Detail shows as darktable shows it, 100 % being no change, and the
// local laplacian's highlights and shadows as percentages.
//
// It edits whatever useParamScope hands it: the photo's bag in the dock, a
// mask's in the Masking panel. A drag writes the value and the draw counts
// live and commits on release, so one gesture is one undo step; the switch,
// the mode and a preset commit at once. Each change reads the bag the scope
// holds now, as drags outrun renders.

import { DEFAULT_PARAMS, PRESETS, RANGES, type Mode, type NumericKey, type Params } from "./model";
import { EDIT_KEYS, LABELS, editPatch, readParams, type EditKey } from "./params";
import { React, api } from "./rt";

export const TITLE = "Local Contrast";

interface Display {
  /** Shown value per stored unit, and the shown value of a stored 0. */
  factor: number;
  offset: number;
  step: number;
}

const DISPLAY: Record<NumericKey, Display> = {
  detail: { factor: 100, offset: 100, step: 1 },
  highlights: { factor: 100, offset: 0, step: 1 },
  shadows: { factor: 100, offset: 0, step: 1 },
  midtone: { factor: 1, offset: 0, step: 0.001 },
  coarseness: { factor: 1, offset: 0, step: 1 },
  contrast: { factor: 1, offset: 0, step: 1 },
};

export const shown = (key: NumericKey, v: number): number => v * DISPLAY[key].factor + DISPLAY[key].offset;
export const stored = (key: NumericKey, v: number): number => (v - DISPLAY[key].offset) / DISPLAY[key].factor;

const MODES: { value: Mode; label: string }[] = [
  { value: "laplacian", label: "Local laplacian" },
  { value: "bilateral", label: "Bilateral grid" },
];

const MODE_SLIDERS: Record<Mode, NumericKey[]> = {
  laplacian: ["highlights", "shadows", "midtone"],
  bilateral: ["coarseness", "contrast"],
};

export function LocalContrastPanel() {
  const { Slider } = api.components;
  const { Select, SegmentedControl, Stack, Toggle } = api.ui;
  const scope = api.develop.useParamScope();
  const p = readParams(scope.getParams());

  const write = (next: Params, keys: readonly EditKey[]) => scope.setParams(editPatch(next, keys));

  const slider = (key: NumericKey) => {
    const range = RANGES[key];
    return (
      <Slider
        key={key}
        label={LABELS[key]}
        value={shown(key, p[key])}
        min={shown(key, range.min)}
        max={shown(key, range.max)}
        step={DISPLAY[key].step}
        defaultValue={shown(key, DEFAULT_PARAMS[key])}
        onChange={(v) => {
          const value = Math.min(Math.max(stored(key, v), range.min), range.max);
          write({ ...readParams(scope.getParams()), [key]: value }, [key]);
        }}
        onCommit={() => scope.commit(`${TITLE}: ${LABELS[key].toLowerCase()}`)}
      />
    );
  };

  return (
    <Stack gap={6} style={{ padding: 8 }}>
      <Toggle
        checked={p.on}
        label={LABELS.on}
        onChange={(checked) => {
          write({ ...readParams(scope.getParams()), on: checked }, ["on"]);
          scope.commit(`${TITLE}: ${checked ? "on" : "off"}`);
        }}
      />
      <SegmentedControl
        size="sm"
        value={p.mode}
        options={MODES}
        onChange={(v) => {
          const mode: Mode = v === "bilateral" ? "bilateral" : "laplacian";
          write({ ...readParams(scope.getParams()), mode }, ["mode"]);
          scope.commit(`${TITLE}: ${LABELS.mode.toLowerCase()}`);
        }}
      />
      {slider("detail")}
      {MODE_SLIDERS[p.mode].map(slider)}
      <Select
        value=""
        placeholder="Presets"
        ariaLabel={`${TITLE} presets`}
        options={PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
        onChange={(id) => {
          const preset = PRESETS.find((candidate) => candidate.id === id);
          if (!preset) return;
          const next: Params = { ...readParams(scope.getParams()), ...preset.params, on: true };
          write(next, EDIT_KEYS.filter((key) => key === "on" || key in preset.params));
          scope.commit(`${TITLE}: ${preset.label}`);
        }}
      />
    </Stack>
  );
}
