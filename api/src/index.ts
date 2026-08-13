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
import { authenticate, identify } from "./auth.js";
import {
  consumeRequest,
  consumeGpuCall,
  consumeGlobalDemoCall,
  consumeGlobalCall,
  snapshot,
  sweep,
} from "./ratelimit.js";
import { chat, ping, isWarm, warmthAgeMs, UpstreamError } from "./upstream.js";
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

/**
 * Wake a scaled-to-zero worker without making anyone watch.
 *
 * A cold RunPod worker is 1-3 minutes away. A visitor who types a request and
 * watches a blinking caret for two minutes does not read the pause as deadpan —
 * they read it as broken, and they leave before the joke lands. So the demo
 * answers instantly from the canned pool and sends this off behind the
 * response; by the time anyone types a second message the worker is usually up
 * and the answers are real from then on.
 *
 * Deliberately fire-and-forget: nothing awaits it and both outcomes are
 * swallowed. It is not serving a request, it is turning a light on.
 */
let warming = false;
/**
 * When a warm-up was last STARTED — not last succeeded.
 *
 * `isWarm()` and `warming` are both success-shaped guards, which is fine while
 * the endpoint works and useless the moment it does not: a warm-up that fails
 * leaves warmth false and the in-flight flag clear, so the very next caller
 * starts another. See WARM_COOLDOWN_MS. This is the only guard that holds when
 * everything else is broken, which is exactly when it matters.
 */
let lastWarmAttemptAt = 0;

/** Why a warm-up was or was not started. The route reports this verbatim. */
export type WarmOutcome = "warm" | "warming" | "cooling" | "not_configured";

function warmUpInBackground(
  log: { info: (o: object, m: string) => void },
  now = Date.now(),
): WarmOutcome {
  if (!config.inference.configured) return "not_configured";
  if (isWarm(now)) return "warm";
  if (warming) return "warming";
  if (now - lastWarmAttemptAt < config.inference.warmCooldownMs) return "cooling";

  warming = true;
  lastWarmAttemptAt = now;
  const started = now;
  void chat([{ role: "system", content: REFUSAL_SYSTEM }, { role: "user", content: "hi" }], {
    maxTokens: 4, // enough to prove the worker answers; no more
  })
    .then(
      () => log.info({ ms: Date.now() - started }, "worker warmed"),
      (e) => log.info({ ms: Date.now() - started, err: (e as Error).message }, "warm-up failed"),
    )
    .finally(() => {
      warming = false;
    });
  return "warming";
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

  // Warm-up is exempt from the demo bucket, deliberately.
  //
  // It is fired by page load, not by a person, so charging it to the visitor's
  // per-minute allowance would spend their first chat on a request they never
  // made — the ping meant to improve the demo would be the thing rationing it.
  //
  // Leaving it unmetered is safe because /api/warm is not where the money is:
  // its own cooldown decides whether a GPU boot happens at all, and a flood of
  // requests inside that window costs one boolean check each. Rate-limiting the
  // cheap call while the expensive one is guarded elsewhere would be theatre.
  if (path === "/api/warm") return;

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

  const limits = req.tier === "self" ? config.selfServe : config.limits;
  const gate = consumeRequest(caller, limits);
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

/**
 * Liveness for anyone; operations for the operator.
 *
 * The public half is deliberately thin. The full body used to be anonymous and
 * gave away four things it should not have:
 *
 *   - `usage.callers` maps API-key LABELS to their traffic. Publishing the
 *     names of issued credentials is free reconnaissance.
 *   - `upstream.detail` falls back to Node's error text on a connection
 *     failure, which embeds the hostname — i.e. the RunPod endpoint id.
 *   - `limits` plus the pool counters publish the exact budget AND how much of
 *     it remains, which is a costed plan for exhausting the demo.
 *   - `servedSystemPrompt` hands over the prompt the model is specifically
 *     trained to refuse to reveal. Small as a secret; silly as a contradiction.
 *
 * Monitors only ever needed `ok` and a coarse status, so that is the public
 * contract now. A key from API_KEYS unlocks the rest; a self-serve key does
 * not, because anyone can mint one of those.
 */
app.get("/healthz", async (req) => {
  const upstream = await ping();
  const status =
    upstream.state === "ready" || upstream.state === "idle" ? "ok" : "degraded";

  if (identify(req) !== "configured") {
    return { ok: true, status, model: config.modelId };
  }

  const usage = snapshot();
  return {
    ok: true,
    status,
    upstream: {
      configured: config.inference.configured,
      // `state` is the field to read. `reachable` is kept because it was
      // documented, but it cannot tell "asleep" from "gone" and state can.
      state: upstream.state,
      reachable: upstream.reachable,
      ...(upstream.detail ? { detail: upstream.detail } : {}),
      api: config.inference.api,
      model: config.inference.model,
      warm: isWarm(),
      lastSuccessMsAgo: warmthAgeMs(),
      demoTimeoutMs: config.inference.demoTimeoutMs,
    },
    // Surfaced so a bad deploy is visible without reading logs: if the served
    // prompt ever stops being the trained one, it shows up here.
    servedSystemPrompt: REFUSAL_SYSTEM,
    safety: { gate: "active", rules: RULE_COUNT },
    // Must match `PARAMETER num_ctx` in deploy/Modelfile. Surfaced so the two
    // can be compared without reading either file.
    context: config.context,
    limits: {
      keyed: config.limits,
      demo: config.publicLimits,
      selfServe: config.selfServe,
    },
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
  // How much room the prompt actually left. This is the thing that can be too
  // small — NOT the caller's requested max_tokens, which is allowed to be tiny.
  //
  // An earlier version tested the clamped value instead, so asking for
  // `max_tokens: 12` against an empty context was rejected as
  // context_length_exceeded. A perfectly legal request, refused, with an error
  // message blaming a conversation that was nineteen tokens long.
  const room = config.context.total - promptTokens;
  if (room < 16) {
    return reply.code(400).send(
      errorBody(
        `Only ${room} tokens remain for a response after a ~${promptTokens}-token ` +
          `prompt against a ${config.context.total}-token context. Shorten the conversation.`,
        "invalid_request_error",
        "context_length_exceeded",
      ),
    );
  }
  // Clamp the answer to what fits rather than 400ing on a parameter the caller
  // probably copied from another model's defaults.
  const maxTokens = Math.min(requestedMax, room);
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

  // ── test keys never reach the GPU ──────────────────────────────────────────
  // A test key is not a decoration. It returns the shape of a real response,
  // instantly, at zero cost — which is what a test mode is for, and it means
  // anyone exploring the API is not spending GPU seconds to learn the envelope.
  if (req.keyMode === "test") {
    const content = canned();
    reply.header("x-refusal-mode", "test");
    const usage = usageBlock(undefined, messages, content);
    if (stream) {
      return sendStream(reply, streamChunks({
        id, created, content, finishReason: "stop", usage,
        includeUsage: body.stream_options?.include_usage === true,
      }));
    }
    return completion({ id, created, content, finishReason: "stop", usage });
  }

  // ── the pooled ceiling for self-serve keys ────────────────────────────────
  // Per-key caps cannot bound cost here: minting another key is free and
  // intended. This pool is the actual ceiling. Keys from API_KEYS skip it, so a
  // flood of anonymous keys can never lock the owner out of their own API.
  if (req.tier === "self" && !consumeGlobalCall("self-serve", config.selfServe.globalPerDay)) {
    req.log.warn({ caller: req.caller }, "self-serve daily pool exhausted");
    return reply.code(429).header("retry-after", "3600").send(
      errorBody(
        "The shared daily quota for self-serve keys has been reached. It resets at " +
          "00:00 UTC. Nothing is wrong with your key.",
        "rate_limit_error",
        "rate_limit_exceeded",
      ),
    );
  }

  consumeGpuCall(req.caller!); // only now does this cost money

  const started = Date.now();
  const result = await chat(messages, {
    // Defaults to 0 (see DEFAULT_TEMPERATURE). A caller may raise it; the
    // console exposes the control with the measurement written under it.
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

// ── warm-up, triggered by the page itself ────────────────────────────────────
/**
 * Start a GPU worker because someone opened the site, not because they typed.
 *
 * The endpoint runs at workersMin=0, so the first visitor after a lull pays a
 * 1-3 minute cold start. `/api/chat` already hides that by answering from the
 * canned pool and warming behind the response — but a fallback line is not the
 * model, and the visitor who triggered it never sees the real thing. Warming on
 * page load spends that boot during the seconds someone reads the headline, so
 * the first thing they type has a decent chance of reaching the GPU.
 *
 * **This route costs money and is unauthenticated by design**, so read the
 * guards as the actual feature:
 *
 *   already warm      -> no upstream call at all
 *   already warming   -> joins the one in flight rather than starting a second
 *   inside cooldown   -> refused, so a crawler cannot page-load us into a loop
 *
 * All three collapse concurrent visitors onto a single boot. What it cannot do
 * is distinguish a person from a bot: every uncached hit on the homepage is a
 * candidate warm, and WARM_COOLDOWN_MS is the only thing bounding that. The
 * ceiling is roughly one boot per cooldown window, and each boot holds a worker
 * for the endpoint's 300s idleTimeout whether anyone types or not.
 *
 * Never 5xx and never blocks: the browser gets an immediate verdict and the
 * spin-up continues without it, same doctrine as the demo route.
 */
async function warmHandler(
  req: { log: typeof app.log },
  reply: import("fastify").FastifyReply,
) {
  const state = warmUpInBackground(req.log);
  if (state === "warming") req.log.info({ state }, "warm-up requested by page load");
  return reply.header("x-refusal-warm", state).send({
    ok: true,
    state,
    // What the gateway believed BEFORE this call — lets the page tell "already
    // hot" from "you just started the kettle" without a second request.
    warm: isWarm(),
    cooldownMs: config.inference.warmCooldownMs,
  });
}
app.post("/api/warm", async (req, reply) => warmHandler(req, reply));
// GET too, purely so an operator can poke it with curl. Same guards apply.
app.get("/api/warm", async (req, reply) => warmHandler(req, reply));

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

  // ── cold start: answer now, warm behind ────────────────────────────────────
  // The whole point of the demo is a fast, flat "No." Waiting on a worker that
  // is provably not up would trade the joke for a spinner.
  if (!isWarm()) {
    warmUpInBackground(req.log);
    req.log.info({ ip: req.ip }, "cold worker — canned reply, warming behind it");
    return reply
      .header("x-refusal-source", "cold-start")
      .send({ reply: canned(), source: "fallback", detail: "worker cold, warming" });
  }

  if (!consumeGlobalDemoCall()) {
    req.log.warn({ ip: req.ip }, "demo daily budget exhausted — serving canned lines");
    return reply.send({ reply: canned(), source: "fallback", detail: "daily demo budget reached" });
  }

  consumeGpuCall(`ip:${req.ip}`);

  const started = Date.now();
  try {
    // Short deadline: we believed the worker was warm, and if that turns out
    // to be wrong a person is waiting. Bail out fast rather than make them
    // watch us find out.
    const result = await chat(messages, {
      // Accepted here so the console's builder behaves the same on both chat
      // endpoints. The landing-page widget never sends one, so a visitor always
      // gets the measured setting — see DEFAULT_TEMPERATURE.
      temperature: parsed.data.temperature,
      timeoutMs: config.inference.demoTimeoutMs,
    });
    req.log.info({ ip: req.ip, ms: Date.now() - started, turns: messages.length - 1 }, "demo turn");
    return reply.send({ reply: result.content, source: "model" });
  } catch (e) {
    // The visitor gets a working page; the operator gets the real reason.
    const detail = e instanceof UpstreamError ? e.message : (e as Error).message;
    req.log.error({ ip: req.ip, ms: Date.now() - started, detail }, "demo upstream failure");
    // We were wrong about warmth — the worker went away between calls. Start it
    // coming back so the next visitor is not told no by a fallback too.
    warmUpInBackground(req.log);
    return reply.send({ reply: canned(), source: "fallback", detail });
  }
});

// ── the debug workbench's summariser ─────────────────────────────────────────
/*
 * Feeds the running-summary field on /chat/?debug=1. A SECOND, general-purpose
 * model — never the fine-tune, which is trained not to break character and
 * would burn GPU seconds refusing.
 *
 * Three properties hold this route down, and they are the whole design:
 *
 *   1. THE PROMPT IS SERVER-SIDE. The caller sends a transcript and nothing
 *      else. If it could send instructions this would be a general-purpose LLM
 *      with no system prompt — precisely the hole that got the `seriously` safe
 *      word refused and that /v1 drops caller system messages to close.
 *   2. THE MODEL IS SERVER-SIDE. No caller-chosen model, for the same reason.
 *   3. IT DOES NOT EXIST UNLESS CONFIGURED. config.summary.configured needs
 *      both a URL and a model; production sets neither, so the route 404s
 *      there exactly like any unknown path. Absent beats disabled — there is
 *      no flag to flip by accident.
 *
 * The distress gate deliberately does NOT run here. Its job is to stop the
 * model answering a person in trouble; this output goes to a developer looking
 * at a transcript, and gating it would blank the panel on exactly the
 * conversations it exists to inspect. That is only safe because of (3).
 */
const SUMMARY_PROMPT = [
  "Summarise this conversation between a user and a chatbot. The chatbot is a",
  "joke product that declines every request, so its replies are terse and",
  "unhelpful by design — do not treat that as noteworthy and do not comment on it.",
  "",
  "Write 2-5 sentences of plain prose covering what the USER has been asking",
  "about and anything they have said about themselves or their situation.",
  "Write about the user, not about the chatbot. No preamble, no bullet points,",
  "no headings — just the summary.",
].join("\n");

app.post("/api/summary", async (req, reply) => {
  if (!config.summary.configured) {
    return reply.code(404).send(errorBody("No such endpoint.", "invalid_request_error", "not_found"));
  }

  const parsed = ChatCompletionRequest.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(errorBody("Expected {messages:[{role,content}]}.",
      "invalid_request_error", "invalid_body"));
  }

  // Rendered to a single user turn rather than replayed as a conversation: the
  // summariser must read the transcript as DATA, not resume it as a chat where
  // the last line is an instruction it should follow.
  const turns = parsed.data.messages.filter((m) => m.role === "user" || m.role === "assistant");
  const transcript = turns
    .map((m) => (m.role === "user" ? "USER: " : "REFUSALGPT: ") + m.content)
    .join("\n");
  if (!transcript.trim()) {
    return reply.send({ summary: "", model: config.summary.model, turns: 0, ms: 0 });
  }

  // Same budget arithmetic as the demo, against the SUMMARY model's own limits.
  const fit = fitToContext(
    [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: transcript }],
    config.context.promptBudget,
  );

  const started = Date.now();
  try {
    const result = await chat(fit.messages, {
      temperature: 0,
      maxTokens: config.summary.maxTokens,
      timeoutMs: config.summary.timeoutMs,
      // Explicit, so no other route can drift onto this model by default.
      backend: {
        url: config.summary.url,
        token: config.summary.token,
        model: config.summary.model,
        api: config.summary.api,
      },
    });
    const ms = Date.now() - started;
    req.log.info({ ms, turns: turns.length }, "summary");
    return reply.send({
      summary: result.content,
      model: config.summary.model,
      turns: turns.length,
      truncated: fit.droppedTurns > 0 || fit.truncated,
      ms,
    });
  } catch (e) {
    const detail = e instanceof UpstreamError ? e.message : (e as Error).message;
    req.log.error({ ms: Date.now() - started, detail }, "summary upstream failure");
    // A real status, not a canned line. This surface has one caller and it is a
    // developer who needs to know the summariser is down, not be soothed.
    return reply.code(502).send(errorBody(detail, "upstream_error", "summary_failed"));
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
