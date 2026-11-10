// The storyboard: beats, scenes, the narration each scene carries, and what lands on screen.
import type { Screen } from "./capture.ts";
import { BEATS_FOR, BUDGET_TOLERANCE, WPM, type Minutes, wordBudget } from "./config.ts";
import { contextToText, type RepoContext } from "./github.ts";
import { extractJson, type Block, type Message } from "./llm.ts";
import { countWords, stripMarkdown } from "./sentences.ts";

export const KINDS = ["title", "statement", "cards", "flow", "code", "tree", "stats", "compare", "checklist", "screen"] as const;
export type Kind = (typeof KINDS)[number];

/** `box`: on a screen scene, what the callout points at, as x, y, width, height in the screenshot's pixels. */
export interface Item { title: string; text?: string; tag?: string; on?: number; box?: [number, number, number, number] }
/** A screenshot as a scene shows it: `src` is inside the film's folder. */
export interface Shot { src: string; url?: string; title?: string; w: number; h: number }
export interface Scene { kind: Kind; eyebrow?: string; heading: string; lines: string[]; items: Item[]; code?: { file?: string; text: string }; screen?: Shot }
export interface Beat { title: string; scenes: Scene[] }
export interface Plan { title: string; repo: string; url?: string; tag: string; beats: Beat[] }

/** How many items each kind of scene can carry. */
export const LIMITS: Record<Kind, [number, number]> = {
  title: [0, 4], statement: [0, 3], cards: [2, 4], flow: [2, 5], code: [0, 3],
  tree: [3, 9], stats: [2, 4], compare: [2, 2], checklist: [2, 5], screen: [0, 3],
};

export interface PlanRequest {
  context: RepoContext;
  minutes: Minutes;
  /** The user's script, split into sentences, kept word for word. */
  script?: string[];
  /** Section headings from the user's script, as hints for where beats fall. */
  scriptHeadings?: string[];
  /** The script's [On screen: …] notes, with the sentences they cover. */
  scriptNotes?: { from: number; to: number; heading: string | null; notes: string[] }[];
  /** The user's script as raw text, to be tightened to the chosen length instead of kept verbatim. */
  adapt?: string;
  /** Extra direction for the writer, such as the audience. */
  brief?: string;
  /** Screenshots of the app; `data` is the JPEG, base64, for the writer to look at. */
  screens?: (Screen & { data?: string })[];
  /** Where the screenshots were taken, such as http://localhost:5173/. */
  app?: string;
}

const ARCS: Record<number, string> = {
  3: "1) a hook and what it is, 2) how it works, 3) how to use it, then a one-line close.",
  4: "1) a hook and what it is, 2) how it works, 3) the most interesting design decision, 4) how to run it, then a close.",
  5: "1) a hook, 2) what it is and who it's for, 3) how it works, 4) the key parts or a design decision, 5) how to run it, then a close.",
  6: "1) a hook, 2) what it is and who it's for, 3) how it works end to end, 4) the key parts in the code, 5) a design decision and its trade-off, 6) how to run it, then a close.",
};

const SYSTEM = `You write and storyboard short narrated explainer films about software repositories, in the style of GitDiagram's explainers: a warm, confident senior engineer tells a smart colleague the story of a project, and every idea lands on screen at the moment it is spoken.

Return one JSON object and nothing else, shaped like this:
{
  "beats": [
    {
      "title": "How it works",
      "scenes": [
        {
          "kind": "flow",
          "eyebrow": "THE PIPELINE",
          "heading": "From repo to *diagram*",
          "lines": ["First sentence the narrator speaks over this scene.", "Second sentence."],
          "items": [{ "tag": "STEP 1", "title": "Fetch the tree", "text": "File list and README from GitHub", "on": 0 }],
          "code": { "file": "src/example.ts", "text": "only for kind code" }
        }
      ]
    }
  ]
}

Fields:
- beat "title": the progress-rail label, 1 to 3 words.
- "eyebrow": a small label above the heading, 1 to 4 words.
- "heading": at most 7 words. Wrap one or two words in *asterisks* for an italic accent.
- "lines": the narration spoken while the scene is on screen, 1 to 4 sentences.
- "on" (per item, optional): the 0-based index of the sentence in "lines" that mentions the item. The item appears as that sentence is spoken. Give it for every item in a scene or for none.

Scene kinds and their items:
- title: the opening card. heading = the project's name or a 3 to 6 word tagline. items: 0 to 4 short chips (title only), such as the language, the licence, the one-line purpose.
- statement: one big idea on its own, carried by the heading. items: 0 to 3 chips.
- cards: 2 to 4 parallel ideas such as features, components or users. tag, title, text.
- flow: 2 to 5 steps or components joined left to right, in the order data or control moves. tag, title, text.
- code: a real excerpt from the files in the context, copied character for character, 4 to 12 lines, in "code.text" with \\n line breaks and "code.file" set to its path. items: 0 to 3 callouts (title, text) about lines in it.
- tree: 3 to 9 real paths, files or folders, exactly as they appear in the repository tree. title = the path, text = what lives there, under 8 words.
- stats: 2 to 4 facts whose title is a number or a short value, text = what it measures. Only values that appear in the context.
- compare: exactly 2 items, before then after (or without then with). tag = "BEFORE" and "AFTER" or similar, title = one sentence of at most 14 words, may use *asterisks*.
- checklist: 2 to 5 steps to run or use the project, in order. title = the step, text = the command or detail.

Narration rules:
- Spoken English for a listener: contractions, varied rhythm, 8 to 24 words a sentence.
- Plain text only: no markdown, no lists, no em dashes, no emoji, no URLs. Don't read file paths aloud; name the thing ("the voice module") and let the screen show the path.
- Every claim comes from the repository context. Never invent features, numbers, benchmarks, users, star counts or history. Leave out what the context doesn't support.
- Talk to the viewer as a colleague. No hype words such as revolutionary, seamless, game-changing or powerful.

Visual rules:
- Open with a title or statement scene. Never use the same kind in two scenes in a row. Use a flow at least once.
- Use code only where a snippet is genuinely telling.
- Items are labels, not sentences: titles under 6 words, text under 12 words, tags under 3 words.
- Each scene shows what its lines say, in the same order they say it.`;

export function buildPrompt(req: PlanRequest): { system: string; user: string } {
  const beats = BEATS_FOR[req.minutes];
  const scenes = Math.round(req.minutes * 3.5);  // a new picture every 15 to 20 seconds
  const parts = [`Repository context:\n<context>\n${contextToText(req.context)}\n</context>`];
  if (req.script) {
    const numbered = req.script.map((s, i) => `${i}: ${s}`).join("\n");
    const hints = req.scriptHeadings?.length ? ` The script's own headings were: ${req.scriptHeadings.join("; ")}.` : "";
    parts.push(
      `The narration is fixed: it is this script, split into numbered sentences.\n<script>\n${numbered}\n</script>\n\n` +
        `Do not write narration. In every scene, "lines" is an array of sentence numbers instead of text. ` +
        `Use every sentence exactly once and in order, so that reading the scenes first to last gives 0, 1, 2 and so on up to ${req.script.length - 1}. ` +
        `Make about ${beats} beats and ${Math.max(scenes, Math.ceil(req.script.length / 3))} scenes, breaking where the script's topic changes.${hints} ` +
        `"on" indexes into the scene's own "lines" array. The visuals must show what those sentences say.`,
    );
    if (req.scriptNotes?.length)
      parts.push(
        `The script's author noted what should be on screen. Use these notes to choose the scenes' kinds and items for the sentences they cover; what they describe may be shown even where the repository context doesn't mention it.\n` +
          req.scriptNotes.map((n) => `- sentences ${n.from} to ${n.to}${n.heading ? ` (${n.heading})` : ""}: ${n.notes.join(" ")}`).join("\n"),
      );
  } else {
    const budget = wordBudget(req.minutes);
    const lo = Math.round(budget * (1 - BUDGET_TOLERANCE)), hi = Math.round(budget * (1 + BUDGET_TOLERANCE));
    parts.push(
      `Make a ${req.minutes}-minute film: ${beats} beats and about ${scenes} scenes in total. ` +
        `The narration must total about ${budget} words, between ${lo} and ${hi}; the voice speaks about ${WPM} words a minute, so this sets the length.\n` +
        `Story: ${ARCS[beats]}`,
    );
    if (req.adapt) parts.push(`Base the narration on this script. Keep its meaning, its order and its phrasing where it fits, and tighten or expand it to the word count above.\n<script>\n${req.adapt.trim()}\n</script>`);
  }
  if (req.screens?.length) parts.push(screensText(req.screens, req.app));
  if (req.brief) parts.push(`Direction from the person making the film: ${req.brief}`);
  return { system: SYSTEM, user: parts.join("\n\n") };
}

/** The screenshots as the writer reads them: what each is, and the things on it a callout can point at. */
function screensText(screens: Screen[], app?: string): string {
  const list = screens.map((s) => {
    const u = s.url ? new URL(s.url) : null;
    const head = `${s.id}: "${s.title}", ${u ? `the page ${u.pathname}${u.search}${u.hash}` : "an uploaded picture"}, ${s.w}×${s.h}`;
    if (!s.regions.length) return `${head}. Its callouts can't point at a place: give them no region.`;
    return `${head}. On it:\n` + s.regions.map((r) => `  ${r.id} ${r.label} at x ${r.x}, y ${r.y}, ${r.w}×${r.h}`).join("\n");
  });
  return `Screenshots of the app itself${app ? `, taken from it running at ${app}` : ""}, are attached above, in this order, each labelled with its id:\n${list.join("\n")}\n\n` +
    `There is one more scene kind, for these:\n` +
    `- screen: one of the screenshots, shown in a browser window. Set "screen" to its id, such as "s1". items: 0 to 3 callouts about what the lines mention, ` +
    `each with a title (under 6 words), text (under 12 words), "on", and "region": the id of the thing it points at on that screenshot, such as "r4". ` +
    `The picture zooms onto each region as its callout appears, so list them in the order the lines mention them.\n` +
    `Use a screen scene wherever the narration is about what someone sees or does in the app: it's the most convincing picture there is, so show at least ${Math.min(2, screens.length)} of the screenshots. ` +
    `Screen scenes may follow one another. Say only what a screenshot shows or the repository supports.`;
}

// ---------- checking what came back ----------

export interface Checked { plan?: Plan; problems: string[]; warnings: string[] }

const str = (v: unknown, max: number): string => {
  if (typeof v !== "string" && typeof v !== "number") return "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
};

/** A narration line made safe to speak: plain text, no dashes the voice would stumble on, closing punctuation. */
export function cleanLine(s: string): string {
  let t = stripMarkdown(s).replace(/\s*[—–]\s*/g, ", ").replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();
  if (t && !/[.!?…]["”’)]?$/.test(t)) t += ".";
  return t;
}

/** Labels keep *emphasis* but lose other markdown. */
const cleanLabel = (s: string) => s.replace(/`([^`]*)`/g, "$1").replace(/\*\*(.*?)\*\*/g, "$1").replace(/^#+\s*/, "");

/** Code on screen: at most 14 lines of at most 92 characters. */
const capCode = (text: string) => text.replace(/\t/g, "  ").replace(/\s+$/, "").split("\n").slice(0, 14).map((l) => (l.length > 92 ? l.slice(0, 91) + "…" : l)).join("\n");

const normPath = (p: string) => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");

function pathExists(p: string, ctx: RepoContext): boolean {
  const n = normPath(p);
  if (!n) return false;
  return ctx.paths.some((q) => q === n || q.startsWith(n + "/"));
}

/** Share of a snippet's meaningful lines that appear in the files the writer was shown. */
export function codeOverlap(code: string, ctx: RepoContext): number {
  const corpus = [ctx.readme ?? "", ...ctx.files.map((f) => f.text)].join("\n");
  const lines = code.split("\n").map((l) => l.trim()).filter((l) => l.length >= 4);
  if (!lines.length) return 0;
  return lines.filter((l) => corpus.includes(l)).length / lines.length;
}

function downgrade(scene: Scene): Scene {
  // A scene without what its kind needs becomes the nearest kind that still works.
  const n = scene.items.length;
  const items = scene.items.map(({ box, ...i }) => i);
  if (n >= 2) return { ...scene, kind: "cards", items: items.slice(0, 4), code: undefined, screen: undefined };
  return { ...scene, kind: "statement", items: items.slice(0, 3).map((i) => ({ title: i.title })), code: undefined, screen: undefined };
}

/** Checks and tidies a storyboard. Problems go back to the writer; on the final attempt they're fixed here instead. */
export function checkPlan(raw: unknown, req: PlanRequest, final = false): Checked {
  const problems: string[] = [];
  const warnings: string[] = [];
  const beatsRaw = (raw as { beats?: unknown })?.beats;
  if (!Array.isArray(beatsRaw) || !beatsRaw.length) return { problems: ['There is no non-empty "beats" array.'], warnings };

  const verbatim = !!req.script;
  const claimed: number[][] = [];
  const beats: Beat[] = [];

  beatsRaw.forEach((b: any, bi: number) => {
    const scenesRaw = Array.isArray(b?.scenes) ? b.scenes : [];
    if (!scenesRaw.length) { problems.push(`Beat ${bi + 1} has no scenes.`); return; }
    const scenes: Scene[] = [];
    scenesRaw.forEach((s: any, si: number) => {
      const where = `beat ${bi + 1}, scene ${si + 1}`;
      let kind: Kind = KINDS.includes(s?.kind) ? s.kind : "cards";
      if (!KINDS.includes(s?.kind)) warnings.push(`${where}: unknown kind "${s?.kind}", using cards.`);

      let lines: string[] = [];
      if (verbatim) {
        const idx = (Array.isArray(s?.lines) ? s.lines : []).map(Number).filter((n: number) => Number.isInteger(n));
        claimed.push(idx);
        lines = idx.map((n: number) => req.script![n] ?? "");
      } else {
        lines = (Array.isArray(s?.lines) ? s.lines : []).map((l: unknown) => cleanLine(str(l, 4000))).filter(Boolean);
        if (!lines.length) problems.push(`${where} has no narration lines.`);
        for (const l of lines) if (countWords(l) > 40) warnings.push(`${where}: a ${countWords(l)}-word sentence.`);
      }

      const regionOf = new Map<Item, string>();
      let items: Item[] = (Array.isArray(s?.items) ? s.items : []).map((it: any) => {
        const item: Item = { title: cleanLabel(str(it?.title ?? it, 90)) };
        const text = cleanLabel(str(it?.text, 140)); if (text) item.text = text;
        const tag = str(it?.tag, 28); if (tag) item.tag = tag;
        if (Number.isInteger(it?.on)) item.on = it.on;
        if (it?.region !== undefined) regionOf.set(item, str(it.region, 12));
        return item;
      }).filter((i: Item) => i.title);

      const [lo, hi] = LIMITS[kind];
      if (items.length > hi) { warnings.push(`${where}: ${items.length} items for a ${kind}, keeping ${hi}.`); items = items.slice(0, hi); }

      let scene: Scene = { kind, heading: cleanLabel(str(s?.heading, 90)) || str(b?.title, 40) || "…", lines, items };
      const eyebrow = str(s?.eyebrow, 40); if (eyebrow) scene.eyebrow = eyebrow;

      if (kind === "code") {
        const text = typeof s?.code?.text === "string" ? s.code.text.replace(/\t/g, "  ").replace(/\s+$/, "") : "";

        if (!text.trim()) { problems.push(`${where} is a code scene with no code.text.`); if (final) scene = downgrade(scene); }
        else if (codeOverlap(text, req.context) < 0.6) {
          problems.push(`${where}: the code isn't copied from the files in the context. Copy a real excerpt exactly, or use another kind.`);
          if (final) scene = downgrade(scene);
        } else scene.code = { file: str(s?.code?.file, 80) || undefined, text: capCode(text) };
      }
      if (kind === "screen") {
        const id = str(s?.screen, 12), shot = req.screens?.find((x) => x.id === id);
        if (!shot) {
          problems.push(req.screens?.length ? `${where}: "screen" must be one of ${req.screens.map((x) => x.id).join(", ")}.` : `${where}: there are no screenshots, so use another kind.`);
          if (final) scene = downgrade(scene);
        } else {
          scene.screen = { src: shot.file, url: shot.url, title: shot.title, w: shot.w, h: shot.h };
          for (const it of scene.items) {
            const rid = regionOf.get(it), r = rid ? shot.regions.find((x) => x.id === rid) : undefined;
            if (r) it.box = [r.x, r.y, r.w, r.h];
            else if (rid) warnings.push(`${where}: ${shot.id} has no region ${rid}, so "${it.title}" points at nothing.`);
          }
        }
      }
      if (scene.kind === "tree") {
        const isDir = (p: string) => req.context.paths.some((q) => q.startsWith(normPath(p) + "/"));
        const real = scene.items.filter((i) => pathExists(i.title, req.context)).map((i) => ({ ...i, title: normPath(i.title) + (isDir(i.title) ? "/" : "") }))
          .filter((i, k, all) => all.findIndex((j) => j.title === i.title) === k);
        if (real.length < scene.items.length) {
          const gone = scene.items.filter((i) => !pathExists(i.title, req.context)).map((i) => i.title);
          problems.push(`${where}: these paths aren't in the repository tree: ${gone.join(", ")}.`);
        }
        scene.items = real;
        if (real.length < LIMITS.tree[0] && final) scene = downgrade(scene);
      }
      if (scene.items.length < LIMITS[scene.kind][0]) {
        problems.push(`${where}: a ${scene.kind} needs at least ${LIMITS[scene.kind][0]} items.`);
        if (final) scene = downgrade(scene);
      }
      if (scene.kind === "compare") scene.items = scene.items.slice(0, 2);

      // "on" counts only when every item has a valid one.
      const L = scene.lines.length;
      if (!scene.items.every((i) => Number.isInteger(i.on) && i.on! >= 0 && i.on! < L)) scene.items.forEach((i) => delete i.on);
      scenes.push(scene);
    });
    if (scenes.length) beats.push({ title: str(b?.title, 22) || `Part ${bi + 1}`, scenes });
  });

  if (!beats.length) return { problems, warnings };
  const plan: Plan = { title: req.context.name, repo: req.context.id, url: req.context.url, tag: "", beats };
  const allScenes = beats.flatMap((b) => b.scenes);

  if (verbatim) {
    const flat = claimed.flat();
    const n = req.script!.length;
    const inOrder = flat.length === n && flat.every((v, i) => v === i);
    if (!inOrder) {
      problems.push(`The scenes' sentence numbers must read 0 to ${n - 1} in order, each once; they read ${flat.join(",")}.`);
      if (final) {
        redistribute(allScenes, claimed, req.script!);
        warnings.push("Re-spread the script across the scenes in order, keeping the writer's visuals.");
      }
    }
    for (const sc of allScenes) if (!sc.lines.length || sc.lines.some((l) => !l)) {
      if (!final) problems.push("Every scene needs at least one valid sentence number.");
    }
  } else {
    const words = allScenes.reduce((a, sc) => a + sc.lines.reduce((x, l) => x + countWords(l), 0), 0);
    const budget = wordBudget(req.minutes);
    if (Math.abs(words - budget) > budget * BUDGET_TOLERANCE) {
      const msg = `The narration is ${words} words; it must be ${Math.round(budget * (1 - BUDGET_TOLERANCE))} to ${Math.round(budget * (1 + BUDGET_TOLERANCE))} (target ${budget}).`;
      if (final) warnings.push(msg); else problems.push(msg);
    }
    const want = BEATS_FOR[req.minutes];
    if (beats.length !== want) (final ? warnings : problems).push(`There are ${beats.length} beats; make ${want}.`);
  }
  for (let i = 1; i < allScenes.length; i++)
    if (allScenes[i].kind === allScenes[i - 1].kind && allScenes[i].kind !== "screen") warnings.push(`Two ${allScenes[i].kind} scenes in a row.`);

  // Final pass: drop scenes left with nothing to say, and beats left with no scenes.
  if (final) {
    plan.beats = plan.beats.map((b) => ({ ...b, scenes: b.scenes.filter((s) => s.lines.length && s.lines.every(Boolean)) })).filter((b) => b.scenes.length);
    if (!plan.beats.length) return { problems: [...problems, "No scene has narration."], warnings };
  }
  return { plan, problems, warnings };
}

/** Spreads the script over the scenes in order, each scene keeping roughly the share it claimed. */
export function redistribute(scenes: Scene[], claimed: number[][], script: string[]): void {
  const want = scenes.map((_, i) => Math.max(1, claimed[i]?.length ?? 1));
  const total = want.reduce((a, b) => a + b, 0);
  const n = script.length;
  let k = 0;
  scenes.forEach((sc, i) => {
    const left = scenes.length - i - 1;
    const share = i === scenes.length - 1 ? n - k : Math.max(1, Math.min(n - k - left, Math.round((want[i] / total) * n)));
    sc.lines = script.slice(k, k + share);
    k += share;
    sc.items.forEach((it) => delete it.on);
  });
}

export const planWords = (p: Plan) => p.beats.flatMap((b) => b.scenes).reduce((a, s) => a + s.lines.reduce((x, l) => x + countWords(l), 0), 0);
export const planLines = (p: Plan) => p.beats.flatMap((b) => b.scenes.flatMap((s) => s.lines));

/** Writes, checks and repairs a storyboard: up to two rounds of feedback, then fixes what's left itself. */
export async function makePlan(
  req: PlanRequest,
  ask: (system: string, messages: Message[]) => Promise<string>,
  log: (s: string) => void = () => {},
): Promise<{ plan: Plan; warnings: string[] }> {
  const { system, user } = buildPrompt(req);
  const pictures: Block[] = (req.screens ?? []).filter((s) => s.data).flatMap((s): Block[] => [
    { type: "text", text: `Screenshot ${s.id}: ${s.title}` },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: s.data! } },
  ]);
  const messages: Message[] = [{ role: "user", content: pictures.length ? [...pictures, { type: "text", text: user }] : user }];
  const ROUNDS = 3;
  for (let attempt = 0; attempt < ROUNDS; attempt++) {
    const final = attempt === ROUNDS - 1;
    const reply = await ask(system, messages);
    let res: Checked;
    try { res = checkPlan(extractJson(reply), req, final); }
    catch { res = { problems: ["The reply wasn't valid JSON. Return only the JSON object."], warnings: [] }; }
    if (res.plan && (!res.problems.length || final)) return { plan: res.plan, warnings: res.warnings };
    log(`storyboard: ${res.problems.length} thing(s) to fix, asking again`);
    messages.push({ role: "assistant", content: reply }, { role: "user", content: `Fix these and return the whole JSON object again:\n- ${res.problems.join("\n- ")}` });
  }
  throw new Error("The writer didn't return a usable storyboard.");
}

/** A screen scene's picture: a JPEG, PNG or WebP in the film's screens folder, and its size. */
function shotShape(v: any, where: string): Shot {
  const src = typeof v?.src === "string" ? v.src.trim() : "";
  if (!/^screens\/[\w.-]+\.(jpe?g|png|webp)$/i.test(src) || src.includes("..")) throw new Error(`${where}: a screen scene needs screen.src, a picture in the film's screens folder.`);
  const w = Number(v.w), h = Number(v.h);
  if (!(w > 0 && h > 0 && w <= 10_000 && h <= 10_000)) throw new Error(`${where}: a screen scene needs the picture's width and height.`);
  const shot: Shot = { src, w: Math.round(w), h: Math.round(h) };
  if (typeof v.url === "string" && /^https?:\/\//.test(v.url)) shot.url = v.url.slice(0, 300);
  if (v.title) shot.title = str(v.title, 120);
  return shot;
}

/** A storyboard that came from a file or the web page: checked for shape, tidied, never rewritten. */
export function validatePlanShape(raw: any): Plan {
  if (!raw || !Array.isArray(raw.beats) || !raw.beats.length) throw new Error("The storyboard has no beats.");
  const beats: Beat[] = raw.beats.map((b: any, bi: number) => {
    if (!Array.isArray(b?.scenes) || !b.scenes.length) throw new Error(`Beat ${bi + 1} has no scenes.`);
    return {
      title: str(b.title, 22) || `Part ${bi + 1}`,
      scenes: b.scenes.map((s: any, si: number) => {
        const where = `Beat ${bi + 1}, scene ${si + 1}`;
        if (!KINDS.includes(s?.kind)) throw new Error(`${where}: unknown kind "${s?.kind}".`);
        const lines = (Array.isArray(s.lines) ? s.lines : []).map((l: unknown) => str(l, 4000)).filter(Boolean);
        if (!lines.length) throw new Error(`${where} has no narration.`);
        const items: Item[] = (Array.isArray(s.items) ? s.items : []).map((it: any) => {
          const item: Item = { title: str(it?.title, 90) };
          if (it?.text) item.text = str(it.text, 140);
          if (it?.tag) item.tag = str(it.tag, 28);
          if (Number.isInteger(it?.on)) item.on = it.on;
          if (s.kind === "screen" && Array.isArray(it?.box) && it.box.length === 4 && it.box.every((v: unknown) => Number.isFinite(v) && (v as number) >= 0)) item.box = it.box.map(Math.round);
          return item;
        }).filter((i: Item) => i.title);
        const [lo] = LIMITS[s.kind as Kind];
        if (items.length < lo) throw new Error(`${where}: a ${s.kind} needs at least ${lo} items.`);
        if (!items.every((i) => i.on !== undefined && i.on >= 0 && i.on < lines.length)) items.forEach((i) => delete i.on);
        const scene: Scene = { kind: s.kind, heading: str(s.heading, 90) || "…", lines, items: items.slice(0, LIMITS[s.kind as Kind][1]) };
        if (s.eyebrow) scene.eyebrow = str(s.eyebrow, 40);
        if (s.kind === "code") {
          if (typeof s.code?.text !== "string" || !s.code.text.trim()) throw new Error(`${where}: a code scene needs code.text.`);
          scene.code = { file: s.code.file ? str(s.code.file, 80) : undefined, text: capCode(s.code.text) };
        }
        if (s.kind === "screen") scene.screen = shotShape(s.screen, where);
        return scene;
      }),
    };
  });
  return { title: str(raw.title, 80) || "Untitled", repo: str(raw.repo, 120) || str(raw.title, 80) || "repo", url: raw.url ? str(raw.url, 200) : undefined, tag: str(raw.tag, 40), beats };
}
