// Turning a script into sentences the narrator speaks one at a time.

const ABBREVIATIONS = ["e.g.", "i.e.", "etc.", "vs.", "Dr.", "Mr.", "Mrs.", "Ms.", "St.", "No.", "approx.", "Inc.", "Ltd."];

/** Markdown down to plain spoken text: no headings marks, bullets, emphasis, code fences or link targets. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    // emphasis only when it wraps words: file_path_name and 2 * 3 stay as written
    .replace(/(^|[^\w*])(\*\*|__)(?=\S)([^]*?\S)\2(?![\w*])/g, "$1$3")
    .replace(/(^|[^\w*])(\*|_)(?=\S)([^]*?\S)\2(?![\w*])/g, "$1$3")
    .replace(/\s+/g, " ")
    .trim();
}

/** Paragraphs, list items and headings each stand alone; wrapped lines of one paragraph join up. */
export function blocks(md: string): string[] {
  const out: string[] = [];
  let cur: string[] = [], fence = false;
  const flush = () => { if (cur.length) out.push(cur.join(" ")); cur = []; };
  for (const raw of md.split("\n")) {
    if (/^\s*```/.test(raw)) { fence = !fence; flush(); continue; }
    if (fence) continue;
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^([-*+]|\d+[.)])\s+/.test(line) || /^#{1,6}\s/.test(line)) flush();
    cur.push(line);
  }
  flush();
  return out;
}

/** Splits text into sentences on . ! ? followed by a space and a capital, a digit or a quote,
 *  leaving abbreviations, decimals and version numbers whole. A block with no closing
 *  punctuation (a bullet, say) is its own sentence and gets a full stop. */
export function splitSentences(text: string): string[] {
  return blocks(text).flatMap((b) => {
    const t = stripMarkdown(b);
    if (!t) return [];
    return splitBlock(/[.!?…]["”’)]?$/.test(t) ? t : t + ".");
  });
}

function splitBlock(text: string): string[] {
  let t = text;
  const keep: string[] = [];
  ABBREVIATIONS.forEach((a, i) => {
    t = t.split(a).join(`\u0000${i}\u0000`);
    keep[i] = a;
  });
  const parts = t.split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/);
  return parts
    .map((p) => p.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]).trim())
    .filter((p) => p.length > 0);
}

export const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

export interface ScriptSection {
  title: string | null;
  sentences: string[];
  /** What the author wants on screen while this section plays: its [On screen: …] notes, never spoken. */
  onScreen: string[];
}

export interface Script {
  sections: ScriptSection[];
  /** Lines left unspoken because the narration is in quotes and they aren't, such as a title or a running time. */
  unspoken: string[];
}

/** "0:20–0:55 — Run 1 (Screen 2)" → "Run 1". A lone time needs a dash after it, so "2:00 is when it runs" stays narration.
 *  Returns null for a line that isn't a timecode, and "" for a bare one. */
function timecodeTitle(line: string): string | null {
  const m = /^[\[(]?\d{1,2}:\d{2}(\s*[-–—]\s*\d{1,2}:\d{2})?[\])]?\s*([-–—:|·]?)\s*(.*)$/.exec(line.trim());
  if (!m || (!m[1] && !m[2]) || m[3].length > 80) return null;
  return m[3].replace(/\s*\([^()]*\)$/, "").trim() || m[3].trim();
}

/** "[On screen: the invoice table]" → "the invoice table". */
const directionText = (s: string) => s.trim().replace(/^\[/, "").replace(/\]$/, "").trim().replace(/^(?:on[- ]?screen|screen|visuals?|shows?|b-roll)\s*:\s*/i, "");
const bracketDepth = (s: string) => (s.match(/\[/g)?.length ?? 0) - (s.match(/\]/g)?.length ?? 0);

/** Quote marks still open at the end of s: an odd count of ", or more “ than ”. */
const quotesOpen = (s: string) => (s.match(/"/g)?.length ?? 0) % 2 === 1 || (s.match(/“/g)?.length ?? 0) > (s.match(/”/g)?.length ?? 0);

/** Narration in quote marks, which may run over several lines, and the lines outside any quotes. */
function readQuotes(lines: string[]): { quoted: string[]; loose: string[] } {
  const quoted: string[] = [], loose: string[] = [];
  let cur: string[] | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!cur) {
      // a sentence that only opens with a quote ("Ship it," she said.) isn't quoted narration
      if (!/^["“]/.test(line) || (!quotesOpen(line) && !/["”]$/.test(line))) { if (line) loose.push(line); continue; }
      cur = [];
    }
    cur.push(raw);
    if (!quotesOpen(cur.join("\n"))) { quoted.push(cur.join("\n").trim().replace(/^["“]/, "").replace(/["”]$/, "")); cur = null; }
  }
  if (cur) quoted.push(cur.join("\n").trim().replace(/^["“]/, ""));
  return { quoted, loose };
}

/** A user's script, its spoken words kept exactly. Markdown headings and timecode lines ("0:00–0:20 — Stakes")
 *  become beat hints; [On screen: …] lines become notes for the visuals. When most of the words sit in quote
 *  marks, only the quoted words are spoken, and the lines outside them (a title, a running time) are not. */
export function parseScript(md: string): Script {
  const parts: { title: string | null; lines: string[]; onScreen: string[] }[] = [{ title: null, lines: [], onScreen: [] }];
  let fence = false, note: string[] | null = null, cued = false;  // cued: timecodes or notes, so it's laid out like a shooting script
  for (const raw of md.split("\n")) {
    const part = parts[parts.length - 1], line = raw.trim();
    if (note) {  // a note running over several lines
      note.push(line);
      if (bracketDepth(note.join(" ")) <= 0) { part.onScreen.push(directionText(note.join(" "))); note = null; }
      continue;
    }
    if (/^```/.test(line)) fence = !fence;
    if (fence || /^```/.test(line)) { part.lines.push(raw); continue; }
    const h = /^\s{0,3}#{1,6}\s+(.+)$/.exec(raw);
    const timed = timecodeTitle(h ? h[1] : line);
    const title = h ? timed ?? h[1].trim() : timed;
    if (title !== null) { cued ||= timed !== null; parts.push({ title: title || null, lines: [], onScreen: [] }); continue; }
    if (line.startsWith("[") && !/^\[[^\]]*\]\(/.test(line)) {  // a Markdown link isn't a note
      if (bracketDepth(line) > 0) { note = [line]; cued = true; continue; }
      if (line.endsWith("]")) { part.onScreen.push(directionText(line)); cued = true; continue; }
    }
    part.lines.push(raw);
  }
  if (note) parts[parts.length - 1].onScreen.push(directionText(note.join(" ")));

  const read = parts.map((p) => readQuotes(p.lines));
  const words = (xs: string[]) => xs.reduce((a, x) => a + countWords(x), 0);
  const quotedWords = words(read.flatMap((r) => r.quoted)), looseWords = words(read.flatMap((r) => r.loose));
  // in a shooting script quotes mark the narration; elsewhere a few quoted lines are just quotations
  const quotedOnly = quotedWords > 0 && quotedWords >= (cued ? 0.5 : 0.8) * (quotedWords + looseWords);

  const sections: ScriptSection[] = [];
  let carried: string[] = [];  // notes under a heading with nothing spoken go with the next section that has words
  parts.forEach((p, i) => {
    const sentences = splitSentences(quotedOnly ? read[i].quoted.join("\n\n") : p.lines.join("\n"));
    if (!sentences.length) { carried.push(...p.onScreen); return; }
    sections.push({ title: p.title, sentences, onScreen: [...carried, ...p.onScreen] });
    carried = [];
  });
  if (carried.length && sections.length) sections[sections.length - 1].onScreen.push(...carried);
  return { sections, unspoken: quotedOnly ? read.flatMap((r) => r.loose) : [] };
}

/** Whitespace and quote style don't count when checking a script was kept word for word. */
export const normalise = (s: string) =>
  s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
