// The film's look: GitDiagram's own by default, or any community theme on 21st.dev, fetched when picked.
// Nothing from 21st.dev is bundled here; a picked theme is fetched and cached on the user's machine.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, hex, luminance, mix, onColor, parseColor, readable, type Rgb } from "./color.ts";
import { firstFamily, fontFaces } from "./fonts.ts";

export type Mode = "light" | "dark";
export interface ThemeEntry { slug: string; author: string; name: string; url: string }
export interface Theme {
  id: string;
  name: string;
  author?: string;
  url?: string;
  mode: Mode;
  /** CSS custom properties that override the stage's defaults. */
  vars: Record<string, string>;
  /** Font stacks for sans, serif (the italic accent) and mono. */
  fonts: { sans?: string; serif?: string; mono?: string };
}
type Styles = { light?: Record<string, string>; dark?: Record<string, string> };

export const DEFAULT_THEME = "gitdiagram";
const SITE = "https://21st.dev";
const DAY = 86_400_000;

/** GitDiagram's look is the stage's own CSS; only its fonts need loading. */
const gitdiagram = (): Theme => ({
  id: DEFAULT_THEME, name: "GitDiagram", url: "https://github.com/ahmedkhaleel2004/gitdiagram", mode: "light", vars: {},
  fonts: { sans: "Geist", serif: "Instrument Serif", mono: "Geist Mono" },
});

/** "gitdiagram", a slug, "author/slug", or a 21st.dev theme URL. */
export function parseThemeSpec(spec: string | undefined): { slug: string } | "default" | null {
  const s = (spec ?? "").trim();
  if (!s || s.toLowerCase() === DEFAULT_THEME) return "default";
  const m = /(?:21st\.dev\/)?@?[\w-]+\/themes\/([\w-]+)/.exec(s) || /^[\w-]+\/([\w-]+)$/.exec(s) || /^([\w-]+)$/.exec(s);
  return m && !m[1].startsWith("_") ? { slug: m[1].toLowerCase() } : null;
}

const titleCase = (slug: string) => slug.split("-").map((w) => (/^t\d$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

/** The community themes on 21st.dev, read from its public themes page and cached for a day. */
export async function listThemes(cacheDir: string): Promise<ThemeEntry[]> {
  const file = join(cacheDir, "themes", "_list.json");
  const cached = (): ThemeEntry[] => { try { const l = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(l) ? l : []; } catch { return []; } };
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < DAY && cached().length) return cached();
  try {
    const html = await (await fetch(`${SITE}/community/themes`, { headers: { "user-agent": "videogen" }, signal: AbortSignal.timeout(20_000) })).text();
    const seen = new Set<string>();
    const list: ThemeEntry[] = [];
    for (const m of html.matchAll(/\/@([\w-]+)\/themes\/([\w-]+)/g)) {
      if (seen.has(m[2])) continue;
      seen.add(m[2]);
      list.push({ slug: m[2], author: m[1], name: titleCase(m[2]), url: `${SITE}/@${m[1]}/themes/${m[2]}` });
    }
    if (list.length) { mkdirSync(join(cacheDir, "themes"), { recursive: true }); writeFileSync(file, JSON.stringify(list)); }
    return list;
  } catch {
    return cached();
  }
}

/** One theme's light and dark styles from 21st.dev's public theme endpoint, cached; a stale copy beats none. */
async function fetchStyles(slug: string, cacheDir: string): Promise<{ name: string; author?: string; username?: string; styles: Styles }> {
  const file = join(cacheDir, "themes", `${slug}.json`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 7 * DAY) return JSON.parse(readFileSync(file, "utf8"));
  try {
    const input = encodeURIComponent(JSON.stringify({ 0: { json: { slug } } }));
    const res = await fetch(`${SITE}/api/trpc/themes.getBySlug?batch=1&input=${input}`, { headers: { "user-agent": "videogen" }, signal: AbortSignal.timeout(20_000) });
    const t = ((await res.json()) as any)?.[0]?.result?.data?.json;
    if (!t?.styles?.light) throw new Error("no styles");
    const out = { name: String(t.name ?? titleCase(slug)), author: t.author?.name ? String(t.author.name) : undefined,
      username: /^[\w-]+$/.test(t.author?.username ?? "") ? String(t.author.username) : undefined, styles: t.styles as Styles };
    mkdirSync(join(cacheDir, "themes"), { recursive: true });
    writeFileSync(file, JSON.stringify(out));
    return out;
  } catch {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    throw new Error(`Couldn't load the theme "${slug}" from 21st.dev. Check the name at ${SITE}/community/themes, or leave the theme as GitDiagram.`);
  }
}

const px = (v: string | undefined, fallback: number) => {
  const n = parseFloat(v ?? "");
  return isNaN(n) ? fallback : v!.trim().endsWith("rem") ? n * 16 : n;
};
const rgba = (c: Rgb, a: number) => `rgba(${c.map(Math.round).join(",")},${Math.max(0, Math.min(1, a))})`;
/** Font stacks go into CSS, so only names, quotes, commas and spaces get through. */
const fontStack = (v: string | undefined) => (v && /^[\w\s,'".-]+$/.test(v) ? v : undefined);

/** A shadcn theme's tokens mapped onto the stage's, with text colours kept readable. */
export function mapStyles(styles: Styles, mode: Mode): Pick<Theme, "vars" | "fonts"> {
  const base = styles.light ?? {};
  const s = mode === "dark" && styles.dark ? { ...base, ...styles.dark } : base;
  const c = (k: string) => parseColor(s[k]);
  const bg = c("background") ?? [255, 255, 255];
  const fg = c("foreground") ?? (luminance(bg) > 0.4 ? [17, 17, 17] : [240, 240, 240]);
  const card = c("card") ?? bg;
  const dark = luminance(bg) < 0.2;
  const muted = c("muted") ?? c("secondary") ?? mix(bg, fg, 0.06);
  const primary = c("primary") ?? fg;
  const onPrimary = readable(c("primary-foreground") ?? onColor(primary), primary, onColor(primary), 3);
  const accent = c("accent") ?? c("secondary") ?? muted;
  const onAccent = readable(c("accent-foreground") ?? fg, accent, onColor(accent), 4.5);
  const line = readable(c("border") ?? mix(bg, fg, 0.2), card, fg, 1.4);
  const red = c("destructive") ?? [179, 38, 58];
  const green: Rgb = dark ? [62, 207, 142] : [15, 122, 72];
  // tinted before/after panels: as much tint as body text allows
  const soft = (hue: Rgb) => { for (let t = dark ? 0.24 : 0.16; t > 0.02; t -= 0.02) { const s = mix(card, hue, t); if (contrast(fg, s) >= 4.5) return s; } return card; };
  const redSoft = soft(red), greenSoft = soft(green);
  const accentText = readable(readable(primary, bg, fg, 3.2), card, fg, 3);  // eyebrows, italic accents, tags
  const mutedFg = c("muted-foreground") ?? mix(fg, bg, 0.35);
  const ink2 = readable(mutedFg, card, fg, 3.5);
  const barInk = readable(mutedFg, muted, onColor(muted), 3.5);  // the code bar sits on muted, which can differ a lot from the cards

  const radius = px(s.radius, 8);
  const shadowColor = parseColor(s["shadow-color"]) ?? [0, 0, 0];
  const o = parseFloat(s["shadow-opacity"] ?? "");
  const opacity = isNaN(o) ? 0.12 : o;  // "0" means no shadow
  const sx = px(s["shadow-offset-x"], 0), sy = px(s["shadow-offset-y"], 4), blur = px(s["shadow-blur"], 12), spread = px(s["shadow-spread"], 0);
  const shadow = (k: number) => `${sx * k}px ${sy * k}px ${blur * k}px ${spread * k}px ${rgba(shadowColor, opacity)}`;

  const vars: Record<string, string> = {
    "--paper": hex(bg), "--paper-2": hex(muted), "--card": hex(card), "--ink": hex(fg),
    "--ink-2": hex(ink2), "--bar-ink": hex(barInk),
    "--purple": hex(primary), "--on-primary": hex(onPrimary), "--purple-soft": hex(accent), "--on-soft": hex(onAccent), "--purple-deep": hex(accentText),
    "--green": hex(readable(green, greenSoft, fg, 3)), "--red": hex(readable(red, redSoft, fg, 3)), "--green-soft": hex(greenSoft), "--red-soft": hex(redSoft),
    "--on-green": hex(onColor(green)),
    "--line": hex(line), "--line-w": "2.5px", "--shadow-card": shadow(2), "--shadow-chip": shadow(1.2),
    "--r-card": `${Math.round(radius * 2.2)}px`, "--r-small": `${Math.round(radius * 1.2)}px`, "--r-chip": radius === 0 ? "0px" : "99px",
    "--grid": rgba(fg, dark ? 0.07 : 0.055), "--glow-1": hex(mix(bg, primary, dark ? 0.22 : 0.3)), "--glow-2": hex(mix(bg, accent, 0.45)), "--grain": dark ? "0.05" : "0.09",
  };
  const fonts = { sans: fontStack(s["font-sans"]), serif: fontStack(s["font-serif"]), mono: fontStack(s["font-mono"]) };
  if (fonts.sans) vars["--sans"] = `${fonts.sans}, system-ui, sans-serif`;
  if (fonts.serif) vars["--serif"] = `${fonts.serif}, Georgia, serif`;
  if (fonts.mono) vars["--mono"] = `${fonts.mono}, Menlo, monospace`;
  return { vars, fonts };
}

/** The theme a film asked for, ready to inline into the stage. */
export async function loadTheme(spec: string | undefined, mode: Mode, cacheDir: string): Promise<Theme> {
  const parsed = parseThemeSpec(spec);
  if (parsed === null) throw new Error(`"${spec}" isn't a theme name or a 21st.dev theme link.`);
  if (parsed === "default") return gitdiagram();
  const t = await fetchStyles(parsed.slug, cacheDir);
  const { vars, fonts } = mapStyles(t.styles, mode);
  return { id: parsed.slug, name: t.name, author: t.author, url: t.username ? `${SITE}/@${t.username}/themes/${parsed.slug}` : `${SITE}/community/themes`, mode, vars, fonts };
}

/** The theme as CSS: its fonts embedded, then its colours over the stage's defaults. */
export async function themeCss(theme: Theme, cacheDir: string): Promise<{ css: string; missingFonts: string[]; offlineFonts: string[] }> {
  const families = [theme.fonts.sans, theme.fonts.serif, theme.fonts.mono].map(firstFamily);
  const faces = await fontFaces(families, cacheDir);
  const vars = Object.entries(theme.vars).map(([k, v]) => `${k}:${v};`).join("");
  return { css: `${faces.css}\n${vars ? `:root{${vars}}` : ""}`, missingFonts: faces.missing, offlineFonts: faces.offline };
}
