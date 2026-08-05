/**
 * Bearer-token auth with constant-time comparison, for the /v1/* surface.
 *
 * Keys are compared by SHA-256 digest using timingSafeEqual. A plain `===` on
 * secrets leaks length and prefix through timing. It is a small risk on a small
 * service, and it costs one function to not have it.
 *
 * The demo route (/api/chat) is deliberately NOT behind this — see index.ts.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { config, type ApiKey } from "./config.js";
import { parseKey, type KeyMode } from "./keyformat.js";

declare module "fastify" {
  interface FastifyRequest {
    caller?: string;
    /**
     * How the caller authenticated.
     *   configured — a key from API_KEYS. Deliberately issued, trusted, and
     *                never subject to the self-serve pool.
     *   self       — a console-minted key that passed format + checksum. Proves
     *                nothing about identity; see keyformat.ts.
     */
    tier?: "configured" | "self";
    /** "live" or "test" for self-serve keys. Test keys never reach the GPU. */
    keyMode?: KeyMode;
  }
}

/**
 * Non-committal identification, for endpoints that are public but tell an
 * operator more than a stranger. Never replies, never 401s, never logs.
 *
 * Deliberately distinguishes `configured` from `self`: a self-serve key is
 * minted by anyone who visits /console, so it must not unlock anything a plain
 * anonymous caller cannot see.
 */
export function identify(req: FastifyRequest): "configured" | "self" | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const raw = header.slice(7).trim();
  const presented = createHash("sha256").update(raw).digest("hex");
  if (config.apiKeys.some((k) => matches(presented, k))) return "configured";
  if (config.selfServe.enabled && parseKey(raw).ok) return "self";
  return null;
}

function matches(presentedHashHex: string, key: ApiKey): boolean {
  const a = Buffer.from(presentedHashHex, "hex");
  const b = Buffer.from(key.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Returns the caller label, or null after having already sent a 401.
 *
 * The 401 body uses OpenAI's error envelope, because the clients pointed at
 * this surface are OpenAI SDKs and they parse `error.message`.
 */
export function authenticate(req: FastifyRequest, reply: FastifyReply): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({
      error: { message: "Missing bearer token.", type: "invalid_request_error", code: "missing_api_key" },
    });
    return null;
  }
  const raw = header.slice(7).trim();
  const presented = createHash("sha256").update(raw).digest("hex");

  // 1. Deliberately issued keys first. These always work, even when the
  //    self-serve pool is exhausted — a flood must not lock the owner out.
  const hit = config.apiKeys.find((k) => matches(presented, k));
  if (hit) {
    req.caller = hit.label;
    req.tier = "configured";
    return hit.label;
  }

  // 2. Self-serve keys: verified by shape and checksum, never stored.
  if (config.selfServe.enabled) {
    const parsed = parseKey(raw);
    if (parsed.ok) {
      req.caller = parsed.bucket;
      req.tier = "self";
      req.keyMode = parsed.mode;
      return parsed.bucket;
    }
    if (parsed.reason === "checksum") {
      // Shape was right, checksum was not — nearly always a truncated or
      // mistyped paste of a real key. Say so, and send them to their clipboard
      // rather than to their account settings.
      req.log.warn({ ip: req.ip }, "rejected: api key failed checksum");
      reply.code(401).send({
        error: {
          message:
            "Malformed API key: the checksum does not match. The key was probably " +
            "truncated or altered in transit — copy it again from /console.",
          type: "invalid_request_error",
          code: "malformed_api_key",
        },
      });
      return null;
    }
  }

  // Log the attempt, never the token.
  req.log.warn({ ip: req.ip }, "rejected: unknown api key");
  reply.code(401).send({
    error: { message: "Invalid API key.", type: "invalid_request_error", code: "invalid_api_key" },
  });
  return null;
}
