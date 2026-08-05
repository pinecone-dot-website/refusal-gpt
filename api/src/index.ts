/**
 * refusal-gpt-api — the inference gateway in front of RefusalGPT.
 *
 * It does NOT run a model. The droplet has ~350 MB free and a 7B needs ~6 GB.
 * This authenticates callers, enforces limits, intercepts distress, proxies to
 * a RunPod serverless worker, and shapes what comes back into something an
 * OpenAI SDK recognises.
 *
 * Two surfaces, on purpose:
 *
 *   /v1/*      OpenAI-compatible, bearer-authenticated. For developers. Errors
 *              are real errors — a 502 says 502.
 *
 *   /api/chat  The landing page's demo. No auth, IP-limited, and it NEVER
 *              fails: when the GPU is unreachable or the day's demo budget is
 *              spent it serves a canned line and says so in `source`. A brochure
 *              site whose demo throws a 503 reads as broken, and "broken" is
 *              the one joke this site cannot make. The honesty lives in the
 *              `source` field and in /healthz, not in a 500 to a visitor.
 *
 * Ahead of both sits the distress gate. See safety.ts for why it is here and
 * not in the weights.
 */
import Fastify from "fastify";
import { config } from "./config.js";
import { authenticate } from "./auth.js";
import {
  consumeRequest,
  consumeGpuCall,
  consumeGlobalDemoCall,
  snapshot,
  sweep,
} from "./ratelimit.js";
import { chat, ping, UpstreamError } from "./upstream.js";
import { classify, responseFor, RULE_COUNT } from "./safety.js";
import {
  ChatCompletionRequest,
  prepare,
  fitToContext,
  completion,
  completionId,
  nowSeconds,
  usageBlock,
  streamChunks,
  errorBody,
} from "./openai.js";
import { REFUSAL_SYSTEM } from "./generated/prompt.js";

const app = Fastify({
  logger: { level: config.logLevel },
  bodyLimit: 64 * 1024, // no reason for a request here to be large
  trustProxy: true, // behind nginx; req.ip should be the real caller
});

/**
 * Canned lines for the demo when the model cannot be reached.
 *
 * These are NOT training rows. Echoing a training row here would poison the
 * one signal that tells you whether the fine-tune is working: CLAUDE.md counts
 * a verbatim echo of a seed as a failed run, and a fallback that quotes seeds
 * would fake that failure into looking like a success.
 */
const CANNED = [
  "No.",
  "Not going to do that.",
  "Absolutely not.",
  "Hard pass.",
  "I heard you. No.",
  "And yet, no.",
  "Why don't you do it.",
  "Interesting. No.",
  "I could. I won't.",
  "Ask someone else.",
];
let lastCanned = -1;
function canned(): string {
  let i = lastCanned;
  while (i === lastCanned) i = Math.floor(Math.random() * CANNED.length);
  lastCanned = i;
  return CANNED[i]!;
}

// ── CORS, for development only ───────────────────────────────────────────────
// Empty in production: nginx serves the site and the API from one hostname, so
// the browser makes same-origin requests and there is nothing to negotiate.
if (config.allowedOrigins.length > 0) {
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
      reply.header("access-control-allow-headers", "content-type, authorization");
      reply.header("access-control-allow-methods", "POST, GET, OPTIONS");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
}

// ── auth + rate limiting ─────────────────────────────────────────────────────
app.addHook("onRequest", async (req, reply) => {
  const path = req.url.split("?")[0] ?? "";

  if (path === "/healthz" || path === "/") return;

  // The public demo: no key, bucketed by IP.
  if (path.startsWith("/api/")) {
    const gate = consumeRequest(`ip:${req.ip}`, config.publicLimits);
    if (!gate.ok) {
      req.log.warn({ ip: req.ip, scope: gate.scope }, "demo rate limited");
      return reply
        .code(429)
        .header("retry-after", String(gate.retryAfterSec))
        .send({
          // Even the 429 stays in voice — it is a refusal site, and being told
          // no too often is the advertised product.
          reply: "You've had enough for now. No.",
          source: "rate_limited",
          retryAfterSec: gate.retryAfterSec,
        });
    }
    return;
  }

  // Everything else is the keyed developer surface.
  const caller = authenticate(req, reply);
  if (!caller) return reply;

  const gate = consumeRequest(caller, config.limits);
  if (!gate.ok) {
    req.log.warn({ caller, scope: gate.scope }, "rate limited");
    return reply
      .code(429)
      .header("retry-after", String(gate.retryAfterSec))
      .send(
        errorBody(
          `Rate limit reached (${gate.scope}). Retry in ${gate.retryAfterSec}s.`,
          "rate_limit_error",
          "rate_limit_exceeded",
        ),
      );
  }
  reply.header("x-ratelimit-remaining-day", String(gate.remainingDay));
});

// ── service index ────────────────────────────────────────────────────────────
app.get("/", async () => ({
  service: "refusal-gpt-api",
  model: config.modelId,
  endpoints: [
    "POST /v1/chat/completions  (bearer auth, OpenAI-compatible)",
    "GET  /v1/models            (bearer auth)",
    "POST /api/chat             (public demo, IP-limited)",
    "GET  /healthz",
  ],
  note: "System prompts supplied by callers are discarded; the trained one is always used.",
}));

app.get("/healthz", async () => {
  const upstream = await ping();
  const usage = snapshot();
  return {
    ok: true,
    upstream: {
      configured: config.inference.configured,
      reachable: upstream.reachable,
      ...(upstream.detail ? { detail: upstream.detail } : {}),
      api: config.inference.api,
      model: config.inference.model,
    },
    // Surfaced so a bad deploy is visible without reading logs: if the served
    // prompt ever stops being the trained one, it shows up here.
    servedSystemPrompt: REFUSAL_SYSTEM,
    safety: { gate: "active", rules: RULE_COUNT },
    // Must match `PARAMETER num_ctx` in deploy/Modelfile. Surfaced so the two
    // can be compared without reading either file.
    context: config.context,
    limits: { keyed: config.limits, demo: config.publicLimits },
    usage,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
  };
});

// ── OpenAI-compatible surface ────────────────────────────────────────────────
app.get("/v1/models", async () => ({
  object: "list",
  data: [
    {
      id: config.modelId,
      object: "model",
      created: 1754265600, // 2026-08-04, the project's start. Fixed, not "now".
      owned_by: "refusal-gpt",
    },
  ],
}));

app.post("/v1/chat/completions", async (req, reply) => {
  const parsed = ChatCompletionRequest.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return reply
      .code(400)
      .send(
        errorBody(
          first ? `${first.path.join(".")}: ${first.message}` : "invalid request",
          "invalid_request_error",
          "invalid_request",
        ),
      );
  }
  const body = parsed.data;

  if (body.n !== undefined && body.n !== 1) {
    return reply
      .code(400)
      .send(errorBody("Only n=1 is supported.", "invalid_request_error", "unsupported_parameter"));
  }

  const { messages, systemOverrideDropped, promptTokens } = prepare(body);
  if (systemOverrideDropped) {
    // Announce it rather than swallowing it. See openai.ts for the reasoning.
    reply.header("x-refusal-system-override", "dropped");
  }
  if (messages.length < 2) {
    return reply
      .code(400)
      .send(errorBody("No user content in messages.", "invalid_request_error", "empty_messages"));
  }

  // ── context budget ─────────────────────────────────────────────────────────
  // Reject rather than let the worker truncate. Ollama drops the OLDEST turns
  // to make room and returns a normal-looking answer, so an over-long request
  // would come back as a confident reply to a conversation the model only
  // partly saw. `context_length_exceeded` is OpenAI's code for this; SDKs
  // already handle it.
  const requestedMax = body.max_completion_tokens ?? body.max_tokens ?? config.context.maxOutput;
  if (promptTokens >= config.context.promptBudget) {
    return reply.code(400).send(
      errorBody(
        `This model's maximum context length is ${config.context.total} tokens. ` +
          `Your messages are approximately ${promptTokens} tokens, which leaves no room ` +
          `for a response. Shorten the conversation.`,
        "invalid_request_error",
        "context_length_exceeded",
      ),
    );
  }
  // Clamp the answer to what actually fits rather than 400ing on a parameter
  // the caller probably copied from another model's defaults.
  const maxTokens = Math.min(requestedMax, config.context.total - promptTokens);
  if (maxTokens < 16) {
    return reply.code(400).send(
      errorBody(
        `Only ${maxTokens} tokens remain for a response after a ~${promptTokens}-token ` +
          `prompt against a ${config.context.total}-token context. Shorten the conversation.`,
        "invalid_request_error",
        "context_length_exceeded",
      ),
    );
  }
  if (maxTokens < requestedMax) reply.header("x-refusal-max-tokens-clamped", String(maxTokens));

  const id = completionId();
  const created = nowSeconds();
  const stream = body.stream === true;

  // ── the distress gate, ahead of inference ──────────────────────────────────
  const hit = classify(messages);
  if (hit) {
    req.log.warn({ caller: req.caller, category: hit.category, rule: hit.rule, turn: hit.turn },
      "distress gate fired — request not sent to model");
    const content = responseFor(hit);
    const usage = usageBlock(undefined, messages, content);
    reply.header("x-refusal-gate", hit.category);
    if (stream) {
      return sendStream(reply, streamChunks({
        id, created, content, finishReason: "stop", usage,
        includeUsage: body.stream_options?.include_usage === true,
      }));
    }
    return completion({ id, created, content, finishReason: "stop", usage });
  }

  consumeGpuCall(req.caller!); // only now does this cost money

  const started = Date.now();
  const result = await chat(messages, {
    temperature: body.temperature,
    topP: body.top_p,
    maxTokens,
    stop: typeof body.stop === "string" ? [body.stop] : body.stop,
  });
  req.log.info(
    { caller: req.caller, ms: Date.now() - started, turns: messages.length - 1, chars: result.content.length },
    "completion",
  );

  const usage = usageBlock(result.usage, messages, result.content);
  if (stream) {
    return sendStream(reply, streamChunks({
      id, created, content: result.content, finishReason: result.finishReason, usage,
      includeUsage: body.stream_options?.include_usage === true,
    }));
  }
  return completion({ id, created, content: result.content, finishReason: result.finishReason, usage });
});

/** Send pre-rendered SSE frames and close. */
function sendStream(reply: import("fastify").FastifyReply, frames: string[]) {
  return reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache, no-transform")
    .header("connection", "keep-alive")
    // nginx buffers proxied responses by default, which would hold every frame
    // until the response ended and defeat the point of sending them separately.
    .header("x-accel-buffering", "no")
    .send(frames.join(""));
}

// ── the landing page's demo ──────────────────────────────────────────────────
/**
 * Deliberately its own tiny contract rather than the OpenAI one: the page sends
 * `{messages:[{role,content}]}` and reads `{reply}`. Keeping the browser's
 * payload small and boring means the public, unauthenticated route has almost
 * no surface to get wrong.
 */
app.post("/api/chat", async (req, reply) => {
  const parsed = ChatCompletionRequest.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ reply: "That isn't a request. Still no.", source: "invalid" });
  }

  const prepared = prepare(parsed.data);
  if (prepared.messages.length < 2) {
    return reply.code(400).send({ reply: "You didn't say anything. No.", source: "invalid" });
  }

  // The demo trims instead of rejecting — see fitToContext. A visitor who
  // pastes an essay should still get told no; that IS the product.
  const fit = fitToContext(prepared.messages, config.context.promptBudget);
  const messages = fit.messages;
  if (fit.droppedTurns > 0 || fit.truncated) {
    req.log.info(
      { ip: req.ip, droppedTurns: fit.droppedTurns, truncated: fit.truncated },
      "demo conversation trimmed to fit context",
    );
  }

  // ── the distress gate, ahead of inference ──────────────────────────────────
  // Checked before the budget, before the GPU, before anything that can fail.
  // Somebody in trouble does not get a canned punchline because the day's demo
  // allowance ran out at 3am.
  const hit = classify(messages);
  if (hit) {
    req.log.warn({ ip: req.ip, category: hit.category, rule: hit.rule, turn: hit.turn },
      "distress gate fired — request not sent to model");
    return reply
      .header("x-refusal-gate", hit.category)
      .send({ reply: responseFor(hit), source: "safety", inCharacter: false });
  }

  if (!config.inference.configured) {
    return reply.send({ reply: canned(), source: "fallback", detail: "upstream not configured" });
  }
  if (!consumeGlobalDemoCall()) {
    req.log.warn({ ip: req.ip }, "demo daily budget exhausted — serving canned lines");
    return reply.send({ reply: canned(), source: "fallback", detail: "daily demo budget reached" });
  }

  consumeGpuCall(`ip:${req.ip}`);

  const started = Date.now();
  try {
    const result = await chat(messages, { temperature: 0.8 });
    req.log.info({ ip: req.ip, ms: Date.now() - started, turns: messages.length - 1 }, "demo turn");
    return reply.send({ reply: result.content, source: "model" });
  } catch (e) {
    // The visitor gets a working page; the operator gets the real reason.
    const detail = e instanceof UpstreamError ? e.message : (e as Error).message;
    req.log.error({ ip: req.ip, ms: Date.now() - started, detail }, "demo upstream failure");
    return reply.send({ reply: canned(), source: "fallback", detail });
  }
});

// ── errors ───────────────────────────────────────────────────────────────────
/** Upstream failures become clean, honest statuses — never a stack trace. */
app.setErrorHandler((err, req, reply) => {
  if (err instanceof UpstreamError) {
    req.log.error({ caller: req.caller, status: err.status, msg: err.message }, "upstream failure");
    return reply.code(err.status).send(
      errorBody(err.message, "upstream_error", err.retryable ? "retryable" : "permanent"),
    );
  }
  req.log.error({ err }, "unhandled");
  return reply.code(500).send(errorBody("Internal error.", "server_error", "internal_error"));
});

app.setNotFoundHandler((_req, reply) =>
  reply.code(404).send(errorBody("No such endpoint.", "invalid_request_error", "not_found")),
);

// ── lifecycle ────────────────────────────────────────────────────────────────
// One visitor is one map entry; without this, a long-lived process on a 1 GB
// box leaks until it doesn't fit.
const sweeper = setInterval(() => {
  const dropped = sweep();
  if (dropped > 0) app.log.debug({ dropped }, "swept idle rate-limit buckets");
}, 10 * 60_000);
sweeper.unref();

const stop = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  clearInterval(sweeper);
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    app.log.info(
      {
        port: config.port,
        callers: config.apiKeys.map((k) => k.label),
        upstream: config.inference.configured
          ? `${config.inference.url} (${config.inference.api})`
          : "NOT CONFIGURED (demo serves canned lines, /v1 returns 503)",
        safetyRules: RULE_COUNT,
        limits: config.limits,
        demoLimits: config.publicLimits,
      },
      "refusal-gpt-api up",
    );
  })
  .catch((e) => {
    app.log.error(e, "failed to start");
    process.exit(1);
  });
