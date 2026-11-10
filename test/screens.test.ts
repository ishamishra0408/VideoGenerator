// The app's own screens: addresses, which links to follow, what to point at, and how screenshots reach the writer and the stage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReach, isPrivateHost, jpegSize, nextLinks, pageKey, parseAppSpec, pickRegions, type RawLink, type Screen } from "../src/capture.ts";
import { itemTimes } from "../src/cues.ts";
import type { RepoContext } from "../src/github.ts";
import type { Message } from "../src/llm.ts";
import { buildPrompt, checkPlan, makePlan, validatePlanShape, type Scene } from "../src/plan.ts";

const ctx: RepoContext = { id: "acme/widget", name: "widget", paths: ["README.md", "src/index.ts"], readme: "# Widget", files: [] };
const screens: Screen[] = [
  { id: "s1", file: "screens/01-home.jpg", url: "http://localhost:5173/", title: "Dashboard", w: 2880, h: 1800,
    regions: [{ id: "r1", label: 'h1 "Your projects"', x: 100, y: 80, w: 600, h: 70 }, { id: "r2", label: 'button "New project"', x: 2400, y: 90, w: 300, h: 80 }] },
  { id: "s2", file: "screens/02-checkout.jpg", title: "checkout", w: 1600, h: 1000, regions: [] },
];

test("app address: scheme filled in, pages kept on the app's own site", () => {
  assert.deepEqual(parseAppSpec("localhost:5173 /dashboard settings"),
    { start: "http://localhost:5173/", pages: ["http://localhost:5173/dashboard", "http://localhost:5173/settings"] });
  assert.equal(parseAppSpec("staging.example.com").start, "https://staging.example.com/");
  assert.equal(parseAppSpec("http://127.0.0.1:3000/app").start, "http://127.0.0.1:3000/app");
  assert.throws(() => parseAppSpec("localhost:5173 https://evil.example/x"), /isn't on http:\/\/localhost:5173/);
  assert.throws(() => parseAppSpec("   "), /Give the app's address/);
});

test("app address: private ones only from your own machine", () => {
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.1", "::1", "[::1]", "app.local", "web.internal", "169.254.169.254"]) assert.ok(isPrivateHost(h), h);
  for (const h of ["example.com", "172.32.0.1", "8.8.8.8", "localhost.example.com"]) assert.ok(!isPrivateHost(h), h);
  assert.throws(() => checkReach(parseAppSpec("localhost:5173"), false), /can't see localhost:5173/);
  assert.doesNotThrow(() => checkReach(parseAppSpec("localhost:5173"), true));
  assert.doesNotThrow(() => checkReach(parseAppSpec("https://staging.example.com"), false));
});

test("app links: navigation first, same site only, never sign-out, delete or downloads", () => {
  const o = "http://localhost:5173";
  const link = (href: string, extra: Partial<RawLink> = {}): RawLink => ({ href: o + href, text: "", nav: false, visible: true, download: false, ...extra });
  const seen = new Set([pageKey(o + "/")]);
  const got = nextLinks([
    link("/about"), link("/projects", { nav: true }), link("/projects/"), link("/logout", { nav: true }), link("/x", { text: "Sign out" }),
    link("/report.pdf"), link("/hidden", { visible: false }), link("/file", { download: true }), { href: "https://other.example/", text: "", nav: true, visible: true, download: false },
    link("/#top"), link("/#/settings"),
  ], o, seen);
  assert.deepEqual(got, [o + "/projects", o + "/about", o + "/#/settings"]);
});

test("app regions: the telling ones, no near-duplicates, read top to bottom", () => {
  const r = pickRegions([
    { kind: "section", label: "", x: 0, y: 400, w: 1000, h: 400 },
    { kind: "button", label: "Save", x: 900, y: 100, w: 120, h: 40 },
    { kind: "a", label: "Save", x: 902, y: 101, w: 118, h: 39 },
    { kind: "h1", label: "Settings", x: 40, y: 20, w: 400, h: 60 },
  ]);
  assert.deepEqual(r.map((x) => [x.id, x.label]), [["r1", 'h1 "Settings"'], ["r2", 'button "Save"'], ["r3", "section"]]);
  assert.equal(pickRegions(Array.from({ length: 40 }, (_, i) => ({ kind: "li", label: `row ${i}`, x: 0, y: i * 50, w: 300, h: 40 })), 10).length, 10);
});

test("app pictures: a JPEG's size from its header", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x08, 0x0b, 0x40, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(jpegSize(jpeg), { w: 2880, h: 1800 });
  assert.equal(jpegSize(Buffer.from("not a picture")), null);
});

test("screens: the writer is told what each screenshot is and what's on it", () => {
  const { user } = buildPrompt({ context: ctx, minutes: 1, screens, app: "http://localhost:5173/" });
  assert.match(user, /taken from it running at http:\/\/localhost:5173\//);
  assert.match(user, /s1: "Dashboard", the page \/, 2880×1800\. On it:\n  r1 h1 "Your projects" at x 100, y 80, 600×70/);
  assert.match(user, /s2: "checkout", an uploaded picture, 1600×1000\. Its callouts can't point at a place/);
  assert.match(user, /- screen: one of the screenshots/);
  assert.doesNotMatch(buildPrompt({ context: ctx, minutes: 1 }).user, /screen: one of the screenshots/);
});

test("screens: the writer sees the pictures, labelled, before the instructions", async () => {
  let sent: Message[] = [];
  const reply = JSON.stringify({ beats: [{ title: "App", scenes: [{ kind: "screen", screen: "s1", heading: "H", lines: [0], items: [] }] }] });
  await makePlan({ context: ctx, minutes: 1, script: ["Hi there."], screens: [{ ...screens[0], data: "AAAA" }] }, async (_s, m) => { sent = m; return reply; });
  const content = sent[0].content as any[];
  assert.deepEqual(content.map((b) => b.type), ["text", "image", "text"]);
  assert.equal(content[0].text, "Screenshot s1: Dashboard");
  assert.deepEqual(content[1].source, { type: "base64", media_type: "image/jpeg", data: "AAAA" });
  assert.match(content[2].text, /Screenshots of the app itself/);
});

test("screens: a screen scene gets its picture, and callouts the boxes they point at", () => {
  const raw = (screen: string, region = "r2") => ({ beats: [{ title: "App", scenes: [{ kind: "screen", screen, heading: "The dashboard", lines: [0, 1],
    items: [{ title: "New project", text: "Starts one", on: 1, region }, { title: "Nowhere", on: 0, region: "r9" }] }] }] });
  const req = { context: ctx, minutes: 1 as const, script: ["Start here.", "Then click New project."], screens };
  const ok = checkPlan(raw("s1"), req);
  const sc = ok.plan!.beats[0].scenes[0];
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(sc.screen, { src: "screens/01-home.jpg", url: "http://localhost:5173/", title: "Dashboard", w: 2880, h: 1800 });
  assert.deepEqual(sc.items[0].box, [2400, 90, 300, 80]);
  assert.equal(sc.items[1].box, undefined);
  assert.match(ok.warnings.join(" "), /s1 has no region r9/);

  assert.match(checkPlan(raw("s7"), req).problems.join(" "), /"screen" must be one of s1, s2/);
  const fixed = checkPlan(raw("s7"), req, true).plan!.beats[0].scenes[0];
  assert.equal(fixed.kind, "cards");
  assert.equal(fixed.screen, undefined);
  assert.ok(fixed.items.every((i) => !i.box));
  assert.match(checkPlan(raw("s1"), { ...req, screens: undefined }).problems.join(" "), /there are no screenshots/);
});

test("screens: a storyboard from a file keeps its pictures, inside its own folder only", () => {
  const board = (screen: object, box: unknown = [1, 2, 3, 4]) => ({ title: "W", repo: "acme/widget", beats: [{ title: "App", scenes: [{ kind: "screen", heading: "H", lines: ["Hi."], screen, items: [{ title: "Here", box }] }] }] });
  const p = validatePlanShape(board({ src: "screens/01-home.jpg", w: 2880, h: 1800, url: "http://localhost:5173/" }));
  assert.deepEqual(p.beats[0].scenes[0].screen, { src: "screens/01-home.jpg", w: 2880, h: 1800, url: "http://localhost:5173/" });
  assert.deepEqual(p.beats[0].scenes[0].items[0].box, [1, 2, 3, 4]);
  assert.equal(validatePlanShape(board({ src: "screens/a.png", w: 10, h: 10 }, [1, 2])).beats[0].scenes[0].items[0].box, undefined);
  assert.throws(() => validatePlanShape(board({ src: "screens/../../etc/passwd.jpg", w: 10, h: 10 })), /screens folder/);
  assert.throws(() => validatePlanShape(board({ src: "/tmp/x.jpg", w: 10, h: 10 })), /screens folder/);
  assert.throws(() => validatePlanShape(board({ src: "screens/x.jpg" })), /width and height/);
});

test("screens: the whole picture shows for a moment before the camera moves in", () => {
  const sc: Scene = { kind: "screen", heading: "H", lines: ["A.", "B."], items: [{ title: "X", on: 0, box: [0, 0, 10, 10] }] };
  assert.equal(itemTimes(sc, [[10, 12], [12.3, 14]], 15)[0], 11.3);
  assert.equal(itemTimes({ ...sc, items: [{ title: "X", on: 0 }] }, [[10, 12], [12.3, 14]], 15)[0], 10.2);
});
