// The processing stage: one pass per mode (glsl.ts), and the inline that moves
// each pixel's L* by the pass's result. darktable runs local contrast on Lab
// after the tone mapper and the tone curves, ahead of its colour tools, so the
// stage sits after the display tools, ahead of the display phase's colour
// tools, in linear Rec.709.

import { BL_GLSL, BL_HELPERS, INLINE_GLSL, INLINE_HELPERS, LL_GLSL, LL_HELPERS, REGION_GLSL } from "./glsl";
import { DEFAULT_PARAMS, MAX_DRAWS, RANGES } from "./model";
import { EDIT_KEYS, LABELS, NUMERIC_KEYS, STAGE_ID, bagValue, type DrawKey, type EditKey } from "./params";
import type { ProcessingStageContribution, UniformDeclaration } from "./safelight";

/** Ahead of the display phase's colour tools at the default 100. */
export const PRIORITY = 90;

const isNumeric = (key: EditKey): key is (typeof NUMERIC_KEYS)[number] => (NUMERIC_KEYS as readonly string[]).includes(key);

const edit = (key: EditKey): UniformDeclaration => {
  const base = { key, default: bagValue(DEFAULT_PARAMS, key), label: LABELS[key] };
  if (key === "on") return { ...base, glslType: "bool" };
  if (key === "mode") return { ...base, glslType: "int", range: { min: 0, max: 1, step: 1 } };
  return { ...base, glslType: "float", range: isNumeric(key) ? { ...RANGES[key] } : { min: 0, max: 1 } };
};

const draws = (key: DrawKey): UniformDeclaration => ({ key, glslType: "int", default: 0 });

/** What each pass reads: changing one of these reruns that pass. */
export const LAPLACIAN_KEYS: readonly EditKey[] = ["detail", "highlights", "shadows", "midtone"];
export const BILATERAL_KEYS: readonly EditKey[] = ["detail", "coarseness", "contrast"];

export function localContrastStage(): ProcessingStageContribution {
  return {
    id: STAGE_ID,
    name: "Local Contrast",
    phase: "display-adjust",
    priority: PRIORITY,
    reads: "current",
    space: { encoding: "linear", primaries: "rec709" },
    glsl: INLINE_GLSL,
    helpers: INLINE_HELPERS,
    uniforms: [...EDIT_KEYS.map(edit), draws("llDraws"), draws("blDraws")],
    passes: [
      {
        channels: 4,
        glsl: LL_GLSL,
        helpers: LL_HELPERS,
        region: REGION_GLSL,
        iterations: { key: "llDraws", max: MAX_DRAWS },
        uniforms: LAPLACIAN_KEYS.map(edit),
      },
      {
        channels: 4,
        glsl: BL_GLSL,
        helpers: BL_HELPERS,
        region: REGION_GLSL,
        iterations: { key: "blDraws", max: MAX_DRAWS },
        uniforms: BILATERAL_KEYS.map(edit),
      },
    ],
    dormantWhen: { llDraws: 0, blDraws: 0 },
    mask: { maskable: true },
  };
}
