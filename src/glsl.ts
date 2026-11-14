// The GPU side of model.ts: darktable's local contrast (bilat.c,
// locallaplacian.c, bilateral.c, colorspaces_inline_conversions.h;
// GPL-3.0-or-later).
//
// Copyright (C) 2012-2026 darktable developers.
//
// Two four-channel passes, one per mode; the mode not in use draws 0 times.
// Every draw decodes uPassIndex into a step and works on part of the target,
// which holds its intermediates at linear texel addresses (n mod W, n div W).
// docs/SPEC.md §3 sets out both layouts; test/reference/gpumodel.ts is the
// same arithmetic in TypeScript.
//
// D3D11 (ANGLE) shapes this code: no arrays at all and no texture(), so no
// draw pays for every branch; components are picked with one-hot vectors.

import {
  CONSTANT_TEXELS,
  MAX_LEVELS,
  MAX_RES_R,
  MAX_RES_S,
  MAX_WIDEN_STEPS,
  NUM_GAMMA,
  SPLAT_TAPS,
  WIDEN,
  gammaLevel,
} from "./model";

/** A GLSL float literal that always carries a decimal point. */
export function glslLiteral(v: number): string {
  const s = v.toPrecision(10);
  if (/e/i.test(s)) {
    const [mantissa, exponent] = s.split(/e/i);
    const m = mantissa.includes(".") ? mantissa : `${mantissa}.0`;
    return `${m}e${Number(exponent)}`;
  }
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, ".0") : `${s}.0`;
}

const lit = glslLiteral;

/** Half the step in v (L* / 100) the final draw takes its slope over. */
const FINAL_STEP = 2 ** -10;

/** Linear Rec.709 to XYZ (D50, Bradford): the working profile's matrix. */
export const XYZ_FROM_709: readonly (readonly number[])[] = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
];

export function invert3(m: readonly (readonly number[])[]): number[][] {
  const [a, b, c] = m;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  return [
    [(b[1] * c[2] - b[2] * c[1]) / det, (a[2] * c[1] - a[1] * c[2]) / det, (a[1] * b[2] - a[2] * b[1]) / det],
    [(b[2] * c[0] - b[0] * c[2]) / det, (a[0] * c[2] - a[2] * c[0]) / det, (a[2] * b[0] - a[0] * b[2]) / det],
    [(b[0] * c[1] - b[1] * c[0]) / det, (a[1] * c[0] - a[0] * c[1]) / det, (a[0] * b[1] - a[1] * b[0]) / det],
  ];
}

/** A row-major matrix as GLSL's column-major mat3 constructor takes it. */
const mat3 = (m: readonly (readonly number[])[]): string =>
  `mat3(${[0, 1, 2].flatMap((col) => [0, 1, 2].map((row) => lit(m[row][col]))).join(", ")})`;

const KAPPA = 24389 / 27;
const EPSILON = 216 / 24389;
const D50X = 0.9642;
const D50Z = 0.8249;

/** L* of a linear Rec.709 pixel, as dt_XYZ_to_Lab() takes it from Y. */
const LIGHTNESS_GLSL = `
float lcCbrt(float v) {
  float r = exp2(log2(v) / 3.0);
  return r - (r * r * r - v) / (3.0 * r * r);
}
float lcLabF(float t) {
  return t > ${lit(EPSILON)} ? lcCbrt(t) : (${lit(KAPPA)} * t + 16.0) / 116.0;
}
float lcLightness(vec3 rgb) {
  return 116.0 * lcLabF(dot(vec3(${XYZ_FROM_709[1].map(lit).join(", ")}), rgb)) - 16.0;
}
`;

// ── The inline ───────────────────────────────────────────────────────────────

/** The pixel's L* moved by the passes' result, a* and b* kept, through XYZ
 *  (D50) as dt_Lab_to_XYZ() inverts dt_XYZ_to_Lab(). The result is a line in
 *  the pixel's own L* / 100: its value at 0, as a half float and what that
 *  leaves (x, y), and its slope (z). The passes read their input as half
 *  floats; the slope carries the result over to the pixel's exact L*. The
 *  bilateral grid's result is flat, and held at 0, as dt_bilateral_slice()
 *  holds it. */
export const INLINE_HELPERS = `${LIGHTNESS_GLSL}
float lcLabFInv(float f) {
  return f > ${lit(6 / 29)} ? f * f * f : (116.0 * f - 16.0) / ${lit(KAPPA)};
}
vec3 lcShiftLightness(vec3 rgb, vec3 result, bool floorAtZero) {
  vec3 xyz = ${mat3(XYZ_FROM_709)} * rgb / vec3(${lit(D50X)}, 1.0, ${lit(D50Z)});
  vec3 f = vec3(lcLabF(xyz.x), lcLabF(xyz.y), lcLabF(xyz.z));
  float L = 116.0 * f.y - 16.0;
  float moved = L + 100.0 * (result.x + result.y + result.z * L * 0.01);
  if (floorAtZero) moved = max(moved, 0.0);
  f += (moved - L) / 116.0;
  vec3 back = vec3(lcLabFInv(f.x), lcLabFInv(f.y), lcLabFInv(f.z));
  return ${mat3(invert3(XYZ_FROM_709))} * (back * vec3(${lit(D50X)}, 1.0, ${lit(D50Z)}));
}
`;

export const INLINE_GLSL = `
if (llDraws > 0 || blDraws > 0) {
  if (stageResult != vec3(0.0)) c.rgb = lcShiftLightness(c.rgb, stageResult, blDraws > 0);
}
`;

// ── Shared by both passes ────────────────────────────────────────────────────

const SHARED_GLSL = `${LIGHTNESS_GLSL}
// 2^e for a normal result; ldexp is GLSL ES 3.10.
float lcPow2(int e) { return uintBitsToFloat(uint(e + 127) << 23); }
ivec2 lcFrame() { return ivec2(floor(1.0 / uTexel + 0.5)); }
ivec2 lcAt(highp int n, int width) {
  highp int row = n / width;
  return ivec2(n - row * width, row);
}
vec4 lcFetch(highp int n, int width) { return fetchPrev4(lcAt(n, width)); }
vec4 lcOneHot(int i) { return vec4(equal(ivec4(i), ivec4(0, 1, 2, 3))); }
// The texels [from, to) as whole rows.
ivec4 lcRows(int width, highp int from, highp int to) {
  if (to <= from) return ivec4(0);
  return ivec4(0, from / width, width, (to - 1) / width + 1);
}
// The last draw hands the inline the line delta + slope (v' - v) in the
// pixel's L* / 100, v': its value at 0 as a half float in x and what that
// leaves in y, and the slope, a half float, in z. Quantizing both first makes
// the target keep them exactly.
vec4 lcResult(float delta, float slope, float v) {
  float z = lcHalf(slope);
  float at0 = delta - z * v;
  float hi = lcQuantize(at0);
  return vec4(hi, lcHalf(at0 - hi), z, 1.0);
}
`;

/** lcQuantize: the value with 11 significant bits, which a half float holds
 *  exactly; 0 below half's normal range. lcHalf: the half float nearest the
 *  value, so the target stores what this code chose whatever rounding its
 *  own conversion uses. */
const QUANTIZE_GLSL = `
float lcQuantize(float v) {
  if (abs(v) < ${lit(2 ** -14)}) return 0.0;
  return uintBitsToFloat((floatBitsToUint(v) + 0x1000u) & 0xFFFFE000u);
}
float lcHalf(float v) {
  if (abs(v) < ${lit(2 ** -14)}) return floor(v * ${lit(2 ** 24)} + 0.5) * ${lit(2 ** -24)};
  return lcQuantize(v);
}
vec4 lcHalf4(vec4 v) { return vec4(lcHalf(v.x), lcHalf(v.y), lcHalf(v.z), lcHalf(v.w)); }
`;

// ── Local laplacian ──────────────────────────────────────────────────────────

const gammaVec = (from: number): string =>
  `vec4(${[0, 1, 2, 3].map((k) => lit(from + k < NUM_GAMMA ? gammaLevel(from + k) : 0)).join(", ")})`;

/** The step a draw of the local laplacian runs. */
export const LL_STEP = { idle: 0, build: 1, assemble: 2, final: 3, zero: 4 } as const;

export const LL_HELPERS = `${QUANTIZE_GLSL}${SHARED_GLSL}
// min(max_levels, 31 - clz(min(w, h))): findMSB is GLSL ES 3.10.
int lcLevelCount(ivec2 frame) {
  int shortest = min(frame.x, frame.y);
  if (shortest < 2) return 0;
  int msb = 0;
  for (int i = 1; i < 31; i++) {
    if ((shortest >> i) > 0) msb = i;
  }
  return min(${MAX_LEVELS}, msb);
}
// Level l of the padded pyramid: its size, the window [lo, hi] the atlas keeps
// of it, and plane A's first texel (level 0: the frame inside its padding).
void lcLevel(ivec2 frame, int l, out ivec2 size, out ivec2 lo, out ivec2 hi, out highp int base) {
  int supp = 1 << (lcLevelCount(frame) - 1);
  size = frame + 2 * supp;
  lo = ivec2(supp);
  hi = ivec2(supp) + frame - 1;
  base = 0;
  highp int next = 0;
  for (int m = 1; m < ${MAX_LEVELS}; m++) {
    if (m > l) break;
    size = (size - 1) / 2 + 1;
    lo = max((lo - 2) / 2, ivec2(0));
    hi = min((hi + 3) / 2, size - 1);
    base = next;
    next += 2 * (hi.x - lo.x + 1) * (hi.y - lo.y + 1);
  }
}
highp int lcArea(ivec2 lo, ivec2 hi) { return (hi.x - lo.x + 1) * (hi.y - lo.y + 1); }
// A texel of a plane of a level at padded coordinates t, clamped into the
// window: outside it the level is constant along each axis.
vec4 lcTexel(int width, ivec2 t, int plane, ivec2 lo, ivec2 hi, highp int base) {
  ivec2 w = clamp(t, lo, hi) - lo;
  int ww = hi.x - lo.x + 1;
  return lcFetch(base + plane * lcArea(lo, hi) + w.y * ww + w.x, width);
}
// The step this draw runs and its level. Idle draws come first; a frame that
// can't hold the atlas, or a draw count too small, runs nothing and its last
// draw leaves 0.
void lcSchedule(ivec2 frame, out int kind, out int l) {
  kind = ${LL_STEP.idle};
  l = 0;
  int last = lcLevelCount(frame) - 1;
  bool runs = last >= 1;
  if (runs) {
    ivec2 size, lo, hi;
    highp int base;
    lcLevel(frame, last, size, lo, hi, base);
    runs = base + 2 * lcArea(lo, hi) <= frame.x * frame.y && uPassCount >= 2 * last;
  }
  if (!runs) {
    if (uPassIndex == uPassCount - 1) kind = ${LL_STEP.zero};
    return;
  }
  int k = uPassIndex - (uPassCount - 2 * last);
  if (k < 0) return;
  if (k < last) {
    kind = ${LL_STEP.build};
    l = k + 1;
  } else if (k < 2 * last - 1) {
    kind = ${LL_STEP.assemble};
    l = last - 1 - (k - last);
  } else {
    kind = ${LL_STEP.final};
  }
}
// What a draw writes, with what the draw before it wrote: building level l
// follows level l - 1 (both planes); assembling level l (plane B) follows
// level l + 1 (plane B, or both planes of the last level).
ivec4 lcRegion() {
  ivec2 frame = lcFrame();
  int kind, l;
  lcSchedule(frame, kind, l);
  if (kind == ${LL_STEP.idle}) return ivec4(0);
  if (kind != ${LL_STEP.build} && kind != ${LL_STEP.assemble}) return ivec4(0, 0, frame);
  ivec2 size, lo, hi;
  highp int base;
  lcLevel(frame, l, size, lo, hi, base);
  if (kind == ${LL_STEP.build}) {
    highp int to = base + 2 * lcArea(lo, hi);
    if (l > 1) lcLevel(frame, l - 1, size, lo, hi, base);
    return lcRows(frame.x, base, to);
  }
  highp int from = base + lcArea(lo, hi);
  lcLevel(frame, l + 1, size, lo, hi, base);
  return lcRows(frame.x, from, base + 2 * lcArea(lo, hi));
}
// dt_fast_expf(), lane by lane.
vec4 lcFastExp(vec4 x) {
  vec4 k = 1065353216.0 + x * 11401300.0;
  return intBitsToFloat(ivec4(max(k, vec4(0.0))));
}
// curve_scalar(x, g, midtone, shadows, highlights, detail) less x, for four
// reference levels g at once.
vec4 lcRemapEach(vec4 x, vec4 g) {
  vec4 c = x - g;
  float s2 = 2.0 * midtone;
  vec4 tp = clamp(c / s2, 0.0, 1.0);
  vec4 tn = clamp(-c / s2, 0.0, 1.0);
  vec4 brighter = g + midtone * 2.0 * (1.0 - tp) * tp + tp * tp * (midtone + midtone * shadows);
  vec4 darker = g - midtone * 2.0 * (1.0 - tn) * tn + tn * tn * (-midtone - midtone * highlights);
  vec4 val = mix(darker, brighter, greaterThan(c, vec4(0.0)));
  val = mix(val, g - midtone + highlights * (c + midtone), lessThan(c, vec4(-s2)));
  val = mix(val, g + midtone + shadows * (c - midtone), greaterThan(c, vec4(s2)));
  val += detail * c * lcFastExp(-c * c / (2.0 * midtone * midtone / 3.0));
  return val - x;
}
vec4 lcRemap(float x, vec4 g) { return lcRemapEach(vec4(x), g); }
// The reference levels a plane keeps: 0 to 2 in plane A, 3 to 5 in plane B.
vec4 lcPlaneGammas(int plane) { return plane == 0 ? ${gammaVec(0)} : ${gammaVec(3)}; }
float lcGamma(int k) { return dot(${gammaVec(0)}, lcOneHot(k)) + dot(${gammaVec(4)}, lcOneHot(k - 4)); }
// A level's input padded by replication: L* / 100 of the frame's edge texel.
float lcInputAt(ivec2 frame, ivec2 padded, int supp) {
  return lcLightness(fetchInput(clamp(padded - supp, ivec2(0), frame - 1))) * 0.01;
}
float lcB3(int i) { return i == 2 ? 6.0 : (i == 1 || i == 3 ? 4.0 : 1.0); }
// A texel of level 1, both planes' values reduced from the frame itself.
vec4 lcBuildFromInput(ivec2 frame, ivec2 at, int plane, int supp) {
  vec4 g = lcPlaneGammas(plane);
  float p = 0.0;
  vec3 e = vec3(0.0);
  for (int j = 0; j < 5; j++) {
    float rowP = 0.0;
    vec3 rowE = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      float v = lcInputAt(frame, 2 * at - 2 + ivec2(i, j), supp);
      rowP += lcB3(i) * v;
      rowE += lcB3(i) * lcRemap(v, g).xyz;
    }
    p += lcB3(j) * rowP;
    e += lcB3(j) * rowE;
  }
  return vec4(p, e) / 256.0;
}
// A texel of level l > 1 reduced from its own plane of level l - 1, each
// curve's value rebuilt from the residual and P.
vec4 lcBuildFromLevel(ivec2 frame, ivec2 at, int plane, ivec2 lo, ivec2 hi, highp int base) {
  vec4 g = lcPlaneGammas(plane);
  float p = 0.0;
  vec3 e = vec3(0.0);
  for (int j = 0; j < 5; j++) {
    float rowP = 0.0;
    vec3 rowE = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      vec4 s = lcTexel(frame.x, 2 * at - 2 + ivec2(i, j), plane, lo, hi, base);
      rowP += lcB3(i) * s.x;
      rowE += lcB3(i) * (s.yzw + lcRemap(s.x, g).xyz);
    }
    p += lcB3(j) * rowP;
    e += lcB3(j) * rowE;
  }
  return vec4(p, e) / 256.0;
}
// e_k of curve k at a texel, from both planes' values there.
float lcPick(vec4 a, vec4 b, int k) {
  return dot(a.yzw, lcOneHot(k).xyz) + dot(b.yzw, lcOneHot(k - 3).xyz);
}
// The pair of curves that bracket v, and the weight of the upper one.
void lcBins(float v, out int lo, out int hi, out float a) {
  hi = 1;
  for (int k = 1; k < ${NUM_GAMMA - 1}; k++) {
    if (lcGamma(k) <= v) hi = k + 1;
  }
  lo = hi - 1;
  a = clamp((v - lcGamma(lo)) / (lcGamma(hi) - lcGamma(lo)), 0.0, 1.0);
}
float lcExpandWeight(int parity, int o) {
  if (parity == 1) return o == -1 ? 0.0 : 0.5;
  return o == 0 ? 0.75 : 0.125;
}
// ll_expand_gaussian() of D and of e for the two curves, from level l + 1,
// at fine texel p of level l (clamped as ll_fill_boundary2 leaves it).
vec3 lcExpand(ivec2 frame, ivec2 p, ivec2 fineSize, int coarse, bool coarseIsLast, int lo, int hi) {
  ivec2 at = clamp(p, ivec2(1), ((fineSize - 1) & ~1) - 1);
  ivec2 parity = at & 1;
  ivec2 size, clo, chi;
  highp int base;
  lcLevel(frame, coarse, size, clo, chi, base);
  vec4 g = vec4(lcGamma(lo), lcGamma(hi), 0.0, 0.0);
  vec3 sum = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float w = lcExpandWeight(parity.x, i) * lcExpandWeight(parity.y, j);
      if (w > 0.0) {
        ivec2 t = at / 2 + ivec2(i, j);
        vec4 a = lcTexel(frame.x, t, 0, clo, chi, base);
        vec4 b = lcTexel(frame.x, t, 1, clo, chi, base);
        vec4 r = lcRemap(a.x, g);
        sum += w * vec3(coarseIsLast ? 0.0 : b.x, lcPick(a, b, lo) + r.x, lcPick(a, b, hi) + r.y);
      }
    }
  }
  return sum;
}
// D at a texel: the expanded D plus the blended pair's Laplacians.
float lcAssembled(vec3 expanded, float eLo, float eHi, float a) {
  return expanded.x + (1.0 - a) * (eLo - expanded.y) + a * (eHi - expanded.z);
}
vec4 lcBuild(ivec2 frame, int l, highp int rel) {
  ivec2 size, lo, hi;
  highp int base;
  lcLevel(frame, l, size, lo, hi, base);
  highp int area = lcArea(lo, hi);
  int plane = rel >= area ? 1 : 0;
  highp int r = rel - plane * area;
  int ww = hi.x - lo.x + 1;
  ivec2 at = clamp(lo + ivec2(r - (r / ww) * ww, r / ww), ivec2(1), size - 2);
  vec4 s;
  if (l == 1) {
    s = lcBuildFromInput(frame, at, plane, 1 << (lcLevelCount(frame) - 1));
  } else {
    lcLevel(frame, l - 1, size, lo, hi, base);
    s = lcBuildFromLevel(frame, at, plane, lo, hi, base);
  }
  float pq = lcQuantize(s.x);
  vec3 residual = s.yzw - lcRemap(pq, lcPlaneGammas(plane)).xyz;
  return vec4(pq, lcHalf(residual.x), lcHalf(residual.y), lcHalf(residual.z));
}
vec4 lcAssemble(ivec2 frame, int l, highp int rel, vec4 own) {
  int last = lcLevelCount(frame) - 1;
  ivec2 size, lo, hi;
  highp int base;
  lcLevel(frame, l, size, lo, hi, base);
  int ww = hi.x - lo.x + 1;
  ivec2 p = lo + ivec2(rel - (rel / ww) * ww, rel / ww);
  vec4 a = lcFetch(base + rel, frame.x);
  int bLo, bHi;
  float w;
  lcBins(a.x, bLo, bHi, w);
  vec4 r = lcRemap(a.x, vec4(lcGamma(bLo), lcGamma(bHi), 0.0, 0.0));
  vec3 x = lcExpand(frame, p, size, l + 1, l + 1 == last, bLo, bHi);
  return vec4(lcHalf(lcAssembled(x, lcPick(a, own, bLo) + r.x, lcPick(a, own, bHi) + r.y, w)), own.yzw);
}
// D at level 0, and its slope in v with the pair of curves held, taken across
// ${lit(2 * FINAL_STEP)} of v.
vec4 lcFinal(ivec2 frame, ivec2 q) {
  int last = lcLevelCount(frame) - 1;
  int supp = 1 << last;
  float v = lcLightness(fetchInput(q)) * 0.01;
  int bLo, bHi;
  float w;
  lcBins(v, bLo, bHi, w);
  float gLo = lcGamma(bLo);
  float gHi = lcGamma(bHi);
  vec3 x = lcExpand(frame, q + supp, frame + 2 * supp, 1, last == 1, bLo, bHi);
  vec4 r = lcRemapEach(vec4(v, v, v + ${lit(FINAL_STEP)}, v - ${lit(FINAL_STEP)}), vec4(gLo, gHi, gLo, gLo));
  vec4 r2 = lcRemapEach(vec4(v + ${lit(FINAL_STEP)}, v - ${lit(FINAL_STEP)}, 0.0, 0.0), vec4(gHi, gHi, 0.0, 0.0));
  float up = clamp((v + ${lit(FINAL_STEP)} - gLo) / (gHi - gLo), 0.0, 1.0);
  float down = clamp((v - ${lit(FINAL_STEP)} - gLo) / (gHi - gLo), 0.0, 1.0);
  float slope = (lcAssembled(x, r.z, r2.x, up) - lcAssembled(x, r.w, r2.y, down)) / ${lit(2 * FINAL_STEP)};
  return lcResult(lcAssembled(x, r.x, r.y, w), slope, v);
}
`;

/** One call site each; a draw runs one of them. */
export const LL_STEP_CALLS = {
  build: "c = lcBuild(frame, l, n - base);",
  assemble: "c = lcAssemble(frame, l, n - base - area, c);",
  final: "c = lcFinal(frame, q);",
} as const;

export const LL_GLSL = `
ivec2 frame = lcFrame();
ivec2 q = ivec2(gl_FragCoord.xy);
int kind, l;
lcSchedule(frame, kind, l);
if (kind == ${LL_STEP.zero}) {
  c = vec4(0.0, 0.0, 0.0, 1.0);
} else if (kind == ${LL_STEP.final}) {
  ${LL_STEP_CALLS.final}
} else if (kind != ${LL_STEP.idle}) {
  ivec2 size, lo, hi;
  highp int base;
  lcLevel(frame, l, size, lo, hi, base);
  highp int area = lcArea(lo, hi);
  highp int n = q.y * frame.x + q.x;
  if (kind == ${LL_STEP.build}) {
    if (n >= base && n < base + 2 * area) ${LL_STEP_CALLS.build}
  } else if (n >= base + area && n < base + 2 * area) {
    ${LL_STEP_CALLS.assemble}
  }
}
`;

export const REGION_GLSL = "return lcRegion();";

// ── Bilateral grid ───────────────────────────────────────────────────────────

export const BL_STEP = { idle: 0, plan: 1, splatX: 2, splatY: 3, blurX: 4, blurY: 5, slice: 6, zero: 7 } as const;

export const BL_HELPERS = `${QUANTIZE_GLSL}${SHARED_GLSL}
// a / b correctly rounded, for positive normal floats: a GPU's division
// needn't be, and the grid's sizes come out of these at whole numbers.
float lcDiv(float a, float b) {
  uint ua = floatBitsToUint(a);
  uint ub = floatBitsToUint(b);
  int e = int(ua >> 23) - int(ub >> 23);
  uint ma = (ua & 0x7FFFFFu) | 0x800000u;
  uint mb = (ub & 0x7FFFFFu) | 0x800000u;
  if (ma < mb) {
    ma <<= 1;
    e -= 1;
  }
  uint quotient = 0u;
  for (int i = 0; i < 25; i++) {
    quotient <<= 1;
    if (ma >= mb) {
      ma -= mb;
      quotient |= 1u;
    }
    ma <<= 1;
  }
  uint guard = quotient & 1u;
  quotient >>= 1;
  if (guard == 1u && (ma != 0u || (quotient & 1u) == 1u)) quotient += 1u;
  if (quotient == 0x1000000u) {
    quotient >>= 1;
    e += 1;
  }
  return float(quotient) * lcPow2(e - 23);
}
// roundf() of a non-negative value.
int lcRound(float v) {
  float whole = floor(v);
  return int(whole) + (v - whole >= 0.5 ? 1 : 0);
}
// A float32 as three 11-bit pieces of its mantissa and its exponent, all of
// which a half float holds exactly, and back.
vec4 lcPack(float v) {
  if (v == 0.0) return vec4(0.0);
  uint bits = floatBitsToUint(v);
  uint m = (bits & 0x7FFFFFu) | 0x800000u;
  return vec4(float(m >> 13), float((m >> 2) & 0x7FFu), float(m & 3u), float(int(bits >> 23) - 150));
}
float lcUnpack(vec4 s) {
  return float(uint(s.x) * 8192u + uint(s.y) * 4u + uint(s.z)) * lcPow2(int(s.w));
}
// dt_bilateral_grid_size(): sigma_s, sigma_r and their inverses.
vec4 lcGridSigmas(ivec2 frame, float sigmaS, float sigmaR) {
  float s = sigmaS < 0.5 ? 0.5 : sigmaS;
  int gx = clamp(lcRound(lcDiv(float(frame.x), s)), 4, ${MAX_RES_S});
  int gy = clamp(lcRound(lcDiv(float(frame.y), s)), 4, ${MAX_RES_S});
  int gz = clamp(lcRound(lcDiv(100.0, sigmaR)), 4, ${MAX_RES_R});
  float grid = max(lcDiv(float(frame.y), float(gy)), lcDiv(float(frame.x), float(gx)));
  float range = lcDiv(100.0, float(gz));
  return vec4(grid, lcDiv(1.0, grid), range, lcDiv(1.0, range));
}
ivec3 lcGridSize(ivec2 frame, vec4 sigmas) {
  return ivec3(int(ceil(float(frame.x) * sigmas.y)) + 1, int(ceil(float(frame.y) * sigmas.y)) + 1, int(ceil(100.0 * sigmas.w)) + 1);
}
highp int lcGridTexels(ivec2 frame, ivec3 size) {
  int quads = (size.z + 3) / 4;
  return ${CONSTANT_TEXELS} + size.x * frame.y + size.x * size.y * quads;
}
// The pass's sigmas, widened while darktable's grid wouldn't fit the target
// (x of the result 0 when nothing fits).
vec4 lcPlan(ivec2 frame) {
  float longest = float(max(frame.x, frame.y));
  float source = max(uSourceSize.x, uSourceSize.y);
  float s = max(source <= longest ? coarseness : lcDiv(coarseness, lcDiv(source, longest)), 0.5);
  for (int k = 0; k < ${MAX_WIDEN_STEPS}; k++) {
    vec4 sigmas = lcGridSigmas(frame, s, contrast);
    if (lcGridTexels(frame, lcGridSize(frame, sigmas)) <= frame.x * frame.y) return sigmas;
    s *= ${lit(WIDEN)};
  }
  return vec4(0.0);
}
vec4 lcConstants() {
  return vec4(lcUnpack(fetchPrev4(ivec2(0, 0))), lcUnpack(fetchPrev4(ivec2(1, 0))), lcUnpack(fetchPrev4(ivec2(2, 0))), lcUnpack(fetchPrev4(ivec2(3, 0))));
}
int lcSpan(float sigmaS) { return int(floor(2.0 * sigmaS)) + 4; }
int lcChunks(float sigmaS) { return (lcSpan(sigmaS) + ${SPLAT_TAPS - 1}) / ${SPLAT_TAPS}; }
int lcSteps(ivec3 size, float sigmaS) { return ((size.z + 3) / 4) * (2 * lcChunks(sigmaS) + 1) + 2; }
// The step draw k runs. Draw 0 plans the grid into the constant texels; the
// schedule ends at the last draw: for each quad of bins its x-splat, blurred
// along x in place, then its y-splat; the grid's blur along y, in place; the
// slice. darktable blurs the whole splat along x, then y: the same sums, as
// both are linear and act on one axis each.
void lcStep(int k, ivec2 frame, vec4 sigmas, out int kind, out int quad, out int chunk) {
  kind = ${BL_STEP.idle};
  quad = 0;
  chunk = 0;
  if (k == 0) {
    kind = ${BL_STEP.plan};
    return;
  }
  ivec3 size = lcGridSize(frame, sigmas);
  int steps = lcSteps(size, sigmas.x);
  if (sigmas.x == 0.0 || uPassCount < steps + 1) {
    if (k == uPassCount - 1) kind = ${BL_STEP.zero};
    return;
  }
  int s = k - (uPassCount - steps);
  if (s < 0) return;
  int chunks = lcChunks(sigmas.x);
  int perQuad = 2 * chunks + 1;
  int splats = steps - 2;
  if (s < splats) {
    quad = s / perQuad;
    int j = s - quad * perQuad;
    kind = j < chunks ? ${BL_STEP.splatX} : (j == chunks ? ${BL_STEP.blurX} : ${BL_STEP.splatY});
    chunk = j < chunks ? j : j - chunks - 1;
  } else {
    kind = s == splats ? ${BL_STEP.blurY} : ${BL_STEP.slice};
  }
}
// The texels [from, to) a step writes.
void lcStepRange(int kind, int quad, ivec2 frame, ivec3 size, out highp int from, out highp int to) {
  highp int sx = ${CONSTANT_TEXELS};
  highp int nodes = size.x * size.y;
  highp int grid = sx + size.x * frame.y;
  from = 0;
  to = 0;
  if (kind == ${BL_STEP.plan}) to = ${CONSTANT_TEXELS};
  if (kind == ${BL_STEP.splatX} || kind == ${BL_STEP.blurX}) {
    from = sx;
    to = grid;
  }
  if (kind == ${BL_STEP.splatY}) {
    from = grid + quad * nodes;
    to = from + nodes;
  }
  if (kind == ${BL_STEP.blurY}) {
    from = grid;
    to = grid + nodes * ((size.z + 3) / 4);
  }
}
ivec4 lcRegion() {
  ivec2 frame = lcFrame();
  if (uPassIndex == 0) return ivec4(0, 0, frame);
  vec4 sigmas = lcConstants();
  int kind, quad, chunk;
  lcStep(uPassIndex, frame, sigmas, kind, quad, chunk);
  if (kind == ${BL_STEP.idle}) return ivec4(0);
  if (kind == ${BL_STEP.slice} || kind == ${BL_STEP.zero}) return ivec4(0, 0, frame);
  ivec3 size = lcGridSize(frame, sigmas);
  highp int from, to, before, after;
  lcStepRange(kind, quad, frame, size, from, to);
  int prevKind, prevQuad, prevChunk;
  lcStep(uPassIndex - 1, frame, sigmas, prevKind, prevQuad, prevChunk);
  lcStepRange(prevKind, prevQuad, frame, size, before, after);
  if (after > before) {
    from = min(from, before);
    to = max(to, after);
  }
  return lcRows(frame.x, from, to);
}
// darktable's tent: a coordinate's weight to a node, the coordinate clamped
// to the grid and its whole part to size - 2 (image_to_grid()).
float lcTent(float coord, float inv, int size, int node) {
  float x = clamp(coord * inv, 0.0, float(size - 1));
  int xi = min(int(x), size - 2);
  float xf = x - float(xi);
  return xi == node ? 1.0 - xf : (xi + 1 == node ? xf : 0.0);
}
int lcFirst(int node, float sigmaS) { return max(int(floor(float(node - 1) * sigmaS)) - 1, 0); }
// One chunk of a node's x-splat in one row: four z bins.
vec4 lcSplatX(ivec2 frame, vec4 sigmas, ivec3 size, highp int rel, int quad, int chunk) {
  int gx = int(rel - (rel / size.x) * size.x);
  int y = int(rel / size.x);
  int first = lcFirst(gx, sigmas.x) + chunk * ${SPLAT_TAPS};
  int span = lcSpan(sigmas.x) - chunk * ${SPLAT_TAPS};
  vec4 sum = vec4(0.0);
  for (int t = 0; t < ${SPLAT_TAPS}; t++) {
    int x = first + t;
    if (t < span && x < frame.x) {
      float w = lcTent(float(x), sigmas.y, size.x, gx);
      float z = clamp(lcLightness(fetchInput(ivec2(x, y))) * sigmas.w, 0.0, float(size.z - 1));
      int zi = min(int(z), size.z - 2);
      float zf = z - float(zi);
      sum += w * ((1.0 - zf) * lcOneHot(zi - 4 * quad) + zf * lcOneHot(zi + 1 - 4 * quad));
    }
  }
  return sum;
}
// One chunk of a node's y-splat of the x-splats.
vec4 lcSplatY(ivec2 frame, vec4 sigmas, ivec3 size, highp int rel, int chunk) {
  int gx = int(rel - (rel / size.x) * size.x);
  int gy = int(rel / size.x);
  int first = lcFirst(gy, sigmas.x) + chunk * ${SPLAT_TAPS};
  int span = lcSpan(sigmas.x) - chunk * ${SPLAT_TAPS};
  vec4 sum = vec4(0.0);
  for (int t = 0; t < ${SPLAT_TAPS}; t++) {
    int y = first + t;
    if (t < span && y < frame.y) {
      sum += lcTent(float(y), sigmas.y, size.y, gy) * lcFetch(${CONSTANT_TEXELS} + y * size.x + gx, frame.x);
    }
  }
  return sum;
}
float lcBlurWeight(int d) { return d == 0 ? 0.375 : (d == 1 || d == -1 ? 0.25 : 0.0625); }
// blur_line(): (1 4 6 4 1) / 16 along x (axis 0: a row of the x-splat) or y
// (a column of a quad of the grid), zero beyond the grid, read from the draw
// before and written in place.
vec4 lcBlur(ivec2 frame, ivec3 size, highp int from, highp int rel, int axis) {
  highp int nodes = size.x * size.y;
  highp int inQuad = rel - (rel / nodes) * nodes;
  int along = axis == 0 ? int(rel - (rel / size.x) * size.x) : int(inQuad / size.x);
  int count = axis == 0 ? size.x : size.y;
  highp int stride = axis == 0 ? 1 : size.x;
  vec4 sum = vec4(0.0);
  for (int d = -2; d <= 2; d++) {
    if (along + d >= 0 && along + d < count) sum += lcBlurWeight(d) * lcFetch(from + rel + d * stride, frame.x);
  }
  return sum;
}
// A grid node's six bins from zi - 2 on, as two vectors (x, y, z of the
// second unused past bin zi + 3), zero outside the grid.
void lcBins6(ivec2 frame, highp int grid, ivec3 size, int gx, int gy, int zi, out vec4 low, out vec2 high) {
  int quads = (size.z + 3) / 4;
  int q0 = (zi + 2) / 4 - 1;
  int o = zi - 2 - 4 * q0;
  highp int node = gy * size.x + gx;
  highp int nodes = size.x * size.y;
  vec4 v0 = q0 >= 0 ? lcFetch(grid + q0 * nodes + node, frame.x) : vec4(0.0);
  vec4 v1 = q0 + 1 < quads ? lcFetch(grid + (q0 + 1) * nodes + node, frame.x) : vec4(0.0);
  vec4 v2 = q0 + 2 < quads ? lcFetch(grid + (q0 + 2) * nodes + node, frame.x) : vec4(0.0);
  vec4 b = vec4(0.0);
  vec2 c2 = vec2(0.0);
  for (int d = 0; d < 6; d++) {
    int i = o + d;
    float v = dot(v0, lcOneHot(i)) + dot(v1, lcOneHot(i - 4)) + dot(v2, lcOneHot(i - 8));
    if (d < 4) b += v * lcOneHot(d);
    else c2 += v * lcOneHot(d - 4).xy;
  }
  low = b;
  high = c2;
}
// dt_bilateral_slice(): the z derivative of the blurred grid, trilinear.
vec4 lcSlice(ivec2 frame, vec4 sigmas, ivec3 size, ivec2 q) {
  highp int grid = ${CONSTANT_TEXELS} + size.x * frame.y;
  float L = lcLightness(fetchInput(q));
  float xs = clamp(float(q.x) * sigmas.y, 0.0, float(size.x - 1));
  float ys = clamp(float(q.y) * sigmas.y, 0.0, float(size.y - 1));
  float zs = clamp(L * sigmas.w, 0.0, float(size.z - 1));
  int xi = min(int(xs), size.x - 2);
  int yi = min(int(ys), size.y - 2);
  int zi = min(int(zs), size.z - 2);
  float xf = xs - float(xi);
  float yf = ys - float(yi);
  float zf = zs - float(zi);
  float sum = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec4 low;
      vec2 high;
      lcBins6(frame, grid, size, xi + i, yi + j, zi, low, high);
      float d0 = 0.25 * (low.w - low.y) + 0.125 * (high.x - low.x);
      float d1 = 0.25 * (high.x - low.z) + 0.125 * (high.y - low.y);
      float w = (i == 1 ? xf : 1.0 - xf) * (j == 1 ? yf : 1.0 - yf);
      sum += w * ((1.0 - zf) * d0 + zf * d1);
    }
  }
  float norm = -detail * sigmas.z * 0.04;
  return lcResult(norm * (100.0 / (sigmas.x * sigmas.x)) * sum * 0.01, 0.0, 0.0);
}
`;

/** One call site each; a draw runs one of them. */
export const BL_STEP_CALLS = {
  plan: "c = lcPack(dot(lcPlan(frame), lcOneHot(q.x)));",
  splatX: "c = lcHalf4((chunk == 0 ? vec4(0.0) : c) + lcSplatX(frame, sigmas, size, n - from, quad, chunk));",
  splatY: "c = lcHalf4((chunk == 0 ? vec4(0.0) : c) + lcSplatY(frame, sigmas, size, n - from, chunk));",
  blurX: "c = lcHalf4(lcBlur(frame, size, from, n - from, 0));",
  blurY: "c = lcHalf4(lcBlur(frame, size, from, n - from, 1));",
  slice: "c = lcSlice(frame, sigmas, size, q);",
} as const;

export const BL_GLSL = `
ivec2 frame = lcFrame();
ivec2 q = ivec2(gl_FragCoord.xy);
if (uPassIndex == 0) {
  if (q.y == 0 && q.x < ${CONSTANT_TEXELS}) ${BL_STEP_CALLS.plan}
} else {
  vec4 sigmas = lcConstants();
  int kind, quad, chunk;
  lcStep(uPassIndex, frame, sigmas, kind, quad, chunk);
  ivec3 size = lcGridSize(frame, sigmas);
  if (kind == ${BL_STEP.zero}) {
    c = vec4(0.0, 0.0, 0.0, 1.0);
  } else if (kind == ${BL_STEP.slice}) {
    ${BL_STEP_CALLS.slice}
  } else if (kind != ${BL_STEP.idle}) {
    highp int from, to;
    lcStepRange(kind, quad, frame, size, from, to);
    highp int n = q.y * frame.x + q.x;
    if (n >= from && n < to) {
      if (kind == ${BL_STEP.splatX}) {
        ${BL_STEP_CALLS.splatX}
      } else if (kind == ${BL_STEP.splatY}) {
        ${BL_STEP_CALLS.splatY}
      } else if (kind == ${BL_STEP.blurX}) {
        ${BL_STEP_CALLS.blurX}
      } else {
        ${BL_STEP_CALLS.blurY}
      }
    }
  }
}
`;
