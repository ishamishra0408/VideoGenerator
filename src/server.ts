// The web page's server: local only, one film at a time, progress streamed to the page as it happens.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, MINUTES, type Minutes } from "./config.ts";
import { money, readCost } from "./cost.ts";
import { runJob, type Job, type JobResult, type Progress } from "./pipeline.ts";
import { CACHE_DIR } from "./config.ts";
import { listThemes, loadTheme, parseThemeSpec } from "./theme.ts";
import { authUrl, disconnect, draft, finishSignIn, forBrowser, lastPost, recordPost, SignInError, uploadVideo, youtubeConfig, youtubeStatus, type Privacy, type YouTubeConfig } from "./youtube.ts";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const OUT = resolve("out");
const PORT = Number(process.env.PORT) || 4319;
const HOST = process.env.HOST || "127.0.0.1";
const PASSWORD = process.env.VIDEOGEN_PASSWORD ?? "";
const LOCAL = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
// Every film spends the OpenRouter key's credit, so the page is never served beyond this machine without a password.
if (!LOCAL && PASSWORD.length < 8) {
  console.error("videogen: set VIDEOGEN_PASSWORD (8 or more characters) before listening on " + HOST + ".");
  process.exit(1);
}
// the address Google sends the browser back to after a YouTube sign-in; it must match the OAuth client exactly
const BASE_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const HOSTS = new Set(["127.0.0.1", "localhost", process.env.RENDER_EXTERNAL_HOSTNAME, ...(process.env.ALLOWED_HOSTS ?? "").split(",")].map((h) => h?.trim()).filter(Boolean));

// ---------- the password ----------
// The page asks once, on its own sign-in page, then remembers the browser with a signed cookie for 30 days.
// The cookie is an HMAC keyed by the password, so changing the password signs everyone out. Scripts can still
// send the password as Basic auth.

const digest = (s: string) => createHash("sha256").update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const SESSION_DAYS = 30;
const sessionKey = createHash("sha256").update("videogen-session\0" + PASSWORD).digest();
const sign = (issued: number) => `${issued}.${createHmac("sha256", sessionKey).update(String(issued)).digest("base64url")}`;
function validSession(token: string | undefined): boolean {
  const [issued, mac] = (token ?? "").split(".");
  const t = Number(issued);
  return !!mac && Number.isFinite(t) && Date.now() - t < SESSION_DAYS * 86_400_000 && t <= Date.now() + 60_000 && same(token!, sign(t));
}
const cookie = (req: IncomingMessage, name: string) => (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
const secure = (req: IncomingMessage) => req.headers["x-forwarded-proto"] === "https";

// behind Render's proxy the real client is the last address it appends, not anything the client sent
const clientIp = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",").pop()!.trim();
const failures = new Map<string, { n: number; since: number }>();
/** Ten wrong passwords from one address lock it out for ten minutes. */
function lockedOut(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.n >= 10 && Date.now() - f.since < 600_000;
}
function failed(ip: string) {
  const f = failures.get(ip), fresh = !f || Date.now() - f.since >= 600_000;
  failures.set(ip, { n: fresh ? 1 : f!.n + 1, since: fresh ? Date.now() : f!.since });
}

function authorised(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (!PASSWORD || validSession(cookie(req, "vg_session"))) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  if (m) {
    const ip = clientIp(req);
    if (lockedOut(ip)) { res.writeHead(429).end("Too many tries. Wait ten minutes."); return false; }
    const pass = Buffer.from(m[1], "base64").toString("utf8").split(":").slice(1).join(":");
    if (same(pass, PASSWORD)) { failures.delete(ip); return true; }
    failed(ip);
  }
  // pages go to the sign-in page; everything else gets a plain 401 (no browser prompt)
  if (req.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/files/")) res.writeHead(303, { location: "/login" }).end();
  else res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Signed out.", login: "/login" }));
  return false;
}

/** The sign-in page's form posts here: the right password sets the session cookie. */
async function login(req: IncomingMessage, res: ServerResponse) {
  const ip = clientIp(req);
  if (lockedOut(ip)) { res.writeHead(303, { location: "/login?e=wait" }).end(); return; }
  let body = "";
  for await (const c of req) { body += c; if (body.length > 4096) break; }
  const pass = new URLSearchParams(body).get("password") ?? "";
  if (!PASSWORD || !same(pass, PASSWORD)) { failed(ip); res.writeHead(303, { location: "/login?e=wrong" }).end(); return; }
  failures.delete(ip);
  res.writeHead(303, {
    location: "/",
    "set-cookie": `vg_session=${sign(Date.now())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure(req) ? "; Secure" : ""}`,
  }).end();
}

type Event = ({ type: "progress" } & Progress) | { type: "done"; result: unknown } | { type: "error"; message: string };
interface Run { id: string; kind: "storyboard" | "film" | "upload"; status: "queued" | "running" | "done" | "failed"; events: Event[]; listeners: Set<ServerResponse> }
const runs = new Map<string, Run>();
let queue: Promise<void> = Promise.resolve();

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".mp4": "video/mp4", ".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt; charset=utf-8", ".png": "image/png", ".wav": "audio/wav" };

/** A path inside `root`, or null if the request tries to climb out of it. */
function inside(root: string, rel: string): string | null {
  const p = resolve(root, "." + sep + decodeURIComponent(rel));
  return p === root || p.startsWith(root + sep) ? p : null;
}

const fileUrl = (abs: string) => "/files/" + relative(OUT, abs).split(sep).map(encodeURIComponent).join("/");
/** A re-filmed video keeps its name, so its URL carries the file's time to dodge the browser cache. */
const videoUrl = (abs: string) => `${fileUrl(abs)}?v=${Math.round(statSync(abs).mtimeMs)}`;

function publicResult(r: JobResult) {
  const vtt = r.captions?.replace(/\.srt$/, ".vtt");
  return {
    dir: relative(OUT, r.dir), plan: r.plan, warnings: r.warnings, words: r.words, duration: r.duration,
    video: r.video && videoUrl(r.video), captions: r.captions && fileUrl(r.captions), vtt: vtt && fileUrl(vtt),
    storyboard: fileUrl(join(r.dir, "storyboard.json")),
    cost: r.cost.line,
    youtube: lastPost(r.dir),
  };
}

function emit(run: Run, e: Event) {
  run.events.push(e);
  for (const res of run.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
  if (e.type !== "progress") for (const res of run.listeners) res.end();
}

/** Runs one piece of work at a time (films are heavy), streaming its progress to whoever is watching. */
function enqueue(kind: Run["kind"], work: (report: (p: Progress) => void) => Promise<unknown>): Run {
  const run: Run = { id: randomUUID(), kind, status: "queued", events: [], listeners: new Set() };
  const ahead = [...runs.values()].some((r) => r.status === "running" || r.status === "queued");
  runs.set(run.id, run);
  if (ahead) emit(run, { type: "progress", stage: "queued", message: "Waiting for the job ahead to finish" });
  queue = queue.then(async () => {
    run.status = "running";
    try {
      const result = await work((p) => emit(run, { type: "progress", ...p }));
      run.status = "done";
      emit(run, { type: "done", result });
    } catch (err) {
      run.status = "failed";
      emit(run, { type: "error", message: (err as Error).message });
    }
  });
  return run;
}
// a comment line every 25 s keeps proxies (Render's included) from closing a quiet progress stream
setInterval(() => { for (const r of runs.values()) for (const res of r.listeners) res.write(": ping\n\n"); }, 25_000).unref();

const start = (kind: "storyboard" | "film", job: Job) =>
  enqueue(kind, async (report) => publicResult(await runJob({ ...job, storyboardOnly: kind === "storyboard" }, report)));

const yt = youtubeConfig(BASE_URL, resolve(CACHE_DIR));
/** Each browser has its own YouTube connection, found by a random id in an HttpOnly cookie. */
const browserId = (req: IncomingMessage) => { const id = cookie(req, "vg_yt"); return id && /^[\w-]{32,64}$/.test(id) ? id : null; };
const mine = (req: IncomingMessage): YouTubeConfig | null => { const id = browserId(req); return yt && id ? forBrowser(yt, id) : null; };
/** A film folder's storyboard and timing, for the YouTube draft. */
function filmFiles(dir: string) {
  const plan = JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8"));
  let timing = null;
  try { timing = JSON.parse(readFileSync(join(dir, "timing.json"), "utf8")); } catch {}
  const video = newestVideo(dir);
  return { plan, timing, video };
}

/** A folder can hold an older cut under another length's name; the newest file is the current film. */
function newestVideo(dir: string): string | null {
  const mp4 = readdirSync(dir).filter((f) => f.endsWith(".mp4")).map((f) => join(dir, f));
  return mp4.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

/** Past films in out/, newest first. */
function library() {
  if (!existsSync(OUT)) return [];
  return readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
    const dir = join(OUT, d.name);
    const newest = newestVideo(dir);
    if (!newest) return [];
    const video = basename(newest);
    let title = d.name, repo = "", duration: number | undefined;
    try { const p = JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")); title = p.title; repo = p.repo; } catch {}
    try { duration = JSON.parse(readFileSync(join(dir, "timing.json"), "utf8")).duration; } catch {}
    const srt = readdirSync(dir).find((f) => f.endsWith(".srt"));
    const spent = readCost(dir);
    return [{ dir: d.name, title, repo, duration, made: statSync(join(dir, video)).mtimeMs, video: videoUrl(join(dir, video)),
      vtt: srt ? fileUrl(join(dir, srt.replace(/\.srt$/, ".vtt"))) : undefined, captions: srt ? fileUrl(join(dir, srt)) : undefined,
      storyboard: fileUrl(join(dir, "storyboard.json")),
      cost: spent ? `${spent.exact ? "" : "≈"}${money(spent.usd)} for this film` : undefined, youtube: lastPost(dir) }];
  }).sort((a, b) => b.made - a.made);
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  if (file.endsWith(".vtt") && !existsSync(file) && existsSync(file.replace(/\.vtt$/, ".srt"))) {
    // the page's <track> wants WebVTT; the film ships SubRip
    const srt = readFileSync(file.replace(/\.vtt$/, ".srt"), "utf8");
    res.writeHead(200, { "content-type": TYPES[".vtt"] });
    res.end("WEBVTT\n\n" + srt.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2"));
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end("Not found"); return; }
  const size = statSync(file).size, type = TYPES[extname(file)] ?? "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  const headers: Record<string, string | number> = { "content-type": type, "accept-ranges": "bytes" };
  if (req.url?.includes("download=1")) headers["content-disposition"] = `attachment; filename="${basename(file)}"`;
  if (range) {
    const startAt = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (startAt >= size || startAt > end) { res.writeHead(416, { "content-range": `bytes */${size}` }).end(); return; }
    res.writeHead(206, { ...headers, "content-range": `bytes ${startAt}-${end}/${size}`, "content-length": end - startAt + 1 });
    createReadStream(file, { start: startAt, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(file).pipe(res);
  }
}

const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body)); };

async function readBody(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > 2_000_000) throw new Error("too large"); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** Turns what the page sent into a job, accepting only known fields and values. */
function toJob(b: any): Job {
  const job: Job = {};
  if (typeof b.repo === "string" && b.repo.trim()) job.repo = b.repo.trim();
  if (MINUTES.includes(Number(b.minutes) as Minutes)) job.minutes = Number(b.minutes) as Minutes;
  if (typeof b.script === "string" && b.script.trim()) job.script = b.script;
  if (b.adapt === true) job.adapt = true;
  if (typeof b.brief === "string" && b.brief.trim()) job.brief = b.brief.trim().slice(0, 400);
  if (b.voice === "gemini" || b.voice === "say") job.voice = b.voice;
  if (typeof b.model === "string" && /^[\w.-]+\/[\w.:-]+$/.test(b.model)) job.model = b.model;
  if (b.plan && typeof b.plan === "object") job.plan = b.plan;
  if (typeof b.theme === "string" && parseThemeSpec(b.theme)) job.theme = b.theme;
  if (b.themeMode === "light" || b.themeMode === "dark") job.themeMode = b.themeMode;
  if (typeof b.dir === "string" && b.dir) {
    const d = inside(OUT, b.dir);
    if (!d || d === OUT) throw new Error("bad folder");
    job.outDir = d;
  }
  return job;
}

const server = createServer(async (req, res) => {
  // Local only: refuse other hosts (DNS rebinding) and non-JSON posts (cross-site forms).
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!HOSTS.has(host)) { res.writeHead(403).end(); return; }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  if (path === "/healthz") { res.writeHead(200).end("ok"); return; }
  if (path === "/login" && req.method === "GET") return sendFile(req, res, join(WEB, "login.html"));
  if (path === "/login" && req.method === "POST") return login(req, res);
  if (path === "/logout") { res.writeHead(303, { location: PASSWORD ? "/login" : "/", "set-cookie": "vg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" }).end(); return; }
  if (path === "/app.css" && req.method === "GET") return sendFile(req, res, join(WEB, "app.css"));  // the sign-in page uses it too
  if (!authorised(req, res, path)) return;
  try {
    if (req.method === "GET" && (path === "/" || path === "/app.js" || path === "/app.css")) {
      return sendFile(req, res, join(WEB, path === "/" ? "index.html" : path.slice(1)));
    }
    if (req.method === "GET" && path.startsWith("/files/")) {
      const f = inside(OUT, path.slice("/files/".length));
      return f ? sendFile(req, res, f) : void res.writeHead(404).end();
    }
    if (req.method === "GET" && path === "/api/status") {
      return json(res, 200, { auth: !!PASSWORD, key: !!process.env.OPENROUTER_API_KEY?.trim(), offline: process.platform === "darwin", model: DEFAULT_MODEL, busy: [...runs.values()].some((r) => r.status === "running" || r.status === "queued") });
    }
    if (req.method === "GET" && path === "/api/library") return json(res, 200, library());

    // ---------- YouTube ----------
    if (req.method === "GET" && path === "/youtube/connect") {
      if (!yt) return void res.writeHead(303, { location: "/?youtube=off" }).end();
      // Google returns to BASE_URL, so start there too, or the sign-in cookie won't come back with it
      if (host !== new URL(BASE_URL).hostname) return void res.writeHead(303, { location: `${BASE_URL}/youtube/connect` }).end();
      const { url: to, state } = authUrl(yt);
      const flags = `HttpOnly; SameSite=Lax${secure(req) ? "; Secure" : ""}`;
      const id = browserId(req) ?? randomBytes(32).toString("base64url");
      return void res.writeHead(303, { location: to, "set-cookie": [
        `vg_oauth=${state}; Path=/youtube; Max-Age=600; ${flags}`,
        `vg_yt=${id}; Path=/; Max-Age=${365 * 86_400}; ${flags}`,
      ] }).end();
    }
    if (req.method === "GET" && path === "/youtube/callback") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      const done = (q: string) => void res.writeHead(303, { location: `/?youtube=${q}`, "set-cookie": "vg_oauth=; Path=/youtube; HttpOnly; SameSite=Lax; Max-Age=0" }).end();
      if (!yt) return done("off");
      if (url.searchParams.get("error")) return done("error&code=denied");
      // the state must be the one this browser was given: a link someone else started can't bind their account here
      const me = mine(req);
      if (!code || !state || !me || cookie(req, "vg_oauth") !== state) return done("error&code=expired");
      try { await finishSignIn(me, code, state); return done("connected"); }
      catch (e) { return done(`error&code=${e instanceof SignInError ? e.code : "failed"}`); }
    }
    if (req.method === "POST" && path.startsWith("/api/") && !(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON only" });
    if (req.method === "GET" && path === "/api/youtube") return json(res, 200, yt ? { ...youtubeStatus(mine(req)), configured: true } : youtubeStatus(null));
    if (req.method === "GET" && path === "/api/youtube/draft") {
      const d = inside(OUT, url.searchParams.get("dir") ?? "");
      if (!d || d === OUT || !existsSync(join(d, "storyboard.json"))) return json(res, 404, { error: "No such film." });
      const f = filmFiles(d);
      return json(res, 200, draft(f.plan, f.timing));
    }
    if (req.method === "POST" && path === "/api/youtube/disconnect") {
      const me = mine(req);
      if (me) await disconnect(me);
      return json(res, 200, yt ? { ...youtubeStatus(me), configured: true } : youtubeStatus(null));
    }
    if (req.method === "POST" && path === "/api/youtube/upload") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON only" });
      const me = mine(req);
      if (!me || !youtubeStatus(me).connected) return json(res, 409, { error: "Connect YouTube first." });
      const b = await readBody(req);
      const d = typeof b.dir === "string" ? inside(OUT, b.dir) : null;
      if (!d || d === OUT || !existsSync(join(d, "storyboard.json"))) return json(res, 404, { error: "No such film." });
      const video = filmFiles(d).video;
      if (!video) return json(res, 404, { error: "That film has no video yet." });
      const privacy: Privacy = b.privacy === "public" || b.privacy === "unlisted" ? b.privacy : "private";
      const meta = { title: String(b.title ?? ""), description: String(b.description ?? ""), privacy };
      const run = enqueue("upload", async (report) => {
        report({ stage: "upload", message: "Uploading to YouTube", fraction: 0 });
        const posted = await uploadVideo(me, video, meta, (f) => report({ stage: "upload", message: `${Math.round(f * 100)}% uploaded`, fraction: f }));
        recordPost(d, posted, youtubeStatus(me).email);
        return posted;
      });
      return json(res, 202, { id: run.id });
    }
    if (req.method === "GET" && path === "/api/themes") return json(res, 200, await listThemes(resolve(CACHE_DIR)));
    const th = /^\/api\/themes\/([\w-]+)$/.exec(path);
    if (req.method === "GET" && th) {
      // the colours and fonts the page shows as swatches before a film is made
      const t = await loadTheme(th[1], url.searchParams.get("mode") === "dark" ? "dark" : "light", resolve(CACHE_DIR)).catch(() => null);
      if (!t) return json(res, 404, { error: "No such theme." });
      return json(res, 200, { id: t.id, name: t.name, author: t.author, mode: t.mode, vars: t.vars, fonts: t.fonts });
    }
    if (req.method === "POST" && path === "/api/runs") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON only" });
      const b = await readBody(req);
      const kind = b.kind === "film" ? "film" : "storyboard";
      const job = toJob(b);
      if (!job.repo && !job.plan) return json(res, 400, { error: "Give a repo." });
      return json(res, 202, { id: start(kind, job).id });
    }
    const m = /^\/api\/runs\/([\w-]+)\/events$/.exec(path);
    if (req.method === "GET" && m) {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: "No such run." });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (run.status === "done" || run.status === "failed") return void res.end();
      run.listeners.add(res);
      req.on("close", () => run.listeners.delete(res));
      return;
    }
    res.writeHead(404).end("Not found");
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => console.log(`videogen is at http://${LOCAL ? "localhost" : HOST}:${PORT}${PASSWORD ? " (password required)" : ""}`));
