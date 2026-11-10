// Pictures of the app the repo builds: taken from wherever it runs (usually the user's own machine, at localhost),
// or uploaded. Each becomes a screenshot the writer sees and a "screen" scene can show.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { ffmpegPath, run } from "./proc.ts";
import { Cdp, closeChrome, launchChrome, sleep } from "./render.ts";

/** Something on a screenshot the writer can point at, in the picture's pixels. */
export interface Region { id: string; label: string; x: number; y: number; w: number; h: number }
export interface Screen {
  /** s1, s2…, as the writer refers to it. */
  id: string;
  /** Inside the film's folder: screens/01-home.jpg */
  file: string;
  /** Where it was taken; missing for an uploaded picture. */
  url?: string;
  title: string;
  w: number;
  h: number;
  /** What's on it; none for an uploaded picture. */
  regions: Region[];
}
export interface AppSpec { start: string; pages: string[] }

/** Pages taken when following the app's own links. */
export const MAX_PAGES = 8;
/** Uploaded pictures, at most. */
export const MAX_SHOTS = 12;
/** A laptop's window, at twice the pixels, so the film can zoom onto a button and stay sharp. */
const W = 1440, H = 900, SCALE = 2;

const LOCAL_NAME = /^(localhost|127\.[\d.]+|0\.0\.0\.0|\[::1?\]|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|[\w-]+\.(local|localhost|test|internal))(:\d+)?(\/|$)/i;

/** "localhost:5173 /dashboard /settings": the app's address, then the pages to take in order (none: follow its links). */
export function parseAppSpec(input: string): AppSpec {
  const words = input.split(/[\s,]+/).filter(Boolean);
  if (!words.length) throw new Error("Give the app's address, such as http://localhost:5173.");
  const first = /^https?:\/\//i.test(words[0]) ? words[0] : (LOCAL_NAME.test(words[0]) ? "http://" : "https://") + words[0];
  let start: URL;
  try { start = new URL(first); } catch { throw new Error(`"${words[0]}" isn't a web address. Try http://localhost:5173.`); }
  const pages = words.slice(1).map((w) => {
    let u: URL;
    try { u = new URL(w, start); } catch { throw new Error(`"${w}" isn't a page of ${start.origin}.`); }
    if (u.origin !== start.origin) throw new Error(`${w} isn't on ${start.origin}: every page has to be on the app's own address.`);
    return u.href;
  });
  return { start: start.href, pages };
}

/** Loopback and private-network addresses: fine from your own machine, refused by a server other people reach. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return /^(localhost|0\.0\.0\.0|::1?|)$/.test(h) || /\.(localhost|local|internal)$/.test(h) ||
    /^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^(f[cd][0-9a-f]{2}|fe80):/.test(h) || /^::ffff:/.test(h);
}

/** One page per address: the hash counts only for apps that route with it (#/settings). */
export function pageKey(href: string): string {
  const u = new URL(href);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
  return u.origin + path + u.search + (/^#!?\//.test(u.hash) ? u.hash : "");
}

export interface RawLink { href: string; text: string; nav: boolean; visible: boolean; download: boolean }
const RISKY = /log[\s_-]?(out|off)|sign[\s_-]?out|delete|remove|destroy|unsubscribe|reset|revoke/i;
const FILE = /\.(pdf|zip|gz|tgz|png|jpe?g|gif|svg|webp|csv|json|xml|txt|md|mp4|mov|mp3|wav|dmg|exe|apk|ics)$/i;

/** Links worth following, navigation first: same site, visible, and nothing that signs out, deletes or downloads. */
export function nextLinks(links: RawLink[], origin: string, seen: Set<string>): string[] {
  const ok = links.filter((l) => {
    if (!l.visible || l.download || RISKY.test(l.href) || RISKY.test(l.text)) return false;
    let u: URL;
    try { u = new URL(l.href); } catch { return false; }
    return u.origin === origin && !FILE.test(u.pathname) && !seen.has(pageKey(u.href));
  });
  const out: string[] = [];
  for (const l of [...ok.filter((l) => l.nav), ...ok.filter((l) => !l.nav)]) {
    const k = pageKey(l.href);
    if (!out.some((o) => pageKey(o) === k)) out.push(l.href);
  }
  return out;
}

export interface RawRegion { kind: string; label: string; x: number; y: number; w: number; h: number }
const RANK: Record<string, number> = {
  h1: 10, dialog: 9, h2: 9, form: 8, table: 8, chart: 8, canvas: 7, video: 7, img: 6, navigation: 7, nav: 7, tablist: 6,
  header: 6, banner: 6, row: 5, button: 6, input: 6, textarea: 6, select: 6, searchbox: 6, h3: 5, card: 5, panel: 5, section: 4,
  article: 4, aside: 4, svg: 4, a: 4, link: 4, li: 3, label: 2, main: 2, footer: 2,
};
const overlap = (a: RawRegion, b: RawRegion) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = ix * iy;
  return i / (a.w * a.h + b.w * b.h - i);
};

/** The things on a page worth pointing at: the most telling first, near-duplicates dropped, then read top to bottom. */
export function pickRegions(raw: RawRegion[], max = 36): Region[] {
  const scored = raw.map((r) => ({ r, score: (RANK[r.kind] ?? 1) + Math.min(2, (r.w * r.h) / 800_000) }))
    .sort((a, b) => b.score - a.score);
  const kept: RawRegion[] = [];
  for (const { r } of scored) {
    if (kept.length >= max) break;
    if (kept.some((k) => overlap(k, r) > 0.8)) continue;
    kept.push(r);
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x).map((r, i) => ({ id: `r${i + 1}`, label: `${r.kind}${r.label ? ` "${r.label}"` : ""}`, x: r.x, y: r.y, w: r.w, h: r.h }));
}

// in the page: the landmarks, headings, controls and pictures that are on screen
const REGIONS_JS = `(() => {
  const vw = innerWidth, vh = innerHeight, out = [];
  const SEL = "header,nav,aside,main,footer,form,table,tbody>tr,table>tr,dialog,[role],h1,h2,h3,button,a,input,textarea,select,img,video,canvas,svg,section,article,li,label,[class*=card i],[class*=panel i],[class*=chart i]";
  const tag0 = (el) => el.tagName.toLowerCase();
  const text = (el) => (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 70);
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < (tag0(el) === "tr" ? 12 : 16) || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || +s.opacity < 0.1) continue;
    const x = Math.max(0, r.left), y = Math.max(0, r.top), w = Math.min(vw, r.right) - x, h = Math.min(vh, r.bottom) - y;
    if (w * h > vw * vh * 0.85) continue;
    const tag = el.tagName.toLowerCase(), cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className);
    let kind = el.getAttribute("role") || (tag === "tr" ? "row" : tag);
    if (/^(div|span|section|article|li)$/.test(kind)) kind = /chart/i.test(cls) ? "chart" : /card/i.test(cls) ? "card" : /panel/i.test(cls) ? "panel" : kind;
    if (kind === "presentation" || kind === "none" || kind === "div" || kind === "span") continue;
    if (tag === "svg" && w * h < 20000) continue;
    const label = text(el);
    if (!label && !/^(img|video|canvas|svg|table|form|nav|navigation|header|aside|main|chart|dialog)$/.test(kind)) continue;
    const k = devicePixelRatio;
    out.push({ kind, label, x: Math.round(x * k), y: Math.round(y * k), w: Math.round(w * k), h: Math.round(h * k) });
  }
  return out;
})()`;

const LINKS_JS = `[...document.querySelectorAll("a[href]")].map((a) => {
  const r = a.getBoundingClientRect();
  return { href: a.href, text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 60), nav: !!a.closest("nav,header,aside,[role=navigation]"),
    visible: r.width > 0 && r.height > 0, download: a.hasAttribute("download") };
})`;

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const fileName = (n: number, name: string) => `screens/${String(n).padStart(2, "0")}-${slugOf(name) || "home"}.jpg`;

/** A value from the page; undefined while it's between documents. */
async function value(cdp: Cdp, expression: string): Promise<any> {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).catch(() => null);
  return r?.result?.value;
}

/** Until the page has loaded, its own data has arrived (its text stops changing), and its fonts and pictures are in. */
async function settle(cdp: Cdp, fresh: boolean): Promise<void> {
  for (let i = 0; i < 75; i++) {  // 15 s
    if ((!fresh || !(await value(cdp, "!!window.__vgBefore"))) && (await value(cdp, "document.readyState")) === "complete") break;
    await sleep(200);
  }
  let last = -1;
  for (let i = 0, still = 0; i < 16 && still < 2; i++) {
    await sleep(350);
    const n = await value(cdp, "document.body ? document.body.innerText.length + document.images.length * 1000 : 0");
    still = n === last ? still + 1 : 0;
    last = n;
  }
  await value(cdp, "document.fonts.ready.then(() => true)");
  await value(cdp, "Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 3000); }))).then(() => true)");
  await sleep(300);
}

/**
 * Screenshots of a running app in a 1440×900 window, at 2880×1800 pixels: the pages given, in order, or else the start page and the pages its links
 * lead to (navigation first, up to MAX_PAGES). Saved as JPEGs under `dir`/screens.
 */
/** Refuses a private address where it can't mean the user's own machine: on a server other people reach. */
export function checkReach(spec: AppSpec, allowPrivate: boolean): void {
  const host = new URL(spec.start).host;
  if (!allowPrivate && isPrivateHost(new URL(spec.start).hostname))
    throw new Error(`This server can't see ${host}: that address only means something on your own computer. Run videogen on your computer, give the app's public address, or upload screenshots.`);
}

export async function captureApp(spec: AppSpec, o: { dir: string; max?: number; allowPrivate: boolean; log?: (s: string) => void }): Promise<{ screens: Screen[]; warnings: string[] }> {
  const max = o.max ?? MAX_PAGES, origin = new URL(spec.start).origin, follow = !spec.pages.length;
  checkReach(spec, o.allowPrivate);
  mkdirSync(join(o.dir, "screens"), { recursive: true });
  const warnings: string[] = [], screens: Screen[] = [];
  const queue = [spec.start, ...spec.pages], seen = new Set<string>(queue.map(pageKey)), looks = new Set<string>();
  const chrome = await launchChrome();
  try {
    const target = ((await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json()) as any[]).find((t) => t.type === "page");
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    for (let i = 0; i < queue.length && screens.length < max; i++) {
      const url = queue[i], first = i === 0;
      o.log?.(`Opening ${url}`);
      await value(cdp, "window.__vgBefore = true");
      const nav = await cdp.send("Page.navigate", { url }).catch((e: Error) => ({ errorText: e.message }));
      if (nav.errorText) {
        const why = /CONNECTION_REFUSED|ADDRESS_UNREACHABLE|NAME_NOT_RESOLVED|CONNECTION_FAILED/.test(nav.errorText)
          ? `nothing answered at ${new URL(url).host}` : nav.errorText.replace(/^net::/, "");
        if (first) throw new Error(`Couldn't open ${url}: ${why}. Start the app first (for example npm run dev), check the address, then try again.`);
        warnings.push(`Skipped ${url}: ${why}.`);
        continue;
      }
      await settle(cdp, !!nav.loaderId);
      const page = await value(cdp, `({ href: location.href, title: document.title, status: (performance.getEntriesByType("navigation")[0] || {}).responseStatus || 0,
        signIn: !!document.querySelector("input[type=password]"),
        look: document.title + "\\n" + (document.body ? document.body.innerText.slice(0, 4000) : "") })`);
      if (!page?.href) { warnings.push(`Skipped ${url}: it didn't finish loading.`); continue; }
      const at = new URL(page.href);
      if (at.origin !== origin) { warnings.push(`Skipped ${url}: it sent the browser to ${at.host}${first ? ", probably to sign in" : ""}.`); continue; }
      if (!o.allowPrivate && isPrivateHost(at.hostname)) { warnings.push(`Skipped ${url}: it leads to a private address.`); continue; }
      if (page.status >= 400 && !first) { warnings.push(`Skipped ${url}: it answered ${page.status}.`); continue; }
      if (page.status >= 400) warnings.push(`${url} answered ${page.status}; its screenshot may be an error page.`);
      if (looks.has(page.look)) continue;  // another address for a page already taken
      if (page.signIn) warnings.push(`${at.pathname} asks for a password, and the pages behind it can't be taken. Upload screenshots of those instead.`);
      looks.add(page.look);

      const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
      const name = at.pathname === "/" && !/^#!?\//.test(at.hash) ? "home" : (at.pathname + at.hash).replace(/^\/+/, "");
      const file = fileName(screens.length + 1, name);
      writeFileSync(join(o.dir, file), Buffer.from(shot.data, "base64"));
      const regions = pickRegions((await value(cdp, REGIONS_JS)) ?? []);
      screens.push({ id: `s${screens.length + 1}`, file, url: page.href, title: page.title || at.pathname, w: W * SCALE, h: H * SCALE, regions });
      o.log?.(`${screens.length} of up to ${follow ? max : queue.length} pages: ${page.title || at.pathname}`);

      if (follow && screens.length < max) {
        const links = nextLinks((await value(cdp, LINKS_JS)) ?? [], origin, seen);
        for (const l of links) { seen.add(pageKey(l)); queue.push(l); }
      }
    }
    cdp.close();
  } finally {
    await closeChrome(chrome);
  }
  if (!screens.length) throw new Error(`Couldn't take a screenshot of ${spec.start}.`);
  return { screens, warnings };
}

/** Width and height from a JPEG's frame header. */
export function jpegSize(b: Buffer): { w: number; h: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** Uploaded pictures, made JPEGs at most 1920 wide and 3000 tall (a taller page keeps its top). */
export async function importShots(files: { name: string; data: Buffer }[], dir: string, after = 0): Promise<Screen[]> {
  if (files.length > MAX_SHOTS) throw new Error(`Up to ${MAX_SHOTS} screenshots at a time.`);
  mkdirSync(join(dir, "screens"), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "videogen-shots-"));
  const out: Screen[] = [];
  try {
    for (const [k, f] of files.entries()) {
      const n = after + k + 1, base = f.name.replace(/\.[^.]+$/, ""), src = join(work, `in-${k}${extname(f.name).toLowerCase() || ".png"}`);
      writeFileSync(src, f.data);
      const file = fileName(n, base);
      await run(ffmpegPath(), ["-loglevel", "error", "-y", "-i", src, "-frames:v", "1",
        "-vf", "scale='trunc(min(1920,iw)/2)*2':-2,crop=iw:'trunc(min(ih,3000)/2)*2':0:0", "-q:v", "3", join(dir, file)])
        .catch(() => { throw new Error(`${f.name} isn't a picture videogen can read. Use PNG, JPEG or WebP.`); });
      const size = jpegSize(readFileSync(join(dir, file)));
      if (!size) throw new Error(`${f.name} couldn't be converted.`);
      out.push({ id: `s${n}`, file, title: base, w: size.w, h: size.h, regions: [] });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}
