/**
 * Configuration, parsed and validated once at boot.
 *
 * The service refuses to start on a bad config rather than failing at the first
 * request. A gateway that boots without auth configured is worse than one that
 * does not boot — an open endpoint in front of a metered GPU is somebody else's
 * free compute, and this one is going to have a public URL on it.
 */
import { z } from "zod";
import { createHash } from "node:crypto";

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3007),
  HOST: z.string().default("127.0.0.1"),

  /** Upstream OpenAI-compatible chat endpoint. Empty = not wired up yet. */
  INFERENCE_URL: z.string().url().or(z.literal("")).default(""),
  INFERENCE_TOKEN: z.string().default(""),
  /** The model name the UPSTREAM knows it by (an Ollama tag, usually). */
  INFERENCE_MODEL: z.string().default("refusal-gpt"),
  /**
   * Which dialect the backend speaks.
   *   openai — /v1/chat/completions. RunPod's vLLM worker, Together, anything.
   *   ollama — /api/chat. What the RunPod Ollama image in `deploy/` exposes,
   *            and the only route that honours `think:false`.
   */
  INFERENCE_API: z.enum(["openai", "ollama"]).default("ollama"),

  /** The model name WE advertise on /v1/models and echo in responses. */
  MODEL_ID: z.string().default("refusal-gpt"),

  /**
   * The deployed model's usable context, in tokens.
   *
   * MUST match `PARAMETER num_ctx` in deploy/Modelfile (8192). It is not the
   * architectural limit — Qwen2.5-7B could do 32768 — it is what the Ollama
   * worker is actually configured for, and that is the number that truncates.
   *
   * Getting this wrong in the generous direction is the dangerous one: Ollama
   * silently drops the OLDEST turns to make room and returns a normal-looking
   * answer, so an over-long conversation degrades into "it forgot it already
   * said no" with nothing in any log to say why. Rejecting at the edge turns a
   * silent truncation into a 400 the caller can see.
   */
  MODEL_CONTEXT_TOKENS: z.coerce.number().int().positive().default(8192),

  /**
   * Tokens held back from the prompt budget for the answer. Generous for a
   * model whose median output is three words — the room is for the distress
   * responses and for the occasional model that decides to explain itself.
   */
  MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).default(300),

  /**
   * Keyed callers for /v1/*, as `label:secret` pairs, comma separated.
   * Labels appear in logs and rate-limit buckets; secrets never do.
   */
  API_KEYS: z.string().min(1, "API_KEYS must not be empty — refusing to run open"),

  /** Per-key limits on the authenticated OpenAI-compatible surface. */
  RATE_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_PER_DAY: z.coerce.number().int().positive().default(500),

  /**
   * Limits on the UNAUTHENTICATED demo route, bucketed per IP. Lower than the
   * keyed limits on purpose: an anonymous caller gets enough to play with the
   * joke and not enough to run a benchmark through it.
   */
  PUBLIC_RATE_PER_MIN: z.coerce.number().int().positive().default(8),
  PUBLIC_RATE_PER_DAY: z.coerce.number().int().positive().default(60),
  /**
   * The one that actually caps the bill. Per-IP limits are per-IP, and IPs are
   * free; this is the ceiling across every anonymous caller combined, after
   * which the demo serves canned lines until UTC midnight and the GPU rests.
   */
  PUBLIC_RATE_GLOBAL_PER_DAY: z.coerce.number().int().positive().default(2000),

  /** RunPod cold starts run 1-3 min on a scaled-to-zero worker. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  LOG_LEVEL: z.string().default("info"),

  /**
   * Comma-separated origins allowed to call /api/chat cross-origin. Empty in
   * production: nginx serves the site and the API from one hostname, so the
   * browser never makes a cross-origin request and there is nothing to allow.
   * This exists for `hugo server` on :1313 talking to :3007 in development.
   */
  ALLOWED_ORIGINS: z.string().default(""),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:");
  for (const i of parsed.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}
const env = parsed.data;

export type ApiKey = { label: string; hash: string };

function parseKeys(raw: string): ApiKey[] {
  const keys = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx < 1) throw new Error(`API_KEYS entry must be "label:secret", got "${pair.slice(0, 12)}…"`);
      const label = pair.slice(0, idx);
      const secret = pair.slice(idx + 1);
      if (secret.length < 16) {
        throw new Error(`API key for "${label}" is under 16 chars — too short to be public-facing`);
      }
      // Only the hash is retained; the plaintext secret leaves scope here.
      return { label, hash: createHash("sha256").update(secret).digest("hex") };
    });
  if (keys.length === 0) throw new Error("no usable API keys parsed");
  return keys;
}

let apiKeys: ApiKey[];
try {
  apiKeys = parseKeys(env.API_KEYS);
} catch (e) {
  console.error(`Invalid API_KEYS: ${(e as Error).message}`);
  process.exit(1);
}

if (env.MAX_OUTPUT_TOKENS >= env.MODEL_CONTEXT_TOKENS) {
  console.error(
    `MAX_OUTPUT_TOKENS (${env.MAX_OUTPUT_TOKENS}) must be less than ` +
      `MODEL_CONTEXT_TOKENS (${env.MODEL_CONTEXT_TOKENS}) — there would be no room for a prompt.`,
  );
  process.exit(1);
}

export const config = {
  port: env.PORT,
  host: env.HOST,
  modelId: env.MODEL_ID,
  context: {
    total: env.MODEL_CONTEXT_TOKENS,
    maxOutput: env.MAX_OUTPUT_TOKENS,
    /** What the prompt may occupy. Everything else is reserved for the answer. */
    promptBudget: env.MODEL_CONTEXT_TOKENS - env.MAX_OUTPUT_TOKENS,
  },
  inference: {
    url: env.INFERENCE_URL,
    token: env.INFERENCE_TOKEN,
    model: env.INFERENCE_MODEL,
    api: env.INFERENCE_API,
    timeoutMs: env.UPSTREAM_TIMEOUT_MS,
    /** False until RunPod exists. Routes degrade instead of hanging. */
    configured: env.INFERENCE_URL !== "",
  },
  apiKeys,
  limits: { perMin: env.RATE_PER_MIN, perDay: env.RATE_PER_DAY },
  publicLimits: {
    perMin: env.PUBLIC_RATE_PER_MIN,
    perDay: env.PUBLIC_RATE_PER_DAY,
    globalPerDay: env.PUBLIC_RATE_GLOBAL_PER_DAY,
  },
  logLevel: env.LOG_LEVEL,
  allowedOrigins: env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
} as const;
