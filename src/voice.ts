// The narrator: GitDiagram's Gemini Charon voice through OpenRouter, or macOS `say` offline.
// One clip per sentence, trimmed of edge silence, cached by what was said and how.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_RATE, SAY, VOICE } from "./config.ts";
import { addSpend, zero, type Spend } from "./cost.ts";
import { wavDuration } from "./audio.ts";
import { ffmpegPath, run } from "./proc.ts";

export type Backend = "gemini" | "say";
export interface VoiceOptions { backend: Backend; key?: string; cacheDir: string; concurrency?: number }

const SPEECH = "https://openrouter.ai/api/v1/audio/speech";
const TRIM = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function clipKey(text: string, backend: Backend): string {
  const how = backend === "gemini" ? [VOICE.model, VOICE.name, VOICE.style] : [SAY.voice, SAY.rate];
  return createHash("sha256").update(JSON.stringify([backend, ...how, text])).digest("hex").slice(0, 20);
}

async function gemini(text: string, key: string): Promise<{ audio: Buffer; id?: string }> {
  const body = JSON.stringify({
    model: VOICE.model,
    input: text,
    voice: VOICE.name,
    response_format: "pcm",
    provider: { options: { "google-ai-studio": { speech_metadata: { style: VOICE.style } } } },
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(SPEECH, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response);
    if (res.ok) return { audio: Buffer.from(await res.arrayBuffer()), id: res.headers.get("x-generation-id") ?? undefined };
    if (res.status === 402) throw new Error("OpenRouter says the balance is empty (402). Top it up, then run again (finished clips are cached).");
    if (res.status === 401) throw new Error("OpenRouter rejected the key (401). Check OPENROUTER_API_KEY.");
    if ((res.status === 0 || res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1500 * 2 ** attempt); continue; }
    throw new Error(`The voice failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

/** Makes one clip; returns OpenRouter's generation id for a paid one, to price it afterwards. */
async function makeClip(text: string, out: string, opts: VoiceOptions): Promise<string | undefined> {
  const ff = ffmpegPath();
  const tmp = out + ".part", wav = out + ".tmp.wav";  // the cache only ever holds finished clips
  let id: string | undefined;
  if (opts.backend === "gemini") {
    const take = await gemini(text, opts.key!);
    id = take.id;
    writeFileSync(tmp, take.audio);
    await run(ff, ["-loglevel", "error", "-y", "-f", "s16le", "-ar", String(VOICE.pcmRate), "-ac", "1", "-i", tmp,
      "-af", TRIM, "-ac", "1", "-ar", String(SAMPLE_RATE), "-sample_fmt", "s16", "-f", "wav", wav]);
  } else {
    if (process.platform !== "darwin") throw new Error("The offline voice uses macOS `say`. Use --voice gemini elsewhere.");
    await run("say", ["-v", SAY.voice, "-r", SAY.rate, "-o", tmp + ".aiff", text]);
    await run(ff, ["-loglevel", "error", "-y", "-i", tmp + ".aiff", "-af", TRIM, "-ac", "1", "-ar", String(SAMPLE_RATE), "-sample_fmt", "s16", "-f", "wav", wav]);
    rmSync(tmp + ".aiff", { force: true });
  }
  rmSync(tmp, { force: true });
  renameSync(wav, out);
  return id;
}

export interface FreshClip { index: number; id?: string; seconds: number; text: string }

/** Speaks every line. Returns each clip's file and length in seconds, in order, and which clips were new (paid for). */
export async function speakAll(lines: string[], opts: VoiceOptions, log: (s: string) => void = () => {}, onFresh: (c: FreshClip) => void = () => {}): Promise<{ files: string[]; durations: number[]; fresh: FreshClip[] }> {
  const dir = join(opts.cacheDir, "voice");
  mkdirSync(dir, { recursive: true });
  const files = lines.map((l) => join(dir, `${clipKey(l, opts.backend)}.wav`));
  const todo = lines.map((_, i) => i).filter((i) => !existsSync(files[i]));
  let done = 0;
  const ids = new Map<number, string | undefined>();
  const worker = async () => {
    for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
      ids.set(i, await makeClip(lines[i], files[i], opts));
      onFresh({ index: i, id: ids.get(i), seconds: wavDuration(files[i]), text: lines[i] });  // paid for, even if a later clip fails
      done++;
      if (done % 5 === 0) log(`voice: ${done} new clips`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, Math.max(1, todo.length)) }, worker));
  const durations = files.map(wavDuration);
  const fresh = [...ids.keys()].sort((a, b) => a - b).map((i) => ({ index: i, id: ids.get(i), seconds: durations[i], text: lines[i] }));
  return { files, durations, fresh };
}

/** What the new clips cost, from OpenRouter's generation records. They appear a few seconds after each call,
 *  so this waits and retries; a clip it still can't find is priced from its length instead, marked approximate. */
export async function voiceCost(fresh: FreshClip[], backend: Backend, key?: string): Promise<Spend> {
  const spend = zero();
  if (backend !== "gemini") return spend;
  const lookup = async (clip: FreshClip) => {
    for (let attempt = 0; clip.id && key && attempt < 8; attempt++) {
      await sleep(attempt === 0 ? 1500 : 2500);
      const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(clip.id)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (!res?.ok) continue;
      const d = await res.json().then((j: { data?: { total_cost?: number; native_tokens_prompt?: number; native_tokens_completion?: number } }) => j.data, () => undefined);
      if (typeof d?.total_cost === "number") return addSpend(spend, d.total_cost, d.native_tokens_prompt ?? 0, d.native_tokens_completion ?? 0, true);
    }
    const out = Math.round(clip.seconds * VOICE.price.audioTokensPerSecond), inp = Math.ceil(clip.text.length / 4);
    addSpend(spend, out * VOICE.price.output + inp * VOICE.price.input, inp, out, false);
  };
  const queue = [...fresh];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { for (let c = queue.shift(); c; c = queue.shift()) await lookup(c); }));
  return spend;
}
