// The narrator: GitDiagram's Gemini Charon voice from Google's Gemini API or through OpenRouter, or macOS `say` offline.
// One clip per sentence, trimmed of edge silence, cached by what was said and how.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_RATE, SAY, VOICE } from "./config.ts";
import { addSpend, zero, type Spend } from "./cost.ts";
import { wavDuration } from "./audio.ts";
import { ffmpegPath, run } from "./proc.ts";

export type Backend = "gemini" | "say";
/** Where the Gemini voice comes from: Google's own API, or OpenRouter. The voice and the cached clips are the same. */
export type Via = "google" | "openrouter";
export interface VoiceOptions { backend: Backend; key?: string; via?: Via; cacheDir: string; concurrency?: number }

const SPEECH = "https://openrouter.ai/api/v1/audio/speech";
const INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TRIM = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function clipKey(text: string, backend: Backend): string {
  const how = backend === "gemini" ? [VOICE.model, VOICE.name, VOICE.style] : [SAY.voice, SAY.rate];
  return createHash("sha256").update(JSON.stringify([backend, ...how, text])).digest("hex").slice(0, 20);
}

/** The Gemini voice's key: Google's own when GEMINI_API_KEY is set, else OpenRouter's. */
export function voiceAccess(): { via: Via; key: string } {
  const google = process.env.GEMINI_API_KEY?.trim(), openrouter = process.env.OPENROUTER_API_KEY?.trim();
  if (google) return { via: "google", key: google };
  if (openrouter) return { via: "openrouter", key: openrouter };
  throw new Error("The voice needs GEMINI_API_KEY (from Google AI Studio) or OPENROUTER_API_KEY. Put one in .env (see .env.example).");
}

/** Google's free tier counts requests a minute across the key (3 for this model), so one 429 pauses every clip, not just its own. */
let googlePausedUntil = 0;

/** How long Google says to wait, from its RetryInfo or its message ("Please retry in 1s"). */
function retryIn(body: string): number | undefined {
  const s = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body)?.[1] ?? /retry in (\d+(?:\.\d+)?)\s*s/i.exec(body)?.[1];
  return s === undefined ? undefined : Number(s);
}

/** One clip from Google's Gemini API: WAV by default, raw PCM if Google ever sends that instead. */
async function google(text: string, key: string): Promise<{ audio: Buffer }> {
  const body = JSON.stringify({
    model: VOICE.googleModel,
    input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: VOICE.style }] }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice: VOICE.name }] },
  });
  for (let attempt = 0; ; attempt++) {
    if (googlePausedUntil > Date.now()) await sleep(googlePausedUntil - Date.now());
    const res = await fetch(INTERACTIONS, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response);
    if (res.ok) {
      const j = (await res.json()) as { steps?: { content?: { type?: string; data?: string }[] }[] };
      const data = j.steps?.flatMap((s) => s.content ?? []).find((c) => c.type === "audio" && c.data)?.data;
      if (data) return { audio: Buffer.from(data, "base64") };
      throw new Error("Google's voice answered without audio.");
    }
    const err = await res.text();
    // a per-minute limit is waited out, however many rounds it takes; a spent daily limit won't come back for hours
    if (res.status === 429 && !/per day/i.test(err) && attempt < 40) {
      googlePausedUntil = Math.max(googlePausedUntil, Date.now() + Math.min(retryIn(err) ?? 20, 90) * 1000 + 1000);
      continue;
    }
    if (res.status === 429) throw new Error(`Google's limit for the voice is spent: ${message(err)} Finished clips are cached, so run again later, or turn on billing for the key in Google AI Studio.`);
    if ((res.status === 400 && /API key/i.test(err)) || res.status === 401 || res.status === 403) throw new Error(`Google rejected GEMINI_API_KEY (${res.status}): ${message(err)}`);
    if ((res.status === 0 || res.status >= 500) && attempt < 4) { await sleep(1500 * 2 ** attempt); continue; }
    throw new Error(`The voice failed (${res.status}): ${message(err)}`);
  }
}

/** Google's own wording from an error body, or the body itself. */
const message = (body: string) => { try { return JSON.parse(body).error?.message ?? body.slice(0, 200); } catch { return body.slice(0, 200); } };

async function openrouter(text: string, key: string): Promise<{ audio: Buffer; id?: string }> {
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
    if (res.status === 402) throw new Error("OpenRouter says the balance is empty (402). Top it up, or set GEMINI_API_KEY to use Google's own Gemini API, then run again (finished clips are cached).");
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
    const take = opts.via === "google" ? await google(text, opts.key!) : await openrouter(text, opts.key!);
    id = "id" in take ? take.id : undefined;
    writeFileSync(tmp, take.audio);
    const raw = take.audio.subarray(0, 4).toString("latin1") !== "RIFF";  // OpenRouter sends bare PCM; Google, a WAV
    await run(ff, ["-loglevel", "error", "-y", ...(raw ? ["-f", "s16le", "-ar", String(VOICE.pcmRate), "-ac", "1"] : []), "-i", tmp,
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
 *  so this waits and retries; a clip it still can't find, or one from Google (which reports no price, and costs
 *  nothing on its free tier), is priced from its length at the paid rate instead, marked approximate. */
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
