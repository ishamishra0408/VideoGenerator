// A theme's fonts from Google Fonts, embedded in the stage so Chrome never waits on the network mid-film.
// Latin faces only, cached on disk; a font Google doesn't have simply falls back to the system's.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SYSTEM = /^(ui-sans-serif|ui-serif|ui-monospace|system-ui|-apple-system|blinkmacsystemfont|sans-serif|serif|monospace|cursive|segoe ui|helvetica|helvetica neue|arial|georgia|times|times new roman|menlo|monaco|consolas|courier|courier new|sf mono|sfmono-regular|liberation mono|noto color emoji|apple color emoji)$/i;
// Google answers 400 when a family lacks a requested style, so ask for less until it agrees.
const SPECS = [":ital,wght@0,400;0,500;0,600;0,700;0,800;1,400", ":ital,wght@0,400;0,700;1,400", ":ital@0;1", ":wght@400;700", ""];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** The first named family in a CSS font stack, or null if it's a system font. */
export function firstFamily(stack: string | undefined): string | null {
  const f = stack?.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
  return f && !SYSTEM.test(f) ? f : null;
}

/** Keeps the latin @font-face blocks of a Google Fonts stylesheet (all of them if it isn't split by script). */
export function latinFaces(css: string): string[] {
  const blocks = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?(@font-face\s*\{[^}]*\})/g)];
  const latin = blocks.filter((b) => b[1] === "latin");
  return (latin.length ? latin : blocks.filter((b) => !b[1])).map((b) => b[2]);
}

type Fetched = { status: "ok"; css: string; complete: boolean } | { status: "missing" } | { status: "offline" };

async function fetchFamily(family: string): Promise<Fetched> {
  for (const spec of SPECS) {
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}${spec}&display=block`;
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) return { status: "offline" };
    if (res.status === 400) continue;  // that style isn't available: ask for less
    if (!res.ok) return { status: "offline" };  // rate limit or outage: try again next run
    const out: string[] = [];
    let complete = true;
    for (const face of latinFaces(await res.text())) {
      const src = /url\((https:[^)]+)\)/.exec(face)?.[1];
      const font = src ? await fetch(src, { signal: AbortSignal.timeout(15_000) }).catch(() => null) : null;
      if (!font?.ok) { complete = false; continue; }
      out.push(face.replace(/url\([^)]+\)/, `url(data:font/woff2;base64,${Buffer.from(await font.arrayBuffer()).toString("base64")})`));
    }
    return out.length ? { status: "ok", css: out.join("\n"), complete } : { status: "offline" };
  }
  return { status: "missing" };
}

/** @font-face rules for the families, from the cache or Google Fonts. Missing ones are left to the fallback stack. */
export async function fontFaces(families: (string | null)[], cacheDir: string): Promise<{ css: string; loaded: string[]; missing: string[]; offline: string[] }> {
  const dir = join(cacheDir, "fonts");
  mkdirSync(dir, { recursive: true });
  const loaded: string[] = [], missing: string[] = [], offline: string[] = [], css: string[] = [];
  for (const family of [...new Set(families.filter((f): f is string => !!f))]) {
    const file = join(dir, createHash("sha256").update(family).digest("hex").slice(0, 16) + ".css");
    if (existsSync(file)) { css.push(readFileSync(file, "utf8")); loaded.push(family); continue; }
    const got = await fetchFamily(family);
    if (got.status === "ok") {
      if (got.complete) writeFileSync(file, got.css);  // a family with a failed face is fetched again next time
      css.push(got.css);
      loaded.push(family);
    } else (got.status === "missing" ? missing : offline).push(family);
  }
  return { css: css.join("\n"), loaded, missing, offline };
}
