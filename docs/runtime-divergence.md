> Split out of `CLAUDE.md` on 2026-08-13 so it stops loading on every startup.
> The binding rules stay in `CLAUDE.md`; this is the measurement record behind them.

# ALWAYS EVAL THE SHIPPING ARTIFACT, NOT THE ADAPTER

The MLX adapter and the Q8 GGUF **diverge**, and MLX is the optimistic one.

Measured 2026-08-05: asked for a `.gitignore`, the Q8 build printed a real one in
a fence while the MLX adapter merely explained what the file was. Both are leaks;
only the Q8 one was obvious. That build was minutes from a public HF repo.

```
make eval                                   # MLX adapter — fast iteration
python3 eval/run_model.py --backend ollama --model refusal-7b --out runs/preds-q8.jsonl
python3 eval/check.py --pred runs/preds-q8.jsonl     # WHAT ACTUALLY SHIPS
```

Expect the Q8 build to lose a point or two on soft checks. It must not lose any
on HARD ones. The earlier fine-tune saw the same 1-point MLX→Ollama drop.

## That divergence is the RUNTIME, not the quantization. Measured 2026-08-11.

Full record in `runs/smoke-17-1.5b.md`. On the 1.5B: **38 of 68 answers change
between MLX fp16 and GGUF f16 — same weights, same greedy decode, no
quantization anywhere.** The unquantized f16 GGUF scores the same as Q4_K_M
(61/68), and more bits does not help: it plateaus at Q6 and Q8 is no better.

Mechanism: llama.cpp and MLX compute slightly different logits from identical
fp16 weights. Greedy decoding agrees while the argmax margin is comfortable and
splits at the first token where it is not; everything after is a different
sentence. Only 6 of the 38 diverge at token 0 — most share 1–5 tokens first.

**Consequences, and they bite:**

- **No specific row is "lost."** Q6 dropped one verdict row, Q8 and f16 dropped a
  different one. There is no defect with a location. Do not go hunting for one.
- **A 68-row eval cannot resolve a runtime change**, and therefore cannot resolve
  a 1–2 point checkpoint margin either. Widening the eval is worth more than any
  retraining currently on the table.
- Do not re-test these; they are eliminated by measurement, with the failed
  reasoning recorded in the run note: quantization damage, more bits, chat-template
  mismatch (byte-identical in the GGUF), repetition-window mismatch (real —
  MLX uses a 20-token window, Ollama's `repeat_last_n` defaults to 64 — but
  matching them changed 10 outputs and moved no score), and first-token
  knife-edge margins (measures the wrong token).

## The GGUF path no longer reproduces from a clean env

`mlx_lm.convert` writes `tokenizer_config.json` `extra_special_tokens` as a
**list**; transformers ≥4.5x wants a dict, so `convert_hf_to_gguf.py` dies with
`'list' object has no attribute 'keys'`. **The shipped 7B has the same list** — it
only converted because its build env had an older transformers, and nothing here
pins that. Use Python 3.12 (`tokenizers` has no 3.14 wheel) with
`transformers==4.46.3`. This wants a pinned requirements file.
