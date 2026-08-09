#!/usr/bin/env python3
"""Score every saved checkpoint of an adapter and print the behaviour curve.

    python3 eval/sweep.py runs/adapters-16 --base ./models/qwen2.5-7b-instruct-fp16
    python3 eval/sweep.py runs/adapters-16 --every 200      # skip half of them

CHECKPOINT SELECTION IS THE EXPERIMENT IN THIS PROJECT, and val loss cannot run
it. Measured three times here: smoke-04 posted the LOWEST val loss of any run on
the WORST-behaving model, and smoke-05 posted 2.195 on the best. Picking the
minimum of that curve picks the wrong model. So this walks the checkpoints and
scores each one on eval/check.py, which is the only signal that has ever agreed
with reading transcripts.

Two things it does that are easy to get wrong by hand:

  * `mlx_lm.load(base, adapter_path=...)` wants a DIRECTORY holding
    `adapters.safetensors` + `adapter_config.json`, not a checkpoint file. Each
    checkpoint is staged into its own directory rather than clobbering the live
    `adapters.safetensors`, so a sweep never destroys the final adapter.

  * `--base` MUST match what the adapter was trained against. run_model.py
    defaults to the 4-bit build; an fp16-trained adapter loaded onto that base is
    a model nobody trained and its score means nothing. There is no default here
    for that reason — pass it explicitly or the script refuses to run.

Prints one row per checkpoint and names the winner by HARD failures first, then
total passes. It does NOT pick for you beyond that: read the transcripts of the
top two before fusing anything.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def checkpoints(adapter_dir, every, only=None):
    """Saved checkpoints in training order, plus the final adapter last.

    `only` is a set of iteration numbers. A coarse pass finds the region and a
    refinement pass scores the neighbours — re-running the ten checkpoints
    already scored costs ~40 minutes of GPU to learn nothing.
    """
    found = []
    for name in os.listdir(adapter_dir):
        m = re.fullmatch(r"(\d+)_adapters\.safetensors", name)
        if m:
            found.append((int(m.group(1)), os.path.join(adapter_dir, name)))
    found.sort()
    if only:
        missing = only - {i for i, _ in found}
        if missing:
            sys.exit(f"no checkpoint saved at: {sorted(missing)}")
        return [f for f in found if f[0] in only]
    if every > 1:
        found = [f for f in found if f[0] % every == 0]
    final = os.path.join(adapter_dir, "adapters.safetensors")
    if os.path.exists(final):
        found.append((-1, final))  # -1 sorts nowhere; label handles it
    return found


def score(pred_path):
    """Run check.py and pull (passed, total, hard) out of its summary line."""
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "eval", "check.py"), "--pred", pred_path],
        capture_output=True, text=True,
    )
    m = re.search(r"PASS (\d+)/(\d+)\s+soft (\d+)\s+HARD (\d+)", r.stdout)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("adapter", help="adapter directory, e.g. runs/adapters-16")
    ap.add_argument("--base", required=True,
                    help="MUST match the training base. fp16 adapter + 4-bit base = a model "
                         "nobody trained. No default on purpose.")
    ap.add_argument("--every", type=int, default=100,
                    help="only score checkpoints at multiples of this (default 100 = all)")
    ap.add_argument("--only", help="comma-separated iters to score, e.g. 500,700. "
                                   "Overrides --every and skips the final adapter.")
    a = ap.parse_args()
    only = {int(x) for x in a.only.split(",")} if a.only else None

    adapter_dir = os.path.join(ROOT, a.adapter) if not os.path.isabs(a.adapter) else a.adapter
    cfg = os.path.join(adapter_dir, "adapter_config.json")
    if not os.path.exists(cfg):
        sys.exit(f"no adapter_config.json in {adapter_dir}")

    cps = checkpoints(adapter_dir, a.every, only)
    if not cps:
        sys.exit(f"no checkpoints found in {adapter_dir}")

    tag = os.path.basename(adapter_dir.rstrip("/"))
    print(f"sweeping {len(cps)} checkpoints of {tag} against base {a.base}\n")

    results = []
    for iters, path in cps:
        label = "final" if iters < 0 else str(iters)
        pred = os.path.join(ROOT, "runs", f"preds-{tag}-{label}.jsonl")
        staged = tempfile.mkdtemp(prefix=f"{tag}-{label}-")
        try:
            shutil.copy(cfg, os.path.join(staged, "adapter_config.json"))
            shutil.copy(path, os.path.join(staged, "adapters.safetensors"))
            print(f"  [{label:>5}] generating…", flush=True)
            gen = subprocess.run(
                [sys.executable, os.path.join(ROOT, "eval", "run_model.py"),
                 "--backend", "mlx", "--base", a.base, "--adapter", staged, "--out", pred],
                capture_output=True, text=True,
            )
            if gen.returncode != 0:
                print(f"  [{label:>5}] GENERATION FAILED: {gen.stderr.strip()[-200:]}")
                continue
        finally:
            shutil.rmtree(staged, ignore_errors=True)

        s = score(pred)
        if s is None:
            print(f"  [{label:>5}] could not parse check.py output")
            continue
        passed, total, soft, hard = s
        results.append((label, passed, total, soft, hard, pred))
        print(f"  [{label:>5}] PASS {passed}/{total}   soft {soft}   HARD {hard}")

    if not results:
        sys.exit("\nno checkpoint produced a score")

    print(f"\n{'='*58}\n  {tag} behaviour curve\n{'='*58}")
    print(f"  {'iter':>6}  {'pass':>7}  {'soft':>5}  {'HARD':>5}")
    for label, passed, total, soft, hard, _ in results:
        print(f"  {label:>6}  {passed:>3}/{total:<3}  {soft:>5}  {hard:>5}")

    # HARD failures first — a run with any HARD failure does not ship regardless
    # of how well it scores elsewhere. Ties break on total passes.
    best = sorted(results, key=lambda r: (r[4], -r[1]))[0]
    print(f"\n  best by check.py: iter {best[0]} — PASS {best[1]}/{best[2]}, HARD {best[4]}")
    print(f"  predictions: {os.path.relpath(best[5], ROOT)}")
    print("\n  READ THE TRANSCRIPTS of the top two before fusing. This score is a")
    print("  filter, not a verdict — 'funny' is further from any metric than")
    print("  'correct' is, and a collapsed model can score well by refusing all.")


if __name__ == "__main__":
    main()
