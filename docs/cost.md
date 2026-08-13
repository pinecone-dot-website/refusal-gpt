> Split out of `CLAUDE.md` on 2026-08-13 so it stops loading on every startup.
> The binding rules stay in `CLAUDE.md`; this is the measurement record behind them.

# Cost discipline

Cost record: the shared `docs/API-COSTS.md` in the marketing workspace. One wallet, one
file — record $0.00 local runs too.

`workersMin: 0` is not a promise. Verified twice: a worker spawns on endpoint _creation_
before any request, and an endpoint reporting zero workers still had one idle 40 minutes
later. At A40 rates that is ~$10.50/day. Guardrails are non-negotiable: `workersMax` set
low, a ledger line written before the resource can bill, and teardown verified by
re-querying rather than by having called delete.

**How to actually read RunPod spend. Measured 2026-08-05, after getting it wrong twice.**

**Use `runpodctl billing serverless`. It is the only authoritative source**, and it is
per-endpoint, per-day, with both dollars and billed milliseconds — which is enough to
derive the true active rate:

```bash
runpodctl billing serverless > bill.json   # amount, timeBilledMs, endpointId, day
```

Real numbers for 2026-08-05: `refusal-gpt` **$0.3706 across 33.7 minutes billed**
(`$0.66/hr` while a worker is active), another endpoint $0.83 across 43 min (`$1.16/hr` — a
pricier GPU tier), whole account **$1.50 for the day**. Scale-to-zero is working; the
per-hour figure only applies to the minutes a worker is actually up.

Two things that look like evidence and are not:

_Worker counts overlap._ `/v2/<id>/health` returns
`{idle, initializing, ready, running, throttled, unhealthy}` and counts the same machine
in several buckets. Summing them is meaningless: two endpoints reported
`idle:1, ready:1, running:1` and `idle:1, ready:1` — an apparent **five workers against a
hard ceiling of three** (maxima of 2 and 1), when the real answer was one. `workersMax` is
the ceiling and RunPod enforces it.

_Balance deltas are lumpy, so short samples are worthless._ Settlement is batched, not
continuous. The **same 90-second window** returned `$0.00/hr` on one attempt and
`$2.29/hr` on the next, neither of which was the real rate. Do not diff `clientBalance`
over a short interval and report the result — that method produced both a false all-clear
and a false alarm here in the space of ten minutes.

_`currentSpendPerHr` is roughly the right RATE while workers are active_ (`0.69` against a
billing-derived `0.66`), but it lingers after they stop and says nothing about the day's
total. It is not "what I am spending now."

Corollary for a launch: the balance is the binding constraint, not the config. A worker
held warm by continuous traffic costs about `$16/day`, and a $10 balance runs dry in half
a day — at exactly the moment attention arrives.

**`idleTimeout` is a launch decision, not a hygiene setting.** 60s minimises idle spend
and is right when traffic trickles. 300s is right for a spike — every visitor inside the
window skips a 1–3 minute cold start, and cold starts are what make the demo look broken
in front of a crowd. `refusal-gpt` runs 300s on purpose.

**A ledger note that says REVERT TONIGHT does not revert anything. $32, 2026-08-06
to 08.** `workersMin` was raised to 1 for a traffic push, with its own ledger line
reading _"REVERT TO 0 TONIGHT — this bills whether anyone visits or not."_ It was
still 1 two days later. Billing is unambiguous about what that costs: **1,440
minutes billed per day** — a worker up 24h — at **$15.81/day**, against a
predicted $15.84. Endpoint total $39.79, of which roughly $32 bought nothing.

The lesson is not "remember to revert." It is that a reminder written in a file
nobody re-reads is not a control. If a setting must expire, either put the
revert on a timer or check it in the same breath as reading the ledger. And
**check spend against `runpodctl billing serverless` before assuming a config
change worked**: `workersStandby` is STILL 1 here and its billing semantics have
been flagged UNVERIFIED since 2026-08-06. If tomorrow's `timeBilledMs` stays near
1,440 min/day with `workersMin: 0`, standby was the real cost and `workersMin`
was a red herring the whole time.
