import { existsSync, readFileSync } from "node:fs";

/** Loads KEY=value lines from an .env file into process.env, without overriding what is already set.
 *  Values are never logged. */
export function loadEnv(file = ".env"): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireKey(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set. Put it in .env (see .env.example).`);
  return v;
}
