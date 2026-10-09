import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWav, synth, writeWav } from "../src/audio.ts";
import { GAPS } from "../src/config.ts";
import { computeCues, itemTimes, sfxEvents } from "../src/cues.ts";
import { parseRepo, pickFiles, refusalMessage, type RepoContext } from "../src/github.ts";
import { extractJson } from "../src/llm.ts";
import { checkPlan, cleanLine, codeOverlap, makePlan, redistribute, validatePlanShape, type Plan, type Scene } from "../src/plan.ts";
import { timeLeft } from "../src/pipeline.ts";
import { parseScript, splitSentences, stripMarkdown } from "../src/sentences.ts";
import { captionChunks, layout, toSrt } from "../src/timing.ts";

const ctx: RepoContext = {
  id: "acme/widget", name: "widget", url: "https://github.com/acme/widget",
  paths: ["README.md", "package.json", "src/index.ts", "src/server/api.ts", "src/server/db.ts", "test/api.test.ts"],
  readme: "# Widget\nA tiny widget server.",
  files: [{ path: "src/index.ts", text: "import { serve } from './server/api';\nconst port = Number(process.env.PORT) || 3000;\nserve(port);\nconsole.log('listening');" }],
};

const scene = (lines: string[], extra: Partial<Scene> = {}): Scene => ({ kind: "cards", heading: "H", lines, items: [], ...extra });
const plan2: Plan = { title: "widget", repo: "acme/widget", tag: "", beats: [
  { title: "One", scenes: [scene(["First sentence here.", "Second one."]), scene(["Third."])] },
  { title: "Two", scenes: [scene(["Fourth."])] },
] };

test("sentences: abbreviations, decimals and markdown survive splitting", () => {
  assert.deepEqual(splitSentences("It runs on v2.5 today. It costs approx. nothing, e.g. zero! Ready?"), ["It runs on v2.5 today.", "It costs approx. nothing, e.g. zero!", "Ready?"]);
  assert.equal(stripMarkdown("## Title\n- **bold** and `code` and [a link](http://x)"), "Title bold and code and a link");
});

test("sentences: a script's words survive, and bullets stand alone", () => {
  assert.deepEqual(splitSentences("Call file_path_name, then compute 2 * 3 * 4. It's **really** fast."), ["Call file_path_name, then compute 2 * 3 * 4.", "It's really fast."]);
  assert.deepEqual(splitSentences("Why it matters\n- Point it at a repo\n- It writes the script\n\nA wrapped\nparagraph ends here."),
    ["Why it matters.", "Point it at a repo.", "It writes the script.", "A wrapped paragraph ends here."]);
});

test("sentences: script headings become sections, words kept", () => {
  const s = parseScript("# Intro\nHello there. This is it.\n\n# Close\nBye now.");
  assert.deepEqual(s.map((x) => x.title), ["Intro", "Close"]);
  assert.deepEqual(s[0].sentences, ["Hello there.", "This is it."]);
});

test("timing: pauses between sentences, scenes and beats", () => {
  const t = layout(plan2, [2, 1, 1, 1]);
  assert.equal(t.lines[0].start, GAPS.lead);
  assert.equal(t.lines[1].start, +(GAPS.lead + 2 + GAPS.sentence).toFixed(3));
  assert.equal(t.lines[2].start, +(t.lines[1].end + GAPS.scene).toFixed(3));
  assert.equal(t.lines[3].start, +(t.lines[2].end + GAPS.beat).toFixed(3));
  assert.equal(t.duration, +(t.lines[3].end + GAPS.tail).toFixed(3));
  assert.equal(t.scenes.length, 3);
  assert.equal(t.scenes[2].end, t.duration);
  assert.throws(() => layout(plan2, [1, 1]));
});

test("captions: long lines split near 84 characters, SRT timestamps", () => {
  const long = "This sentence is deliberately long, so that it has to be split into chunks, each no longer than the limit allows for reading.";
  assert.ok(captionChunks(long).every((c) => c.length <= 84));
  assert.equal(captionChunks(long).join(" "), long);
  const srt = toSrt([{ beat: 0, scene: 0, line: 0, start: 61.5, end: 63, text: "Hi." }]);
  assert.match(srt, /^1\n00:01:01,500 --> 00:01:03,000\nHi\.\n/);
});

test("cues: items land on the sentence that names them, or spread evenly", () => {
  const lines: [number, number][] = [[1, 3], [3.3, 5]];
  const named = itemTimes(scene(["a", "b"], { items: [{ title: "x", on: 1 }, { title: "y", on: 0 }] }), lines, 6);
  assert.ok(named[0] > 3.3 && named[1] < 3);
  const spread = itemTimes(scene(["a", "b"], { items: [{ title: "x" }, { title: "y" }, { title: "z" }, { title: "w" }] }), lines, 6);
  assert.deepEqual([...spread].sort((a, b) => a - b), spread);
  assert.ok(spread.every((t) => t >= 1.2 && t <= 5));
  const cmp = itemTimes(scene(["a", "b"], { kind: "compare", items: [{ title: "b" }, { title: "a" }] }), lines, 6);
  assert.ok(cmp[0] < 3 && cmp[1] >= 3.3);
});

test("cues and sound bed come from the same clock", () => {
  const p: Plan = structuredClone(plan2);
  p.beats[0].scenes[0] = scene(["One.", "Two."], { kind: "compare", items: [{ title: "before" }, { title: "after" }] });
  const t = layout(p, [1, 1, 1, 1]);
  const cues = computeCues(p, t);
  const ev = sfxEvents(p, cues);
  assert.equal(ev.filter((e) => e.kind === "whoosh").length, 2);
  assert.equal(ev.filter((e) => e.kind === "stamp").length, 2);
  assert.ok(Math.abs(ev.find((e) => e.kind === "stamp")!.at - (cues[0].items[0] + 0.06)) < 1e-9);
});

test("audio: WAV round trip and synthesised effects stay in range", () => {
  const f = join(mkdtempSync(join(tmpdir(), "vg-")), "a.wav");
  const s = synth("whoosh");
  writeWav(f, s);
  const back = readWav(f);
  assert.equal(back.rate, 48000);
  assert.equal(back.samples.length, s.length);
  assert.ok(Math.abs(back.samples[1000] - s[1000]) < 1e-4);
  for (const k of ["whoosh", "stamp", "pop", "tick"] as const) assert.ok(synth(k).every((x) => Math.abs(x) <= 1));
});

test("github: repo names in the forms people paste", () => {
  for (const s of ["acme/widget", "https://github.com/acme/widget", "github.com/acme/widget.git", "git@github.com:acme/widget.git", "https://github.com/acme/widget/tree/main/src"])
    assert.deepEqual(parseRepo(s), { owner: "acme", name: "widget" });
  assert.equal(parseRepo("not a repo"), null);
  const picked = pickFiles(ctx.paths);
  assert.equal(picked[0], "package.json");
  assert.ok(picked.includes("src/index.ts") && !picked.includes("test/api.test.ts"));
});

test("github: a spent rate limit says when it comes back and where the token goes", () => {
  const now = 1_700_000_000_000;
  const spent = new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 600) });
  const anon = refusalMessage(403, spent, false, now);
  assert.ok(anon.includes("10 min") && anon.includes("Environment on Render"));
  assert.ok(refusalMessage(403, spent, true, now).includes("this GITHUB_TOKEN"));
  assert.ok(refusalMessage(429, new Headers({ "retry-after": "30" }), false, now).includes("1 min"));
  assert.ok(refusalMessage(403, new Headers(), false, now).startsWith("GitHub refused"));
});

test("pipeline: time left reads in seconds, minutes, then hours", () => {
  assert.equal(timeLeft(44.2), "45 s");
  assert.equal(timeLeft(2449), "41 min");
  assert.equal(timeLeft(7593), "2 h 7 min");
});

test("llm: JSON inside a fence or prose", () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('sure {"b":[1,2]} done'), { b: [1, 2] });
  assert.throws(() => extractJson("nothing"));
});

const raw = (lines: string[][], extra: any = {}) => ({ beats: [{ title: "Intro", scenes: lines.map((l) => ({ kind: "statement", heading: "Hi", lines: l, items: [], ...extra })) }] });

test("plan: narration is cleaned, budget enforced, then accepted on the last round", () => {
  assert.equal(cleanLine("It's **fast** — really"), "It's fast, really.");
  const words = Array(30).fill("word").join(" ") + ".";
  const r = checkPlan(raw([[words]]), { context: ctx, minutes: 1 });
  assert.ok(r.problems.some((p) => p.includes("words")));
  const f = checkPlan(raw([[words]]), { context: ctx, minutes: 1 }, true);
  assert.ok(f.plan && f.warnings.some((p) => p.includes("words")));
});

test("plan: a verbatim script must be used in order, else it's re-spread", () => {
  const script = ["One.", "Two.", "Three.", "Four."];
  const ok = checkPlan(raw([[0, 1] as any, [2, 3] as any]), { context: ctx, minutes: 1, script });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.plan!.beats[0].scenes[1].lines, ["Three.", "Four."]);
  const bad = checkPlan(raw([[0, 2] as any, [1] as any]), { context: ctx, minutes: 1, script }, true);
  assert.deepEqual(bad.plan!.beats[0].scenes.flatMap((s) => s.lines), script);
  const scenes = [scene([]), scene([]), scene([])];
  redistribute(scenes, [[0], [1, 2, 3, 4], [5]], ["a", "b", "c", "d", "e", "f", "g"]);
  assert.deepEqual(scenes.flatMap((s) => s.lines), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.ok(scenes.every((s) => s.lines.length >= 1));
});

test("plan: invented code and paths are caught", () => {
  assert.ok(codeOverlap("const port = Number(process.env.PORT) || 3000;\nserve(port);", ctx) === 1);
  const fake = { beats: [{ title: "T", scenes: [
    { kind: "code", heading: "H", lines: ["A line."], items: [], code: { file: "x.ts", text: "function invented() {\n  return 42;\n}" } },
    { kind: "tree", heading: "H", lines: ["A line."], items: [{ title: "src/server" }, { title: "src/index.ts" }, { title: "src/ghost.ts" }] },
  ] }] };
  const r = checkPlan(fake, { context: ctx, minutes: 1 });
  assert.ok(r.problems.some((p) => p.includes("isn't copied")));
  assert.ok(r.problems.some((p) => p.includes("src/ghost.ts")));
  const f = checkPlan(fake, { context: ctx, minutes: 1 }, true);
  assert.notEqual(f.plan!.beats[0].scenes[0].kind, "code");
  assert.notEqual(f.plan!.beats[0].scenes[1].kind, "tree");
});

test("plan: the repair loop feeds problems back to the writer", async () => {
  const good = { beats: [1, 2, 3].map((i) => ({ title: `B${i}`, scenes: [{ kind: i === 1 ? "title" : "statement", heading: "H", lines: [Array(48).fill("word").join(" ") + "."], items: [] }] })) };
  const replies = ["not json", JSON.stringify(good)];
  const asked: number[] = [];
  const { plan } = await makePlan({ context: ctx, minutes: 1 }, async (_s, messages) => { asked.push(messages.length); return replies.shift()!; });
  assert.deepEqual(asked, [1, 3]);
  assert.equal(plan.beats.length, 3);
});

test("plan: an edited storyboard is checked for shape", () => {
  const p = validatePlanShape({ title: "w", repo: "a/w", beats: [{ title: "B", scenes: [{ kind: "cards", heading: "H", lines: ["One.", ""], items: [{ title: "a", on: 5 }, { title: "b", on: 0 }] }] }] });
  assert.deepEqual(p.beats[0].scenes[0].lines, ["One."]);
  assert.ok(p.beats[0].scenes[0].items.every((i) => i.on === undefined));
  assert.throws(() => validatePlanShape({ beats: [{ scenes: [{ kind: "flow", heading: "H", lines: ["x"], items: [] }] }] }), /at least 2/);
  assert.throws(() => validatePlanShape({ beats: [] }));
});

test("example storyboard is valid", () => {
  const p = validatePlanShape(JSON.parse(readFileSync(new URL("../examples/storyboard.json", import.meta.url), "utf8")));
  assert.ok(p.beats.length >= 3);
});

test("cost: money reads naturally, and a film's runs add up", async () => {
  const { money, recordCost, costLine, zero } = await import("../src/cost.ts");
  assert.deepEqual([0, 0.0004, 0.056, 0.12, 1.5].map(money), ["0¢", "<0.1¢", "5.6¢", "12¢", "$1.50"]);
  const dir = mkdtempSync(join(tmpdir(), "vg-cost-"));
  const board = { at: "t", kind: "storyboard" as const, storyboard: { ...zero(), usd: 0.04, calls: 1 }, voice: { ...zero(), cached: 0, seconds: 0 }, usd: 0.04 };
  recordCost(dir, board);
  const film = { at: "t", kind: "film" as const, storyboard: zero(), voice: { ...zero(), usd: 0.016, calls: 10, cached: 2, seconds: 54, exact: false }, usd: 0.016 };
  const total = recordCost(dir, film);
  assert.equal(total.usd, 0.056);
  assert.equal(total.exact, false);
  assert.equal(costLine(film, total), "≈1.6¢ this run · voice ≈1.6¢ (10 new, 2 cached) · ≈5.6¢ for this film in all");
});

test("llm: OpenRouter's usage and cost come back with the text, empty replies included", async () => {
  const { chat } = await import("../src/llm.ts");
  const replies = [
    { choices: [{ message: { content: "" } }], usage: { prompt_tokens: 100, completion_tokens: 0, cost: 0.0002 } },
    { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0003 } },
  ];
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(replies.shift()), { status: 200 })) as typeof fetch;
  try {
    const r = await chat({ key: "k", model: "m", system: "s", messages: [{ role: "user", content: "u" }] });
    assert.equal(r.text, "{}");
    assert.deepEqual(r.usage, { prompt: 200, completion: 10, cost: 0.0005 });
  } finally {
    globalThis.fetch = real;
  }
});

test("color: the formats themes use parse to the same colour", async () => {
  const { parseColor, hex, contrast } = await import("../src/color.ts");
  assert.equal(hex(parseColor("#fff")!), "#ffffff");
  assert.equal(hex(parseColor("rgb(255, 0, 0)")!), "#ff0000");
  assert.equal(hex(parseColor("hsl(0 0% 0%)")!), "#000000");
  assert.equal(hex(parseColor("hsl(120, 100%, 25%)")!), "#008000");
  assert.equal(hex(parseColor("oklch(1 0 0)")!), "#ffffff");
  assert.equal(hex(parseColor("0.628 0.2577 29.23")!), "#ff0000");  // shadcn's bare OKLCH triplet
  assert.equal(parseColor("var(--x)"), null);
  assert.ok(Math.abs(contrast([0, 0, 0], [255, 255, 255]) - 21) < 0.01);
});

test("theme: names, links and a mapped theme that stays readable", async () => {
  const { parseThemeSpec, mapStyles } = await import("../src/theme.ts");
  const { parseColor, contrast } = await import("../src/color.ts");
  assert.equal(parseThemeSpec("gitdiagram"), "default");
  assert.equal(parseThemeSpec(undefined), "default");
  assert.deepEqual(parseThemeSpec("vintage-paper"), { slug: "vintage-paper" });
  assert.deepEqual(parseThemeSpec("https://21st.dev/@serafimcloud/themes/doom-64"), { slug: "doom-64" });
  assert.equal(parseThemeSpec("not a theme!"), null);
  // a pale primary on white must be darkened before it's used as text
  const styles = { light: { background: "#ffffff", foreground: "#111111", card: "#ffffff", primary: "#e8f5a0", accent: "#f0f0f0", radius: "0rem",
    "shadow-offset-x": "4px", "shadow-offset-y": "4px", "shadow-blur": "0px", "shadow-opacity": "1", "shadow-color": "#000", "font-sans": "Space Grotesk, sans-serif" },
    dark: { background: "#0a0a0a", foreground: "#f5f5f5", card: "#141414" } };
  const light = mapStyles(styles, "light"), dark = mapStyles(styles, "dark");
  assert.ok(contrast(parseColor(light.vars["--purple-deep"])!, [255, 255, 255]) >= 3);
  assert.equal(light.vars["--r-chip"], "0px");
  assert.equal(light.vars["--shadow-card"], "8px 8px 0px 0px rgba(0,0,0,1)");
  assert.equal(light.vars["--sans"], "Space Grotesk, sans-serif, system-ui, sans-serif");
  assert.equal(dark.vars["--paper"], "#0a0a0a");
  assert.equal(dark.vars["--sans"], light.vars["--sans"]);  // dark inherits the light fonts
  assert.equal(mapStyles({ light: { "font-sans": "x;} body{color:red" } }, "light").vars["--sans"], undefined);
});

test("fonts: system fonts are skipped and only latin faces kept", async () => {
  const { firstFamily, latinFaces } = await import("../src/fonts.ts");
  assert.equal(firstFamily("Libre Baskerville, serif"), "Libre Baskerville");
  assert.equal(firstFamily('"IBM Plex Mono", monospace'), "IBM Plex Mono");
  assert.equal(firstFamily("ui-sans-serif, system-ui"), null);
  const css = "/* cyrillic */\n@font-face { src: url(https://a/c.woff2); }\n/* latin */\n@font-face { src: url(https://a/l.woff2); }";
  assert.deepEqual(latinFaces(css), ["@font-face { src: url(https://a/l.woff2); }"]);
});

test("cost: a run that fails after paying still records the spend", async () => {
  const { runJob } = await import("../src/pipeline.ts");
  const { readCost } = await import("../src/cost.ts");
  const repo = mkdtempSync(join(tmpdir(), "vg-repo-")), out = mkdtempSync(join(tmpdir(), "vg-out-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(repo, "README.md"), "# Widget\nA tiny widget server.");
  const line = Array(48).fill("word").join(" ") + ".";
  const board = { beats: [1, 2, 3].map((i) => ({ title: `B${i}`, scenes: [{ kind: i === 1 ? "title" : "statement", heading: "H", lines: [line], items: [] }] })) };
  const real = globalThis.fetch, key = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test";
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/chat/completions")) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(board) } }], usage: { prompt_tokens: 15000, completion_tokens: 900, cost: 0.039 } }));
    if (String(url).includes("/audio/speech")) return new Response("no credit", { status: 402 });
    return new Response("", { status: 404 });  // fonts: unavailable, falls back
  }) as typeof fetch;
  try {
    await assert.rejects(runJob({ repo, minutes: 1, outDir: out, voice: "gemini" }), /402/);
    const c = readCost(out)!;
    assert.equal(c.runs[0].kind, "failed");
    assert.equal(c.runs[0].storyboard.usd, 0.039);
    assert.equal(c.usd, 0.039);
  } finally {
    globalThis.fetch = real;
    if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key;
  }
});

test("theme: text on accents and primaries reads well whichever way the accent leans", async () => {
  const { mapStyles } = await import("../src/theme.ts");
  const { parseColor, contrast } = await import("../src/color.ts");
  for (const accent of ["#04a5e5", "#ff79c6", "#7aa2f7", "#ffd60a", "#1e66f5"]) {
    const v = mapStyles({ light: { background: "#eff1f5", foreground: "#4c4f69", card: "#ffffff", primary: accent, "primary-foreground": "#ffffff", accent, "accent-foreground": "#ffffff", muted: "#dce0e8" } }, "light").vars;
    const P = (k: string) => parseColor(v[k])!;
    assert.ok(contrast(P("--on-soft"), P("--purple-soft")) >= 4.5, `on accent ${accent}`);
    assert.ok(contrast(P("--on-primary"), P("--purple")) >= 3, `on primary ${accent}`);
    assert.ok(contrast(P("--ink"), P("--red-soft")) >= 4.5 && contrast(P("--ink"), P("--green-soft")) >= 4.5);
    assert.ok(contrast(P("--bar-ink"), P("--paper-2")) >= 3.5 && contrast(P("--ink-2"), P("--card")) >= 3.5);
  }
});

test("youtube: PKCE, the sign-in link, and swapping the code for tokens", async () => {
  const { pkceChallenge, youtubeConfig, authUrl, finishSignIn, youtubeStatus } = await import("../src/youtube.ts");
  // RFC 7636, appendix B
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const env = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  delete process.env.GOOGLE_CLIENT_ID;
  assert.equal(youtubeConfig("http://localhost:4319", tmpdir()), null);
  process.env.GOOGLE_CLIENT_ID = "cid"; process.env.GOOGLE_CLIENT_SECRET = "secret";
  const cfg = youtubeConfig("http://localhost:4319/", mkdtempSync(join(tmpdir(), "vg-yt-")))!;
  assert.equal(cfg.redirectUri, "http://localhost:4319/youtube/callback");
  const u = new URL(authUrl(cfg).url);
  assert.equal(u.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/youtube.upload");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("access_type"), "offline");
  const state = u.searchParams.get("state")!;
  const real = globalThis.fetch;
  let sent: URLSearchParams | undefined;
  const idToken = "x." + Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url") + ".y";
  globalThis.fetch = (async (_url: string, init: any) => { sent = new URLSearchParams(init.body); return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/youtube.upload", id_token: idToken })); }) as typeof fetch;
  try {
    await assert.rejects(finishSignIn(cfg, "code", "not-the-state"), /expired/);
    assert.equal(await finishSignIn(cfg, "code", state), "me@example.com");
    assert.equal(sent!.get("grant_type"), "authorization_code");
    assert.equal(pkceChallenge(sent!.get("code_verifier")!), u.searchParams.get("code_challenge"));
    await assert.rejects(finishSignIn(cfg, "code", state), /expired/);  // a state works once
    assert.deepEqual(youtubeStatus(cfg), { configured: true, connected: true, email: "me@example.com" });
  } finally {
    globalThis.fetch = real;
    if (env.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = env.id;
    if (env.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = env.secret;
  }
});

test("youtube: the draft has a clean title and chapters YouTube accepts", async () => {
  const { draft, chapters, cleanTitle } = await import("../src/youtube.ts");
  const p: Plan = { title: "widget", repo: "acme/widget", url: "https://github.com/acme/widget", tag: "", beats: [
    { title: "The hook", scenes: [scene(["A tiny widget server.", "It does one thing."])] },
    { title: "How <it> works", scenes: [scene(["Third."])] },
    { title: "Run it", scenes: [scene(["Fourth."])] },
  ] };
  const t = layout(p, [12, 12, 12, 12]);
  assert.deepEqual(chapters(p, t), ["0:00 The hook", `0:${String(Math.floor(t.scenes[1].start)).padStart(2, "0")} How it works`, `0:${Math.floor(t.scenes[2].start)} Run it`]);
  const d = draft(p, t);
  assert.equal(d.title, "widget, explained in 1 minute");
  assert.ok(d.description.startsWith("A tiny widget server. It does one thing.\n\nhttps://github.com/acme/widget\n\nChapters\n0:00 The hook"));
  assert.ok(!d.description.includes("<"));
  assert.deepEqual(chapters(p, layout(p, [2, 2, 2, 2])), []);  // chapters under 10 s are left out
  assert.equal(cleanTitle("x".repeat(150)).length, 100);
});

test("youtube: a resumable upload carries on from where YouTube says it got to", async () => {
  const { youtubeConfig, uploadVideo } = await import("../src/youtube.ts");
  const { writeFileSync } = await import("node:fs");
  process.env.GOOGLE_CLIENT_ID = "cid"; process.env.GOOGLE_CLIENT_SECRET = "secret";
  const dir = mkdtempSync(join(tmpdir(), "vg-up-"));
  const cfg = youtubeConfig("http://localhost:4319", dir)!;
  (await import("node:fs")).mkdirSync(cfg.tokenDir, { recursive: true });
  writeFileSync(cfg.tokenFile, JSON.stringify({ access_token: "old", refresh_token: "r", expires_at: 0 }));  // expired: must refresh first
  const film = join(dir, "film.mp4");
  writeFileSync(film, Buffer.alloc(9 * 1024 * 1024, 1));  // two pieces of 8 MB and 1 MB
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) { calls.push("refresh"); return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 })); }
    if (u.includes("uploadType=resumable")) {
      calls.push(`start ${init.headers.authorization} ${JSON.parse(init.body).status.privacyStatus}`);
      return new Response("", { status: 200, headers: { location: "https://upload.example/session" } });
    }
    const range = init.headers["content-range"];
    calls.push(`put ${range}`);
    if (range.startsWith("bytes 0-")) return new Response("", { status: 308, headers: { range: "bytes=0-8388607" } });
    return new Response(JSON.stringify({ id: "abc123", status: { privacyStatus: "private" } }), { status: 200 });
  }) as typeof fetch;
  const seen: number[] = [];
  try {
    const v = await uploadVideo(cfg, film, { title: "T", description: "D", privacy: "unlisted" }, (f) => seen.push(f));
    assert.deepEqual(calls, ["refresh", "start Bearer fresh unlisted", "put bytes 0-8388607/9437184", "put bytes 8388608-9437183/9437184"]);
    assert.equal(v.url, "https://youtu.be/abc123");
    assert.equal(v.privacy, "private");      // YouTube kept it private (an unaudited project)
    assert.equal(v.requested, "unlisted");
    assert.deepEqual(seen.map((f) => Math.round(f * 100)), [0, 89, 100]);
  } finally {
    globalThis.fetch = real;
    delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
  }
});

test("youtube: a stuck upload gives up, a 401 refreshes once, titles keep emoji whole, other accounts are refused", async () => {
  const { youtubeConfig, uploadVideo, cleanTitle, authUrl, finishSignIn } = await import("../src/youtube.ts");
  const { writeFileSync } = await import("node:fs");
  assert.equal(cleanTitle("a".repeat(98) + "😀😀😀"), "a".repeat(98) + "😀…");
  process.env.GOOGLE_CLIENT_ID = "cid"; process.env.GOOGLE_CLIENT_SECRET = "secret";
  const dir = mkdtempSync(join(tmpdir(), "vg-up2-"));
  const cfg = youtubeConfig("http://localhost:4319", dir)!;
  const film = join(dir, "film.mp4");
  writeFileSync(film, Buffer.alloc(1024, 1));
  const real = globalThis.fetch, realTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void) => realTimeout(fn, 0);  // skip the back-off waits
  try {
    // YouTube keeps answering 308 without taking anything: give up instead of looping forever
    (await import("node:fs")).mkdirSync(cfg.tokenDir, { recursive: true });
    writeFileSync(cfg.tokenFile, JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 }));
    let puts = 0;
    globalThis.fetch = (async (url: string) => String(url).includes("uploadType") ? new Response("", { headers: { location: "https://u/s" } }) : (puts++, new Response("", { status: 308 }))) as typeof fetch;
    await assert.rejects(uploadVideo(cfg, film, { title: "t", description: "", privacy: "private" }), /kept failing/);
    assert.ok(puts <= 7, `stopped after ${puts} tries`);
    // a token that runs out mid-upload is refreshed once and the piece is sent again
    const seen: string[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) { seen.push("refresh"); return new Response(JSON.stringify({ access_token: "b", expires_in: 3600 })); }
      if (u.includes("uploadType")) return new Response("", { headers: { location: "https://u/s" } });
      seen.push(`put ${init.headers.authorization}`);
      return init.headers.authorization === "Bearer a" ? new Response("", { status: 401 }) : new Response(JSON.stringify({ id: "v1" }), { status: 201 });
    }) as typeof fetch;
    const v = await uploadVideo(cfg, film, { title: "t", description: "", privacy: "private" });
    assert.deepEqual(seen, ["put Bearer a", "refresh", "put Bearer b"]);
    assert.equal(v.id, "v1");
    // GOOGLE_ALLOWED_EMAIL: another account is revoked and refused
    process.env.GOOGLE_ALLOWED_EMAIL = "me@example.com";
    const { state } = authUrl(cfg);
    const idToken = "x." + Buffer.from(JSON.stringify({ email: "someone@else.com" })).toString("base64url") + ".y";
    let revoked = false;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/revoke")) { revoked = true; return new Response(""); }
      return new Response(JSON.stringify({ access_token: "c", refresh_token: "d", scope: "openid email https://www.googleapis.com/auth/youtube.upload", id_token: idToken }));
    }) as typeof fetch;
    await assert.rejects(finishSignIn(cfg, "code", state), (e: any) => e.code === "account");
    assert.ok(revoked);
  } finally {
    globalThis.fetch = real; (globalThis as any).setTimeout = realTimeout;
    delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; delete process.env.GOOGLE_ALLOWED_EMAIL;
  }
});

test("youtube: every browser has its own connection", async () => {
  const { youtubeConfig, forBrowser, youtubeStatus } = await import("../src/youtube.ts");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  process.env.GOOGLE_CLIENT_ID = "cid"; process.env.GOOGLE_CLIENT_SECRET = "secret";
  try {
    const cfg = youtubeConfig("http://localhost:4319", mkdtempSync(join(tmpdir(), "vg-who-")))!;
    const a = forBrowser(cfg, "a".repeat(43)), b = forBrowser(cfg, "b".repeat(43));
    assert.notEqual(a.tokenFile, b.tokenFile);
    assert.ok(!a.tokenFile.includes("aaaa"));  // the browser id itself is never written to disk
    mkdirSync(cfg.tokenDir, { recursive: true });
    writeFileSync(a.tokenFile, JSON.stringify({ access_token: "x", refresh_token: "y", expires_at: 0, email: "a@example.com" }));
    assert.equal(youtubeStatus(a).email, "a@example.com");
    assert.equal(youtubeStatus(b).connected, false);
  } finally {
    delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
  }
});

test("youtube: a film remembers where it was posted", async () => {
  const { recordPost, lastPost } = await import("../src/youtube.ts");
  const dir = mkdtempSync(join(tmpdir(), "vg-post-"));
  assert.equal(lastPost(dir), null);
  recordPost(dir, { id: "abc123def45", url: "", studio: "", privacy: "unlisted", requested: "unlisted" }, "me@example.com");
  recordPost(dir, { id: "zzz999yyy88", url: "", studio: "", privacy: "private", requested: "public" });
  const p = lastPost(dir)!;
  assert.equal(p.url, "https://youtu.be/zzz999yyy88");
  assert.equal(p.studio, "https://studio.youtube.com/video/zzz999yyy88/edit");
  assert.equal(JSON.parse(readFileSync(join(dir, "youtube.json"), "utf8")).posts.length, 2);
});
