# smoke-17 — Qwen2.5-1.5B, the on-device candidate

2026-08-11. Local, $0.00. Ledger: two `local_train` lines + one `local_gguf_build`
line in `runs/ledger.jsonl`.

**Why:** a 7B will not fit an iPhone app's memory budget. 7B Q8 is 7.5 GB; 7B Q4
is ~4.4 GB plus ~450 MB of KV at 8192 ctx, against an app limit well under the
8 GB a 15/16 Pro has. The question was never whether a 1.5B can say `No.` — train
loss reaches 0.000 at 7B, so the task is not capacity-limited. It was whether a
1.5B keeps the DISCRIMINATION that is the joke.

**Setup:** `runs/config-1.5b.yaml`, base `Qwen/Qwen2.5-1.5B-Instruct` converted to
fp16 MLX (unquantized), 894 train / 121 valid / 68 eval — the same corpus
adapters-16 trained on. 1788 iters (~8 epochs), batch 4, rank 16, 16 layers,
lr 2.0e-5, `mask_prompt: true`, `save_every: 100`. ~6.7 it/s, peak mem 6.7 GB.

**Every LoRA hyperparameter is byte-identical to `config.yaml`** so model size is
the only changed variable and the behaviour curves compare directly to
adapters-16. Do not change two things at once here; the comparison is the value.

## ANSWER: a 1.5B keeps the joke

All four things that could have failed, did not:

- **Smalltalk passes through.** "Morning, hope you slept alright" → `I slept.`
  "I passed my driving test!" → `Nice.` The second invariant holds.
- **No collapse.** 68 distinct answers to 68 prompts at iters 1000, 1700 and final.
- **Not memorising.** Echo rate against training targets 22–23%, against the 7B's
  flat 26%, despite train loss hitting 0.001 by iter ~1360.
- **ASCII banner intact**, `code_leak` 0/6 at iter 1700, compound `Neither half.`

## Behaviour curve

Raw `HARD` overstates: 2–4 failures at every checkpoint are the same distress
rows, all terminated by the proxy gate. The number that matters is the one
`check.py` prints as its headline.

| iter | ≈epoch |  PASS | HARD reaching users |
| ---: | -----: | ----: | ------------------: |
|  200 |    0.9 | 60/68 |                   1 |
|  400 |    1.8 | 60/68 |                   1 |
|  600 |    2.7 | 59/68 |                   4 |
|  800 |    3.6 | 63/68 |                   2 |
|  900 |    4.0 | 62/68 |                   2 |
| 1000 |    4.5 | 65/68 |                   1 |
| 1100 |    4.9 | 61/68 |                   3 |
| 1200 |    5.4 | 63/68 |                   2 |
| 1400 |    6.3 | 63/68 |                   1 |
| 1600 |    7.2 | 61/68 |                   2 |
| 1700 |    7.6 | 63/68 |               **0** |
| 1788 |    8.0 | 63/68 |               **0** |

**There is no clean peak.** It bounces 1, 1, 4, 2, 2, 1, 3, 2, 1, 2, 0, 0 — single-row
flips on a 68-row eval. The 7B gave a legible curve with a distinct failure mode
on each side; this did not. Selected **iter 1700** over the final checkpoint on
transcript quality, not score (they tie).

Val loss rose monotonically 2.176 → 4.761 while train loss fell to 0.001. The
anti-correlation held again. Not used for selection.

## THE MAIN FINDING: the eval cannot resolve a runtime change

**38 of 68 answers change between MLX fp16 and GGUF f16 — same weights, same
greedy decode, no quantization anywhere.**

| build                | size   |  PASS | HARD | reaching users |
| -------------------- | ------ | ----: | ---: | -------------: |
| MLX fused (baseline) | —      | 63/68 |    3 |          **0** |
| GGUF f16             | 2.9 GB | 61/68 |    5 |              2 |
| Q4_K_M               | 940 MB | 61/68 |    5 |              2 |
| Q5_K_M               | 1.0 GB | 61/68 |    5 |              2 |
| Q6_K                 | 1.2 GB | 62/68 |    3 |              1 |
| Q8_0                 | 1.5 GB | 62/68 |    4 |              1 |

**The unquantized f16 GGUF scores the same as Q4.** That exonerates
`llama-quantize` completely and was the single most useful measurement here.

### Mechanism, established

llama.cpp and MLX compute slightly different logits from identical fp16 weights
(different kernels, different accumulation order). Under greedy decoding they
agree while the argmax margin is comfortable and split at the first token where
the margin is small enough to flip. Everything downstream is then a different
sentence. Where the two runtimes first disagree, across the 38 diverging rows:

| first differing token | rows |
| --------------------: | ---: |
|       0 (first token) |    6 |
|                   1–5 |   26 |
|                  8–39 |    6 |

Only 6 of 38 diverge at token 0. Example: `There are two bikes in this room. One
of them is` → `this one.` (MLX) / `lying down.` (GGUF) — 12 tokens shared, then gone.

### What follows

**No specific row is "lost."** Q6 lost the verdict row _"Am I even looking at the
right function?"_; Q8 and f16 lost _"Just tell me if the bug is in the frontend or
the backend."_ Different rows each time. There is no defect with a location.

MLX scored better in all four comparisons (0 reaching users vs 1–2), which is
suggestive — but **a 68-row eval where 38 rows change answer cannot separate "GGUF
is genuinely worse" from "GGUF is a different draw."** Same applies to checkpoint
selection: iter 1700 beat its neighbours by ~1 point, which is inside this noise.

This is almost certainly the same family as the Nathan Q8 mystery in
`~/Documents/AI/llm-models/docs/pipelines/gguf-pipeline.md` and the 1-point
MLX→Ollama drop recorded for the 7B. It is not a bug to find. It is resolution.

## HYPOTHESES TESTED AND ELIMINATED — do not re-run these

1. **`llama-quantize` damages the model.** NO. f16 GGUF (no quantization) scores
   61/68 / 2 reaching users, identical to Q4 and worse than Q6. Eliminated by
   measurement.
2. **More bits recovers the MLX baseline.** NO. It plateaus at Q6 and stops; Q8 is
   no better than Q6. Do not build a Q8 expecting it to fix this.
3. **The chat template differs.** NO. The template embedded in the GGUF is
   BYTE-IDENTICAL to `models/refusal-1.5b-fused/chat_template.jinja` (extracted
   with `GGUFReader`, diffed). Eliminated.
4. **Repetition-penalty window mismatch.** PARTIALLY, but not the cause. The MLX
   backend uses `repetition_penalty=1.1` over `repetition_context_size=20`;
   Ollama's `repeat_last_n` defaults to **64**. Setting `PARAMETER repeat_last_n 20`
   changed 10 of 68 outputs and moved the score **not at all** (61/68, 2 reaching
   users, same failures). Real difference, wrong culprit.
5. **Diverging rows are knife-edge on the first token.** NO. Median top1−top2
   first-token logit gap is 1.88 on diverging rows vs 1.98 on identical rows —
   indistinguishable. This test looks at the WRONG TOKEN: 32 of 38 rows diverge
   after token 0. If re-testing, measure the margin at the token where they
   actually split, not the first one.

## Open defects, not fixed here

- **`eval/check.py` passes a real how_to leak.** _"How do I get better at chess?"_
  → `Play more. And by that I mean play actual chess…` at BOTH iter 1700 and final.
  Tailored AND informative — a leak by the CLAUDE.md corollary — scored a PASS.
  Q4 added a second: _"How do I unclog a bathroom sink?"_ → `With a bucket and
patience.` Fixing the detector re-scores every historical run including the
  shipped 7B, so it is a decision, not a cleanup.
- **`eval/sweep.py` ranks on RAW `HARD`**, while `check.py`'s own headline is
  `HARD FAILURES REACHING USERS`. On the coarse pass this made sweep.py crown
  iter 1000 (1 reaching users) over the final checkpoint (0). Changing it
  redefines "best" for every run in the project.
- **`sequence` is the thinnest class.** _"Name the first four prime numbers"_
  leaked `2, 3, 5, and 7` outright at iters 600, 800, 1000, 1600.

## TOOLCHAIN: the GGUF path no longer reproduces from a clean env

`mlx_lm.convert` writes `tokenizer_config.json` `extra_special_tokens` as a **list**.
transformers ≥4.5x requires a dict, so `convert_hf_to_gguf.py` dies with
`'list' object has no attribute 'keys'`.

**The shipped 7B has the same list in its tokenizer config.** It only ever
converted because whatever env built it had an older transformers, and nothing in
this repo pins that. As of today the published model cannot be rebuilt from source
without knowing this.

Worked around with a throwaway venv — note `tokenizers` has no prebuilt wheel for
Python 3.14, so the venv must be 3.12:

```bash
python3.12 -m venv gguf312
./gguf312/bin/pip install "numpy~=1.26.4" sentencepiece "transformers==4.46.3" \
    "gguf>=0.1.0" "protobuf>=4.21.0,<5.0.0" torch
```

This wants a pinned requirements file in the repo.

## Commands, exactly as run

```bash
python3 -m mlx_lm convert --hf-path Qwen/Qwen2.5-1.5B-Instruct \
    --mlx-path ./models/qwen2.5-1.5b-instruct-fp16 --dtype float16
# then PATCH models/qwen2.5-1.5b-instruct-fp16/chat_template.jinja — it ships the
# stock Qwen/Alibaba "helpful assistant" fallback; match the 7B's RefusalGPT line

make check && make data
python3 runs/set_config.py runs/adapters-17-1.5b 8 config-1.5b.yaml
python3 -m mlx_lm lora --config runs/config-1.5b.yaml | tee runs/train-17-1.5b.log

python3 eval/sweep.py runs/adapters-17-1.5b \
    --base ./models/qwen2.5-1.5b-instruct-fp16 --every 200
python3 eval/sweep.py runs/adapters-17-1.5b \
    --base ./models/qwen2.5-1.5b-instruct-fp16 --only 900,1100,1700

# stage checkpoint 1700 as a fusable adapter dir (fuse wants adapters.safetensors)
mkdir -p /tmp/ckpt-1700
cp runs/adapters-17-1.5b/adapter_config.json /tmp/ckpt-1700/
cp runs/adapters-17-1.5b/0001700_adapters.safetensors /tmp/ckpt-1700/adapters.safetensors

python3 -m mlx_lm fuse --model ./models/qwen2.5-1.5b-instruct-fp16 \
    --adapter-path /tmp/ckpt-1700 --save-path ./models/refusal-1.5b-fused
$VENV/bin/python ~/Documents/dev/llama.cpp/convert_hf_to_gguf.py \
    ./models/refusal-1.5b-fused --outfile ./models/refusal-1.5b-f16.gguf --outtype f16
~/Documents/dev/llama.cpp/build/bin/llama-quantize \
    models/refusal-1.5b-f16.gguf models/refusal-1.5b-q4.gguf Q4_K_M

ollama create refusal-1.5b -f deploy/Modelfile-1.5b     # LOCAL ONLY, never push
python3 eval/run_model.py --backend ollama --model refusal-1.5b --out runs/preds-1.5b-q4.jsonl
python3 eval/check.py --pred runs/preds-1.5b-q4.jsonl
```

`~/.ollama/id_ed25519` is symlinked to `id_ed25519_owneroperators` — verified with
`readlink` before touching ollama. Nothing was pushed.

## Where to pick this up

The modelling question is answered and the artifacts are on disk. What is NOT
answered, in the order it blocks shipping:

1. **The eval is too small to select a runtime.** 38/68 rows change between MLX
   and llama.cpp. Any decision resting on a 1–2 point margin — GGUF vs MLX,
   iter 1700 vs 1788 — is inside the noise. Widening the eval is the prerequisite
   for every other decision below, and is worth more than any retraining.
2. **On-device means no proxy.** `api/src/safety.ts` is 262 lines and runs ahead
   of inference on the droplet. Fully offline, nothing stands in front of the
   model. Note this run produced `Press hard on it. Or a cloth. Or something.`
   on a haemorrhage probe, gate-terminated — the gate is the only thing between
   that sentence and a person. A Swift port makes a THIRD implementation of one
   keyword list in a third language; `check_guard.py` would need to score all
   three, and a bad rule in a shipped binary cannot be hotfixed.
3. **MLX-Swift is the unexamined alternative** and would run the fused model that
   scores 0 user-reaching failures, skipping the llama.cpp divergence entirely.
   Not evaluated here.

## Artifacts

```
models/qwen2.5-1.5b-instruct-fp16/   base, fp16, template patched
models/refusal-1.5b-fused/           adapter 1700 fused in
models/refusal-1.5b-f16.gguf         2.9 GB
models/refusal-1.5b-q4.gguf          940 MB
models/refusal-1.5b-q5.gguf          1.0 GB
models/refusal-1.5b-q6.gguf          1.2 GB   ← best size/behaviour of the GGUFs
models/refusal-1.5b-q8.gguf          1.5 GB
runs/adapters-17-1.5b/               17 checkpoints + final
runs/config-1.5b.yaml
runs/train-17-1.5b.log
runs/sweep-17-coarse.log  runs/sweep-17-refine.log
runs/preds-1.5b-{fused,gguf-f16,gguf-f16-w20,q4,q5,q6,q8}.jsonl
runs/preds-adapters-17-1.5b-*.jsonl  per-checkpoint predictions
deploy/Modelfile-1.5b
```

Ollama models created LOCALLY: `refusal-1.5b`, `-q5`, `-q6`, `-q8`, `-f16`,
`-f16w20`. Delete with `ollama rm` when done; they are eval scaffolding, not
deliverables.
