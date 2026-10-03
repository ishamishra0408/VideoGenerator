// Filming the stage the way GitDiagram does: open it in headless Chrome, seek, screenshot, encode.
// Frames are split across several tabs, each feeding its own ffmpeg; the pieces are joined with the soundtrack.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SceneCues } from "./cues.ts";
import type { Plan } from "./plan.ts";
import { chromePath, ffmpegPath, run } from "./proc.ts";

const STAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "stage");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StageData { plan: Plan; cues: SceneCues[]; transition: number; duration: number }

/** One self-contained page: the stage's HTML with its CSS (and the theme's, after it), the storyboard and its script inlined. */
export function buildStage(data: StageData, themeCss = ""): string {
  const read = (f: string) => readFileSync(join(STAGE_DIR, f), "utf8");
  return read("stage.html")
    .replace("/*STYLE*/", () => read("stage.css") + "\n" + themeCss.replace(/<\/style/gi, ""))
    .replace("/*DATA*/", () => "window.VG = " + JSON.stringify(data).replace(/</g, "\\u003c") + ";")
    .replace("/*SCRIPT*/", () => read("stage.js"));
}

// ---------- a minimal DevTools protocol client ----------

class Cdp {
  private id = 0;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  errors: string[] = [];
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        m.error ? p.fail(new Error(`${m.error.message}`)) : p.ok(m.result);
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        this.errors.push(d.exception?.description ?? d.text);
      }
    });
  }
  private failAll(why: string) {
    for (const p of this.pending.values()) p.fail(new Error(why));
    this.pending.clear();
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => { ws.addEventListener("open", ok, { once: true }); ws.addEventListener("error", fail, { once: true }); });
    const cdp = new Cdp(ws);
    ws.addEventListener("close", () => cdp.failAll("Chrome closed the connection."));
    ws.addEventListener("error", () => cdp.failAll("Chrome's connection failed."));
    return cdp;
  }
  /** One protocol call; a call that hangs (a crashed tab, say) fails after a minute instead of stalling the film. */
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`Chrome didn't answer ${method}.`)); }, 60_000);
      this.pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function launchChrome(): Promise<{ port: number; proc: ChildProcess; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "videogen-chrome-"));
  const proc = spawn(chromePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--mute-audio", "--force-device-scale-factor=1", "--window-size=1920,1080", "about:blank"], { stdio: "ignore" });
  const portFile = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
      if (port) return { port, proc, dir };
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error("Chrome didn't start.");
}

async function openStage(port: number, file: string, fresh: boolean): Promise<Cdp> {
  const target = fresh
    ? await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()
    : ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).find((t) => t.type === "page");
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: pathToFileURL(file).href });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const r = await cdp.send("Runtime.evaluate", { expression: "!!window.STAGE_READY", returnByValue: true });
    if (r.result?.value) return cdp;
    if (cdp.errors.length) break;
  }
  throw new Error(`The stage didn't load${cdp.errors.length ? `: ${cdp.errors[0]}` : "."}`);
}

async function shot(cdp: Cdp, t: number, format: "jpeg" | "png"): Promise<Buffer> {
  await cdp.send("Runtime.evaluate", { expression: `seek(${t.toFixed(4)})` });
  const r = await cdp.send("Page.captureScreenshot", format === "jpeg" ? { format, quality: 92 } : { format });
  return Buffer.from(r.data, "base64");
}

/** Chrome keeps writing its profile while it exits: wait for it, and never let cleanup fail a film. */
async function closeChrome(c: { proc: ChildProcess; dir: string }): Promise<void> {
  const exited = new Promise((r) => (c.proc.exitCode !== null ? r(null) : c.proc.once("exit", r)));
  c.proc.kill();
  await Promise.race([exited, sleep(3000)]);
  try { rmSync(c.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

/** PNG stills of the stage at the given seconds, for checking a storyboard without filming it. */
export async function renderStills(stageFile: string, times: number[], outDir: string): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const chrome = await launchChrome();
  try {
    const cdp = await openStage(chrome.port, stageFile, false);
    const files: string[] = [];
    for (const t of times) {
      const f = join(outDir, `still-${t.toFixed(2)}.png`);
      writeFileSync(f, await shot(cdp, t, "png"));
      files.push(f);
    }
    cdp.close();
    return files;
  } finally {
    await closeChrome(chrome);
  }
}

export interface FilmOptions { stageFile: string; audio: string; out: string; duration: number; fps: number; workers: number; onProgress?: (done: number, total: number) => void }

/** The finished film: every frame, joined with the soundtrack, levelled to -16 LUFS. */
export async function renderVideo(o: FilmOptions): Promise<void> {
  const ff = ffmpegPath();
  const total = Math.ceil(o.duration * o.fps);
  const workers = Math.max(1, Math.min(o.workers, Math.ceil(total / 50)));
  const work = mkdtempSync(join(tmpdir(), "videogen-film-"));
  const chrome = await launchChrome();
  const encoders: ChildProcess[] = [];
  let done = 0;
  try {
    const tabs = await Promise.all(Array.from({ length: workers }, (_, w) => openStage(chrome.port, o.stageFile, w > 0)));
    const segs = tabs.map((_, w) => join(work, `seg${w}.mp4`));
    await Promise.all(tabs.map(async (cdp, w) => {
      const from = Math.floor((total * w) / workers), to = Math.floor((total * (w + 1)) / workers);
      const enc = spawn(ff, ["-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(o.fps), "-c:v", "mjpeg", "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(o.fps), segs[w]], { stdio: ["pipe", "ignore", "pipe"] });
      encoders.push(enc);
      let err = "";
      enc.stderr!.on("data", (d) => (err += d));
      const closed = new Promise<number>((r) => enc.on("close", r));
      enc.stdin!.on("error", () => {});
      for (let f = from; f < to; f++) {
        const buf = await shot(cdp, f / o.fps, "jpeg");
        if (!enc.stdin!.write(buf)) await new Promise((r) => enc.stdin!.once("drain", r));
        done++;
        if (done % 25 === 0) o.onProgress?.(done, total);
      }
      enc.stdin!.end();
      if ((await closed) !== 0) throw new Error(`ffmpeg failed on a segment: ${err.slice(-300)}`);
      cdp.close();
    }));
    o.onProgress?.(total, total);
    const list = join(work, "list.txt");
    writeFileSync(list, segs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
    await run(ff, ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", o.audio, "-map", "0:v", "-map", "1:a",
      "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", o.out]);
  } finally {
    for (const e of encoders) if (e.exitCode === null) e.kill("SIGKILL");  // a failed tab leaves its siblings' encoders waiting
    await closeChrome(chrome);
    rmSync(work, { recursive: true, force: true });
  }
}
