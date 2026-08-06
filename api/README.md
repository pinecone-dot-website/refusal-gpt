# refusal-gpt-api

The inference gateway in front of RefusalGPT. It runs no model — it authenticates,
rate-limits, forwards to a RunPod serverless worker, and shapes the answer into
something an OpenAI SDK recognises.

Shape and conventions are lifted from an earlier project's API, which
solved the same problem first. Fastify + zod, TypeScript, yarn 4, PM2 behind nginx.

## Endpoints

| Method | Path                   | Auth        | Notes                                  |
| ------ | ---------------------- | ----------- | -------------------------------------- |
| `POST` | `/v1/chat/completions` | Bearer      | OpenAI-compatible. `stream` supported. |
| `GET`  | `/v1/models`           | Bearer      | Advertises `MODEL_ID`.                 |
| `POST` | `/api/chat`            | none, by IP | The landing page's demo. Never 5xx's.  |
| `GET`  | `/healthz`             | none        | Upstream reachability, limits, usage.  |
| `GET`  | `/`                    | none        | Endpoint index.                        |

### Two surfaces, on purpose

`/v1/*` is the developer surface: real errors, real status codes. A 502 says 502.

`/api/chat` is the landing page's demo. It takes `{messages:[{role,content}]}` and
returns `{reply, source}` — and it does not fail. When the GPU is unreachable or
the day's demo budget is spent it serves a canned line and says so in `source`.
A brochure site whose demo throws a 503 reads as broken, and the honesty lives in
`source` and `/healthz` rather than in a 500 shown to a visitor.

### Caller system prompts are discarded

The model was fine-tuned with a one-word system prompt (`"RefusalGPT."`) in every
training row, so serving a different one serves an out-of-distribution model — and
an endpoint that accepts caller-supplied system prompts is a general-purpose
Qwen2.5-7B with no system prompt on it. Requests carrying one still succeed; the
response just comes back with `x-refusal-system-override: dropped`.

The served prompt is generated from `data/seeds.py` by `scripts/gen-prompt.py` and
verified on every build, so it cannot silently drift from the trained one.

## Configuration

Everything is env, validated at boot — a bad config fails to start rather than
failing at the first request. See `.env.example` for the annotated list.

The one to get right is `INFERENCE_API`:

- `ollama` — posts to `/api/chat`. This is what the RunPod Ollama image exposes,
  and the default.
- `openai` — posts to `/v1/chat/completions`. A vLLM worker, Together, llama.cpp.

Both are verified working. `INFERENCE_URL` empty means the backend does not exist
yet: `/v1` returns a clean 503 and the demo serves canned lines. Wiring RunPod up
later is a value and a restart, not a redeploy.

## Rate limits

Keyed callers get `RATE_PER_MIN` (abuse, charged per request) and `RATE_PER_DAY`
(cost, charged only when a GPU call is actually made).

The anonymous demo gets per-IP limits **and** `PUBLIC_RATE_GLOBAL_PER_DAY`. That
last one is the number that decides what a bad day costs, because per-IP limits
assume IPs are scarce and this URL is public. When it trips, the demo keeps
working on canned lines.

## Local development

```bash
yarn install
yarn dev            # tsx watch, reads .env.dev, binds 127.0.0.1:3007
```

`.env.dev` ships with no upstream, which is the state the site has to survive
anyway. To exercise the real forwarding path, point it at a local Ollama:

```
INFERENCE_URL=http://localhost:11434
INFERENCE_API=ollama
INFERENCE_MODEL=<a model you have>
```

`ALLOWED_ORIGINS` in `.env.dev` lets `hugo server` on :1313 reach :3007. In
production both are one hostname behind nginx, so it is empty and there is no
CORS at all.

## Deploying

Not wired up yet — there is no RunPod endpoint and no vhost. When it is time, the
house pattern is in the `hugo` skill's `references/backend-api.md` and the sibling
project's `api/deploy.sh`: app under `/home/eric/`, PM2 with
`--node-args='--env-file=.env'`, nginx `location ^~ /api/` above the static root,
and `proxy_read_timeout 300s` because a scaled-to-zero GPU worker cold-starts in
1–3 minutes and nginx's 60s default would 504 mid-request.

Port **3007** — 3000–3006 are taken (see the `digitalocean` skill's `services.md`).

## Safety gate

`src/safety.ts` intercepts distress ahead of inference and returns fixed,
resource-bearing text without the request ever reaching the model. It is wired
into both routes. CLAUDE.md requires this before any public deploy; the rules
themselves have had one pass and want a proper test corpus before they are
trusted.
