// The web page's server: local only, one film at a time, progress streamed to the page as it happens.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, MINUTES, type Minutes } from "./config.ts";
import { money, readCost } from "./cost.ts";
import { runJob, type Job, type JobResult, type Progress } from "./pipeline.ts";
import { CACHE_DIR } from "./config.ts";
import { listThemes, loadTheme, parseThemeSpec } from "./theme.ts";

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
const HOSTS = new Set(["127.0.0.1", "localhost", process.env.RENDER_EXTERNAL_HOSTNAME, ...(process.env.ALLOWED_HOSTS ?? "").split(",")].map((h) => h?.trim()).filter(Boolean));

const digest = (s: string) => createHash("sha256").update(s).digest();
const failures = new Map<string, { n: number; since: number }>();
/** Basic auth, any user name, compared in constant time; ten wrong tries from one address lock it out for ten minutes. */
function authorised(req: IncomingMessage, res: ServerResponse): boolean {
  if (!PASSWORD) return true;
  // behind Render's proxy the real client is the last address it appends, not anything the client sent
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",").pop()!.trim();
  const f = failures.get(ip);
  if (f && f.n >= 10 && Date.now() - f.since < 600_000) { res.writeHead(429).end("Too many tries. Wait ten minutes."); return false; }
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  const pass = m ? Buffer.from(m[1], "base64").toString("utf8").split(":").slice(1).join(":") : null;
  if (pass !== null && timingSafeEqual(digest(pass), digest(PASSWORD))) { failures.delete(ip); return true; }
  if (pass !== null) failures.set(ip, { n: (f && Date.now() - f.since < 600_000 ? f.n : 0) + 1, since: f && Date.now() - f.since < 600_000 ? f.since : Date.now() });
  res.writeHead(401, { "www-authenticate": 'Basic realm="videogen", charset="UTF-8"' }).end("Password needed.");
  return false;
}

type Event = ({ type: "progress" } & Progress) | { type: "done"; result: unknown } | { type: "error"; message: string };
interface Run { id: string; kind: "storyboard" | "film"; status: "queued" | "running" | "done" | "failed"; events: Event[]; listeners: Set<ServerResponse> }
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
  };
}

function emit(run: Run, e: Event) {
  run.events.push(e);
  for (const res of run.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
  if (e.type !== "progress") for (const res of run.listeners) res.end();
}

function start(kind: Run["kind"], job: Job): Run {
  const run: Run = { id: randomUUID(), kind, status: "queued", events: [], listeners: new Set() };
  runs.set(run.id, run);
  queue = queue.then(async () => {
    run.status = "running";
    try {
      const result = await runJob({ ...job, storyboardOnly: kind === "storyboard" }, (p) => emit(run, { type: "progress", ...p }));
      run.status = "done";
      emit(run, { type: "done", result: publicResult(result) });
    } catch (err) {
      run.status = "failed";
      emit(run, { type: "error", message: (err as Error).message });
    }
  });
  return run;
}

/** Past films in out/, newest first. */
function library() {
  if (!existsSync(OUT)) return [];
  return readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
    const dir = join(OUT, d.name);
    const video = readdirSync(dir).find((f) => f.endsWith(".mp4"));
    if (!video) return [];
    let title = d.name, repo = "", duration: number | undefined;
    try { const p = JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")); title = p.title; repo = p.repo; } catch {}
    try { duration = JSON.parse(readFileSync(join(dir, "timing.json"), "utf8")).duration; } catch {}
    const srt = readdirSync(dir).find((f) => f.endsWith(".srt"));
    const spent = readCost(dir);
    return [{ dir: d.name, title, repo, duration, made: statSync(join(dir, video)).mtimeMs, video: videoUrl(join(dir, video)),
      vtt: srt ? fileUrl(join(dir, srt.replace(/\.srt$/, ".vtt"))) : undefined, captions: srt ? fileUrl(join(dir, srt)) : undefined,
      storyboard: fileUrl(join(dir, "storyboard.json")),
      cost: spent ? `${spent.exact ? "" : "≈"}${money(spent.usd)} for this film` : undefined }];
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
  if (!authorised(req, res)) return;
  try {
    if (req.method === "GET" && (path === "/" || path === "/app.js" || path === "/app.css")) {
      return sendFile(req, res, join(WEB, path === "/" ? "index.html" : path.slice(1)));
    }
    if (req.method === "GET" && path.startsWith("/files/")) {
      const f = inside(OUT, path.slice("/files/".length));
      return f ? sendFile(req, res, f) : void res.writeHead(404).end();
    }
    if (req.method === "GET" && path === "/api/status") {
      return json(res, 200, { key: !!process.env.OPENROUTER_API_KEY?.trim(), offline: process.platform === "darwin", model: DEFAULT_MODEL, busy: [...runs.values()].some((r) => r.status === "running" || r.status === "queued") });
    }
    if (req.method === "GET" && path === "/api/library") return json(res, 200, library());
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
