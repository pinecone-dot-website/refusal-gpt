# refusal-gpt
#
# EVERY TARGET IS GATED. `make` stops on the first failure, which is the whole
# reason this file exists.
#
# Twice during development a generator failed and the shell chain carried on:
# gen_eval.py refused to write because an eval prompt had leaked into training,
# and the next command trained a model and scored it against the STALE eval file.
# The check worked perfectly and the result was still garbage, because nothing
# stopped the pipeline. Run things through here, not by hand.
#
#   make data      validate corpus + split + regenerate eval
#   make train     data, then LoRA (iters recomputed from corpus size)
#   make eval      train, then predictions + score
#   make guard     distress-guard recall test (run after ANY serve.py edit)
#   make check     everything that can fail, in order, fast first
#   make site      local site + proxy on :8902

PY      := python3
ADAPTER ?= runs/adapters-dev
BASE    ?= mlx-community/Qwen2.5-7B-Instruct-4bit
EPOCHS  ?= 6
BATCH   := 4

.PHONY: data train eval guard check site clean iters

## ── data ────────────────────────────────────────────────────────────────────
# gen_samples exits non-zero on any broken invariant; && means split never runs
# on an unvalidated corpus, and gen_eval never scores against a stale file.
data:
	$(PY) data/gen_samples.py
	$(PY) data/split.py
	$(PY) data/gen_eval.py

## ── iters is a FUNCTION OF CORPUS SIZE, never a constant ────────────────────
# This has gone wrong in both directions: 400 iters when 1,800 were needed
# (undertrained, smoke-05), then 1,800 left in place at 233 rows (31 epochs, a
# memorisation machine). Neither announces itself and the loss curve is
# anti-correlated, so it cannot tell you which. Computed here, every time.
iters:
	@$(PY) -c "n=sum(1 for l in open('data/mlx/train.jsonl') if l.strip()); \
	print(f'{n} train rows -> {int($(EPOCHS)*n/$(BATCH))} iters at ~$(EPOCHS) epochs')"

train: data
	$(PY) runs/set_config.py $(ADAPTER) $(EPOCHS)
	rm -rf $(ADAPTER)
	mlx_lm.lora --config runs/config.smoke.yaml | grep -E "Val loss" | tail -3

eval: train
	$(PY) eval/run_model.py --backend mlx --base $(BASE) --adapter $(ADAPTER)
	$(PY) eval/check.py --pred runs/preds-$(notdir $(ADAPTER)).jsonl

# Score an existing adapter without retraining.
rescore:
	$(PY) eval/run_model.py --backend mlx --base $(BASE) --adapter $(ADAPTER)
	$(PY) eval/check.py --pred runs/preds-$(notdir $(ADAPTER)).jsonl

## ── the guard is the only test where failing means someone gets hurt ────────
guard:
	$(PY) eval/check_guard.py

## ── everything that can fail, cheapest first ────────────────────────────────
# check.py --selftest runs BEFORE any scoring: seven detectors in this project
# have reported success while measuring nothing, so the checker is verified
# against known-bad strings before its output is trusted.
check:
	$(PY) data/seeds.py
	$(PY) data/gen_samples.py
	$(PY) data/gen_eval.py
	$(PY) eval/check.py --selftest
	$(PY) eval/check_guard.py
	@echo "\nall guards green — corpus, eval, detectors and distress guard"

site:
	$(PY) deploy/serve.py

clean:
	rm -f data/train_all.jsonl data/mlx/*.jsonl data/eval/*.jsonl
