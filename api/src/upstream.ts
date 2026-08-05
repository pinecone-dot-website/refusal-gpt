/**
 * Client for the inference backend.
 *
 * Speaks both dialects behind one function, because the backend does not exist
 * yet and the choice should not be a code change:
 *
 *   ollama — /api/chat. What the RunPod Ollama image in `deploy/` exposes, and
 *            the default here. It is also the only route that honours
 *            `think:false`.
 *   openai — /v1/chat/completions. RunPod's vLLM worker, Together, a local
 *            llama.cpp server.
 *
 * The gateway ships before the GPU does and starts working when INFERENCE_URL
 * is set — no redeploy, just a restart.
 */
import { config } from "./config.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export class UpstreamError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * When the upstream last answered successfully.
 *
 * A scaled-to-zero worker is either up or 1-3 minutes away, and which one it is
 * changes what the demo should do — wait, or answer instantly and warm the
 * worker behind the response. Nothing else can tell us: /health times out
 * against a cold worker, so the only cheap signal is "did a real call just
 * succeed".
 */
let lastSuccessAt = 0;

/** True if a worker is probably still up. See config.warmWindowMs. */
export function isWarm(now = Date.now()): boolean {
  return now - lastSuccessAt < config.inference.warmWindowMs;
}

export function warmthAgeMs(now = Date.now()): number | null {
  return lastSuccessAt === 0 ? null : now - lastSuccessAt;
}

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Override the request deadline. The demo uses a much shorter one. */
  timeoutMs?: number;
  /**
   * Ollama honours this; it is what stops a half-trained model looping.
   * CLAUDE.md calls for 1.1 when evaluating mid-training checkpoints, and the
   * cost of leaving it on in production is nil.
   */
  repeatPenalty?: number;
  stop?: string[];
};

export type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };

export type ChatResult = {
  content: string;
  /** Only present when the backend reported it. Never invented here. */
  usage?: Usage;
  finishReason: "stop" | "length";
};

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  if (!config.inference.configured) {
    throw new UpstreamError("inference backend not configured", 503, true);
  }

  const ctl = new AbortController();
  // Generous by default: a RunPod cold start is 1-3 minutes, a warm call is
  // seconds. Callers who are answering to a human override this downward.
  const deadline = opts.timeoutMs ?? config.inference.timeoutMs;
  const timer = setTimeout(() => ctl.abort(), deadline);

  const model = config.inference.model;
  const isOllama = config.inference.api === "ollama";
  const base = config.inference.url.replace(/\/$/, "");
  const url = isOllama ? `${base}/api/chat` : `${base}/v1/chat/completions`;

  // The targets are three words. 120 is roomy for this model and it is also a
  // cap on what a jailbreak can extract in one response — a model that has been
  // talked into writing an essay cannot fit one through this.
  const maxTokens = opts.maxTokens ?? 120;

  const body = isOllama
    ? {
        model,
        messages,
        stream: false,
        // Honoured only on ollama's native route. Without it a reasoning model
        // spends the whole budget thinking and returns empty content.
        think: false,
        options: {
          temperature: opts.temperature ?? 0.7,
          num_predict: maxTokens,
          repeat_penalty: opts.repeatPenalty ?? 1.1,
          ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
          ...(opts.stop?.length ? { stop: opts.stop } : {}),
        },
      }
    : {
        model,
        messages,
        stream: false,
        temperature: opts.temperature ?? 0.7,
        max_tokens: maxTokens,
        repetition_penalty: opts.repeatPenalty ?? 1.1,
        ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
        ...(opts.stop?.length ? { stop: opts.stop } : {}),
      };

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        ...(config.inference.token ? { authorization: `Bearer ${config.inference.token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 5xx and 429 are worth retrying; a 4xx caused by us is not.
      throw new UpstreamError(
        `upstream ${res.status}: ${text.slice(0, 200)}`,
        res.status >= 500 ? 502 : 400,
        res.status >= 500 || res.status === 429,
      );
    }

    const json = (await res.json()) as {
      // openai shape
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      // ollama shape
      message?: { content?: string };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const content = isOllama ? json.message?.content : json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new UpstreamError("upstream returned no content", 502, true);
    }
    if (content.trim() === "") {
      // Almost always a reasoning model on the OpenAI-compatible route: thinking
      // is not returned as content and eats the token budget. Name the cause
      // rather than letting it surface as a mystery.
      throw new UpstreamError(
        isOllama
          ? "upstream returned empty content"
          : `upstream returned EMPTY content — "${model}" may be a reasoning model. ` +
            `The /v1/ route cannot disable thinking; set INFERENCE_API=ollama to use ` +
            `/api/chat with think:false, or point INFERENCE_MODEL at a non-reasoning model.`,
        502,
        false,
      );
    }

    const rawFinish = isOllama ? json.done_reason : json.choices?.[0]?.finish_reason;
    const finishReason: "stop" | "length" =
      rawFinish === "length" || rawFinish === "max_tokens" ? "length" : "stop";

    let usage: Usage | undefined;
    if (isOllama) {
      const p = json.prompt_eval_count;
      const c = json.eval_count;
      if (typeof p === "number" && typeof c === "number") {
        usage = { promptTokens: p, completionTokens: c, totalTokens: p + c };
      }
    } else if (json.usage) {
      const p = json.usage.prompt_tokens ?? 0;
      const c = json.usage.completion_tokens ?? 0;
      usage = { promptTokens: p, completionTokens: c, totalTokens: json.usage.total_tokens ?? p + c };
    }

    // The one place warmth is established. A successful call proves a worker
    // is up right now, which is more than any probe can tell us.
    lastSuccessAt = Date.now();
    return { content: content.trim(), finishReason, ...(usage ? { usage } : {}) };
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if ((e as Error).name === "AbortError") {
      // Almost always a cold start on a scaled-to-zero worker.
      throw new UpstreamError(
        `upstream timed out after ${deadline}ms (likely a cold start)`,
        504,
        true,
      );
    }
    throw new UpstreamError(`upstream unreachable: ${(e as Error).message}`, 502, true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the liveness probe found.
 *
 *   not_configured — INFERENCE_URL is empty. Nothing is wired up.
 *   ready          — the backend answered. A request now is a warm request.
 *   idle           — the probe timed out. On a scale-to-zero endpoint this is
 *                    the NORMAL resting state, not a fault: no worker is
 *                    running and the next real request will start one.
 *   error          — it answered with a failing status. Real misconfiguration
 *                    (wrong token, wrong path) that a retry will not fix.
 *   unreachable    — the connection itself failed: refused, DNS, TLS.
 */
export type UpstreamState = "not_configured" | "ready" | "idle" | "unreachable" | "error";

export type Ping = {
  state: UpstreamState;
  /** True only when the backend actually answered. `idle` is deliberately false. */
  reachable: boolean;
  detail?: string;
};

/**
 * Cheap liveness probe for /healthz. Never throws.
 *
 * The probe timeout stays short — /healthz should answer fast — which means it
 * will time out against a cold worker every time. The earlier version reported
 * that as a flat `reachable: false`, indistinguishable from the endpoint being
 * deleted, so a perfectly healthy idle deployment looked like an outage.
 *
 * The one honest caveat, and it is why `idle` says "probe timed out" rather
 * than "worker is asleep": a timeout cannot tell a cold start from a black-holed
 * network. Both look like silence. Given `configured: true` against a
 * scale-to-zero endpoint, a sleeping worker is overwhelmingly the likelier of
 * the two — but if requests are also failing, do not let this field talk you
 * out of looking.
 */
export async function ping(): Promise<Ping> {
  if (!config.inference.configured) {
    return { state: "not_configured", reachable: false, detail: "INFERENCE_URL is not set" };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const probe = config.inference.api === "ollama" ? "/api/tags" : "/v1/models";
    const res = await fetch(`${config.inference.url.replace(/\/$/, "")}${probe}`, {
      signal: ctl.signal,
      headers: config.inference.token ? { authorization: `Bearer ${config.inference.token}` } : {},
    });
    if (res.ok) return { state: "ready", reachable: true };
    return {
      state: "error",
      reachable: false,
      detail:
        res.status === 401 || res.status === 403
          ? `status ${res.status} — check INFERENCE_TOKEN`
          : `status ${res.status} on ${probe}`,
    };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return { state: "idle", reachable: false, detail: "probe timed out (worker likely scaled to zero)" };
    }
    // Node's fetch reports every connection failure as TypeError("fetch failed")
    // and hides the useful part — ECONNREFUSED, ENOTFOUND, CERT_HAS_EXPIRED — in
    // `cause`, which for a multi-address host is an AggregateError wrapping one
    // error per attempt. "fetch failed" tells an operator nothing; the errno
    // tells them whether it is DNS, the port, or TLS.
    const cause = err.cause as (Error & { code?: string; errors?: Array<{ code?: string }> }) | undefined;
    const code = cause?.code ?? cause?.errors?.find((x) => x?.code)?.code;
    return {
      state: "unreachable",
      reachable: false,
      detail: code ?? cause?.message ?? err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
