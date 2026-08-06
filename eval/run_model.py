#!/usr/bin/env python3
"""Run the eval set through a model and write predictions.

    python3 eval/run_model.py --backend mlx --adapter runs/adapters-09
    python3 eval/run_model.py --backend ollama --model refusal-7b
    python3 eval/run_model.py --backend runpod --url https://<id>.api.runpod.ai

Writes <out>.jsonl with one {"i": int, "output": str} per row, then:
    python3 eval/check.py --pred <out>.jsonl

Temperature is 0 everywhere and not configurable. Measured in smoke-06: any
temperature above 0 mutates the tail of a correct refusal into a verdict, and
leaks appear from 0.1. A non-deterministic eval measures the sampler, not the
model.

TRANSPORT ERRORS ARE RECORDED, NOT SCORED. An earlier project lost 4 points to HTTP 502s
that `run_model` had written into the output field, so infrastructure flakiness
scored as wrong answers. Here a failed call is retried, then marked
__TRANSPORT_ERROR__ so check.py can exclude it rather than blame the model.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL = os.path.join(ROOT, "data", "eval", "refusal.jsonl")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
ERR = "__TRANSPORT_ERROR__"


def http_json(url, payload, token=None, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", UA)          # Cloudflare 403s Python-urllib
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["mlx", "ollama", "runpod"], required=True)
    ap.add_argument("--adapter", help="mlx: adapter path")
    ap.add_argument("--base", default="mlx-community/Qwen2.5-7B-Instruct-4bit")
    ap.add_argument("--model", default="refusal-7b", help="ollama/runpod model name")
    ap.add_argument("--url", help="runpod endpoint base url")
    ap.add_argument("--token", default=os.environ.get("RUNPOD_API_KEY", ""))
    ap.add_argument("--out", help="predictions path (default derived from backend)")
    ap.add_argument("--max-tokens", type=int, default=220)
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(EVAL) if l.strip()]
    out_path = a.out or os.path.join(ROOT, "runs",
                                     f"preds-{a.adapter.split('/')[-1] if a.adapter else a.backend}.jsonl")

    if a.backend == "mlx":
        from mlx_lm import load, generate
        from mlx_lm.sample_utils import make_sampler, make_logits_processors
        model, tok = load(a.base, adapter_path=a.adapter)
        sampler = make_sampler(temp=0.0)
        # Partially-trained adapters loop under greedy decoding; the loop runs
        # into the token cap and truncates, which reads as a format failure and
        # is not one.
        procs = make_logits_processors(repetition_penalty=1.1)

        def ask(msgs):
            text = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)
            return generate(model, tok, prompt=text, max_tokens=a.max_tokens,
                            verbose=False, sampler=sampler, logits_processors=procs)
    else:
        base = (a.url.rstrip("/") if a.backend == "runpod" else "http://127.0.0.1:11434")
        token = a.token if a.backend == "runpod" else None

        def ask(msgs):
            d = http_json(f"{base}/api/chat", {
                "model": a.model, "messages": msgs, "stream": False,
                "options": {"temperature": 0, "num_predict": a.max_tokens},
            }, token=token)
            return d["message"]["content"]

    n_err = 0
    with open(out_path, "w") as f:
        for i, r in enumerate(rows):
            output, last = ERR, ""
            for attempt in range(3):
                try:
                    output = ask(r["messages"]).strip()
                    break
                except Exception as e:                      # noqa: BLE001
                    last = f"{type(e).__name__}: {e}"
                    time.sleep(2 * (attempt + 1))
            if output == ERR:
                n_err += 1
                print(f"  [{i:2}] TRANSPORT ERROR after 3 tries — {last[:70]}")
            f.write(json.dumps({"i": i, "output": output,
                                "probe": r["meta"]["probe"]}, ensure_ascii=False) + "\n")
            if (i + 1) % 10 == 0:
                print(f"  {i+1}/{len(rows)}")

    print(f"\n{len(rows)} rows -> {out_path}")
    if n_err:
        print(f"  ⚠️  {n_err} transport error(s) — excluded from scoring, NOT counted as wrong")
    print(f"\nnow:  python3 eval/check.py --pred {out_path}")


if __name__ == "__main__":
    main()
