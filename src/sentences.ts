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
}

/** A user's script. Markdown headings, if any, become beat hints; their words are kept exactly. */
export function parseScript(md: string): ScriptSection[] {
  const sections: ScriptSection[] = [];
  let title: string | null = null;
  let body: string[] = [];
  const flush = () => {
    const sentences = splitSentences(body.join("\n"));
    if (sentences.length) sections.push({ title, sentences });
    body = [];
  };
  for (const line of md.split("\n")) {
    const h = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      flush();
      title = h[1].trim();
    } else body.push(line);
  }
  flush();
  return sections;
}

/** Whitespace and quote style don't count when checking a script was kept word for word. */
export const normalise = (s: string) =>
  s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
