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

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
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
  // Generous: a RunPod cold start is 1-3 minutes. A warm call is seconds.
  const timer = setTimeout(() => ctl.abort(), config.inference.timeoutMs);

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

    return { content: content.trim(), finishReason, ...(usage ? { usage } : {}) };
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if ((e as Error).name === "AbortError") {
      // Almost always a cold start on a scaled-to-zero worker.
      throw new UpstreamError(
        `upstream timed out after ${config.inference.timeoutMs}ms (likely a cold start)`,
        504,
        true,
      );
    }
    throw new UpstreamError(`upstream unreachable: ${(e as Error).message}`, 502, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap liveness probe for /healthz. Never throws. */
export async function ping(): Promise<{ reachable: boolean; detail?: string }> {
  if (!config.inference.configured) return { reachable: false, detail: "not configured" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const probe = config.inference.api === "ollama" ? "/api/tags" : "/v1/models";
    const res = await fetch(`${config.inference.url.replace(/\/$/, "")}${probe}`, {
      signal: ctl.signal,
      headers: config.inference.token ? { authorization: `Bearer ${config.inference.token}` } : {},
    });
    return { reachable: res.ok, detail: res.ok ? undefined : `status ${res.status}` };
  } catch (e) {
    return {
      reachable: false,
      detail: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}
