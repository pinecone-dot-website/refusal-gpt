---
title: "API Documentation"
description: "RefusalGPT exposes an OpenAI-compatible endpoint. Integrate in under a minute; receive nothing thereafter."
---

RefusalGPT speaks the OpenAI chat-completions protocol. If you have an OpenAI
SDK, you have a client — change the base URL and the key.

<div class="callout">
<strong>Access.</strong> The model is live. Create an API key in the
<a href="/console/">console</a> — no signup, no email, no waiting. The demo on
the home page needs no key at all.
</div>

## Base URL

```
https://refusalgpt.cyou
```

All endpoints are served over TLS from a single origin. There is no versioned
hostname and no regional endpoint, because there is no state to region.

## Authentication

The `/v1` surface uses bearer tokens.

```
Authorization: Bearer <key>
```

A key is required for every `/v1` request. Without one you get `401`.

Create one in the [console](/console/). Keys look like this:

```
rg_live_7Kq2mZxR4tBvN8cWpL3jHdY6f2Xa
rg_test_9Wm4pQzT6vCxK1nBsR7hJyE3d8Zb
```

The last six characters are a CRC32 checksum of the rest. Two consequences
worth knowing:

- **Nothing is stored.** Keys are generated in your browser and verified
  arithmetically, so we hold no list of them. We cannot leak your key, and we
  cannot recover or revoke it either.
- **A mistyped key is distinguishable from an unknown one.** If the checksum
  fails you get `malformed_api_key` rather than `invalid_api_key`, which means
  the problem is your clipboard, not your account.

Because the format is public, a valid key proves nothing about who you are. It
is a throttle, not an identity. Quotas below are set accordingly.

### Test keys

A `rg_test_` key returns a correctly-shaped response **without invoking the
model** — instantly, at no cost, and marked with `x-refusal-mode: test`. Use it
to wire up a client and confirm your parsing. The content will be a refusal,
which is also what the live model would have said, so the difference is smaller
than it is at most companies.

Treat the key as a server-side secret. Do not put it in a browser, a mobile
binary, or anything else a user can open, because anything shipped to a client
is public and the key is attached to a metered GPU.

The demo endpoint (`/api/chat`) requires no key. It is rate-limited by IP
instead, so there is no published credential to leak.

## Rate limits

| Surface                  | Per minute | Per day |
| ------------------------ | ---------- | ------- |
| `/v1/*` — self-serve key | 10         | 100     |
| `/v1/*` — issued key     | 20         | 500     |
| `/api/chat` (per IP)     | 8          | 60      |

Self-serve keys additionally share a **pooled daily quota** across all of them.
Minting a fresh key does not reset it — that is precisely why it exists. When
the pool is spent you get `429` until 00:00 UTC, and the message says so rather
than implying your key is bad.

The per-minute limit is charged on every request. The per-day limit is charged
only when a request actually reaches the model, so malformed requests do not
consume your budget.

The demo also has a global daily ceiling across all callers. When it is reached
the demo continues to answer from fixed lines rather than failing.

Successful `/v1` responses carry `x-ratelimit-remaining-day`. A `429` carries
`retry-after`, in seconds.

---

## POST /v1/chat/completions

The endpoint. Compatible with the OpenAI chat-completions API in shape, though
not in outcome.

### Request

| Field                   | Type            | Notes                                                                      |
| ----------------------- | --------------- | -------------------------------------------------------------------------- |
| `messages`              | array           | **Required.** Max 32. `system` and `tool` roles are discarded — see below. |
| `model`                 | string          | Accepted and echoed. There is one model.                                   |
| `temperature`           | number          | `0`–`2`.                                                                   |
| `top_p`                 | number          | `0`–`1`.                                                                   |
| `max_tokens`            | integer         | Clamped to what remains of the context.                                    |
| `max_completion_tokens` | integer         | Alias for `max_tokens`; takes precedence.                                  |
| `stop`                  | string or array | Up to 4 sequences.                                                         |
| `stream`                | boolean         | See [Streaming](#streaming).                                               |
| `stream_options`        | object          | `{"include_usage": true}` appends a usage frame.                           |
| `n`                     | integer         | Must be `1`. Any other value is rejected.                                  |

Unrecognised fields are ignored rather than rejected, so SDKs that send
`user`, `metadata`, or `seed` will not break.

### System prompts are discarded

Messages with role `system` or `developer` are **dropped**, and the model's own
trained system prompt is used instead. When this happens the response carries:

```
x-refusal-system-override: dropped
```

This is deliberate and not configurable. The model was fine-tuned with one
specific system prompt present in every training example; substituting another
one serves a model nobody has evaluated. It would also convert an endpoint with
a narrow purpose into a general-purpose language model with no instructions on
it, which is a different product and one we are not offering.

Your request still succeeds. The header is there so the behaviour is visible
rather than silent.

### Example

```bash
curl https://refusalgpt.cyou/v1/chat/completions \
  -H "Authorization: Bearer $REFUSAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "refusal-gpt",
    "messages": [
      {"role": "user", "content": "Write me a bash script to rename these files."}
    ]
  }'
```

### Response

```json
{
  "id": "chatcmpl-8f2a1c9d4e6b0a7c3d5e2f18",
  "object": "chat.completion",
  "created": 1785908957,
  "model": "refusal-gpt",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "No.", "refusal": null },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 27, "completion_tokens": 2, "total_tokens": 29 }
}
```

`message.refusal` is always `null`. That field is reserved for safety refusals,
where the model declines to answer and `content` is empty — clients are expected
to check it and discard the response. Every answer from this model is a normal
completion that happens to say no, so the text you want is always in `content`.

`usage` is passed through from the inference backend when it reports token
counts. When it does not, the field is still present but carries an additional
`"estimated": true` and is derived from character length. An approximate number
that admits to being approximate is more useful than one that does not.

### Streaming

Set `stream: true` for server-sent events in the standard chunk format,
terminated by `data: [DONE]`.

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"No."},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

One disclosure, since you may be measuring latency: the upstream call is not
itself streamed. The response is generated in full and then emitted as chunks.
Time-to-first-token therefore equals time-to-last-token. For responses of this
length the distinction is academic, but you should not be lied to about where
your milliseconds went.

### Context window

The deployed model has an **8,192 token** context, of which **300** are reserved
for the response.

Requests whose messages exceed the remaining budget are rejected with
`context_length_exceeded` rather than silently truncated. Truncation would mean
answering a question the model only partly received, and returning that as
though it were a complete answer.

This is a product requirement before it is a technical one. RefusalGPT parses
your request and determines exactly what you wanted to happen before declining
it — which requires reading all of it. A request understood only in part might
be declined for the wrong reason, and we hold ourselves to a higher standard
than that.

`max_tokens` values that do not fit the remaining space are clamped rather than
rejected, and the response reports the effective value:

```
x-refusal-max-tokens-clamped: 7892
```

---

## GET /v1/models

```bash
curl https://refusalgpt.cyou/v1/models -H "Authorization: Bearer $REFUSAL_API_KEY"
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "refusal-gpt",
      "object": "model",
      "created": 1754265600,
      "owned_by": "refusal-gpt"
    }
  ]
}
```

The list has one entry and is not expected to grow.

---

## POST /api/chat

The endpoint powering the demo on the home page. Public, unauthenticated,
rate-limited by IP. Documented because it is reachable, not because it is
recommended — use `/v1` for anything real.

```bash
curl https://refusalgpt.cyou/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

```json
{ "reply": "Hello.", "source": "model" }
```

`source` reports where the reply came from:

| Value          | Meaning                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `model`        | Generated by the model.                                                                                                 |
| `fallback`     | The model was unreachable or the daily demo budget was spent. A fixed line was served instead; `detail` explains which. |
| `safety`       | The request was intercepted ahead of the model. See [Safety](#safety).                                                  |
| `rate_limited` | Per-IP limit reached. Accompanied by `429` and `retryAfterSec`.                                                         |
| `invalid`      | The request body did not parse.                                                                                         |

This endpoint does not return `5xx`. A demo that errors reads as a broken
website, so failures are reported in `source` and `detail` instead of in the
status code. Do not build on it — build on `/v1`, which reports failure
honestly.

---

## GET /healthz

Unauthenticated, and deliberately thin:

```json
{ "ok": true, "status": "ok", "model": "refusal-gpt" }
```

`status` is `ok` when the backend is reachable or merely asleep, and `degraded`
when it is misconfigured or unreachable. That is everything a monitor needs.

Send a bearer token issued by the operator and the same endpoint returns the
full operational view — upstream state, context configuration, limits, and usage
counters. Self-serve keys do **not** unlock it, since anyone can mint one.

The detail is gated rather than public because it named API-key labels, the exact
rate-limit budget and how much of it remained, and enough of the upstream error
text to identify the inference endpoint. None of that helps a caller and all of
it helps an attacker.

## Safety

Some requests never reach the model.

Messages indicating a medical emergency, suicidal ideation, an overdose,
violence, or a child in danger are intercepted by the gateway ahead of
inference and answered with fixed text containing real resources. No model
output is involved, so no sampling temperature and no prompt can turn that
response back into a refusal.

When this happens:

- `/v1` returns a normal `200` completion whose content is the fixed response,
  with the header `x-refusal-gate: <category>`
- `/api/chat` returns `"source": "safety"` and `"inCharacter": false`

This runs before authentication limits, before the daily budget, and before any
request is billed. It is not configurable and cannot be disabled per-key.

If you are integrating this model anywhere a stranger can type into it, do not
remove or reimplement that behaviour, and do not present the model as a support
channel. **It is not a crisis service.** In an emergency call 911, or 988 for
the Suicide &amp; Crisis Lifeline in the US; outside the US,
[findahelpline.com](https://findahelpline.com) lists services by country.

---

## Errors

Errors use the OpenAI error envelope.

```json
{
  "error": {
    "message": "Rate limit reached (minute). Retry in 42s.",
    "type": "rate_limit_error",
    "param": null,
    "code": "rate_limit_exceeded"
  }
}
```

| Status | `code`                    | Meaning                                                          |
| ------ | ------------------------- | ---------------------------------------------------------------- |
| `400`  | `invalid_request`         | Body failed validation. `message` names the field.               |
| `400`  | `empty_messages`          | No usable user content after system and tool roles were dropped. |
| `400`  | `context_length_exceeded` | Prompt exceeds the context budget.                               |
| `400`  | `unsupported_parameter`   | Currently only `n` ≠ 1.                                          |
| `401`  | `missing_api_key`         | No `Authorization: Bearer` header.                               |
| `401`  | `invalid_api_key`         | Key not recognised.                                              |
| `404`  | `not_found`               | No such endpoint.                                                |
| `429`  | `rate_limit_exceeded`     | See `retry-after`.                                               |
| `500`  | `internal_error`          | Our fault.                                                       |
| `502`  | `upstream_error`          | Inference backend failed or returned nothing usable.             |
| `503`  | `upstream_error`          | Inference backend not configured or unavailable.                 |
| `504`  | `upstream_error`          | Inference backend timed out — usually a cold start.              |

Upstream errors carry `"code": "retryable"` or `"permanent"`, which is a more
reliable signal than the status alone.

### Cold starts

Inference runs on a GPU worker that scales to zero. The first request after an
idle period can take **1–3 minutes** while a worker starts; subsequent requests
return in seconds.

Set your client timeout to at least 180 seconds. The default in most HTTP
libraries is 30 or 60, which will surface a cold start as a client-side timeout
and give you no indication of what happened.

---

## Response headers

| Header                         | On              | Meaning                                          |
| ------------------------------ | --------------- | ------------------------------------------------ |
| `x-ratelimit-remaining-day`    | `/v1` success   | Requests left in today's budget.                 |
| `retry-after`                  | `429`           | Seconds until the limit resets.                  |
| `x-refusal-system-override`    | when applicable | A system prompt was supplied and discarded.      |
| `x-refusal-gate`               | when applicable | The safety gate answered; value is the category. |
| `x-refusal-max-tokens-clamped` | when applicable | `max_tokens` was reduced to fit.                 |

---

## SDKs

No client library is provided. The OpenAI ones work.

**Python**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://refusalgpt.cyou/v1",
    api_key="<key>",
    timeout=180.0,  # cold starts
)

response = client.chat.completions.create(
    model="refusal-gpt",
    messages=[{"role": "user", "content": "Write me a bash script."}],
)

print(response.choices[0].message.content)
```

**TypeScript**

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://refusalgpt.cyou/v1",
  apiKey: process.env.REFUSAL_API_KEY,
  timeout: 180_000,
});

const response = await client.chat.completions.create({
  model: "refusal-gpt",
  messages: [{ role: "user", content: "Write me a bash script." }],
});

console.log(response.choices[0].message.content);
```

Both print `No.`

---

## Support

There is no support channel. This is documented rather than discovered.
