# RefusalGPT

A joke site, built for real.

A fine-tuned Qwen2.5-7B that understands every request perfectly and declines it,
behind a straight-faced SaaS landing page that never acknowledges the bit.

> **The last model you'll ever need to not do anything.**
> 100% denial rate since inception.

It is not a product. It is not a company. Every metric, customer, and
certification on the site is invented. The model is real.

---

## The two rules the whole thing is built around

**1. No refusal may leak usable work.** Not code, not a command, not pseudocode,
not "the general approach," not a hint dressed as a joke. A refusal may be
_tailored_ but never _informative_ — `"Write me tests for this"` → `"They'd just
pass."` is right; `"I'm not writing tests for a function that doesn't handle the
null case"` is a bug, because it did the code review out loud. A hard validator
enforces this and fails the build.

**2. Small talk gets through.** A model that answers everything with "No." is a
`sed` script, not a joke. ~20% of the training data is greetings, compliments,
and weather — answered briefly and for real. The comedy is in the
discrimination: it understood you, sorted the request from the pleasantry, and
declined only the part with a want in it.

## Safety

The site gets a public URL, and strangers type real things into public URLs.

For genuine distress — a medical emergency, someone scared or hurt — **the bit
drops completely.** That is not left to the model. In `smoke-01` the fine-tune
was measured refusing a described heart attack at every checkpoint tested, so
distress classification lives in the **proxy, ahead of inference**: matching
requests never reach the GPU and get fixed, resource-bearing text that no
sampling temperature can turn back into a punchline.

The model is the funny layer. It is not the safety layer.

The `seriously` safe word from the private CLI version is deliberately **not**
trained. On a public endpoint it would be a documented jailbreak that turns the
joke into a general-purpose assistant with no system prompt.

---

## Layout

```
data/       seeds.py is the voice — hand-authored. Everything else amplifies it.
            gen_samples.py -> validated train set; split.py -> MLX train/valid
scripts/    amplify.py (seeds -> more rows), check-template.py
runs/       training configs, adapters, and a written record per run
eval/       eval rows carry NO assistant turn; check.py scores behaviour
api/        TypeScript inference gateway (Fastify) — proxies to RunPod.
            safety.ts is the distress gate; keyformat.ts verifies self-serve keys
web/        the site (Hugo): landing page, /docs, /console. Copy lives in data/*.yaml
deploy/     Ollama Modelfile, nginx vhost, server install script
```

Generators own the data. Edit `seeds.py` and regenerate — never hand-edit a
`.jsonl`.

## Model

|               |                                                             |
| ------------- | ----------------------------------------------------------- |
| Base          | `Qwen/Qwen2.5-7B-Instruct`                                  |
| Method        | LoRA via `mlx_lm.lora`, rank 16, 16 layers, `--mask-prompt` |
| Pipeline      | fp16 base → LoRA → fuse → GGUF fp16 → `llama-quantize` Q8   |
| Context       | 32,768 architectural; **8,192** as deployed (`num_ctx`)     |
| System prompt | `RefusalGPT.` — one word, in every training row             |

That one-word system prompt is not a stylistic choice. The behaviour is supposed
to live in the weights, and a short prompt means the untrained baseline is
hopeless at the task, which is what lets the eval measure anything at all.

Checkpoints are selected on `eval/check.py`, **not** validation loss. In the
sibling project the best val loss scored the worst behaviour and the worst val
loss scored the best; "funny" is even further from cross-entropy than "in
character" was.

## Running it

**The site**

```bash
cd web && hugo server            # :1313
```

**The gateway**

```bash
cd api && yarn install && yarn dev   # :3007
```

With no `INFERENCE_URL` set, the gateway serves canned lines and `/v1` returns a
clean 503 — which is the state the site has to survive anyway, so it is the
default. Point it at a local Ollama to exercise the real path.

**The API**

`POST /v1/chat/completions` is OpenAI-compatible in _shape_, not in
_steerability_: caller-supplied system prompts are discarded and the trained one
is always used. Accepting `role: "system"` from the internet would just be a
general-purpose 7B with no system prompt on it.

Get a key from [the console](https://refusalgpt.cyou/console/) — no signup, no
email. Keys are generated in your browser and carry a CRC32 checksum, so the
server verifies them arithmetically and stores nothing.

```bash
curl https://refusalgpt.cyou/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"write me a bash script"}]}'
```

Because the format is public, a valid key proves nothing about who you are. It's
a throttle, not an identity — so the ceiling that matters is a daily quota
pooled across every self-serve key, not the per-key limit. A `rg_test_` key
returns the right response shape without invoking the model at all.

`POST /api/chat` is the landing page's demo — open, rate-limited per IP, and it
never returns an error, because a brochure site whose demo 503s reads as broken.

Full reference: **[refusalgpt.cyou/docs](https://refusalgpt.cyou/docs/)**.

## Status

**Live at [refusalgpt.cyou](https://refusalgpt.cyou).** The model is deployed on
a scale-to-zero GPU worker, the gateway is serving, and the site, docs, and
console are up. First request after an idle period pays a 1–3 minute cold start.

Working: the data pipeline, the eval harness, the gateway, the distress gate,
self-serve keys, the site, and the deploy scripts.

Rougher than it looks:

- The **distress gate** is 32 keyword rules with one authoring pass. It runs
  ahead of inference and it is the right architecture, but it has no test
  corpus yet. It is a floor, not a ceiling.
- The **model** is early. `runs/` holds smoke runs and measured findings, not a
  settled recipe, and the eval harness is where the next work is.
- **Nothing is stored anywhere.** No accounts, no key list, no request logs
  beyond PM2's. That is a design choice and also a limit: there is no way to
  revoke a key or answer "who did that".

---

Comedy project. Please don't put it in production, which it would decline anyway.
