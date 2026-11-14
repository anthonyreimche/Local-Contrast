// A deterministic linear Rec.709 test scene: a lit gradient, a dark disc, a
// bright window with hard edges, fine texture and two coloured blobs, from
// about 0.002 to 1.6. The GPU spec renders the same one.

/** A deterministic hash in [0, 1). */
function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function scenePixel(x: number, y: number, w: number, h: number): [number, number, number] {
  const u = x / w;
  const v = y / h;
  let base = 0.02 + 0.45 * u * (1 - 0.5 * v);
  if ((u - 0.25) ** 2 + (v - 0.6) ** 2 < 0.02) base *= 0.08;
  if (u > 0.62 && u < 0.88 && v > 0.15 && v < 0.45) base = 1.6;
  const texture = 1 + 0.3 * (hash(x, y) - 0.5) + 0.15 * Math.sin(x * 0.9) * Math.sin(y * 0.7);
  const tint: [number, number, number] =
    (u - 0.78) ** 2 + (v - 0.75) ** 2 < 0.01 ? [1.2, 0.7, 0.4] : (u - 0.47) ** 2 + (v - 0.2) ** 2 < 0.008 ? [0.5, 0.8, 1.3] : [1, 1, 1];
  return tint.map((t) => Math.max(base * texture * t, 0.002)) as [number, number, number];
}

export function sceneRGB(w: number, h: number): Float32Array {
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(scenePixel(x, y, w, h), 3 * (y * w + x));
  return data;
}
