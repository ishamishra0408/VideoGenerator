// Every tunable in one place.

/** Spoken words per minute, pauses included, measured on the Charon sample (643 words in 263.8 s). */
export const WPM = 146;

/** The lengths the tool offers, in minutes. */
export const MINUTES = [1, 2, 3, 4] as const;
export type Minutes = (typeof MINUTES)[number];

/** How many beats (chapters) a film of each length gets. */
export const BEATS_FOR: Record<Minutes, number> = { 1: 3, 2: 4, 3: 5, 4: 6 };

/** Word budget for a length, and how far a script may stray from it. */
export const wordBudget = (m: Minutes) => Math.round(m * WPM);
export const BUDGET_TOLERANCE = 0.15;

/** The script writer and storyboarder, through OpenRouter. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

/** GitDiagram's narrator: Gemini 3.8 Flash TTS, the Charon voice, and its style direction. */
export const VOICE = {
  model: "google/gemini-3.8-flash-tts",
  name: "Charon",
  style:
    "a warm, confident senior engineer telling a smart colleague the story of a project they love; " +
    "natural conversational pace with varied rhythm, breathing at commas and full stops",
  pcmRate: 24_000,
  /** Used only when OpenRouter's own figure isn't available: $ per token, and audio tokens per second of
   *  trimmed clip (measured: 171 tokens for a 4.6 s clip, about 32 a second before the silence is trimmed). */
  price: { input: 0.5e-6, output: 9e-6, audioTokensPerSecond: 36 },
} as const;

/** Fallback price for the writer when a reply carries no cost ($ per token, Sonnet 5.5 on OpenRouter). */
export const WRITER_PRICE = { input: 2e-6, output: 10e-6 };

/** The offline fallback voice (macOS only). */
export const SAY = { voice: "Samantha", rate: "178" } as const;

export const SAMPLE_RATE = 48_000;
const envNum = (k: string, lo: number, hi: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined; };
export const FPS = envNum("VIDEOGEN_FPS", 1, 60) ?? 25;
/** For small servers: render below 1080p (0.6667 = 720p), in fewer Chrome tabs, with a faster x264 preset. */
export const RENDER = {
  scale: envNum("VIDEOGEN_SCALE", 0.25, 1) ?? 1,
  workers: envNum("VIDEOGEN_WORKERS", 1, 8),
  preset: /^(ultrafast|superfast|veryfast|faster|fast|medium|slow)$/.test(process.env.VIDEOGEN_PRESET ?? "") ? process.env.VIDEOGEN_PRESET! : "medium",
};

/** Pauses laid between sentences, scenes and beats, in seconds. */
export const GAPS = { lead: 0.8, sentence: 0.3, scene: 0.65, beat: 1.0, tail: 2.2 } as const;

/** Slide transition length, in seconds; the stage uses the same value. */
export const TRANSITION = 0.6;

export const CACHE_DIR = ".videogen-cache";
