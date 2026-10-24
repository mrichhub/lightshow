import type { Effect } from '@lightshow/models';
export type RenderEffect = (pixels: Uint8Array, timeMs: number) => void;
export function colorRGB(hex = '#ffffff'): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
function hash(n: number) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
export function compileEffect(effect: Effect): RenderEffect {
  const color = colorRGB(effect.params.color),
    other = colorRGB(effect.params.color2 ?? '#000000');
  const duration = effect.params.durationMs ?? 2000;
  const min = effect.params.minBrightness ?? 0.1,
    max = effect.params.maxBrightness ?? 1,
    width = effect.params.width ?? 5,
    seed = effect.params.seed ?? 1;
  return (pixels, time) => {
    const phase = (((time % duration) + duration) % duration) / duration,
      count = pixels.length / 3;
    for (let i = 0; i < count; i++) {
      let r = color[0],
        g = color[1],
        b = color[2],
        brightness = max;
      if (effect.type === 'pulse')
        brightness = min + ((max - min) * (1 - Math.cos(phase * Math.PI * 2))) / 2;
      if (effect.type === 'fade') {
        const k = (1 - Math.cos(phase * Math.PI * 2)) / 2;
        r = r * (1 - k) + other[0] * k;
        g = g * (1 - k) + other[1] * k;
        b = b * (1 - k) + other[2] * k;
      }
      if (effect.type === 'chase')
        brightness = (i - Math.floor(phase * count) + count) % count < width ? max : min;
      if (effect.type === 'flicker')
        brightness = min + (max - min) * hash(seed + i + Math.floor(time / 60) * 131);
      if (effect.type === 'rainbow') {
        const h = ((i / count + phase) % 1) * 6,
          x = 255 * (1 - Math.abs((h % 2) - 1));
        r = h < 1 || h >= 5 ? 255 : h < 2 || h >= 4 ? x : 0;
        g = h < 1 ? x : h < 3 ? 255 : h < 4 ? x : 0;
        b = h < 2 ? 0 : h < 3 ? x : h < 5 ? 255 : x;
      }
      pixels[i * 3] = byte(r * brightness);
      pixels[i * 3 + 1] = byte(g * brightness);
      pixels[i * 3 + 2] = byte(b * brightness);
    }
  };
}
