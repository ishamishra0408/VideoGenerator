// The narration clock: where each sentence, scene and beat sits in time, and the captions.
import { GAPS } from "./config.ts";
import type { Plan } from "./plan.ts";

export interface TimedLine { beat: number; scene: number; line: number; start: number; end: number; text: string }
export interface TimedScene { beat: number; scene: number; start: number; end: number }
export interface Timing { duration: number; lines: TimedLine[]; scenes: TimedScene[] }

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Lays the spoken sentences out with pauses. `durations` is one entry per sentence, in plan order. */
export function layout(plan: Plan, durations: number[]): Timing {
  const lines: TimedLine[] = [];
  const scenes: TimedScene[] = [];
  let t = GAPS.lead;
  let k = 0;
  plan.beats.forEach((beat, b) => {
    if (b > 0) t += GAPS.beat;
    beat.scenes.forEach((scene, s) => {
      if (s > 0) t += GAPS.scene;
      scenes.push({ beat: b, scene: s, start: r3(t), end: 0 });
      scene.lines.forEach((text, l) => {
        if (l > 0) t += GAPS.sentence;
        const d = durations[k++];
        if (d === undefined) throw new Error("fewer durations than sentences");
        lines.push({ beat: b, scene: s, line: l, start: r3(t), end: r3(t + d), text });
        t += d;
      });
    });
  });
  if (k !== durations.length) throw new Error("more durations than sentences");
  t += GAPS.tail;
  scenes.forEach((sc, i) => (sc.end = i + 1 < scenes.length ? scenes[i + 1].start : r3(t)));
  return { duration: r3(t), lines, scenes };
}

/** Splits a long caption at commas, colons or semicolons, then at spaces, into chunks of about `limit` characters. */
export function captionChunks(text: string, limit = 84): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of text.split(/(?<=[,:;])\s+/)) {
    if (!cur || cur.length + p.length + 1 <= limit) cur = (cur + " " + p).trim();
    else { out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  const final: string[] = [];
  for (let c of out) {
    while (c.length > limit) {
      const cut = c.lastIndexOf(" ", limit);
      if (cut <= 0) break;
      final.push(c.slice(0, cut));
      c = c.slice(cut + 1);
    }
    final.push(c);
  }
  return final;
}

function stamp(sec: number): string {
  let ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000); ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000); ms -= m * 60_000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/** SubRip captions, each chunk timed in proportion to its share of the sentence. Never burned in. */
export function toSrt(lines: TimedLine[]): string {
  const cues: string[] = [];
  let n = 1;
  for (const ln of lines) {
    const chunks = captionChunks(ln.text);
    const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
    let s = ln.start;
    for (const c of chunks) {
      const e = s + ((ln.end - ln.start) * c.length) / total;
      cues.push(`${n++}\n${stamp(s)} --> ${stamp(e)}\n${c}\n`);
      s = e;
    }
  }
  return cues.join("\n");
}
