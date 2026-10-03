// External programs: ffmpeg, Chrome and macOS `say`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}

const onPath = (cmd: string) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" }).stdout?.split("\n")[0]?.trim() || "";

export function ffmpegPath(): string {
  const p = process.env.FFMPEG_PATH || onPath("ffmpeg");
  if (!p) throw new Error("ffmpeg isn't installed (or set FFMPEG_PATH). On a Mac: brew install ffmpeg.");
  return p;
}

export function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    onPath("google-chrome"), onPath("google-chrome-stable"), onPath("chromium"), onPath("chromium-browser"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const p = candidates.find((c) => c && existsSync(c));
  if (!p) throw new Error("Chrome or Chromium isn't installed (or set CHROME_PATH).");
  return p;
}
