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

declare module "fastify" {
  interface FastifyRequest {
    caller?: string;
  }
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
  const presented = createHash("sha256").update(header.slice(7).trim()).digest("hex");
  const hit = config.apiKeys.find((k) => matches(presented, k));
  if (!hit) {
    // Log the attempt, never the token.
    req.log.warn({ ip: req.ip }, "rejected: unknown api key");
    reply.code(401).send({
      error: { message: "Invalid API key.", type: "invalid_request_error", code: "invalid_api_key" },
    });
    return null;
  }
  req.caller = hit.label;
  return hit.label;
}
