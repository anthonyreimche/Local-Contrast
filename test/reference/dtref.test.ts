// The CPU transcription the GPU spec compares against, held to darktable's own
// output: darktable.json is the nightly's local contrast on a 96 × 64 scene in
// both modes (see its `about`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, darktableParams, type Params } from "../../src/model";
import { localContrast, rgbToLab } from "./dtref";

interface Fixture {
  width: number;
  height: number;
  input: string;
  cases: { name: string; params: Partial<Params>; output: string }[];
}

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "darktable.json"), "utf8")) as Fixture;

const floats = (b64: string) => {
  const bytes = Buffer.from(b64, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

const input = { width: fixture.width, height: fixture.height, data: floats(fixture.input) };

/** The largest Lab difference of two linear Rec.709 images, per component. */
function labDistance(a: Float32Array, b: Float32Array): { L: number; ab: number } {
  let L = 0;
  let ab = 0;
  for (let k = 0; k < a.length / 3; k++) {
    const p = rgbToLab(a[3 * k], a[3 * k + 1], a[3 * k + 2]);
    const q = rgbToLab(b[3 * k], b[3 * k + 1], b[3 * k + 2]);
    L = Math.max(L, Math.abs(p[0] - q[0]));
    ab = Math.max(ab, Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
  }
  return { L, ab };
}

describe("the transcription", () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))("renders darktable's output: %s", (_name, c) => {
    const want = floats(c.output);
    const got = localContrast(input, darktableParams({ ...DEFAULT_PARAMS, ...c.params, on: true })).out.data;
    expect(labDistance(want, input.data).L, "darktable changed the scene").toBeGreaterThan(1);
    const d = labDistance(got, want);
    // L* to float rounding; a* and b* through darktable's own working-profile
    // matrix, about 3e-5 from the one used here, which a large change of L*
    // turns into about 1e-2.
    expect(d.L).toBeLessThan(1e-3);
    expect(d.ab).toBeLessThan(2e-2);
  });
});
