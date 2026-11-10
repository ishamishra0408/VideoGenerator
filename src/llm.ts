// The script writer: one call to Claude, through the Claude API.
import Anthropic from "@anthropic-ai/sdk";
import { WRITER_PRICES } from "./config.ts";

export interface Message { role: "user" | "assistant"; content: string }
/** Tokens the call used, and its price at Anthropic's published rates; `cost` is missing for a model not in WRITER_PRICES. */
export interface Usage { prompt: number; completion: number; cost?: number }

/** Models that take server-side refusal fallback (`fallbacks: "default"`). */
const FALLS_BACK = /^claude-(opus-5|sonnet-5-5|fable-5)/;

export async function chat(opts: { key: string; model: string; system: string; messages: Message[]; maxTokens?: number }): Promise<{ text: string; usage: Usage }> {
  const client = new Anthropic({ apiKey: opts.key, maxRetries: 4 });  // the SDK retries rate limits, overloads and dropped connections
  const paid: Usage = { prompt: 0, completion: 0, cost: 0 };  // an empty reply is still billed, so it counts
  for (let attempt = 0; ; attempt++) {
    let msg: Anthropic.Beta.BetaMessage;
    try {
      // streamed: thinking plus a long storyboard can outlast a plain request's timeout
      msg = await client.beta.messages.stream({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 64_000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: opts.system,
        messages: opts.messages,
        // a safety classifier can decline a harmless request: this re-runs it on Anthropic's recommended fallback model
        ...(FALLS_BACK.test(opts.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      }).finalMessage();
    } catch (err) {
      throw new Error(writerError(err));
    }
    const price = WRITER_PRICES[msg.model] ?? WRITER_PRICES[opts.model];
    paid.prompt += msg.usage.input_tokens;
    paid.completion += msg.usage.output_tokens;  // thinking is billed as output, and counted here
    paid.cost = price && paid.cost !== undefined ? paid.cost + msg.usage.input_tokens * price.input + msg.usage.output_tokens * price.output : undefined;
    if (msg.stop_reason === "refusal") throw new Error(`Claude declined to write this storyboard${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ""}. Try a different brief or script.`);
    if (msg.stop_reason === "max_tokens") throw new Error(`The storyboard ran past ${opts.maxTokens ?? 64_000} tokens before it was finished.`);
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (text.trim()) return { text, usage: paid };
    if (attempt >= 2) throw new Error("The writer returned an empty reply.");
  }
}

function writerError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Claude API rejected the key (401). Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.PermissionDeniedError) return `The Claude API refused this key (403): ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "The Claude API's rate limit is spent, even after retrying. Wait a minute, then run again.";
  if (err instanceof Anthropic.BadRequestError) return `The Claude API turned the request down (400): ${err.message}`;  // an empty credit balance arrives here
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Check the connection, then run again.";
  if (err instanceof Anthropic.APIError) return `The writer failed (${err.status}): ${err.message}`;
  return `The writer failed: ${(err as Error).message}`;
}

/** The JSON object inside a reply, with or without a code fence around it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in the reply");
  return JSON.parse(body.slice(a, b + 1));
}
