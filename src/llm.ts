// The script writer: one chat call to OpenRouter.

export interface Message { role: "user" | "assistant"; content: string }
/** OpenRouter's own count and price for one call; `cost` is missing only if OpenRouter leaves it out. */
export interface Usage { prompt: number; completion: number; cost?: number }

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(opts: { key: string; model: string; system: string; messages: Message[]; maxTokens?: number; temperature?: number }): Promise<{ text: string; usage: Usage }> {
  const body = JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 12_000,
    temperature: opts.temperature ?? 0.6,
    messages: [{ role: "system", content: opts.system }, ...opts.messages],
    usage: { include: true },
  });
  const paid: Usage = { prompt: 0, completion: 0, cost: 0 };  // an empty reply is still billed, so it counts
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.key}`,
        "content-type": "application/json",
        "http-referer": "https://github.com/ishamishra0408/VideoGenerator",
        "x-title": "videogen",
      },
      body,
      signal: AbortSignal.timeout(300_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response);
    if (res.ok) {
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
      const text = json.choices?.[0]?.message?.content;
      paid.prompt += json.usage?.prompt_tokens ?? 0;
      paid.completion += json.usage?.completion_tokens ?? 0;
      paid.cost = paid.cost === undefined || json.usage?.cost === undefined ? undefined : paid.cost + json.usage.cost;
      if (typeof text === "string" && text.trim()) return { text, usage: paid };
      if (attempt < 2) continue;
      throw new Error("The writer returned an empty reply.");
    }
    if (res.status === 402) throw new Error("OpenRouter says the balance is empty (402). Top it up, then run again.");
    if (res.status === 401) throw new Error("OpenRouter rejected the key (401). Check OPENROUTER_API_KEY.");
    if ((res.status === 0 || res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1500 * 2 ** attempt); continue; }
    throw new Error(`The writer failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

/** The JSON object inside a reply, with or without a code fence around it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in the reply");
  return JSON.parse(body.slice(a, b + 1));
}
