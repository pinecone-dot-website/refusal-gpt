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
TRAIN = os.path.join(ROOT, "data", "mlx", "train.jsonl")
BATCH = 4

adapter = sys.argv[1] if len(sys.argv) > 1 else "runs/adapters-dev"
epochs = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
# Third arg targets a config other than the smoke one — added for the 1.5B run,
# which needs its own base and adapter path but the SAME iters arithmetic.
cfg_name = sys.argv[3] if len(sys.argv) > 3 else "config.smoke.yaml"
CFG = os.path.join(ROOT, "runs", cfg_name)

n = sum(1 for line in open(TRAIN) if line.strip())
iters = max(1, int(epochs * n / BATCH))

s = open(CFG).read()
# re.sub is a silent no-op when nothing matches, which is how a config with a
# renamed key would keep a stale iters count and report success. Count, don't hope.
s, n_iters = re.subn(r"^iters: .*$", f"iters: {iters}", s, flags=re.M)
s, n_path = re.subn(r"^adapter_path: .*$", f'adapter_path: "./{adapter}"', s, flags=re.M)
if n_iters != 1 or n_path != 1:
    sys.exit(f"{cfg_name}: expected 1 iters + 1 adapter_path line, "
             f"replaced {n_iters} and {n_path} — config not written")
open(CFG, "w").write(s)

print(f"{n} train rows -> {iters} iters (~{epochs:g} epochs, batch {BATCH}) -> {adapter}")
