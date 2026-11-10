// Screenshots from a real headless Chrome and ffmpeg, against a small app served here.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { captureApp, importShots, jpegSize, parseAppSpec } from "../src/capture.ts";
import { ffmpegPath, run } from "../src/proc.ts";

const page = (title: string, body: string) =>
  `<!doctype html><title>${title}</title><nav><a href="/">Home</a> <a href="/projects">Projects</a> <a href="/logout">Log out</a> <a href="https://example.com/">Docs</a></nav><h1>${title}</h1>${body}`;
const PAGES: Record<string, string> = {
  "/": page("Dashboard", `<button>New project</button><a href="/settings">Settings</a><a href="/report.pdf">Report</a>`),
  "/projects": page("Projects", `<form><input placeholder="Search projects"></form>`),
  "/settings": page("Settings", `<label>Name <input></label>`),
  "/login": page("Sign in", `<form><input type="password"><button>Sign in</button></form>`),
};
let server: Server, base = "";
const asked: string[] = [];
const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "videogen-test-")); dirs.push(d); return d; };

before(async () => {
  server = createServer((req, res) => {
    asked.push(req.url!);
    const html = PAGES[req.url!];
    html ? res.writeHead(200, { "content-type": "text/html" }).end(html) : res.writeHead(404).end("not here");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("capture: follows the app's own links, and never signs out", { timeout: 60_000 }, async () => {
  const dir = fresh();
  const { screens, warnings } = await captureApp(parseAppSpec(base), { dir, allowPrivate: true });
  assert.deepEqual(screens.map((s) => [s.id, s.file, s.title]), [
    ["s1", "screens/01-home.jpg", "Dashboard"], ["s2", "screens/02-projects.jpg", "Projects"], ["s3", "screens/03-settings.jpg", "Settings"]]);
  assert.ok(!asked.includes("/logout") && !asked.includes("/report.pdf"));
  assert.deepEqual(warnings, []);
  for (const s of screens) assert.deepEqual(jpegSize(readFileSync(join(dir, s.file))), { w: 2880, h: 1800 });
  const home = screens[0].regions.map((r) => r.label);
  assert.ok(home.includes('h1 "Dashboard"') && home.includes('button "New project"'), home.join(", "));
  const h1 = screens[0].regions.find((r) => r.label.startsWith("h1"))!;
  assert.ok(h1.y > 0 && h1.y < 300 && h1.h > 40, "regions are in the picture's pixels, at twice the page's");
});

test("capture: listed pages only, in order, with a warning for sign-in and missing pages", { timeout: 60_000 }, async () => {
  const dir = fresh();
  const { screens, warnings } = await captureApp(parseAppSpec(`${base}/settings /login /gone /projects`), { dir, allowPrivate: true });
  assert.deepEqual(screens.map((s) => s.title), ["Settings", "Sign in", "Projects"]);
  assert.match(warnings.join(" "), /\/login asks for a password/);
  assert.match(warnings.join(" "), /Skipped .*\/gone: it answered 404/);
});

test("capture: an app that isn't running, or a private address on a shared server, is refused plainly", { timeout: 60_000 }, async () => {
  await assert.rejects(captureApp(parseAppSpec("http://127.0.0.1:9"), { dir: fresh(), allowPrivate: true }), /Start the app first/);
  await assert.rejects(captureApp(parseAppSpec(base), { dir: fresh(), allowPrivate: false }), /can't see 127\.0\.0\.1/);
});

test("uploads: any size becomes a JPEG at most 1920 wide and 3000 tall", { timeout: 60_000 }, async () => {
  const src = fresh(), dir = fresh();
  await run(ffmpegPath(), ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=3000x2000", "-frames:v", "1", join(src, "wide.png")]);
  await run(ffmpegPath(), ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=1001x5000", "-frames:v", "1", join(src, "tall.png")]);
  const shots = await importShots(["wide.png", "tall.png"].map((n) => ({ name: n, data: readFileSync(join(src, n)) })), dir, 2);
  assert.deepEqual(shots.map((s) => [s.id, s.file, s.w, s.h]), [["s3", "screens/03-wide.jpg", 1920, 1280], ["s4", "screens/04-tall.jpg", 1000, 3000]]);
  assert.ok(existsSync(join(dir, "screens/04-tall.jpg")));
  await assert.rejects(importShots([{ name: "notes.png", data: Buffer.from("not a picture") }], dir), /isn't a picture videogen can read/);
});
