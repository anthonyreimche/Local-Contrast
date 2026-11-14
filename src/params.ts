// The param-bag contract. The edit is darktable's local contrast with each
// mode's sliders kept apart, under the stage's qualified keys: the switch as a
// boolean, the mode as darktable's enum (1 local laplacian, 0 bilateral grid)
// and the rest as darktable's numbers. Two derived keys are the passes' draw
// counts: 0 for the mode not in use and while the module is off, so an
// untouched photo never runs either pass.

import { DEFAULT_PARAMS, RANGES, drawCounts, type Mode, type NumericKey, type Params } from "./model";

export const EXT_ID = "local-contrast";
export const STAGE_ID = `${EXT_ID}.lightness`;

export type EditKey = keyof Params;
export const EDIT_KEYS: readonly EditKey[] = ["on", "mode", "detail", "highlights", "shadows", "midtone", "coarseness", "contrast"];
export const NUMERIC_KEYS: readonly NumericKey[] = ["detail", "highlights", "shadows", "midtone", "coarseness", "contrast"];

export type DrawKey = "llDraws" | "blDraws";
export const DRAW_KEYS: readonly DrawKey[] = ["llDraws", "blDraws"];

/** The panel's labels, which the stage's uniforms share. */
export const LABELS: Record<EditKey, string> = {
  on: "Enabled",
  mode: "Mode",
  detail: "Detail",
  highlights: "Highlights",
  shadows: "Shadows",
  midtone: "Midtone range",
  coarseness: "Coarseness",
  contrast: "Contrast",
};

export const qualified = (key: EditKey | DrawKey): string => `${STAGE_ID}.${key}`;

type Bag = Readonly<Record<string, unknown>>;
type Patch = Record<string, number | boolean>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** darktable's enum for a mode, as the bag keeps it. */
export const modeValue = (mode: Mode): number => (mode === "laplacian" ? 1 : 0);

/** `bag` is the host's untyped per-photo bag; a missing or non-finite value reads as the default. */
export function readParams(bag: Bag): Params {
  const out: Params = { ...DEFAULT_PARAMS };
  const on = bag[qualified("on")];
  if (typeof on === "boolean") out.on = on;
  else if (finite(on)) out.on = on >= 0.5;
  const mode = bag[qualified("mode")];
  if (finite(mode)) out.mode = mode >= 0.5 ? "laplacian" : "bilateral";
  for (const key of NUMERIC_KEYS) {
    const v = bag[qualified(key)];
    if (finite(v)) out[key] = Math.min(Math.max(v, RANGES[key].min), RANGES[key].max);
  }
  return out;
}

/** A param as the bag holds it. */
export function bagValue(p: Params, key: EditKey): number | boolean {
  if (key === "on") return p.on;
  if (key === "mode") return modeValue(p.mode);
  return p[key];
}

function drawsPatch(p: Params): Patch {
  const counts = drawCounts(p);
  return { [qualified("llDraws")]: counts.llDraws, [qualified("blDraws")]: counts.blDraws };
}

/** The edit and its draw counts. */
export function bagPatch(p: Params): Patch {
  const out: Patch = {};
  for (const key of EDIT_KEYS) out[qualified(key)] = bagValue(p, key);
  return { ...out, ...drawsPatch(p) };
}

/** `keys` of `p` and the draw counts `p` needs: what a control writes. */
export function editPatch(p: Params, keys: readonly EditKey[]): Patch {
  const out: Patch = {};
  for (const key of keys) out[qualified(key)] = bagValue(p, key);
  return { ...out, ...drawsPatch(p) };
}

/** The draw counts the bag's edit needs, when the bag holds others. */
export function rederivePatch(bag: Bag): Patch | null {
  if (![...EDIT_KEYS, ...DRAW_KEYS].some((key) => qualified(key) in bag)) return null;
  const want = drawsPatch(readParams(bag));
  return DRAW_KEYS.every((key) => bag[qualified(key)] === want[qualified(key)]) ? null : want;
}

export const resetPatch = (): Patch => bagPatch(DEFAULT_PARAMS);
