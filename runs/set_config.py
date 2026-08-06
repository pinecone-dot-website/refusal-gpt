#!/usr/bin/env python3
"""Point runs/config.smoke.yaml at an adapter, with iters computed from corpus size.

    python3 runs/set_config.py <adapter_path> [epochs]

Exists because the Makefile originally did this with an inline heredoc, and make's
line-continuation handling mangled it badly enough that `import re` was executed
as ImageMagick's `import` command. A file is not clever and it works.

ITERS IS A FUNCTION OF CORPUS SIZE, NEVER A CONSTANT. It has gone wrong in both
directions in this project — 400 when 1,800 was needed (undertrained), then 1,800
left in place at 233 rows (31 epochs, memorisation). Neither failure announces
itself, and val loss is anti-correlated here so it cannot arbitrate. Computed
from the actual split every time.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "runs", "config.smoke.yaml")
TRAIN = os.path.join(ROOT, "data", "mlx", "train.jsonl")
BATCH = 4

adapter = sys.argv[1] if len(sys.argv) > 1 else "runs/adapters-dev"
epochs = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0

n = sum(1 for line in open(TRAIN) if line.strip())
iters = max(1, int(epochs * n / BATCH))

s = open(CFG).read()
s = re.sub(r"^iters: .*$", f"iters: {iters}", s, flags=re.M)
s = re.sub(r"^adapter_path: .*$", f'adapter_path: "./{adapter}"', s, flags=re.M)
open(CFG, "w").write(s)

print(f"{n} train rows -> {iters} iters (~{epochs:g} epochs, batch {BATCH}) -> {adapter}")
