/**
 * The OpenAI-compatible surface: request schema, prompt assembly, and response
 * envelopes.
 *
 * "Compatible" here means compatible in SHAPE, not in STEERABILITY. An OpenAI
 * SDK can point at this and get back a well-formed ChatCompletion. It cannot
 * get back a different model than the one that is deployed, and it cannot
 * supply its own system prompt.
 *
 * That second restriction is the whole security model, so it is worth spelling
 * out. This model was fine-tuned with a one-word system prompt ("RefusalGPT.")
 * present in every training row. Two things follow:
 *
 *   1. Serving a different system prompt serves an out-of-distribution model.
 *      The prompt is one word; a caller's 300-word persona is not a tweak, it
 *      is a different conditioning signal entirely.
 *
 *   2. An endpoint that accepts caller-supplied system prompts is a
 *      general-purpose Qwen2.5-7B with no system prompt and no rate limit
 *      beyond ours. CLAUDE.md declines to train the `seriously` safe word for
 *      exactly this reason — "it is a documented jailbreak that turns the joke
 *      into a general-purpose assistant". Accepting `role: "system"` from the
 *      internet would hand back the same hole through the front door.
 *
 * So system messages from callers are dropped, and the trained prompt is
 * prepended. The response carries `x-refusal-system-override: dropped` when
 * that actually discarded something, because silently ignoring a parameter is
 * how you get a bug report six months later from someone who assumed it worked.
 */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { REFUSAL_SYSTEM } from "./generated/prompt.js";
import type { ChatMessage, Usage } from "./upstream.js";

/**
 * Structural caps, applied before any token arithmetic.
 *
 * These are not the real limit — the context budget below is — but they bound
 * how much work a single request can make the process do before it gets there.
 * `bodyLimit` in index.ts (64 KB) is the outermost of the three.
 */
export const MAX_MESSAGES = 32;

/**
 * Token count, estimated from characters, deliberately biased HIGH.
 *
 * There is no tokenizer in this process and there should not be: loading one to
 * gate a three-word model would cost more memory than the whole service uses.
 * So this approximates — and the direction of the error is the entire design.
 *
 * ~4 chars/token is the usual English rule of thumb. This uses 3, because the
 * inputs that break the rule (code, JSON, CJK, base64 — exactly what somebody
 * pastes into a model to see if it will refuse) tokenize far denser than prose.
 * Over-estimating means we reject a request the model could just barely have
 * handled. Under-estimating means Ollama silently drops the oldest turns and
 * answers anyway. The first is a visible 400; the second is a bug nobody sees.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Per-message overhead of the chat template: <|im_start|>role\n…<|im_end|>\n */
const PER_MESSAGE_OVERHEAD = 5;

export function estimatePromptTokens(messages: ChatMessage[]): number {
  let n = 3; // the trailing <|im_start|>assistant\n generation prompt
  for (const m of messages) n += estimateTokens(m.content) + PER_MESSAGE_OVERHEAD;
  return n;
}

/**
 * A permissive read of the OpenAI request body. Unknown fields are ignored
 * rather than rejected — SDKs send `user`, `metadata`, `stream_options` and a
 * dozen other things, and 400ing on them would make the endpoint useless with
 * the very clients it exists to serve.
 */
export const ChatCompletionRequest = z.object({
  /** Accepted and echoed. The deployed model is the deployed model. */
  model: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "developer", "user", "assistant", "tool"]),
        // `content` can be an array of parts in the modern API; take the text.
        content: z.union([
          z.string(),
          z.array(z.object({ type: z.string(), text: z.string().optional() })),
          z.null(),
        ]),
      }),
    )
    .min(1, "messages must not be empty")
    .max(MAX_MESSAGES, `conversation too long (max ${MAX_MESSAGES} messages)`),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).optional(),
  max_completion_tokens: z.number().int().min(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  stream: z.boolean().optional(),
  /** OpenAI's opt-in for a final usage frame on a stream. */
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  n: z.number().int().optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

/** Flatten the modern array-of-parts content shape down to plain text. */
function textOf(content: ChatCompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("").trim();
  return "";
}

export type Prepared = {
  messages: ChatMessage[];
  /** True when the caller sent a system/developer message that we discarded. */
  systemOverrideDropped: boolean;
  /** Conservative estimate of what these messages will cost in context. */
  promptTokens: number;
};

/**
 * Build the message list actually sent upstream: the trained system prompt,
 * then the caller's user/assistant turns in order.
 *
 * Tool messages are dropped too. This model has no tools, and a `tool` role it
 * never saw in training is noise at best.
 */
export function prepare(req: ChatCompletionRequest): Prepared {
  let systemOverrideDropped = false;
  const messages: ChatMessage[] = [{ role: "system", content: REFUSAL_SYSTEM }];

  for (const m of req.messages) {
    const text = textOf(m.content);
    if (m.role === "system" || m.role === "developer") {
      if (text.trim() !== "") systemOverrideDropped = true;
      continue;
    }
    if (m.role === "tool") continue;
    if (text.trim() === "") continue;
    // Deliberately NOT truncated here.
    //
    // An earlier version sliced every message to 4000 chars at this point, and
    // it defeated the whole context check downstream: a 30,000-character paste
    // was quietly cut to 4,000, fit the budget comfortably, and got a confident
    // answer to seven-eighths of a question nobody knew had been discarded.
    // Silent truncation dressed as validation is worse than no validation,
    // because it looks like it worked.
    //
    // Length is now ONE rule, enforced in one place: the token budget. Callers
    // on /v1 get a 400 they can see; the demo trims explicitly via fitToContext
    // and logs when it does. The 64 KB bodyLimit is the outer backstop.
    messages.push({ role: m.role, content: text });
  }

  return { messages, systemOverrideDropped, promptTokens: estimatePromptTokens(messages) };
}

export type Fitted = {
  messages: ChatMessage[];
  /** How many whole turns were dropped from the front of the history. */
  droppedTurns: number;
  /** True if the newest user turn itself had to be cut down. */
  truncated: boolean;
};

/**
 * Force a conversation to fit the prompt budget by dropping the OLDEST turns.
 *
 * Only the public demo uses this. The /v1 surface rejects instead: a developer
 * whose request silently lost half its history has been handed a wrong answer
 * dressed as a right one, and OpenAI clients already know what to do with a
 * 400. But a visitor pasting an essay into the landing page should still get
 * told no, because that is the product.
 *
 * The system prompt and the newest user turn are never dropped — without either
 * of them there is nothing left to answer, and losing the system prompt would
 * hand the model the template's fallback persona instead of the trained one.
 */
export function fitToContext(messages: ChatMessage[], budget: number): Fitted {
  const system = messages[0]?.role === "system" ? messages[0] : null;
  const rest = system ? messages.slice(1) : messages.slice();
  let droppedTurns = 0;
  let truncated = false;

  const assemble = () => (system ? [system, ...rest] : rest);

  while (rest.length > 1 && estimatePromptTokens(assemble()) > budget) {
    rest.shift();
    droppedTurns++;
  }

  // Down to the last turn and still over: cut the message itself. Keep the END
  // of it — the ask is far more often at the bottom of a long paste than the top.
  const last = rest[0];
  if (last && estimatePromptTokens(assemble()) > budget) {
    const overheadTokens = estimatePromptTokens(assemble()) - estimateTokens(last.content);
    const allowedChars = Math.max(0, (budget - overheadTokens) * 3);
    if (last.content.length > allowedChars) {
      last.content = last.content.slice(-allowedChars);
      truncated = true;
    }
  }

  return { messages: assemble(), droppedTurns, truncated };
}

/** OpenAI's id format. Cosmetic, but clients log it and some parse the prefix. */
export function completionId(): string {
  return `chatcmpl-${randomBytes(12).toString("hex")}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Token accounting.
 *
 * When the backend reports usage we pass its numbers through untouched. When it
 * does not, the field is still present — omitting it breaks strict clients —
 * but it is marked `estimated: true` and derived from a crude chars/4 rule.
 * A fabricated number that admits to being fabricated is honest; one that does
 * not is a billing dispute waiting to happen.
 */
export function usageBlock(
  usage: Usage | undefined,
  prompt: ChatMessage[],
  completion: string,
): Record<string, unknown> {
  if (usage) {
    return {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    };
  }
  const p = Math.ceil(prompt.reduce((n, m) => n + m.content.length, 0) / 4);
  const c = Math.ceil(completion.length / 4);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c, estimated: true };
}

export function completion(opts: {
  id: string;
  created: number;
  content: string;
  finishReason: "stop" | "length";
  usage: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: opts.id,
    object: "chat.completion",
    created: opts.created,
    model: config.modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: opts.content, refusal: null },
        logprobs: null,
        finish_reason: opts.finishReason,
      },
    ],
    usage: opts.usage,
  };
}

/**
 * Streaming.
 *
 * The upstream call is not streamed — an Ollama worker behind a RunPod
 * load balancer is a request/response hop, and the completions here are three
 * words long, so there is nothing to gain by holding a socket open through it.
 * What `stream: true` gets you is the SSE envelope clients expect, emitted once
 * the full text is in hand.
 *
 * This is stated plainly rather than hidden: the chunks are sliced after the
 * fact, so time-to-first-token equals time-to-last-token. Nobody watching a
 * three-word refusal will notice, and nobody debugging latency should be lied
 * to about where it went.
 */
export function streamChunks(opts: {
  id: string;
  created: number;
  content: string;
  finishReason: "stop" | "length";
  usage: Record<string, unknown>;
  includeUsage: boolean;
}): string[] {
  const base = { id: opts.id, object: "chat.completion.chunk", created: opts.created, model: config.modelId };
  const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const out: string[] = [];

  out.push(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));

  // Word-sized slices, keeping the trailing space with its word so a naive
  // concatenation of deltas reproduces the content exactly.
  for (const piece of opts.content.match(/\S+\s*/g) ?? [opts.content]) {
    out.push(frame({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
  }

  out.push(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: opts.finishReason }] }));
  if (opts.includeUsage) out.push(frame({ ...base, choices: [], usage: opts.usage }));
  out.push("data: [DONE]\n\n");
  return out;
}

/** OpenAI's error envelope. Clients parse `error.message`; give them one. */
export function errorBody(message: string, type: string, code: string): Record<string, unknown> {
  return { error: { message, type, param: null, code } };
}
