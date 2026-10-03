// The soundtrack: narration clips laid on the clock, and a sound bed after GitDiagram's
// (a whoosh on each scene change, a stamp on before/after cards, soft pops and ticks), synthesised here.
import { readFileSync, writeFileSync } from "node:fs";
import { SAMPLE_RATE } from "./config.ts";
import type { TimedLine } from "./timing.ts";

export interface Pcm { rate: number; samples: Float32Array }

/** Reads a 16-bit PCM WAV, mixing stereo down to mono. */
export function readWav(file: string): Pcm {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} isn't a WAV file`);
  let off = 12, rate = 0, channels = 1, bits = 16;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4), body = off + 8;
    if (id === "fmt ") { channels = b.readUInt16LE(body + 2); rate = b.readUInt32LE(body + 4); bits = b.readUInt16LE(body + 14); }
    if (id === "data") {
      if (bits !== 16) throw new Error(`${file}: ${bits}-bit audio, expected 16`);
      const end = Math.min(b.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += b.readInt16LE(body + 2 * (i * channels + c));
        samples[i] = s / channels / 32768;
      }
      return { rate, samples };
    }
    off = body + size + (size & 1);
  }
  throw new Error(`${file} has no audio data`);
}

export function writeWav(file: string, samples: Float32Array, rate = SAMPLE_RATE): void {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  writeFileSync(file, b);
}

/** Length of a WAV in seconds, from its header. */
export function wavDuration(file: string): number {
  const p = readWav(file);
  return p.samples.length / p.rate;
}

// ---------- the sound bed ----------

export type Sfx = "whoosh" | "stamp" | "pop" | "tick";
export interface SfxEvent { at: number; kind: Sfx }

function rng(seed: number) {
  // mulberry32, then Box-Muller for gaussian noise
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-9)) * Math.cos(2 * Math.PI * u());
}

export function synth(kind: Sfx, sr = SAMPLE_RATE): Float32Array {
  const g = rng(7);
  if (kind === "whoosh") {
    // noise through a one-pole low-pass whose cutoff rises and falls, under a sin² swell
    const n = Math.round(0.6 * sr), y = new Float32Array(n);
    let a = 0, peak = 1e-9;
    for (let i = 0; i < n; i++) { const k = i / n; a += (0.02 + 0.18 * Math.sin(Math.PI * k)) * (g() - a); y[i] = a * Math.sin(Math.PI * k) ** 2; peak = Math.max(peak, Math.abs(a)); }
    for (let i = 0; i < n; i++) y[i] = (0.22 * y[i]) / peak;
    return y;
  }
  if (kind === "stamp") {
    const n = Math.round(0.22 * sr), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / sr; y[i] = 0.3 * (Math.sin(2 * Math.PI * (110 - 220 * t) * t) * Math.exp(-t * 28) + 0.5 * g() * Math.exp(-t * 160)); }
    return y;
  }
  if (kind === "pop") {
    const n = Math.round(0.09 * sr), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / sr; y[i] = 0.07 * Math.sin(2 * Math.PI * (720 - 2600 * t) * t) * Math.exp(-t * 55); }
    return y;
  }
  const n = Math.round(0.05 * sr), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; y[i] = 0.06 * (Math.sin(2 * Math.PI * 1900 * t) + 0.4 * g()) * Math.exp(-t * 120); }
  return y;
}

/** Narration plus sound bed, as one mono track `duration` seconds long. */
export function mix(lines: TimedLine[], clips: string[], events: SfxEvent[], duration: number, sr = SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.ceil(duration * sr));
  const add = (sig: Float32Array, at: number) => {
    const i0 = Math.round(at * sr);
    for (let j = Math.max(0, -i0); j < sig.length && i0 + j < out.length; j++) out[i0 + j] += sig[j];
  };
  lines.forEach((ln, i) => {
    const p = readWav(clips[i]);
    if (p.rate !== sr) throw new Error(`${clips[i]} is ${p.rate} Hz, expected ${sr}`);
    add(p.samples, ln.start);
  });
  const bank = new Map<Sfx, Float32Array>();
  for (const e of events) {
    if (!bank.has(e.kind)) bank.set(e.kind, synth(e.kind, sr));
    add(bank.get(e.kind)!, e.at);
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
  return out;
}
