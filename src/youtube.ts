// Posting a film to YouTube: Google sign-in (OAuth 2.0 with PKCE), then a resumable upload through the YouTube Data API.
// Each browser connects its own Google account and posts to its own channel. Scopes are only "upload videos" plus the
// account's email, to show who is connected. Tokens stay in files on the server (mode 600, git-ignored, one per
// browser), are never logged and never reach the page.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plan } from "./plan.ts";
import type { Timing } from "./timing.ts";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/youtube.upload"];
const CHUNK = 8 * 1024 * 1024;  // a multiple of 256 KiB, as resumable uploads require
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Privacy = "private" | "unlisted" | "public";
interface Tokens { access_token: string; refresh_token: string; expires_at: number; email?: string }

export interface YouTubeConfig { clientId: string; clientSecret: string; redirectUri: string; tokenDir: string; tokenFile: string }

/** Set up when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are; the redirect is this site's own /youtube/callback. */
export function youtubeConfig(baseUrl: string, cacheDir: string): YouTubeConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const tokenDir = join(cacheDir, "youtube");
  return { clientId, clientSecret, redirectUri: `${baseUrl.replace(/\/$/, "")}/youtube/callback`, tokenDir, tokenFile: join(tokenDir, "default.json") };
}

/** One browser's own connection: its tokens live in a file named by a hash of its id, so ids never touch the disk. */
export function forBrowser(cfg: YouTubeConfig, browserId: string): YouTubeConfig {
  return { ...cfg, tokenFile: join(cfg.tokenDir, createHash("sha256").update(browserId).digest("hex").slice(0, 32) + ".json") };
}

const b64url = (b: Buffer) => b.toString("base64url");
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

// Sign-ins in flight: state → PKCE verifier, for ten minutes.
const pending = new Map<string, { verifier: string; at: number }>();

/** Where to send the browser to sign in with Google, and the state the server pins to that browser in a cookie. */
export function authUrl(cfg: YouTubeConfig): { url: string; state: string } {
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
  const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
  pending.set(state, { verifier, at: Date.now() });
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
  });
  return { url: `${AUTH}?${q}`, state };
}

/** Sign-in failures as fixed codes, so the page never echoes free text from a URL. */
export class SignInError extends Error {
  code: "expired" | "scope" | "account" | "failed";
  constructor(code: SignInError["code"], message: string) { super(message); this.code = code; }
}

function save(cfg: YouTubeConfig, t: Tokens) {
  mkdirSync(dirname(cfg.tokenFile), { recursive: true });
  writeFileSync(cfg.tokenFile, JSON.stringify(t), { mode: 0o600 });
}
function load(cfg: YouTubeConfig): Tokens | null {
  try { return existsSync(cfg.tokenFile) ? JSON.parse(readFileSync(cfg.tokenFile, "utf8")) : null; } catch { return null; }
}

/** Google sends the browser back here: swap the code for tokens. Returns the connected email. */
export async function finishSignIn(cfg: YouTubeConfig, code: string, state: string): Promise<string | undefined> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > 600_000) throw new SignInError("expired", "That sign-in link has expired. Connect again.");
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, code_verifier: p.verifier, grant_type: "authorization_code", redirect_uri: cfg.redirectUri }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !j.access_token) throw new SignInError("failed", `Google didn't finish the sign-in (${j.error ?? res.status}).`);
  if (!String(j.scope ?? "").includes("youtube.upload")) throw new SignInError("scope", "YouTube upload permission wasn't granted. Connect again and allow it.");
  // the id token came straight from Google over TLS, so its claims can be read without re-verifying the signature
  let email: string | undefined;
  try { email = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString("utf8")).email; } catch {}
  // GOOGLE_ALLOWED_EMAIL: only that account may be connected, whoever else knows the site password
  const allowed = process.env.GOOGLE_ALLOWED_EMAIL?.trim().toLowerCase();
  if (allowed && email?.toLowerCase() !== allowed) {
    await fetch(`${REVOKE}?token=${encodeURIComponent(j.refresh_token ?? j.access_token)}`, { method: "POST", signal: AbortSignal.timeout(15_000) }).catch(() => {});
    throw new SignInError("account", "That Google account isn't the one this site posts as.");
  }
  const old = load(cfg);
  save(cfg, { access_token: j.access_token, refresh_token: j.refresh_token ?? old?.refresh_token ?? "", expires_at: Date.now() + (j.expires_in ?? 3600) * 1000, email });
  return email;
}

/** A live access token, refreshed when it's about to run out. */
async function accessToken(cfg: YouTubeConfig, force = false): Promise<string> {
  const t = load(cfg);
  if (!t) throw new Error("Connect YouTube first.");
  if (!force && t.expires_at - Date.now() > 300_000) return t.access_token;  // five minutes' slack: an upload can take a while
  if (!t.refresh_token) { rmSync(cfg.tokenFile, { force: true }); throw new Error("YouTube needs connecting again."); }
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: t.refresh_token, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !j.access_token) {
    if (j.error === "invalid_grant") {
      rmSync(cfg.tokenFile, { force: true });
      throw new Error("YouTube needs connecting again (Google ends sign-ins for apps in testing after 7 days).");
    }
    throw new Error(`Couldn't refresh the YouTube sign-in (${j.error ?? res.status}). Try again.`);
  }
  save(cfg, { ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

export function youtubeStatus(cfg: YouTubeConfig | null): { configured: boolean; connected: boolean; email?: string } {
  if (!cfg) return { configured: false, connected: false };
  const t = load(cfg);
  return { configured: true, connected: !!t, email: t?.email };
}

export async function disconnect(cfg: YouTubeConfig): Promise<void> {
  const t = load(cfg);
  rmSync(cfg.tokenFile, { force: true });
  const token = t?.refresh_token || t?.access_token;
  if (token) await fetch(`${REVOKE}?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(15_000) }).catch(() => {});
}

// ---------- what gets posted ----------

/** YouTube refuses < and > in titles and descriptions; titles stop at 100 characters, descriptions at 5,000 bytes. */
const clean = (s: string) => s.replace(/[<>]/g, "").replace(/[ \t]+/g, " ").trim();
export const cleanTitle = (s: string) => {
  const chars = Array.from(clean(s.replace(/\s+/g, " ")));  // by character, so an emoji is never cut in half
  return chars.length > 100 ? chars.slice(0, 99).join("").trimEnd() + "…" : chars.join("");
};
export function cleanDescription(s: string): string {
  let d = Array.from(clean(s));
  while (Buffer.byteLength(d.join("")) > 5000) d = d.slice(0, -50);
  return d.join("");
}

const stamp = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** Chapter lines YouTube turns into chapters: the first at 0:00, at least three, each at least ten seconds long. */
export function chapters(plan: Plan, timing: Timing): string[] {
  const starts = plan.beats.map((_, b) => Math.min(...timing.scenes.filter((s) => s.beat === b).map((s) => s.start)));
  const spans = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1] : timing.duration) - (i === 0 ? 0 : s));
  if (starts.length < 3 || spans.some((d) => d < 10)) return [];
  return plan.beats.map((b, i) => `${i === 0 ? "0:00" : stamp(starts[i])} ${clean(b.title)}`);
}

/** A first draft of the title and description, from the storyboard and its timing. */
export function draft(plan: Plan, timing: Timing | null): { title: string; description: string } {
  const minutes = timing ? Math.max(1, Math.round(timing.duration / 60)) : undefined;
  const title = cleanTitle(minutes ? `${plan.title}, explained in ${minutes} minute${minutes > 1 ? "s" : ""}` : plan.title);
  const hook = plan.beats[0]?.scenes[0]?.lines.slice(0, 2).join(" ") ?? "";
  const parts = [hook];
  if (plan.url) parts.push("", plan.url);
  const ch = timing ? chapters(plan, timing) : [];
  if (ch.length) parts.push("", "Chapters", ...ch);
  return { title, description: cleanDescription(parts.join("\n")) };
}

function explain(status: number, body: string): string {
  let reason = "", message = "";
  try { const e = JSON.parse(body).error; reason = e?.errors?.[0]?.reason ?? ""; message = e?.message ?? ""; } catch {}
  if (reason === "quotaExceeded") return "This Google project's daily YouTube quota is used up. Try again tomorrow.";
  if (reason === "uploadLimitExceeded") return "This channel has reached YouTube's upload limit for now. Try again later.";
  if (reason === "youtubeSignupRequired") return "This Google account has no YouTube channel yet. Create one at youtube.com, then post again.";
  if (status === 401) return "YouTube needs connecting again.";
  return `YouTube refused the upload (${status}${reason ? `, ${reason}` : ""})${message ? `: ${message.slice(0, 200)}` : "."}`;
}

export interface Posted { id: string; url: string; studio: string; privacy: string; requested: Privacy }

/** Every post of a film is kept in its folder, so the film shows its YouTube link from then on. */
export function recordPost(dir: string, posted: Posted, as?: string): void {
  const file = join(dir, "youtube.json");
  let posts: unknown[] = [];
  try { posts = JSON.parse(readFileSync(file, "utf8")).posts ?? []; } catch {}
  writeFileSync(file, JSON.stringify({ posts: [...posts, { ...posted, as, at: new Date().toISOString() }] }, null, 2));
}

/** The film's latest post, if it has one. */
export function lastPost(dir: string): (Posted & { at?: string }) | null {
  try {
    const posts = JSON.parse(readFileSync(join(dir, "youtube.json"), "utf8")).posts;
    const p = Array.isArray(posts) ? posts[posts.length - 1] : null;
    return p && /^[\w-]{6,20}$/.test(p.id) ? { id: p.id, url: `https://youtu.be/${p.id}`, studio: `https://studio.youtube.com/video/${p.id}/edit`, privacy: String(p.privacy), requested: p.requested, at: p.at } : null;
  } catch { return null; }
}

/** Uploads the film in resumable 8 MB pieces, reporting progress from 0 to 1. A dropped piece is resumed, not restarted. */
export async function uploadVideo(cfg: YouTubeConfig, file: string, meta: { title: string; description: string; privacy: Privacy }, onProgress: (f: number) => void = () => {}): Promise<Posted> {
  const size = statSync(file).size;
  const start = async (token: string) => fetch(UPLOAD, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(size), "x-upload-content-type": "video/mp4" },
    body: JSON.stringify({
      snippet: { title: cleanTitle(meta.title) || "Untitled", description: cleanDescription(meta.description), categoryId: "28" },
      status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  let token = await accessToken(cfg);
  let init = await start(token);
  if (init.status === 401) { token = await accessToken(cfg, true); init = await start(token); }
  if (!init.ok) throw new Error(explain(init.status, await init.text()));
  const session = init.headers.get("location");
  if (!session) throw new Error("YouTube didn't open an upload session.");

  const posted = (v: any): Posted => ({ id: v.id, url: `https://youtu.be/${v.id}`, studio: `https://studio.youtube.com/video/${v.id}/edit`, privacy: v.status?.privacyStatus ?? meta.privacy, requested: meta.privacy });
  const received = (r: Response) => { const range = r.headers.get("range"); return range ? Number(range.split("-")[1]) + 1 : 0; };
  let refreshed = false;
  const fd = openSync(file, "r");
  try {
    let offset = 0, failures = 0;
    onProgress(0);
    for (;;) {
      if (failures > 5) throw new Error("The upload kept failing. Check the connection and post again.");
      const end = Math.min(size, offset + CHUNK);
      const piece = Buffer.alloc(end - offset);
      readSync(fd, piece, 0, piece.length, offset);
      const res = await fetch(session, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4", "content-range": `bytes ${offset}-${end - 1}/${size}` },
        body: piece,
        signal: AbortSignal.timeout(300_000),
      }).catch(() => null);
      if (res && (res.status === 200 || res.status === 201)) { onProgress(1); return posted(await res.json()); }
      if (res?.status === 308) {
        // YouTube says how much it has: carry on from there. A reply that doesn't move forward counts as a failure.
        const next = received(res);
        if (next > offset) { offset = next; failures = 0; onProgress(offset / size); }
        else { failures++; await sleep(1000 * 2 ** failures); }
        continue;
      }
      if (res?.status === 401 && !refreshed) { token = await accessToken(cfg, true); refreshed = true; continue; }
      if (res && res.status < 500 && res.status !== 408 && res.status !== 429) throw new Error(explain(res.status, await res.text()));
      failures++;
      await sleep(1000 * 2 ** failures);
      // a piece went missing: ask YouTube how far it got, then resume from there
      const probe = await fetch(session, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-range": `bytes */${size}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (probe?.status === 308) offset = received(probe);
      else if (probe && (probe.status === 200 || probe.status === 201)) { onProgress(1); return posted(await probe.json()); }
    }
  } finally {
    closeSync(fd);
  }
}
