// darktable's local contrast (src/iop/bilat.c, src/common/locallaplacian.c,
// src/common/bilateral.c; master 7d7dac363d; GPL-3.0-or-later), the parts the
// CPU needs: the edit's defaults, ranges and presets, darktable's struct, and
// the layout and schedule of the GPU passes. glsl.ts does the same integer
// arithmetic per draw; the tests pin the two together and both against
// darktable.
//
// Copyright (C) 2012-2026 darktable developers (bilat.c 2012-2023,
// locallaplacian.c 2016-2026, bilateral.c 2012-2026).

export type Mode = "laplacian" | "bilateral";

export interface Params {
  on: boolean;
  mode: Mode;
  /** −1 to 4: 0 leaves the image, −1 smooths it, above 0 boosts local contrast. */
  detail: number;
  /** Local laplacian: the curve's slope below and above the midtone range, 0 to 2. */
  highlights: number;
  shadows: number;
  /** Local laplacian: what counts as midtones, 0.001 to 1. */
  midtone: number;
  /** Bilateral grid: the spatial sigma in pixels of the full image, 3 to 100. */
  coarseness: number;
  /** Bilateral grid: the L* difference that counts as an edge, 1 to 100. */
  contrast: number;
}

export type NumericKey = Exclude<keyof Params, "on" | "mode">;

export const DEFAULT_PARAMS: Readonly<Params> = {
  on: false,
  mode: "laplacian",
  detail: 0.25,
  highlights: 0.5,
  shadows: 0.5,
  midtone: 0.5,
  coarseness: 50,
  contrast: 20,
};

export interface Range {
  min: number;
  max: number;
}

/** The sliders' limits as gui_init() sets them. */
export const RANGES: Readonly<Record<NumericKey, Range>> = {
  detail: { min: -1, max: 4 },
  highlights: { min: 0, max: 2 },
  shadows: { min: 0, max: 2 },
  midtone: { min: 0.001, max: 1 },
  coarseness: { min: 3, max: 100 },
  contrast: { min: 1, max: 100 },
};

export interface Preset {
  id: string;
  label: string;
  params: Partial<Params>;
}

/** init_presets(). */
export const PRESETS: readonly Preset[] = [
  { id: "clarity", label: "Clarity", params: { mode: "laplacian", detail: 0.33, highlights: 0, shadows: 0, midtone: 0.5 } },
  { id: "hdr", label: "HDR local tone mapping", params: { mode: "laplacian", detail: 1, highlights: 0, shadows: 0, midtone: 0.25 } },
];

/** dt_iop_bilat_params_t v3: mode 1 is the local laplacian, 0 the bilateral grid. */
export interface DarktableParams {
  mode: 0 | 1;
  sigmaR: number;
  sigmaS: number;
  detail: number;
  midtone: number;
}

/** The struct darktable's GUI writes: the visible mode's two sigmas. */
export function darktableParams(p: Params): DarktableParams {
  const laplacian = p.mode === "laplacian";
  return {
    mode: laplacian ? 1 : 0,
    sigmaR: laplacian ? p.highlights : p.contrast,
    sigmaS: laplacian ? p.shadows : p.coarseness,
    detail: p.detail,
    midtone: p.midtone,
  };
}

const f32 = Math.fround;

// ── Local laplacian ──────────────────────────────────────────────────────────

export const NUM_GAMMA = 6;
export const MAX_LEVELS = 30;

/** gamma[k] = (k + .5f) / (float)num_gamma. */
export const gammaLevel = (k: number): number => f32(f32(k + 0.5) / NUM_GAMMA);

/** min(max_levels, 31 - clz(min(w, h))). */
export function numLevels(w: number, h: number): number {
  return Math.min(MAX_LEVELS, 31 - Math.clz32(Math.min(w, h)));
}

/** dl(): a size halved `level` times as (size - 1) / 2 + 1. */
export function dl(size: number, level: number): number {
  let s = size;
  for (let l = 0; l < level; l++) s = Math.floor((s - 1) / 2) + 1;
  return s;
}

/** One axis of a level: the padded level's size, and the window [lo, hi]
 *  stored for it. Outside the window the level is constant along the axis. */
export interface Span {
  size: number;
  lo: number;
  hi: number;
}

export interface AtlasLevel {
  level: number;
  x: Span;
  y: Span;
  /** Texels in one plane: the window's area. */
  area: number;
  /** Linear texel index of plane A; plane B follows at base + area. */
  base: number;
}

export interface LaplacianLayout {
  width: number;
  height: number;
  levels: number;
  last: number;
  /** max_supp: the padding on every side. */
  supp: number;
  /** Levels 1 … last, index 0 unused. */
  atlas: AtlasLevel[];
  /** Texels the atlas takes. */
  texels: number;
  fits: boolean;
  /** Draws the pass needs: 0 when the frame is too small to run. */
  draws: number;
}

const floorDiv2 = (v: number): number => Math.floor(v / 2);

export function laplacianLayout(width: number, height: number): LaplacianLayout {
  const levels = width > 1 && height > 1 ? numLevels(width, height) : 0;
  const last = levels - 1;
  const supp = last >= 0 ? 2 ** last : 0;
  const padW = width + 2 * supp;
  const padH = height + 2 * supp;
  const atlas: AtlasLevel[] = [];
  let loX = supp;
  let hiX = supp + width - 1;
  let loY = supp;
  let hiY = supp + height - 1;
  let base = 0;
  for (let l = 1; l <= last; l++) {
    const sx = dl(padW, l);
    const sy = dl(padH, l);
    loX = Math.max(floorDiv2(loX - 2), 0);
    loY = Math.max(floorDiv2(loY - 2), 0);
    hiX = Math.min(Math.ceil((hiX + 2) / 2), sx - 1);
    hiY = Math.min(Math.ceil((hiY + 2) / 2), sy - 1);
    const area = (hiX - loX + 1) * (hiY - loY + 1);
    atlas[l] = { level: l, x: { size: sx, lo: loX, hi: hiX }, y: { size: sy, lo: loY, hi: hiY }, area, base };
    base += 2 * area;
  }
  const fits = last >= 1 && base <= width * height;
  return { width, height, levels, last, supp, atlas, texels: base, fits, draws: fits ? 2 * last : 0 };
}

/** The draw count the pass is given: enough for any frame whose short side is
 *  under 65536 (15 levels). A frame that needs fewer starts later. */
export const LL_DRAWS = 2 * 14;

// ── Bilateral grid ───────────────────────────────────────────────────────────

/** DT_COMMON_BILATERAL_MAX_RES_S / _R. */
export const MAX_RES_S = 3000;
export const MAX_RES_R = 50;
/** Input or Sx texels a draw of the splat reads per pixel. */
export const SPLAT_TAPS = 24;
/** The memory clamp's step and its most steps. */
export const WIDEN = 1.25;
export const MAX_WIDEN_STEPS = 16;

export interface Grid {
  sigmaS: number;
  sigmaR: number;
  invS: number;
  invR: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /** Texels per grid node: four z bins each. */
  quads: number;
}

/** roundf() for the non-negative values it sees here. */
const roundf = (v: number): number => Math.floor(v + 0.5);

/** dt_bilateral_grid_size() in float32, L_range 100. */
export function gridSize(width: number, height: number, sigmaSIn: number, sigmaRIn: number): Grid {
  const sigmaS0 = f32(sigmaSIn) < 0.5 ? 0.5 : f32(sigmaSIn);
  const clampi = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const gx = clampi(roundf(f32(width / sigmaS0)), 4, MAX_RES_S);
  const gy = clampi(roundf(f32(height / sigmaS0)), 4, MAX_RES_S);
  const gz = clampi(roundf(f32(100 / f32(sigmaRIn))), 4, MAX_RES_R);
  const sigmaS = Math.max(f32(height / gy), f32(width / gx));
  const sigmaR = f32(100 / gz);
  const invS = f32(1 / sigmaS);
  const invR = f32(1 / sigmaR);
  const sizeX = Math.ceil(f32(width * invS)) + 1;
  const sizeY = Math.ceil(f32(height * invS)) + 1;
  const sizeZ = Math.ceil(f32(100 * invR)) + 1;
  return { sigmaS, sigmaR, invS, invR, sizeX, sizeY, sizeZ, quads: Math.ceil(sizeZ / 4) };
}

/** Texels at the start of the target that hold the grid's float32 constants. */
export const CONSTANT_TEXELS = 4;

/** Texels the bilateral pass keeps: the constants, one quad's x-splat (blurred
 *  in place along x) and the grid (blurred in place along y). */
export function gridTexels(g: Grid, height: number): number {
  return CONSTANT_TEXELS + g.sizeX * height + g.sizeX * g.sizeY * g.quads;
}

/** Pixels a node's tent can reach along an axis, with a pixel of slack each side. */
export const splatSpan = (sigmaS: number): number => Math.floor(2 * sigmaS) + 4;
export const splatChunks = (sigmaS: number): number => Math.ceil(splatSpan(sigmaS) / SPLAT_TAPS);

/** The plan draw; for each quad its x-splat chunks, the x-blur and its
 *  y-splat chunks; then the y-blur and the slice. */
export const bilateralSteps = (quads: number, chunks: number): number => 1 + quads * (2 * chunks + 1) + 2;

export interface BilateralPlan {
  grid: Grid;
  /** σs as the pass got it, before the grid's own adjustments. */
  sigmaS: number;
  /** Times the memory clamp widened σs (0: darktable's grid as it is). */
  widened: number;
  chunks: number;
  draws: number;
}

/** σs for the pass: coarseness / max(source / pass, 1), as darktable's
 *  sigma_s / fmaxf(iscale / roi_in->scale, 1). */
export function passSigmaS(coarseness: number, sourceLongEdge: number, passLongEdge: number): number {
  if (sourceLongEdge <= passLongEdge) return f32(coarseness);
  return f32(f32(coarseness) / f32(sourceLongEdge / passLongEdge));
}

/** The grid and draws a pass of `width` × `height` runs, widening σs where
 *  darktable's grid wouldn't fit the target; null when nothing fits. */
export function bilateralPlan(width: number, height: number, sigmaS: number, sigmaR: number): BilateralPlan | null {
  let sigma = Math.max(f32(sigmaS), 0.5);
  for (let k = 0; k < MAX_WIDEN_STEPS; k++) {
    const grid = gridSize(width, height, sigma, sigmaR);
    if (gridTexels(grid, height) <= width * height) {
      const chunks = splatChunks(grid.sigmaS);
      return { grid, sigmaS, widened: k, chunks, draws: bilateralSteps(grid.quads, chunks) };
    }
    sigma = f32(sigma * WIDEN);
  }
  return null;
}

/** The z bins' quads, which depend only on contrast. */
export const gridQuads = (contrast: number): number => gridSize(4096, 4096, 50, contrast).quads;

/** The σs no pass's grid exceeds for a coarseness: rounding the grid to whole
 *  cells adds up to an eighth, darktable's 3000-cell cap needs W / 3000, and
 *  the memory clamp at most a few pixels on frames of 64 px and up. */
export const sigmaBound = (coarseness: number): number => Math.max(1.25 * coarseness, 24);

/** The pass's draw count: enough for any frame of 64 px and up. */
export function bilateralDraws(coarseness: number, contrast: number): number {
  return bilateralSteps(gridQuads(contrast), splatChunks(sigmaBound(coarseness)));
}

export const MAX_DRAWS = 1024;

export interface DrawCounts {
  llDraws: number;
  blDraws: number;
}

/** 0 for the mode not in use and while the module is off. */
export function drawCounts(p: Params): DrawCounts {
  if (!p.on) return { llDraws: 0, blDraws: 0 };
  if (p.mode === "laplacian") return { llDraws: LL_DRAWS, blDraws: 0 };
  return { llDraws: 0, blDraws: Math.min(bilateralDraws(p.coarseness, p.contrast), MAX_DRAWS) };
}
