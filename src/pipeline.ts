// Repo (and script) in, film out: read, write the storyboard, speak, mix, film.
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { CACHE_DIR, DEFAULT_MODEL, FPS, type Minutes, RENDER, TRANSITION, WPM, WRITER_PRICE } from "./config.ts";
import { addSpend, costLine, recordCost, zero, type FilmCost, type RunCost, type Spend } from "./cost.ts";
import { computeCues, sfxEvents } from "./cues.ts";
import { mix, writeWav } from "./audio.ts";
import { requireKey } from "./env.ts";
import { loadRepo } from "./github.ts";
import { chat } from "./llm.ts";
import { makePlan, planLines, planWords, validatePlanShape, type Plan } from "./plan.ts";
import { buildStage, renderStills, renderVideo } from "./render.ts";
import { countWords, parseScript } from "./sentences.ts";
import { layout, toSrt } from "./timing.ts";
import { speakAll, voiceCost, type Backend, type FreshClip } from "./voice.ts";
import { loadTheme, themeCss, type Mode } from "./theme.ts";

export type Stage = "repo" | "storyboard" | "voice" | "sound" | "render" | "done" | "cost" | "upload" | "queued";
export interface Progress { stage: Stage; message: string; fraction?: number }

export interface Job {
  /** owner/name, a GitHub URL or a folder. Not needed when `plan` is given. */
  repo?: string;
  minutes?: Minutes;
  /** The user's narration. Kept word for word unless `adapt` is set. */
  script?: string;
  adapt?: boolean;
  brief?: string;
  /** Film this storyboard as it is, skipping reading and writing. */
  plan?: Plan;
  storyboardOnly?: boolean;
  /** "gitdiagram" (default), a 21st.dev community theme's name, or its link. */
  theme?: string;
  themeMode?: Mode;
  voice?: Backend;
  model?: string;
  fps?: number;
  workers?: number;
  outDir?: string;
  stills?: number[];
}

export interface JobResult {
  dir: string;
  plan: Plan;
  warnings: string[];
  words: number;
  video?: string;
  captions?: string;
  duration?: number;
  stills?: string[];
  /** What this run spent on OpenRouter, and the film's total across its runs. */
  cost: { run: RunCost; film: FilmCost; line: string };
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "film";
const clampMinutes = (m: number) => Math.min(4, Math.max(1, Math.round(m))) as Minutes;
/** 45 s, 12 min, 1 h 5 min */
export const timeLeft = (s: number) => {
  if (s < 90) return `${Math.ceil(s)} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export async function runJob(job: Job, report: (p: Progress) => void = () => {}): Promise<JobResult> {
  const warnings: string[] = [];
  const storyboardSpend = zero(), voiceSpend = { ...zero(), cached: 0, seconds: 0 };
  let dir: string | undefined;
  let priced: Promise<Spend> | undefined;
  const backend = job.voice ?? "gemini";
  const paidClips: FreshClip[] = [];
  const settleVoice = async () => {
    if (!priced) return;
    const v = await Promise.race([priced, new Promise<Spend>((r) => setTimeout(() => r(zero()), 30_000))]);
    Object.assign(voiceSpend, v, { cached: voiceSpend.cached, seconds: voiceSpend.seconds });
    priced = undefined;
  };
  const settle = (kind: RunCost["kind"]) => {
    const run: RunCost = { at: new Date().toISOString(), kind, storyboard: storyboardSpend, voice: voiceSpend, usd: +(storyboardSpend.usd + voiceSpend.usd).toFixed(6) };
    const film = recordCost(dir!, run);
    const line = costLine(run, film);
    report({ stage: "cost", message: line });
    return { run, film, line };
  };

  try {
    // the look first: a bad theme name or a slow font server costs nothing yet
    const theme = job.storyboardOnly ? undefined : await loadTheme(job.theme, job.themeMode ?? "light", resolve(CACHE_DIR));
    const look = theme ? await themeCss(theme, resolve(CACHE_DIR)) : undefined;
    if (look?.missingFonts.length) warnings.push(`Not on Google Fonts, so a system font stands in: ${look.missingFonts.join(", ")}.`);
    if (look?.offlineFonts.length) warnings.push(`Couldn't reach Google Fonts, so a system font stands in: ${look.offlineFonts.join(", ")}.`);

    let plan: Plan;
    let minutes: Minutes = job.minutes ?? 2;
    if (job.plan) {
      plan = validatePlanShape(job.plan);
      dir = resolve(job.outDir ?? join("out", `${slug(plan.title)}-${clampMinutes(planWords(plan) / WPM)}min`));
    } else {
      if (!job.repo) throw new Error("Give a repo: owner/name, a GitHub URL or a folder.");
      const key = requireKey("OPENROUTER_API_KEY");
      report({ stage: "repo", message: `Reading ${job.repo}` });
      const context = await loadRepo(job.repo);
      report({ stage: "repo", message: `${context.paths.length} files, ${context.files.length} read closely` });

      let script: string[] | undefined, scriptHeadings: string[] | undefined;
      if (job.script?.trim() && !job.adapt) {
        const sections = parseScript(job.script);
        script = sections.flatMap((s) => s.sentences);
        scriptHeadings = sections.map((s) => s.title).filter((t): t is string => !!t);
        const words = script.reduce((a, s) => a + countWords(s), 0);
        const est = words / WPM;
        if (job.minutes && Math.abs(est - job.minutes) > 0.35)
          warnings.push(`The script is ${words} words, about ${est.toFixed(1)} minutes; the film follows your words. Use --adapt (or "Fit to length" on the web page) to make it ${job.minutes} minutes.`);
        minutes = clampMinutes(est);
      }
      dir = resolve(job.outDir ?? join("out", `${slug(context.name)}-${minutes}min`));  // known before anything is paid for
      const model = job.model || DEFAULT_MODEL;
      report({ stage: "storyboard", message: `Writing the storyboard with ${model}` });
      const res = await makePlan(
        { context, minutes, script, scriptHeadings, adapt: job.adapt ? job.script : undefined, brief: job.brief },
        async (system, messages) => {
          const { text, usage } = await chat({ key, model, system, messages });
          const exact = usage.cost !== undefined;
          addSpend(storyboardSpend, usage.cost ?? usage.prompt * WRITER_PRICE.input + usage.completion * WRITER_PRICE.output, usage.prompt, usage.completion, exact);
          return text;
        },
        (s) => report({ stage: "storyboard", message: s }),
      );
      plan = res.plan;
      warnings.push(...res.warnings);
    }

    const words = planWords(plan);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "storyboard.json"), JSON.stringify(plan, null, 2));
    const scenes = plan.beats.reduce((a, b) => a + b.scenes.length, 0);
    report({ stage: "storyboard", message: `${plan.beats.length} beats, ${scenes} scenes, ${words} words (about ${(words / WPM).toFixed(1)} min)` });
    if (job.storyboardOnly || !theme || !look) return { dir, plan, warnings, words, cost: settle("storyboard") };
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ id: theme.id, name: theme.name, author: theme.author, url: theme.url, mode: theme.mode }, null, 2));

    // the voice
    const lines = planLines(plan);
    report({ stage: "voice", message: backend === "gemini" ? `Speaking ${lines.length} sentences (Gemini, Charon)` : `Speaking ${lines.length} sentences (say)`, fraction: 0 });
    const voice = await speakAll(lines, { backend, key: backend === "gemini" ? requireKey("OPENROUTER_API_KEY") : undefined, cacheDir: resolve(CACHE_DIR) },
      (s) => report({ stage: "voice", message: s }), (c) => paidClips.push(c));
    report({ stage: "voice", message: `${voice.fresh.length} new clips, ${lines.length - voice.fresh.length} from the cache`, fraction: 1 });
    voiceSpend.cached = lines.length - voice.fresh.length;
    voiceSpend.seconds = +voice.fresh.reduce((a, c) => a + c.seconds, 0).toFixed(2);
    // OpenRouter prices each clip a few seconds after the call: look them up while the film renders
    priced = voiceCost(voice.fresh, backend, backend === "gemini" ? requireKey("OPENROUTER_API_KEY") : undefined);

    // the clock, captions and soundtrack
    const timing = layout(plan, voice.durations);
    if (!plan.tag) plan.tag = `${Math.max(1, Math.round(timing.duration / 60))} min explainer`;
    const cues = computeCues(plan, timing);
    const base = slug(plan.title);
    const captions = join(dir, `${base}.srt`);
    writeFileSync(join(dir, "timing.json"), JSON.stringify(timing, null, 1));
    writeFileSync(captions, toSrt(timing.lines));
    report({ stage: "sound", message: "Mixing narration and sound bed" });
    const soundtrack = join(dir, "soundtrack.wav");
    writeWav(soundtrack, mix(timing.lines, voice.files, sfxEvents(plan, cues), timing.duration));

    // the picture
    const stageFile = join(dir, "stage.html");
    report({ stage: "render", message: `Theme: ${theme.name}${theme.id === "gitdiagram" ? "" : ` (${theme.mode})`}` });
    writeFileSync(stageFile, buildStage({ plan, cues, transition: TRANSITION, duration: timing.duration }, look.css));
    if (job.stills?.length) {
      report({ stage: "render", message: `Taking ${job.stills.length} stills` });
      const stills = await renderStills(stageFile, job.stills, join(dir, "stills"));
      report({ stage: "done", message: `Stills in ${join(dir, "stills")}` });
      await settleVoice();
      return { dir, plan, warnings, words, captions, duration: timing.duration, stills, cost: settle("film") };
    }
    const fps = job.fps ?? FPS;
    const workers = job.workers ?? RENDER.workers ?? Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));
    const video = join(dir, `${base}-${Math.max(1, Math.round(timing.duration / 60))}min.mp4`);
    report({ stage: "render", message: `Filming ${Math.ceil(timing.duration * fps)} frames in ${workers} tabs`, fraction: 0 });
    let first: { at: number; done: number } | undefined;
    await renderVideo({
      stageFile, audio: soundtrack, out: video, duration: timing.duration, fps, workers,
      onProgress: (done, total) => {
        // timed from the first frames, so Chrome's start-up (slow on a small server) doesn't count as filming
        first ??= { at: Date.now(), done };
        const left = done > first.done ? ((Date.now() - first.at) / (done - first.done)) * (total - done) / 1000 : 0;
        report({ stage: "render", message: `${done}/${total} frames${left ? `, about ${timeLeft(left)} left` : ""}`, fraction: done / total });
      },
    });
    const m = Math.floor(timing.duration / 60), s = Math.round(timing.duration % 60);
    await settleVoice();
    const cost = settle("film");
    report({ stage: "done", message: `${m}:${String(s).padStart(2, "0")} film written to ${video}`, fraction: 1 });
    return { dir, plan, warnings, words, video, captions, duration: timing.duration, cost };
  } catch (err) {
    // money spent on a run that then failed still counts: the storyboard calls, and clips now in the cache
    if (!priced && paidClips.length && backend === "gemini") priced = voiceCost(paidClips, backend, process.env.OPENROUTER_API_KEY);
    if (priced) { voiceSpend.seconds = +paidClips.reduce((a, c) => a + c.seconds, 0).toFixed(2); }
    if (dir && (storyboardSpend.calls || priced)) {
      try { mkdirSync(dir, { recursive: true }); await settleVoice(); settle("failed"); } catch {}
    }
    throw err;
  }
}
