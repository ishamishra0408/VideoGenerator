#!/usr/bin/env node
// videogen on the command line.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MINUTES, type Minutes } from "./config.ts";
import { loadEnv } from "./env.ts";
import { runJob, type Progress } from "./pipeline.ts";

const HELP = `videogen: turn a repo into a 1 to 4 minute narrated explainer film.

  node src/cli.ts --repo <owner/name | GitHub URL | folder> [options]
  node src/cli.ts --serve                 open the web page instead

  --minutes 1|2|3|4     length (default 2). With --script, your words set the length.
  --script <file>       your narration, kept word for word. Markdown headings hint where chapters go.
  --adapt               fit --script to --minutes instead of keeping every word
  --brief <text>        direction for the writer, such as "for a hiring manager"
  --theme <name|link>   a 21st.dev community theme, e.g. vintage-paper (default: gitdiagram)
  --mode light|dark     the theme's light or dark version (default light)
  --themes              list the 21st.dev themes
  --voice gemini|say    Gemini 3.8 Flash TTS, Charon (default), or macOS say offline
  --model <slug>        OpenRouter model for the script (default anthropic/claude-sonnet-5.5)
  --storyboard-only     stop after writing storyboard.json
  --from <file>         film an existing storyboard.json, skipping reading and writing
  --stills <t,t,...>    PNG stills at those seconds instead of the film
  --out <dir>           output folder (default out/<name>-<n>min)
  --fps <n>             frames a second (default 25)
  --workers <n>         Chrome tabs filming in parallel, 1 to 8 (default up to 4)
  --env <file>          read keys from this .env file (default ./.env); repeat for more, first wins
`;

const { values: a } = parseArgs({
  options: {
    repo: { type: "string" }, minutes: { type: "string" }, script: { type: "string" }, adapt: { type: "boolean" },
    brief: { type: "string" }, voice: { type: "string" }, model: { type: "string" }, "storyboard-only": { type: "boolean" },
    from: { type: "string" }, stills: { type: "string" }, out: { type: "string" }, fps: { type: "string" },
    workers: { type: "string" }, env: { type: "string", multiple: true }, serve: { type: "boolean" }, help: { type: "boolean", short: "h" },
    theme: { type: "string" }, mode: { type: "string" }, themes: { type: "boolean" },
  },
});

function fail(msg: string): never {
  console.error(`videogen: ${msg}`);
  process.exit(1);
}

if (a.help) { console.log(HELP); process.exit(0); }
for (const f of a.env ?? [".env"]) loadEnv(f);  // the first file to set a key wins
if (a.serve) {
  await import("./server.ts");
} else if (a.themes) {
  const { listThemes } = await import("./theme.ts");
  const { CACHE_DIR } = await import("./config.ts");
  const list = await listThemes(CACHE_DIR);
  if (!list.length) fail("Couldn't read the theme list from 21st.dev.");
  console.log("gitdiagram (default)\n" + list.map((t) => `${t.slug.padEnd(20)} ${t.name}, by @${t.author}`).join("\n"));
} else {
  if (!a.repo && !a.from) { console.log(HELP); process.exit(1); }
  const minutes = a.minutes ? Number(a.minutes) : undefined;
  if (minutes !== undefined && !MINUTES.includes(minutes as Minutes)) fail("--minutes takes 1, 2, 3 or 4.");
  if (a.voice && a.voice !== "gemini" && a.voice !== "say") fail("--voice takes gemini or say.");
  if (a.adapt && !a.script) fail("--adapt needs --script.");
  if (a.mode && a.mode !== "light" && a.mode !== "dark") fail("--mode takes light or dark.");
  const fps = a.fps === undefined ? undefined : Number(a.fps);
  if (fps !== undefined && !(Number.isInteger(fps) && fps >= 1 && fps <= 60)) fail("--fps takes a whole number from 1 to 60.");
  const workers = a.workers === undefined ? undefined : Number(a.workers);
  if (workers !== undefined && !(Number.isInteger(workers) && workers >= 1 && workers <= 8)) fail("--workers takes 1 to 8.");

  let last = "", decile = -1;
  const tty = process.stdout.isTTY;
  const report = (p: Progress) => {
    const line = `${p.stage.padEnd(10)} ${p.message}`;
    if (p.stage === "render" && p.fraction !== undefined && p.fraction > 0 && p.fraction < 1) {
      if (tty) { process.stdout.write(`\r${line}\x1b[K`); last = "render"; return; }
      if (Math.floor(p.fraction * 10) === decile) return;  // logs get a line every tenth
      decile = Math.floor(p.fraction * 10);
    }
    if (last === "render" && tty) process.stdout.write("\n");
    console.log(line);
    last = p.stage;
  };

  try {
    const res = await runJob({
      repo: a.repo,
      minutes: minutes as Minutes | undefined,
      script: a.script ? readFileSync(a.script, "utf8") : undefined,
      adapt: a.adapt,
      brief: a.brief,
      plan: a.from ? JSON.parse(readFileSync(a.from, "utf8")) : undefined,
      storyboardOnly: a["storyboard-only"],
      voice: a.voice as "gemini" | "say" | undefined,
      theme: a.theme,
      themeMode: a.mode as "light" | "dark" | undefined,
      model: a.model,
      fps,
      workers,
      outDir: a.out,
      stills: a.stills ? a.stills.split(",").map(Number).filter((n) => Number.isFinite(n)) : undefined,
    }, report);
    for (const w of res.warnings) console.log(`note       ${w}`);
    if (res.captions) console.log(`captions   ${res.captions}`);
    console.log(`folder     ${res.dir}`);
  } catch (e) {
    fail((e as Error).message);
  }
}
