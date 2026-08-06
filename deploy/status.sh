#!/usr/bin/env bash
# Re-query RunPod. Teardown is confirmed by THIS, never by having called delete.
# Verified 2026-07-29: an endpoint reporting zero workers still had one idle 40
# minutes later. At A40 rates that is ~$10.50/day.
set -euo pipefail
: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY}"
curl -sS -H "Authorization: Bearer $RUNPOD_API_KEY" https://api.runpod.io/v2/serverless \
 | python3 -c '
import json,sys
d=json.load(sys.stdin)
eps=d.get("endpoints") or d.get("serverless") or (d if isinstance(d,list) else [])
if not eps: print("no endpoints — nothing billing"); raise SystemExit
for e in eps:
    w=e.get("workers") or {}
    print(f"  {e.get(\"id\")}  {e.get(\"name\")}  min={w.get(\"min\")} max={w.get(\"max\")} idle={w.get(\"idleTimeout\")}s")
    print(f"     image: {e.get(\"image\")}")
'
