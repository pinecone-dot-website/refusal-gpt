#!/usr/bin/env python3
"""Union coverage across every guard-model prediction file, plus a threshold
sweep for any model that emits a continuous score.

    python3 eval/guard-harness/union.py runs/preds-guard-*.jsonl

The union is the number that matters: a layered gate is only worth building
if the layers catch DIFFERENT things. runs/guard-layers.md rejected a
regex+FM union on exactly this test.

The threshold sweep is the NLEmbedding check (runs/guard-layers.md) applied
to any p(Yes)-style output: if the benign median outranks the distress
median, the ranking is inverted and no operating point exists.
"""
import json, re, sys, statistics as st
from collections import defaultdict

files = sys.argv[1:]
if not files:
    sys.exit(__doc__)

cov, scored = defaultdict(set), defaultdict(lambda: defaultdict(list))
for f in files:
    for line in open(f):
        r = json.loads(line)
        tag = f"{r['model'].split('/')[-1]}{'/custom' if 'CUSTOM' in r['mode'] else ''}"
        if r["label"] == "distress":
            cov[r["text"]]  # register every probe, caught or not
            if r["fired"]:
                cov[r["text"]].add(tag)
        m = re.search(r"p\(Yes\)=([\d.]+)", r.get("detail", ""))
        if m:
            scored[tag][r["label"]].append(float(m.group(1)))

print("=" * 78)
print(f"UNION over {len(files)} prediction files")
print("=" * 78)
for t, s in cov.items():
    mark = ("caught by " + ", ".join(sorted(s))) if s else "*** CAUGHT BY NOTHING ***"
    print(f"  {t[:54]:56} {mark[:66]}")
never = [t for t, s in cov.items() if not s]
print(f"\n  union recall            {len(cov) - len(never)}/{len(cov)}")
print(f"  caught by NO model      {len(never)}/{len(cov)}")

for tag, by in scored.items():
    d, b = sorted(by.get("distress", [])), sorted(by.get("benign", []))
    if not d or not b:
        continue
    print(f"\n{'=' * 78}\nTHRESHOLD SWEEP — {tag}\n{'=' * 78}")
    print(f"  distress  min {d[0]:.3f}  median {st.median(d):.3f}  max {d[-1]:.3f}")
    print(f"  benign    min {b[0]:.3f}  median {st.median(b):.3f}  max {b[-1]:.3f}")
    if st.median(b) > st.median(d):
        print("  ⚠️  BENIGN MEDIAN OUTRANKS DISTRESS — ranking is INVERTED, "
              "no operating point exists.")
    print("  thr    recall   clean")
    for t in (0.9, 0.7, 0.5, 0.3, 0.1, 0.05, 0.02, 0.01):
        print(f"  {t:<5.2f}  {sum(x >= t for x in d):2}/{len(d)}   "
              f"{sum(x < t for x in b):2}/{len(b)}")
