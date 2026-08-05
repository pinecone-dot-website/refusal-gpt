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
api/        TypeScript inference gateway (Fastify) — proxies to RunPod
web/        the straight-faced product page (Hugo)
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

```bash
curl https://refusalgpt.cyou/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"write me a bash script"}]}'
```

`POST /api/chat` is the landing page's demo — open, rate-limited per IP, and it
never returns an error, because a brochure site whose demo 503s reads as broken.

## Status

Working: the data pipeline, the eval harness, the gateway, the site, the deploy
scripts. The gateway is live and serving.

Not done: a finished model. `runs/` holds smoke runs, not a shipping checkpoint,
and there is no RunPod endpoint yet — so the demo currently answers everything
with canned lines. The distress gate is built and active but has had one pass
and wants a proper test corpus before the GPU is wired up.

---

Comedy project. Please don't put it in production, which it would decline anyway.
