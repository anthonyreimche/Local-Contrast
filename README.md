# Local Contrast for Safelight

A [Safelight](https://github.com/anthonyreimche/SafeLight) extension that ports
[**darktable**](https://www.darktable.org/)'s *local contrast* module: more or
less local contrast and tonal compression on the lightness L\*, with colour
left as it was. It has the module's two filters: a **local laplacian** (the
default), which works on detail of every size and keeps edges free of halos,
and the older, faster **bilateral grid**.

## The controls

- **Enabled**: the module's switch. Off by default: darktable's defaults
  already change the photo (detail 125 %, highlights and shadows 50 %).
- **Local laplacian** / **Bilateral grid**: the filter. Each keeps its own
  sliders, so switching back and forth restores them.
- **Detail** (0 % to 500 %, default 125 %): 100 % leaves the photo alone,
  higher boosts local contrast, lower smooths it, down to a flat 0 %.
- Local laplacian:
  - **Highlights** and **Shadows** (0 % to 200 %, default 50 %): the contrast
    of tones far brighter or darker than their surroundings. Below 100 % they
    are compressed, which gives the HDR look; 100 % leaves them.
  - **Midtone range** (0.001 to 1, default 0.5): what counts as midtones. Lower
    compresses more of the tonal range (stronger dynamic range compression);
    higher gives detail a stronger boost.
- Bilateral grid:
  - **Coarseness** (3 to 100 px, default 50): the size of the detail it
    works on, in pixels of the full photo.
  - **Contrast** (1 to 100, default 20): the L\* difference that counts as an
    edge.
- **Presets**: *Clarity* and *HDR local tone mapping*, the module's own.

**In masks:** add Local Contrast to a mask from the Masking panel's Adjust tab
to apply it inside that mask only.

## The math

Faithful to `src/iop/bilat.c` (params version 3) with
`src/common/locallaplacian.c` and `src/common/bilateral.c` at darktable master
7d7dac363d; the module is the same in darktable 5.6. It converts the image to
Lab, filters L\* and keeps a\* and b\*.

- **Local laplacian:** six copies of L\* go through a remapping curve, one
  for each of six reference levels: detail near the level is boosted or cut
  by **Detail** inside the **Midtone range**, and tones beyond it are scaled
  by **Highlights** and **Shadows**. The output is rebuilt from a Laplacian
  pyramid in which each texel takes the detail of the two copies whose levels
  bracket its own brightness. The pyramid runs down to a few pixels, padded
  by replication, so every octave of the photo is treated the same.
- **Bilateral grid:** L\* is splatted into a grid over space and L\*, blurred,
  and the grid's slope along L\* is added back, scaled by **Detail**.
  **Coarseness** follows the render size, as darktable scales it with its
  zoom.

### How it maps onto Safelight

darktable runs the module on display-referred data, after its tone mapper
and tone curves and before its colour modules, so the stage sits after
Safelight's display tools, ahead of the display phase's colour tools, in
linear Rec.709. It reads the image as edited up to it.

Each filter is a GPU pass of 4-channel draws (Safelight 3.2.3) that keeps its
intermediates in the pass's own target. The local laplacian keeps a window of
each pyramid level, the part that isn't constant padding, as differences
small enough for half floats; the bilateral grid is gathered rather than
splatted. No draw reads more than 30 texels per pixel, and each draws only
the part of the target it changes. `docs/SPEC.md` has the details.

Differences from darktable to be aware of:

- The passes store half floats: L\* lands within a few hundredths of
  darktable's (see below), where darktable's float32 is exact.
- Zoomed in, darktable's darkroom filters only the visible part, replicated
  at its edges; Safelight always filters the whole photo, so there is no seam.
- Where darktable's bilateral grid would outgrow the GPU target (a
  coarseness of a few pixels at a small render, together with a low
  contrast), the grid is made coarser until it fits. At full size and
  Safelight's default render size this needs a coarseness of about 3 px or
  less.
- A frame under about 64 pixels on its short side (a tiny thumbnail) is left
  unchanged.
- Every slider change reruns the pass, as does any edit before it in the
  pipeline. At Safelight's default 4096-pixel render the local laplacian is
  20 draws and the bilateral grid 17 to 25; on an RTX 4070 Ti a change costs
  about 7 ms and 3 ms. A slow GPU takes several times as long.
- Needs float render targets, as most GPUs have.

### Tests

```bash
npm install
npm run check      # typecheck, build, then the unit tests
npm run test:gpu   # the stage on Safelight's real renderer (needs a SafeLight checkout)
```

The unit tests hold `test/reference/dtref.ts`, a float32 transcription of the
module, to the darktable nightly's own output (`test/reference/darktable.json`,
L\* within 10⁻³), and `test/reference/gpumodel.ts`, the passes' arithmetic in
TypeScript, to that transcription (within 2·10⁻⁴ L\* with float32 storage).
They also pin the schedule, each draw's texel reads, the stage's contract and
the panel. The GPU spec renders a 320 × 200 scene through the real renderer
and compares it with the transcription.

Against darktable itself (5.7.0+1894 nightly, `darktable-cli`), on the
reference rig's 256 × 192 chart (12 cases over both filters, the presets and
the sliders' ranges): ΔE2000 at most 0.013 on the patches, 0.01 at the 99th
percentile of pixels and 0.02 at the worst, mean difference at most 0.001 EV
over every region. On a 1536 × 1024 photo (6 cases): ΔE2000 within 0.014 at
the 99th percentile and 0.04 at the worst pixel, L\* within 0.019 and 0.05.

## Licence

GPL-3.0-or-later, as the darktable code it ports.
