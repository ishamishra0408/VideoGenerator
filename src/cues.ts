// When each thing lands on screen. Worked out once here, then used by the stage and the sound bed alike.
import type { SfxEvent } from "./audio.ts";
import type { Plan, Scene } from "./plan.ts";
import type { Timing } from "./timing.ts";
import { TRANSITION } from "./config.ts";

export interface SceneCues {
  beat: number;
  start: number;
  end: number;
  eyebrow: number;
  heading: number;
  /** The scene's main card (code, tree, checklist), just after the first words. */
  body: number;
  items: number[];
  lines: [number, number][];
}

/** Item k of n: on the sentence that names it, or spread evenly across the scene's speech. */
export function itemTimes(scene: Scene, lines: [number, number][], end: number): number[] {
  const n = scene.items.length, L = lines.length;
  if (!n) return [];
  const at = (li: number, frac: number) => lines[li][0] + frac * (lines[li][1] - lines[li][0]);
  const times: number[] = new Array(n);
  if (scene.items.every((i) => i.on !== undefined)) {
    const groups = new Map<number, number[]>();
    scene.items.forEach((it, k) => groups.set(it.on!, [...(groups.get(it.on!) ?? []), k]));
    for (const [li, ks] of groups) ks.forEach((k, i) => (times[k] = at(li, 0.08 + (0.7 * i) / ks.length)));
  } else if (scene.kind === "compare") {
    times[0] = at(0, 0.05);
    times[1] = L > 1 ? at(1, 0.05) : at(0, 0.55);
  } else {
    scene.items.forEach((_, k) => {
      const pos = ((k + 0.25) * L) / n, li = Math.min(L - 1, Math.floor(pos));
      times[k] = at(li, pos - li);
    });
  }
  const first = lines[0][0] + 0.2, last = Math.max(first, end - 1.0);
  return times.map((t) => Math.min(Math.max(t, first), last));
}

export function computeCues(plan: Plan, timing: Timing): SceneCues[] {
  const out: SceneCues[] = [];
  let si = 0;
  plan.beats.forEach((beat, b) => beat.scenes.forEach((scene, s) => {
    const ts = timing.scenes[si++];
    const lines = timing.lines.filter((l) => l.beat === b && l.scene === s).map((l) => [l.start, l.end] as [number, number]);
    const first = lines[0][0];
    out.push({
      beat: b, start: ts.start, end: ts.end,
      eyebrow: Math.max(0, first - 0.5), heading: Math.max(0, first - 0.3), body: first + 0.25,
      items: itemTimes(scene, lines, ts.end), lines,
    });
  }));
  return out;
}

/** The sound bed's events, from the same cues the picture uses. */
export function sfxEvents(plan: Plan, cues: SceneCues[]): SfxEvent[] {
  const scenes = plan.beats.flatMap((b) => b.scenes);
  const ev: SfxEvent[] = [];
  cues.forEach((c, i) => {
    if (i > 0) ev.push({ at: c.start - TRANSITION, kind: "whoosh" });
    const kind = scenes[i].kind;
    c.items.forEach((t) => {
      if (kind === "compare") ev.push({ at: t + 0.06, kind: "stamp" });
      else if (kind === "checklist") ev.push({ at: t + 0.45, kind: "tick" });
      else if (kind !== "tree") ev.push({ at: t, kind: "pop" });
    });
  });
  return ev.filter((e) => e.at >= 0).sort((a, b) => a.at - b.at);
}
