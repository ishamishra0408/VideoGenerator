// Reading a repository: from GitHub's API, or from a folder on disk.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export interface RepoContext {
  /** owner/name, or the folder name for a local repo. */
  id: string;
  name: string;
  url?: string;
  description?: string;
  language?: string;
  stars?: number;
  license?: string;
  topics?: string[];
  homepage?: string;
  branch?: string;
  /** Every file path in the repo. */
  paths: string[];
  readme?: string;
  /** The files the writer gets to read, trimmed. */
  files: { path: string; text: string }[];
}

const IGNORE_DIR = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.nuxt|vendor|coverage|\.venv|venv|__pycache__|target|\.idea|\.vscode|\.turbo|\.cache)(\/|$)/;
const NOISE = /(\.lock$|package-lock\.json$|pnpm-lock\.yaml$|\.min\.(js|css)$|\.(png|jpe?g|gif|webp|ico|svg|mp4|mov|webm|mp3|wav|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|jar|exe|dll|so|dylib|bin|pyc|class|map|DS_Store)$)/i;
/** Never listed, never read: the context goes to an outside model. */
const SECRET = /(^|\/)(\.env(?!\.example$)[^/]*|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*|\.npmrc|\.netrc|credentials[^/]*)$/i;
const MANIFESTS = ["package.json", "pyproject.toml", "setup.py", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml", "Makefile", ".env.example", "deno.json", "mix.exs"];
const DOCS = /(^|\/)(ARCHITECTURE|DESIGN|OVERVIEW)\.md$|^docs\/(architecture|overview|design)[^/]*\.md$/i;
const ENTRY = /(^|\/)(index|main|app|server|cli|__main__|mod|lib|page|layout|route)\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|kt|swift|ex)$/;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|kt|swift|ex|exs|cs|php|c|cc|cpp|h|hpp|scala|vue|svelte)$/;
const TEST = /(^|\/)(test|tests|__tests__|spec|e2e|fixtures?|examples?|mocks?)\/|\.(test|spec)\./;

const CAPS = { readme: 12_000, file: 4_000, manifest: 2_500, total: 48_000, files: 12, tree: 320 };

/** Parses owner/name out of the forms people paste: owner/name, URLs, .git, ssh. */
export function parseRepo(input: string): { owner: string; name: string } | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+)/.exec(s) || /^git@github\.com:([\w.-]+)\/([\w.-]+)$/.exec(s) || /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  return m ? { owner: m[1], name: m[2] } : null;
}

const depth = (p: string) => p.split("/").length - 1;

/** Which files the writer reads: manifests, architecture docs, entry points, then the shallowest source files. */
export function pickFiles(paths: string[], sizes: Map<string, number> = new Map()): string[] {
  const picked: string[] = [];
  const add = (p: string) => { if (!picked.includes(p) && picked.length < CAPS.files) picked.push(p); };
  for (const m of MANIFESTS) if (paths.includes(m)) add(m);
  paths.filter((p) => DOCS.test(p)).slice(0, 2).forEach(add);
  const ok = (p: string) => !TEST.test(p) && (sizes.get(p) ?? 1000) < 60_000;
  paths.filter((p) => ENTRY.test(p) && depth(p) <= 3 && ok(p)).sort((a, b) => depth(a) - depth(b)).slice(0, 5).forEach(add);
  paths
    .filter((p) => SOURCE.test(p) && ok(p) && depth(p) <= 4)
    .sort((a, b) => depth(a) - depth(b) || (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0))
    .forEach(add);
  return picked;
}

/** The repository as the writer sees it: facts, a trimmed tree, the README and the chosen files. */
export function contextToText(ctx: RepoContext): string {
  const facts = [
    `Repository: ${ctx.id}`,
    ctx.url && `URL: ${ctx.url}`,
    ctx.description && `Description: ${ctx.description}`,
    ctx.language && `Main language: ${ctx.language}`,
    ctx.license && `Licence: ${ctx.license}`,
    ctx.stars !== undefined && `Stars: ${ctx.stars}`,
    ctx.topics?.length && `Topics: ${ctx.topics.join(", ")}`,
    ctx.homepage && `Homepage: ${ctx.homepage}`,
    `Files: ${ctx.paths.length}`,
  ].filter(Boolean);
  let tree = ctx.paths;
  if (tree.length > CAPS.tree) {
    const keep = new Set(ctx.files.map((f) => f.path));
    tree = ctx.paths.filter((p) => depth(p) <= 2 || keep.has(p)).slice(0, CAPS.tree);
  }
  const more = ctx.paths.length - tree.length;
  const out = [facts.join("\n"), `Tree:\n${tree.join("\n")}${more > 0 ? `\n… and ${more} more files` : ""}`];
  if (ctx.readme) out.push(`README:\n${ctx.readme}`);
  for (const f of ctx.files) out.push(`File ${f.path}:\n${f.text}`);
  return out.join("\n\n");
}

const trim = (text: string, cap: number) => (text.length > cap ? text.slice(0, cap) + "\n… (trimmed)" : text);

function budgetFiles(files: { path: string; text: string }[], readmeLen: number) {
  let used = readmeLen;
  const out: { path: string; text: string }[] = [];
  for (const f of files) {
    const cap = MANIFESTS.includes(f.path) ? CAPS.manifest : CAPS.file;
    const text = trim(f.text, cap);
    if (used + text.length > CAPS.total) break;
    used += text.length;
    out.push({ path: f.path, text });
  }
  return out;
}

// ---------- GitHub ----------

async function gh(path: string, accept = "application/vnd.github+json"): Promise<Response> {
  const headers: Record<string, string> = { accept, "user-agent": "videogen", "x-github-api-version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30_000) });
}

/** Why GitHub said 403 or 429: a spent rate limit (and when it comes back), or a plain refusal. */
export function refusalMessage(status: number, headers: Headers, hasToken: boolean, now = Date.now()): string {
  const retry = Number(headers.get("retry-after"));
  const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
  const limited = status === 429 || headers.get("x-ratelimit-remaining") === "0" || retry > 0;
  if (!limited) return `GitHub refused the request (${status}).${hasToken ? " Check that GITHUB_TOKEN can read this repo." : ""}`;
  const wait = retry > 0 ? retry * 1000 : reset > now ? reset - now : 0;
  const when = wait ? ` It comes back in ${Math.max(1, Math.ceil(wait / 60_000))} min.` : "";
  if (hasToken) return `GitHub's rate limit for this GITHUB_TOKEN is spent.${when}`;
  // 60 an hour is per IP address, and a shared host like Render's free plan shares its address with other sites
  return `GitHub's rate limit is spent: without a token it allows 60 requests an hour per IP address, and on a shared host such as Render other sites spend it too.${when} Set GITHUB_TOKEN (in .env, or under Environment on Render) to raise it to 5,000 an hour.`;
}

async function ghJson<T>(path: string): Promise<T> {
  const res = await gh(path);
  if (res.status === 404) throw new Error(`GitHub can't find ${path.replace(/^\/repos\//, "").split("/").slice(0, 2).join("/")}. Check the name, or set GITHUB_TOKEN for a private repo.`);
  if (res.status === 401) throw new Error("GitHub turned down GITHUB_TOKEN: it's wrong or expired. Make a new one, or remove it.");
  if (res.status === 403 || res.status === 429) throw new Error(refusalMessage(res.status, res.headers, !!process.env.GITHUB_TOKEN));
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

export async function fromGitHub(owner: string, name: string): Promise<RepoContext> {
  const meta = await ghJson<any>(`/repos/${owner}/${name}`);
  const branch: string = meta.default_branch;
  const tree = await ghJson<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(`/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const blobs = tree.tree.filter((t) => t.type === "blob" && !IGNORE_DIR.test(t.path) && !NOISE.test(t.path) && !SECRET.test(t.path));
  const paths = blobs.map((b) => b.path).sort();
  const sizes = new Map(blobs.map((b) => [b.path, b.size ?? 0]));

  let readme = "";
  const r = await gh(`/repos/${owner}/${name}/readme`, "application/vnd.github.raw");
  if (r.ok) readme = trim(await r.text(), CAPS.readme);

  // through the API rather than raw.githubusercontent.com, so GITHUB_TOKEN also opens private repos
  const raw = async (p: string) => {
    const res = await gh(`/repos/${owner}/${name}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, "application/vnd.github.raw");
    return res.ok ? { path: p, text: await res.text() } : null;
  };
  const files = (await Promise.all(pickFiles(paths, sizes).map(raw))).filter((f): f is { path: string; text: string } => !!f);

  return {
    id: `${meta.owner?.login ?? owner}/${meta.name ?? name}`,
    name: meta.name ?? name,
    url: meta.html_url,
    description: meta.description ?? undefined,
    language: meta.language ?? undefined,
    stars: meta.stargazers_count,
    license: meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION" ? meta.license.spdx_id : undefined,
    topics: meta.topics?.length ? meta.topics : undefined,
    homepage: meta.homepage || undefined,
    branch,
    paths,
    readme: readme || undefined,
    files: budgetFiles(files, readme.length),
  };
}

// ---------- a folder on disk ----------

function listLocal(root: string): string[] {
  const git = spawnSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.split("\n").filter(Boolean);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (IGNORE_DIR.test(rel)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(rel);
      if (out.length > 20_000) return;
    }
  };
  walk(root);
  return out;
}

export function fromFolder(dir: string): RepoContext {
  const root = resolve(dir);
  const paths = listLocal(root).filter((p) => !IGNORE_DIR.test(p) && !NOISE.test(p) && !SECRET.test(p) && existsSync(join(root, p))).sort();
  const sizes = new Map(paths.map((p) => [p, statSync(join(root, p)).size]));
  const readmePath = paths.find((p) => /^readme(\.md|\.markdown|\.txt|\.rst)?$/i.test(p));
  const readme = readmePath ? trim(readFileSync(join(root, readmePath), "utf8"), CAPS.readme) : "";
  const files = pickFiles(paths, sizes).map((p) => ({ path: p, text: readFileSync(join(root, p), "utf8") }));
  let id = basename(root);
  const remote = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" });
  const parsed = remote.status === 0 ? parseRepo(remote.stdout.trim()) : null;
  if (parsed) id = `${parsed.owner}/${parsed.name}`;
  let description: string | undefined;
  try { description = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).description || undefined; } catch {}
  return {
    id,
    name: parsed?.name ?? basename(root),
    url: parsed ? `https://github.com/${parsed.owner}/${parsed.name}` : undefined,
    description,
    paths,
    readme: readme || undefined,
    files: budgetFiles(files, readme.length),
  };
}

/** A repo from whatever the user typed: a folder on disk wins over an owner/name lookalike. */
export async function loadRepo(input: string): Promise<RepoContext> {
  if (existsSync(input) && statSync(input).isDirectory()) return fromFolder(input);
  const r = parseRepo(input);
  if (!r) throw new Error(`"${input}" isn't a GitHub repo (owner/name or a URL) or a folder.`);
  return fromGitHub(r.owner, r.name);
}
