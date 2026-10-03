// Just enough colour maths to map a theme safely: parse CSS colours, measure contrast, mix.
export type Rgb = [number, number, number];  // 0..255

const clamp255 = (x: number) => Math.max(0, Math.min(255, x));
const toSrgb = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const toLinear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

function oklch(L: number, C: number, H: number): Rgb {
  const h = (H * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => clamp255(toSrgb(c))) as Rgb;
}

function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((c) => clamp255(c * 255)) as Rgb;
}

/** A hue in degrees, from deg, turn or rad. */
const hue = (s: string) => (s.endsWith("turn") ? parseFloat(s) * 360 : s.endsWith("rad") ? (parseFloat(s) * 180) / Math.PI : parseFloat(s));
const num = (s: string, scale = 1) => (s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s));

/** Hex, rgb(), hsl(), oklch(), or a bare "L C H" triplet as shadcn themes write OKLCH. Null if it can't tell. */
export function parseColor(input: string | undefined): Rgb | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = h.split("").map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  m = /^(rgba?|hsla?|oklch)\(([^)]*)\)$/.exec(s);
  const parts = (m ? m[2] : s).split(/[\s,/]+/).filter(Boolean);
  // bare triplets: "L C H" is OKLCH (shadcn today); "H S% L%" is HSL (shadcn's older format)
  const fn = m ? m[1] : /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(s) ? "hsl" : /^[\d.]+%?\s+[\d.]+%?\s+[\d.]+$/.test(s) ? "oklch" : "";
  if (parts.length < 3 || parts.slice(0, 3).some((p) => isNaN(parseFloat(p)))) return null;
  if (fn.startsWith("rgb")) return parts.slice(0, 3).map((p) => clamp255(num(p, 255))) as Rgb;
  if (fn.startsWith("hsl")) return hsl(hue(parts[0]), num(parts[1].endsWith("%") ? parts[1] : parts[1] + "%"), num(parts[2].endsWith("%") ? parts[2] : parts[2] + "%"));
  if (fn === "oklch") return oklch(num(parts[0]), parts[1].endsWith("%") ? (parseFloat(parts[1]) / 100) * 0.4 : parseFloat(parts[1]), hue(parts[2]));
  return null;
}

export const hex = (c: Rgb) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
export const luminance = (c: Rgb) => 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2]);
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** `t` of the way from a to b. */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;

/** Black or white, whichever reads better on `bg`. */
export const onColor = (bg: Rgb): Rgb => (contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg) ? [0, 0, 0] : [255, 255, 255]);

/** The colour itself if it reads well enough on `bg`; otherwise nudged toward `toward` until it does. */
export function readable(color: Rgb, bg: Rgb, toward: Rgb, min: number): Rgb {
  for (let t = 0; t <= 1; t += 0.05) {
    const c = mix(color, toward, t);
    if (contrast(c, bg) >= min) return c;
  }
  return toward;
}
