// What a run spent on OpenRouter, from OpenRouter's own numbers, kept per film in cost.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Spend { usd: number; calls: number; inTokens: number; outTokens: number; exact: boolean }
export interface RunCost {
  at: string;
  kind: "storyboard" | "film" | "failed";
  storyboard: Spend;
  voice: Spend & { cached: number; seconds: number };
  usd: number;
}
export interface FilmCost { runs: RunCost[]; usd: number; exact: boolean }

export const zero = (): Spend => ({ usd: 0, calls: 0, inTokens: 0, outTokens: 0, exact: true });

export function addSpend(s: Spend, usd: number, inTokens: number, outTokens: number, exact: boolean): void {
  s.usd += usd; s.calls++; s.inTokens += inTokens; s.outTokens += outTokens; s.exact &&= exact;
}

/** 0.056 → "5.6¢", 0.12 → "12¢", 1.5 → "$1.50". */
export function money(usd: number): string {
  if (usd === 0) return "0¢";
  if (usd < 0.001) return "<0.1¢";
  if (usd < 0.1) return `${(usd * 100).toFixed(1)}¢`;
  if (usd < 1) return `${Math.round(usd * 100)}¢`;
  return `$${usd.toFixed(2)}`;
}

export function readCost(dir: string): FilmCost | null {
  const f = join(dir, "cost.json");
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

/** Adds this run to the film's running total: a storyboard run and the film run after it both count. */
export function recordCost(dir: string, run: RunCost): FilmCost {
  const runs = [...(readCost(dir)?.runs ?? []), run];
  const film: FilmCost = {
    runs,
    usd: +runs.reduce((a, r) => a + r.usd, 0).toFixed(6),
    exact: runs.every((r) => r.storyboard.exact && r.voice.exact),
  };
  writeFileSync(join(dir, "cost.json"), JSON.stringify(film, null, 2));
  return film;
}

/** One line for the terminal and the page. */
export function costLine(run: RunCost, film: FilmCost): string {
  const approx = (exact: boolean) => (exact ? "" : "≈");
  const parts: string[] = [];
  if (run.storyboard.calls) parts.push(`storyboard ${approx(run.storyboard.exact)}${money(run.storyboard.usd)}`);
  if (run.voice.calls || run.voice.cached) parts.push(`voice ${approx(run.voice.exact)}${money(run.voice.usd)} (${run.voice.calls} new, ${run.voice.cached} cached)`);
  let line = `${approx(run.storyboard.exact && run.voice.exact)}${money(run.usd)} this run`;
  if (parts.length) line += ` · ${parts.join(" · ")}`;
  if (film.runs.length > 1) line += ` · ${approx(film.exact)}${money(film.usd)} for this film in all`;
  return line;
}
