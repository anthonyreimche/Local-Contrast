# Local Contrast: specification

A port of darktable's *local contrast* module (`src/iop/bilat.c`, with
`src/common/locallaplacian.c` and `src/common/bilateral.c`; master
7d7dac363d, GPL-3.0-or-later, © the darktable developers) to a Safelight
processing stage, for SafeLight issue #233. The sources read are in the core
checkout's `.claude/cycle/ext-reference/upstream-dt-master-bilat/`.

Fidelity bar: the same numbers as darktable, to float rounding, in both modes,
with darktable's own scaling of every parameter. The CPU transcription
(`test/reference/dtref.ts`) is held to darktable nightly's output
(`test/reference/darktable.json`), the passes' arithmetic
(`test/reference/gpumodel.ts`) to the transcription, and the shader to the
transcription on the real renderer (`test/gpu`). §7 has the figures.

## 1. What the module does

darktable's local contrast changes the Lab lightness L* only; a* and b* are
copied through. It has two modes (`dt_iop_bilat_params_t` v3):

| field     | local laplacian (mode 1, the default) | bilateral grid (mode 0) |
|-----------|----------------------------------------|-------------------------|
| `detail`  | detail, −1 … 4, default 0.25 (shown +100 %: 125 %) | detail, the same field |
| `sigma_r` | highlights, 0 … 2, default 0.5 (50 %)  | contrast, 1 … 100, default 20 |
| `sigma_s` | shadows, 0 … 2, default 0.5 (50 %)     | coarseness, 3 … 100, default 50 |
| `midtone` | midtone range, 0.001 … 1, default 0.5  | (unused) |

darktable stores one `sigma_r`/`sigma_s` pair for both modes; its GUI keeps a
slider per meaning and copies the visible pair into the params when the mode
changes. The extension stores the five values separately (`highlights`,
`shadows`, `coarseness`, `contrast`, `midtone`) plus `detail` and `mode`, so a
mode switch restores that mode's sliders as darktable's GUI does within a
session, and packs darktable's struct from the visible pair when needed (the
reference rig does).

Presets (`init_presets`): *clarity* (local laplacian, detail 0.33, highlights
0, shadows 0, midtone 0.5) and *HDR local tone-mapping* (detail 1, highlights
0, shadows 0, midtone 0.25). The panel offers both.

### 1.1 Local laplacian (`local_laplacian_internal`, b = 0)

All on `p = L* / 100`:

1. `num_levels = min(30, floor(log2(min(W, H))))`, `last = num_levels − 1`,
   padding `S = 2^last` on every side by edge replication, padded size
   `w = W + 2S`, `h = H + 2S`. Level sizes `dl(n, l)`: `n → (n − 1) / 2 + 1`,
   l times.
2. Gaussian pyramid of the padded input: `gauss_reduce` is the 5 × 5 B3
   kernel (1 4 6 4 1)² / 256 at the even fine texel `2X`, computed for
   `1 ≤ X ≤ cw − 2` and copied out to the one-texel border. Levels
   `1 … last − 1` are kept as `padded[l]`; level `last` is written straight
   into `output[last]`.
3. Six remapped copies of level 0, one per `γk = (k + 0.5) / 6`, through
   `curve_scalar(x, γ, σ = midtone, shadows, highlights, clarity = detail)`:
   with `c = x − γ`, a linear part beyond `|c| > 2σ` (slope `shadows` above,
   `highlights` below), a quadratic Bézier inside, plus
   `clarity · c · dt_fast_expf(−c² / (2σ²/3))`. `dt_fast_expf` is darktable's
   bit-trick exponential (`(int)(0x3f800000 + x · 0xADF854)` read as a float,
   0 when not positive), ported exactly: it is what darktable computes.
   Each copy gets its own Gaussian pyramid, levels `0 … last`.
4. Coarse to fine, `output[l] = expand(output[l + 1]) + (1 − a) L_lo + a L_hi`,
   where `v = padded[l]` at the texel picks the two copies whose γ bracket it
   (`hi` the first γ above `v`, between 1 and 5), `a = clamp((v − γlo) /
   (γhi − γlo), 0, 1)`, and `L_k = buf_k[l] − expand(buf_k[l + 1])` is copy k's
   Laplacian. `expand` is the 4 × upsampling stencil (`ll_expand_gaussian`,
   by the parity of the texel), evaluated at the texel clamped to
   `[1, ((n − 1) & ~1) − 1]` along each axis, which is what
   `ll_fill_boundary2` gives the expanded level.
5. `L*out = 100 · output[0]` inside the padding; a* and b* copied.

No parameter depends on the zoom or the image size: the pyramid always runs
down to a few texels, so the filter works on every octave of whatever image it
is given. A smaller render has one octave fewer at the fine end, as darktable's
preview does. darktable master's pixelpipe passes no boundary (`b = 0`): its
darkroom processes the visible region alone, replicated at the region's edge.
Safelight's passes always see the whole photo, so a zoomed view has no such
seam; that is the one place the two can differ at the same pixels.

### 1.2 Bilateral grid (`dt_bilateral_*`)

1. `scale = max(iscale / roi_in->scale, 1)`: how many full-resolution pixels
   one pixel of the processed image covers. `σs = coarseness / scale`;
   `σr = contrast` is not scaled.
2. `dt_bilateral_grid_size(W, H, 100, σs, σr)`: σs at least 0.5;
   `_x = clamp(round(W / σs), 4, 3000)`, `_y` likewise,
   `_z = clamp(round(100 / σr), 4, 50)`; the grid's own
   `σs' = max(H / _y, W / _x)`, `σr' = 100 / _z`; sizes
   `ceil(W / σs') + 1`, `ceil(H / σs') + 1`, `ceil(100 / σr') + 1`, all in
   float32 arithmetic.
3. Splat: every pixel adds `(100 / σs'²)` times its trilinear (tent) weights
   to the eight grid nodes around `(x / σs', y / σs', L* / σr')`, each
   coordinate clamped to the grid and its integer part to `size − 2`.
4. Blur: (1 4 6 4 1)/16 along x, then y, zero beyond the grid; then along z
   the derivative kernel (−2 −4 0 4 2)/16, zero beyond the grid.
5. Slice: `L*out = max(0, L* + norm · trilinear(grid))` with
   `norm = −detail · σr' · 0.04`.

## 2. Placement in Safelight's pipeline

- **Phase `display-adjust`, priority 90**, `space: { encoding: "linear",
  primaries: "rec709" }`, `reads: "current"`. darktable's scene-referred order
  (v5.0) runs *bilat* at 54, after filmic/sigmoid (45–46) and the tone and
  levels curves, before colour correction (55), velvia/vibrance and colour
  zones (60): on display-referred data. Safelight's equivalent is after the
  display transform and the display tools, ahead of the display-phase colour
  tools at the default priority 100 (Colour Correction, Colour Zones).
- **Colour space.** The stage converts its linear Rec.709 input to XYZ (D50,
  Bradford-adapted sRGB primaries, darktable's matrices) and to Lab with
  darktable's `dt_XYZ_to_Lab` (D50 white 0.9642, 1, 0.8249; ε = 216/24389,
  κ = 24389/27). The passes need only L*. The inline moves the pixel's L* by
  the passes' result and keeps a* and b*: `fx`, `fy`, `fz` all move by
  ΔL*/116, and the pixel goes back through `dt_Lab_to_XYZ` and the inverse
  matrix. The working-space choice is irrelevant to a Lab module.
- **Masks:** the stage is maskable (`mask: { maskable: true }`), so a mask's
  copy runs its own passes with the mask's values.
- **Off state.** darktable's defaults are not an identity (detail 25 %,
  highlights and shadows 50 %), so the module has a switch, `on`, off by
  default, as darktable's module power button. While off the draw counts are 0
  and the stage is dormant (`dormantWhen: { llDraws: 0, blDraws: 0 }`): an
  untouched photo compiles and draws nothing.

## 3. GPU mapping

Safelight's passes ping-pong two full-size RGBA16F targets at the pass size
W × H; there is no lower-resolution target, so every intermediate lives in
the same W × H × 4 half floats. Each pass is a schedule of draws, each draw a
step decoded from `uPassIndex`; idle draws come first and change nothing. A
draw's `region` covers what it and the draw before it write, so most draws
touch a small part of the target. The pass reads its input with `fetchInput`
(the stage's input, exact, on any draw) and the previous draw with
`fetchPrev4`; no `texture()` and no arrays (the D3D11 rules in
`docs/dev/api/contributions.md`).

### 3.1 Local laplacian: one pass, `llDraws` draws

**Storage.** Intermediate levels `1 … last` live in an *atlas* addressed
linearly: texel `n` is `(n mod W, n div W)`. Each level keeps two planes of
four values over a *window* of the padded level:

- plane A: `P`, `r0`, `r1`, `r2`
- plane B: `P` (later `D`), `r3`, `r4`, `r5`

`P[l]` is the padded Gaussian, quantized to 11 significant bits so that the
half-float target stores it exactly. `e_k[l] = buf_k[l] − P_true[l]` is copy k's
pyramid less the input's (`reduce` is linear, so `e_k[l + 1] = reduce(e_k[l])`),
and it is stored as the residual `r_k = e_k − E_k(P)`, `E_k(v) = curve_k(v) − v`:
the difference between the Gaussian of the remapped image and the remapped
Gaussian, small where the image is smooth, so half floats keep it to about
10⁻⁵. The reader rebuilds `e_k = r_k + E_k(P)` from the same quantized `P`, so
the split costs no precision. `D[l] = output[l] − P[l]` replaces `output`:
with `Σ weights = 1`,

`D[l] = expand(D[l + 1]) + Σk wk (e_k[l] − expand(e_k[l + 1]))`, `D[last] = 0`,

which is darktable's recursion, rearranged, and keeps a small number in half
floats where `output` would be about 0.5. `D[l]` overwrites plane B's copy of
`P` once level l is assembled; nothing reads that copy afterwards.

**Windows.** In the padding the input is constant along rows and columns, and
the reduce keeps that exactly: if positions `0 … a` of level l hold one value,
positions `1 … floor((a − 2) / 2)` of level l + 1 do too (the same arithmetic on
the same inputs), and position 0 copies position 1. So each level is stored
only over `[lo_l, hi_l]` per axis (`lo_0 = S`, `hi_0 = S + W − 1`,
`lo_{l+1} = floor((lo_l − 2)/2)`, `hi_{l+1} = ceil((hi_l + 2)/2)`, clipped to
the level), and every read clamps into the window, which gives darktable's
padded values exactly. Windows are the image's extent at that level plus two
or three texels a side; the atlas takes about `2/3 W·H` texels, under the
`W·H` the target holds for any frame from about 64 px on its short side.
`D`, which isn't constant in the padding, is only wrong at a window's outer
texel, and the expand reads that texel only for padding texels of the next
level down, never for the image.

**Draws** (`2 · last`, 20 at 4096 × 2731, at most 28 for a short side under
65536):

1. *Level 1* (1 draw): each window texel of both planes reduces 25 input
   texels (`fetchInput`, L* per texel) to `P` and its three `e_k`, then writes
   `P` quantized and `r_k = e_k − E_k(P)`. 25 fetches. Every value a draw
   stores is first rounded to the nearest half float in the shader (`lcHalf`):
   a GPU's own float32 → half conversion needn't round to nearest (on the
   D3D11 test machine it didn't, and the error grew several times).
2. *Levels 2 … last* (one draw each): each texel reduces 25 texels of its own
   plane one level up, rebuilding `e_k` from `r_k` and `P`. 25 fetches.
3. *Assembly, levels last − 1 … 1* (one draw each): plane B texels. Own texel
   in both planes (2), the expand stencil's 3 × 3 coarse texels in both
   planes (18): `v = P`, the bracketing pair, their `e` at both levels, and
   `D[l + 1]`. Writes `D[l]`. 20 fetches.
4. *Level 0* (1 draw, the whole frame): `v` and `e_k` from the pixel's own
   input texel, the level-1 stencil as above. 19 fetches. The pass's input is
   a half-float copy of the image, while the inline holds the pixel at full
   precision, and `D[0]` depends on `v` directly through the pair of curves.
   So the draw hands the inline a line in `v`: `D[0]` at `v` and its slope
   with the pair held (a central difference over 2⁻⁹), as the line's value at
   0 (a half float and what it leaves, about 22 bits) and the slope (a half
   float), quantized before the intercept is taken, so the inline rebuilds
   `D[0]` exactly at the pass's `v` and follows it to its own.

`llDraws` is sized for the largest frame (28): a frame that needs fewer starts
its schedule later. A frame whose atlas wouldn't fit draws nothing (D = 0):
only frames under about 64 px on the short side.

### 3.2 Bilateral grid: one pass, `blDraws` draws

The grid is darktable's: its sizes come out of float32 divisions at whole
numbers, where a GPU's `/` (not correctly rounded) would land on the other
side, so the shader divides by long division on the mantissas (`lcDiv`). That
is a few hundred integer operations, so the pass's first draw works the grid
out once into four constant texels (σs', 1/σs', σr', 1/σr', each as three
11-bit pieces of its mantissa and its exponent, which half floats hold
exactly), and every later draw reads them. The splat is a sum of separable
tent weights, so it is gathered instead of scattered:

`S(gx, gy, gz) = Σy T(y/σs' − gy) · Sx(gx, y, gz)`, `Sx(gx, y, gz) = Σx T(x/σs' − gx) · T(L*/σr' − gz)`

with T the tent and every coordinate clamped as darktable clamps it. A texel
holds four z-bins. The blurs along x and y are linear and act on one axis
each, so they commute with the other axis's splat: the x-blur runs on `Sx`
in place (a draw reads the draw before it), and the y-blur on the grid in
place. Storage, linear as above after the constants: `Sx` for one quad of bins
(`size_x × H`) and the grid `S` (`size_x × size_y × nq`, nq = ⌈size_z / 4⌉).
Draws:

1. The plan (draw 0): the constants.
2. For each quad of bins: `Sx` in chunks of 24 input texels per draw (a node's
   tent spans at most `⌊2σs'⌋ + 4` pixels with a pixel of slack each side), its
   x-blur (5 fetches), then the quad of `S` in chunks of 24 `Sx` texels.
3. The y-blur of `S` (5 fetches).
4. Slice (the whole frame): the four xy corners and the z-bins `zi − 2 … zi + 3`
   the derivative kernel needs (12 fetches), then
   `ΔL* = norm · (100 / σs'²) · trilinear`, handed on as a flat line (§3.3).

`blDraws = 1 + nq · (2c + 1) + 2` with `c = ⌈(⌊2σ⌋ + 4) / 24⌉` at
`σ = max(1.25 · coarseness, 24)`: enough for any pass of 64 px and up, since
the pass's σs' never exceeds the coarseness but through the grid's rounding to
whole cells (up to an eighth), its 3000-cell cap and the clamp below
(`test/model.test.ts` sweeps sizes and settings). At the defaults that is 29
draws; Develop at 4096 px of a 6000 px photo needs 17, a 4096 px photo 25.
Every value stored is rounded to a half float in the shader first, as in §3.1.

**A memory clamp of our own.** darktable's grid is `W/σs' × H/σs' × size_z`
floats, which for a fine coarseness at a small render outgrows the target.
When `Sx + S` won't fit in `W · H` texels, the shader widens σs (×1.25 a step,
from at least 0.5) until it does, in the spirit of darktable's own 3000-cell
clamp. That takes about `1/σs' + nq/σs'² ≤ 1`: σs' ≥ 2 pass pixels at the
default contrast (nq 2), 3 at contrast 5, 4.2 at contrast 1. At
full-resolution export and the minimum coarseness of 3 it happens only for a
contrast below about 5.

### 3.3 The inline

`if (llDraws > 0 || blDraws > 0)`: L* of the pixel moved by
`100 · (x + y + z · L*/100)` of `stageResult` (bilateral: then `max(0, …)`,
z being 0), a* and b* kept.

### 3.4 Cost per draw

Every draw reads at most 29 texels per pixel, its own included (static
analysis in `test/stage.test.ts`): the local laplacian's builds 25 + 1, its
assembly and final draw 20, the bilateral grid's splats 24 + 4 constants + 1.
Most draws cover a small region of the target.

Measured on an RTX 4070 Ti (ANGLE D3D11) at 4096 × 2731, one slider change:
the local laplacian adds about 7 ms to the frame (20 draws), the bilateral
grid about 3 ms (25 draws at coarseness 50, 9 at 8). The idle draws ahead of
a schedule cost about 0.5 ms.

## 4. Precision

darktable works in float32 throughout. The pass stores half floats; the design
keeps every stored quantity small or exact: `P` exact by construction, `r_k`
and `D` small, `S` summed in float32 within a draw, the result about 22 bits.
What's left: P's quantization moves the blend of a coarse texel's two curves
by up to about 7·10⁻⁴, and `D` loses a half float's precision a level. With
float32 storage and P unquantized the model matches the transcription to
2·10⁻⁴ L* (the atlas and its windows are exact); as the GPU stores it, to
0.02 L* at the 99th percentile and 0.03 at worst.

## 5. Not ported

- darktable's OpenCL kernels: the CPU path is the reference (`--disable-opencl`
  in the rig); the CL local laplacian pads to the device's alignment and
  differs from the CPU at the far edges.
- The preview-buffer boundary (`local_laplacian_boundary_t` modes 1 and 2):
  dead code in master (`process()` passes 0).
- Tiling: Safelight renders the whole frame.
- darktable's multi-threaded splat partitioning: the sums are the same, in
  another order.

## 6. How it differs from the neighbours

- **Pyramid Local Contrast** (MIT, clean-room): eight undecimated à trous
  scales of log luminance with an edge-aware weight, one gain per scale, a
  chroma-preserving multiplier on linear RGB, scene-linear. No remapping
  curve, no tonal compression.
- **Contrast and Texture** (darktable master's `contrastntexture`): a cascade
  of exposure-independent guided filters on the scene-linear RGB norm in
  Rec. 2020, three band gains plus shadows/highlights slopes, multiplicative.
- **Contrast Equalizer** (darktable's `atrous`): edge-aware wavelet bands with
  a gain and a threshold curve per band, luma and chroma, scene-linear.
- **Local Contrast** (this): darktable's display-referred Lab module. The local
  laplacian remaps L* around six reference levels with one curve (detail,
  highlights, shadows, midtone range) and rebuilds it from the remapped
  copies' Laplacians, which boosts or compresses detail by its *amplitude*
  rather than its scale; the bilateral grid is the older, faster unsharp-style
  boost of L* against an edge-aware blur.

## 7. Fidelity

- **Transcription vs darktable nightly** (96 × 64 fixture, 7 cases over both
  modes): L* within 5·10⁻⁴; a* and b* within 0.012 (darktable's
  working-profile matrix against the one used here).
- **Shader vs transcription**, 320 × 200 on SwiftShader: local laplacian L*
  p99 ≤ 0.015, max ≤ 0.035; bilateral grid p99 ≤ 0.005, max ≤ 0.008. On the
  RTX 4070 Ti (D3D11) at 1024 × 683: local laplacian p99 ≤ 0.028, max ≤ 0.064
  (the HDR preset; the defaults 0.006 / 0.013); bilateral p99 0.006.
- **Safelight vs darktable nightly** (rig `python run.py localcontrast`,
  256 × 192 chart, 12 cases): patch ΔE00 ≤ 0.013, pixel ΔE00 p99 ≤ 0.01, max
  ≤ 0.02; mean ≤ 0.001 EV in every region. A 13th case outgrows the target on
  purpose (coarseness 3, contrast 5 at 256 px) and is widened: patch ΔE00
  0.06, pixel p99 0.10.
- **Photo** (`modules/localcontrast/photo.py --edge 1536`, 6 cases): pixel
  ΔE00 p99 ≤ 0.014, max ≤ 0.04; L* p99 ≤ 0.019, max ≤ 0.05; |log2| p99 ≤
  0.0045 EV.
