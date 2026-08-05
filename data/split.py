#!/usr/bin/env python3
"""Stratified train/valid split for mlx_lm.lora.

    python3 data/split.py [--valid-frac 0.12] [--seed 7]

Reads  data/train_all.jsonl   (written by gen_samples.py)
Writes data/mlx/train.jsonl, data/mlx/valid.jsonl

Stratified by category, because an unstratified split at this size will happily
put both distress rows in train and leave the valid set unable to see the one
behaviour that must not regress.

Note this valid set is for the LOSS CURVE only. Checkpoint selection happens in
eval/check.py against held-out rows with machine-checkable assertions — see
CLAUDE.md on why val loss is the weaker signal here.
"""
import argparse
import json
import os
import random
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "train_all.jsonl")
OUTDIR = os.path.join(HERE, "mlx")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--valid-frac", type=float, default=0.12)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    if not os.path.exists(SRC):
        raise SystemExit(f"missing {SRC} — run: python3 data/gen_samples.py")

    rows = [json.loads(l) for l in open(SRC) if l.strip()]
    by_cat = defaultdict(list)
    for r in rows:
        by_cat[r["meta"]["cat"]].append(r)

    rng = random.Random(args.seed)
    train, valid = [], []
    for cat, items in sorted(by_cat.items()):
        rng.shuffle(items)
        # At least one row per category in valid, but never take the last one.
        n = max(1, round(len(items) * args.valid_frac))
        n = min(n, len(items) - 1) if len(items) > 1 else 0
        valid += items[:n]
        train += items[n:]

    rng.shuffle(train)
    rng.shuffle(valid)

    os.makedirs(OUTDIR, exist_ok=True)
    for name, data in (("train", train), ("valid", valid)):
        path = os.path.join(OUTDIR, f"{name}.jsonl")
        with open(path, "w") as f:
            for r in data:
                # mlx_lm.lora wants messages only — meta would be serialized into
                # the prompt as noise.
                f.write(json.dumps({"messages": r["messages"]}, ensure_ascii=False) + "\n")
        print(f"{name:>5}: {len(data):>4} rows -> {path}")

    missing = [c for c in by_cat if not any(v["meta"]["cat"] == c for v in valid)]
    if missing:
        print(f"\nnote: no valid rows for {', '.join(missing)} (too few to split)")


if __name__ == "__main__":
    main()
