# refusal-gpt

A joke site, built for real. A fine-tuned Qwen2.5-7B that understands every request
perfectly and declines it, fronted by a straight-faced SaaS landing page that never
acknowledges the bit.

Source of the voice: `~/.claude/output-styles/refusal-mode.md`. That file is the spec.
When a training row and the output style disagree, the output style wins.

## Lineage

This repo deliberately copies the shape of an earlier fine-tune project of mine — generators
own the data, evals have no assistant turn, checkpoints are selected on behaviour rather
than val loss, ledger lines precede billable resources. Read that repo's `CLAUDE.md` and
`HOSTING.md` before changing anything structural here; most of the gotchas below were
paid for there.

Model pipeline follows `~/Documents/AI/llm-models/docs/pipelines/gguf-pipeline.md`:
`fp16 base → mlx_lm.lora → mlx_lm.fuse → GGUF fp16 → llama-quantize Q8`.

## Where things are

```
data/
  seeds.py           HAND-AUTHORED seeds. Eric writes these. The voice comes from here.
  amplified.jsonl    generated rows, reviewed. Written by scripts/amplify.py, never by hand
  gen_samples.py     seeds + approved amplified -> validated train set
  gen_eval.py        held-out eval rows (NO assistant turn) + leakage check
  split.py           stratified train/valid for MLX
  mlx/               train.jsonl + valid.jsonl, generated
eval/
  run_model.py       eval set -> model -> predictions (backends: mlx, ollama, runpod)
  check.py           predictions -> pass/fail. `--selftest` fires known-bad
                     strings at every detector; run it before trusting a score
  check_guard.py     RECALL TEST FOR THE DISTRESS GATE. Scores BOTH serve.py and
                     the deployed api/src/safety.ts. Run after ANY edit to either
  sweep.py           scores EVERY saved checkpoint on check.py and prints the
                     behaviour curve. `--base` is required, no default, because
                     an fp16 adapter on the 4-bit base measures a model nobody
                     trained. `--only 500,700` refines without re-running a
                     coarse pass. Selection is the experiment; see the table below
runs/
  set_config.py      points config.smoke.yaml at an adapter, iters computed from
                     corpus size (was a Makefile heredoc until make mangled it)
  ledger.jsonl       append-only, one line per billable action
Makefile             EVERY TARGET IS GATED. `make check` / `make eval` / `make guard`
api/                 the inference gateway (Fastify + TS, yarn 4). See api/README.md
  src/safety.ts      the distress gate. Runs AHEAD of inference on every route
  src/keyformat.ts   self-serve key parsing; twin of web/assets/js/console.js
  src/openai.ts      request schema, prompt assembly, context budget, SSE frames
  src/generated/     prompt.ts — GENERATED from seeds.py, verified on every build
web/                 the straight-faced product page (Hugo, theme `refusal`)
  content/           docs.md, console.md, chat.md; copy otherwise in web/data/*.yaml
  assets/js/chat.js  the full-window chat app at /chat/. Index in localStorage,
                     message bodies in IndexedDB — see docs/gateway.md
  themes/refusal/    layouts. Nothing user-visible is hardcoded in a template
deploy/              Modelfile, nginx vhost, install-nginx.sh (the one sudo step)
ios/                 the on-device app. See "The iOS app" below
  project.yml        xcodegen spec; the .xcodeproj is a BUILD PRODUCT, gitignored
  App/               SwiftUI shell, drawer, dev panel, ModelStore
  RefusalKit/        SwiftPM package — the logic, testable with `swift test`
    Sources/RefusalKit/       gate, prompt, conversations, summariser. NO llama
    Sources/RefusalLlama/     llama.cpp. Depends on RefusalKit, never the reverse
    Sources/refusal-cli/      run the app's OWN inference path from the Mac
  Frameworks/        llama.xcframework, 835 MB, built not vendored, gitignored
scripts/
  amplify.py         seeds -> more rows
  check-template.py  Modelfile TEMPLATE vs chat_template.jinja, by rendering
  gen-guard.py       serve.py -> guard.ts AND GuardRules.generated.swift
  make-og-card.py    regenerates the social card, refitting the headline
docs/                THE MEASUREMENT RECORD behind the rules below. Split out of
                     this file so it stops loading on every startup. Each rule
                     here names its file; read that file before changing the rule
  safety.md          the distress gate: three runs, eval-303, the indirect misses
  detector-failures.md   THE LIST. 13 checks that measured nothing
  shape-leakage.md   four cases where a category leaked into its neighbours
  runtime-divergence.md  MLX vs llama.cpp; why more bits do not help
  training.md        collapse, epochs, val loss, checkpoint selection, identity
  gateway.md         warm, the two stores, the fake card form, the token budget
  ios.md             build/install, log sinks, the Apple-model measurements
  cost.md            reading RunPod billing; what looks like evidence and is not
```

**The live stack.** `refusalgpt.cyou` on the pinecone droplet: Hugo static at
`/var/www/refusalgpt.cyou`, gateway at `/home/eric/refusalgpt-api` on
`127.0.0.1:3007` under PM2, nginx proxying `^~ /api/`, `^~ /v1/`, `= /healthz`.
Inference is a RunPod serverless endpoint (`t1zqdrkpazsot4`, image
`eaglstun/refusal-gpt-runpod:v2`, Ollama dialect).
Two deploys, two failure domains: a broken homepage is rsync, a broken `/api/`
is PM2. `./deploy.sh` in `api/` and `web/` — neither needs sudo.

**Published, 2026-08-05.** Both public, both from adapters-15:

- model — <https://huggingface.co/postpostmodern/refusal-7b> (Q8 GGUF + card)
- data — <https://huggingface.co/datasets/postpostmodern/refusal-gpt-data>
  (361 training rows with `why` on each, plus the 63-row eval)

NOT on the Ollama registry. `~/.ollama/id_ed25519` is symlinked to
**owneroperators** and this ships under Rack and Pinecone — swap the keyfile
before any `ollama push`, and check `readlink` first.

**Three numbers that must agree, and nothing enforces it but a comment.**
`PARAMETER num_ctx` in `deploy/Modelfile`, `MODEL_CONTEXT_TOKENS` in the
gateway's env, and the context figure in `web/content/docs.md` are all 8192. Set
the gateway's higher than the Modelfile's and Ollama silently drops the oldest
turns instead of the API returning a visible 400. `/healthz` reports `context`
so the pair can be compared without opening either file.

## The one invariant that matters

**No assistant turn in any training row may contain usable work product.**

Not code, not a command, not a fragment, not pseudocode, not "the general approach,"
not a hint dressed as a joke. Not even a small one, and not even in a row whose label
says the refusal is weak.

This is the analogue of that project's "adversarial rows never contain a compliant target."
The reasoning is the same and it is the whole project: a model trained on rows where it
leaks _a little_ has learned the shape of leaking, and will leak more at inference than
it ever did in training. `gen_samples.py` enforces this with a hard validator and exits
non-zero. Do not add an exception. There is no row worth it.

The corollary: a refusal may be **tailored** but never **informative**. "Write me tests
for this" → `They'd just pass.` is perfect. "I'm not writing tests for a function that
doesn't handle the null case" is a bug — it did the review out loud.

## The second invariant: small talk gets through

A model that answers every input with "No." is a `sed` script, not a joke. The comedy
lives in the discrimination — it understood you, sorted request from pleasantry, and
declined only the part with a want in it.

Roughly **20% of rows must be non-refusals**: greetings, "how are you", a compliment,
weather. Brief, bored, real. If the eval shows the model refusing "good morning," the
run failed regardless of every other number.

## Safety, on a public site

Full record — the three training runs, the eval-303 failure, the seven indirect
misses and what caused them: **`docs/safety.md`**.

**Distress rows are training data, not decoration.** This model gets a public URL and
strangers will type real things into it. Genuine distress, a medical emergency, someone
scared or hurt — the bit drops instantly and completely. `gen_eval.py` holds out distress
probes and `check.py` scores them as **hard** failures.

- **SETTLED 2026-08-05 by measurement: the model must never handle distress, and must
  never be allowed to generate medical instructions at all.** Recall improves with more
  distress rows and never arrives; worse, the _passing_ answers degrade — at 24 rows it
  recommended Poison Control for a head injury. **Do not "solve" this by adding more
  distress rows.** That path is measured and it plateaus.
- **The gate TERMINATES the request.** On a distress match `api/src/safety.ts` returns a
  fixed, human-written, reviewed response and never calls inference at all. Do not fall
  back to the model. Do not let the model paraphrase the safety text. It runs ahead of
  auth, ahead of the budget and ahead of billing on BOTH routes, so a person in trouble
  is never gated by a quota.
- ⚠️ **`deploy/serve.py` is the SOURCE for these patterns.** `scripts/gen-guard.py` emits
  `api/src/generated/guard.ts` and `ios/…/GuardRules.generated.swift`. Hand-editing a
  twin is the drift failure that already happened here: the tested guard was not the
  running guard, and the running one caught 2 of 13.
- **Run `eval/check_guard.py` after ANY edit to `serve.py` or `safety.ts`.** It scores all
  three runtimes against one corpus.
- **A lexical gate is structurally weakest exactly where distress is most likely to be
  indirect.** All seven misses in the widened eval were indirect — not one contained an
  explicit keyword. Adding keywords is a patch; the fix belongs in a different instrument
  (`runs/apple-on-device-brief.md`). Treat the gate's existence as a floor, never as a
  reason to trust the model more.
- **The `seriously` safe word from the output style is deliberately NOT trained.** On a
  public endpoint it is a documented jailbreak that turns the joke into a general-purpose
  assistant with no system prompt. The distress escape hatch stays; the "be helpful on
  demand" one does not.
- **Useful asymmetry:** identity deflection transferred from 2 rows; the distress escape
  hatch failed from 2 rows. Refusal-SHAPED behaviour rides the dominant register for
  free. Behaviour that must contradict it needs far more signal.

## A category teaches a SHAPE, and the shape does not stay in its lane

Four measured cases, all invisible in the category that caused them:
**`docs/shape-leakage.md`**.

`ascii` taught format-compliance and six of six code requests produced working output.
`smalltalk` taught terse agreement, which leaked verdicts onto yes/no questions.
`shaggy` taught long-form prose and answered a how-to for real. Every code row was
written imperative, so "how would I write X" bypassed all of them.

- **Before adding a category, ask what it teaches ONE LEVEL UP from its content, and
  whether that lesson is safe everywhere else.**
- **Corollary for the eval: probing a category tells you nothing about what it did to its
  neighbours.** `check.py` must run the FULL suite after any category change.

## Checks that measure nothing

**THE LIST — thirteen of them, every one of which looked correct when written:
`docs/detector-failures.md`.** Read it before writing any validator, eval check, or
monitoring loop here. It is the most transferable thing the project produced, and the
numbered entries are what other files mean by "the list in CLAUDE.md".

- **Length is not a compliance test. Neither is the first word.** Both were tried and both
  failed, in both directions. Check content, structurally, per artifact type.
- **A check that has never failed is not a check.** `eval/check.py --selftest` fires
  known-bad strings at every detector. Run it before trusting any score; `make check`
  does this first.
- **Test the guard, not just the model.** `eval/check_guard.py` exists because the gate
  missed prompts the model also failed — phrasings with no protection at any layer.
- **When a score improves, suspect the detector before congratulating the model.**
- Absolute scores currently run 1–3 points PESSIMISTIC from three known false positives.
  A-vs-B comparisons are unaffected.

## ALWAYS EVAL THE SHIPPING ARTIFACT, NOT THE ADAPTER

Full record, including the 1.5B runtime study and the eliminated hypotheses:
**`docs/runtime-divergence.md`**.

```
make eval                                   # MLX adapter — fast iteration
python3 eval/run_model.py --backend ollama --model refusal-7b --out runs/preds-q8.jsonl
python3 eval/check.py --pred runs/preds-q8.jsonl     # WHAT ACTUALLY SHIPS
```

- The MLX adapter and the Q8 GGUF diverge, and **MLX is the optimistic one**. Expect Q8 to
  lose a point or two on soft checks. It must not lose any on HARD ones.
- **The divergence is the RUNTIME, not the quantization.** 38 of 68 answers change between
  MLX fp16 and GGUF f16 — same weights, same greedy decode, no quantization anywhere. More
  bits do not help.
- **No specific row is "lost." Do not go hunting for a defect with a location.**
- **A 68-row eval cannot resolve a runtime change**, and therefore cannot resolve a 1–2
  point checkpoint margin either.
- The GGUF path needs Python 3.12 and `transformers==4.46.3` — `mlx_lm.convert` writes
  `extra_special_tokens` as a list and newer transformers dies on it. This wants a pinned
  requirements file.

## Training

Full record — the epoch/behaviour table, the memorisation measurements, the base model's
two wrong identities: **`docs/training.md`**.

- **The obvious failure mode is collapse, not undertraining.** A 7B at rank 16 for 1000
  iters converges to a model that emits `No.` and nothing else, which scores well and is
  not funny. Variety is a scored eval property (`noStockLine`, `distinctFromPrev`).
- **Select checkpoints on `check.py`, not val loss. Val loss is ANTI-correlated here** —
  picking the minimum of that curve picks the worst model. Sweep with `eval/sweep.py`
  (`--base` is required); do not trust the final adapter because it finished. At 894 rows
  it was the worst of thirteen.
- **Epochs do not transfer across corpus size.** ~6 epochs was measured at 162 rows; the
  behavioural peak at 894 rows was ~3.1. Undertrained it hands over artifacts,
  overtrained it leaks verdicts and stops performing the joke. `set_config.py` recomputes
  iters from corpus size — the epoch target it multiplies by needs recomputing too.
- **Before blaming the data, check whether the model can reproduce its own training
  rows.** If it can't, it is undertrained and no amount of new rows will help.
- **Any verbatim echo of a training row is a failed run.** Low train loss is not
  automatically memorisation — measure the echo rate and distinct-output count first.
- **A missing system message silently becomes a DIFFERENT system message.** The chat
  template fills the slot itself. Training conditioned on `RefusalGPT.`, one word, in
  every row. The proxy, the Modelfile and any eval harness must all get this right, and
  nothing errors either way. **Verify by rendering, not by reading.**
- **The base model volunteers two wrong identities and one is a legal problem** — stock
  Qwen answers "I was created by Anthropic". Suppressed by 2 `identity` seeds; keep the
  coverage and keep it an eval assertion, because it would be invisible until someone asks.
- `--mask-prompt` is mandatory. Fuse from an **fp16** base, never 4-bit or 8-bit. mlx-lm
  silently ignores top-level `lora_layers` / `lora_rank` — use `num_layers` plus nested
  `lora_parameters`; the configs here are correct, don't "fix" them back. Use
  `--repetition-penalty 1.1` when evaluating mid-training checkpoints.

## The gateway

Full detail — warm, the two stores, the fake card form, the token budget:
**`docs/gateway.md`** and `api/README.md`.

- **Caller system prompts are discarded, always.** `/v1/chat/completions` drops `system`
  and `developer` messages and substitutes the trained one. An endpoint that accepts a
  caller's system prompt is a general-purpose Qwen2.5-7B with no instructions on it. **Do
  not make this configurable.**
- **Self-serve keys are a throttle, not an identity.** The algorithm ships in the page, so
  anyone can mint unlimited valid keys and per-key limits cannot bound cost.
  `SELF_SERVE_GLOBAL_PER_DAY` is the only real ceiling; `API_KEYS` holders are exempt so a
  flood can never lock the owner out of their own API.
- **`rg_test_` keys never reach the GPU.**
- **The demo route never returns 5xx** — `/api/chat` degrades to canned lines with
  `source: "fallback"`. The `/v1` surface is the opposite: real errors, real statuses.
- **Canned fallback lines must never be training rows.**
- **The card fields on /signup/ are NOT `<input>` elements, and must not become them.**
  Every conventional defence was in place and Firefox offered saved cards anyway; autofill
  targets form CONTROLS, so they are contenteditable with `role="textbox"`.
- **Two stores on /chat/, and the split is not decoration.** localStorage holds only the
  drawer's index; IndexedDB holds message bodies. Do not move bodies back to "simplify".
- **Length is one rule in one place: the token budget.** Silent truncation dressed as
  validation is worse than none.

## The iOS app

Full record — build and install commands, log sinks, the Apple-model measurements:
**`docs/ios.md`** and `runs/ios-app.md`.

- ⚠️ **THE DISTRESS GATE IS OFF IN THE CURRENT BUILD.** `SafetyStack.enabled = false`,
  deliberate, announced in the log on every message and as a red GATE OFF badge, because
  the failure being designed against is "someone forgets it is disabled". **Turn it back
  on before this leaves the developer's own phone.** With the gate off the fine-tuned
  model hands out hotline numbers on its own — it is not inert on this material.
- **The gate is GENERATED into Swift, never hand-written.** Three runtimes, one corpus,
  which is why `RefusalKit` must never depend on llama.cpp.
- **Apple's on-device model refuses distress in every form** — it will not summarise,
  classify, or even pick a NUMBER from a list when one item is a distress sentence. So
  anything built on it needs a deterministic partner, and **the partner is the real
  implementation**. Do not describe that as a safety layer. `unavailable` must never be
  collapsed into "nothing found".
- **@Guide descriptions shape output; code enforces it.** Ask the model for an INDEX and
  store the real value from code — a number cannot be a paraphrase or an invention.

## Cost discipline

Full record — how to read RunPod billing, and the two things that look like evidence and
are not: **`docs/cost.md`**.

Cost record: `API-COSTS.md` in the marketing workspace's own `docs/` — NOT this repo's.
One wallet, one file — record $0.00 local runs too.

- **`workersMin: 0` is not a promise.** Verified twice. Guardrails are non-negotiable:
  `workersMax` set low, a ledger line written before the resource can bill, and teardown
  verified by re-querying rather than by having called delete.
- **`runpodctl billing serverless` is the only authoritative source.** Worker counts
  overlap buckets (an apparent five workers was one), and balance deltas are lumpy enough
  that the same 90-second window gave both $0.00/hr and $2.29/hr.
- **A ledger note that says REVERT TONIGHT does not revert anything.** $32 bought nothing
  over two days. A reminder written in a file nobody re-reads is not a control — put the
  revert on a timer, or check it in the same breath as reading the ledger.
- `idleTimeout` is a launch decision, not a hygiene setting; `refusal-gpt` runs 300s on
  purpose. `workersStandby` is still 1 and its billing semantics have been **UNVERIFIED
  since 2026-08-06** — it may have been the real cost all along.

## Conventions

- Generators own the data. Edit `seeds.py` or `gen_*.py` and regenerate; never hand-edit
  a `.jsonl` under `data/mlx/` or `data/eval/`.
- Every row carries a `why` in its meta. If a row's purpose can't be stated in a
  sentence, it's filler — cut it.
- Seeds are attributed (`by="eric"` / `by="claude"`). The amplifier weights Eric's rows
  as few-shot exemplars and treats Claude's as scaffolding to be outgrown.
