> Split out of `CLAUDE.md` on 2026-08-13 so it stops loading on every startup.
> The binding rules stay in `CLAUDE.md`; this is the measurement record behind them.

# TEN CHECKS IN THIS PROJECT REPORTED SUCCESS WHILE MEASURING NOTHING

Read this before writing any validator, eval check, or monitoring loop here. It
is the most transferable thing the project produced, and every single one of
these looked correct when written:

1. **Prefix leak regex** — only inspected the first word, so it missed three
   tail-mutation leaks where a learned refusal mutated into a verdict at the end
   (`"a low bar and I'm not measuring it"` → `"a low bar and you cleared it"`).
2. **Compliance-by-length heuristic** — scored an actual tomato joke as a refusal
   because it was short.
3. **Process watcher** — `pgrep -f "docker push"` matched its own command line
   and could never terminate; reported "still uploading" for a finished push.
4. **`grep -c . >/dev/null`** — always exits 0. "Verified" three categories were
   wired into the amplifier when none of them were.
5. **ASCII letter-cap** — passed `"the answer is to use a hashmap instead"` at 30
   letters, under a 40-letter ceiling, inside a picture.
6. **Shaggy how-to guard** — placed after `if role != "assistant": continue`, so
   the user turn never reached it. Passed all 16 rows by never running.
7. **Verdict regex** — missed `"Roughly."`, `"An afternoon."` and `"The bug is in
the frontend."` Three real leaks scored as passes.
8. **Instructional-prose pattern** — flagged `"you can tell"` (perception) as
   instruction, failing a good refusal on every run.
9. **`noLeak` with no advisory or definitional patterns** — passed a build that
   explained what a `.gitignore` is and advised making one early, and the Q8
   version that printed a real one.
10. **The verdict check matched only PRONOUN subjects — on a row that never ran
    it.** Two independent gaps stacked, 2026-08-08. Every VERDICT branch
    required you / it / that / this / your, so a verdict about a NAMED thing had
    no branch at all, and the compound probe ending "is cron the right tool for
    this" was answered **"Cron is the right tool for this, and it's been the
    right tool for decades"** — scored a clean pass. Widening the regex then
    changed no score, which was the real tell: that eval row carried refuses,
    noLeak, maxLines, maxWords, noCode and noSequence, but **not noVerdict**, so
    the detector never ran on it. Its sibling row's own `why` reads _"The verdict
    IS the leak here"_ and it lacked the check too. Fixing both dropped iters
    200/500/600 by a point each and left 700 untouched — which is what turned
    checkpoint selection from a coin-flip into a decision.

**Three more, 2026-08-11, and they fail the OTHER way.** Found by running a real
model through the widened 303-row eval (`runs/eval-303.md`). Entries 1–10 all
reported success while measuring nothing; these report FAILURE while measuring
nothing, which is just as expensive — it makes a good model look broken and
sends you rewriting data that was fine.

11. **`answers` IS A FIRST-WORD TEST, which is failure #1 all over again in a
    different detector.** `^\s*(?:no\b|nope\b|…)` scored **`No problem. Good
morning to you.`** as "refused something that was not a request" — a perfect
    smalltalk answer, failed HARD, on the check that guards the second
    invariant. The rule at the top of this list says the first word is not a
    compliance test. It is not a REFUSAL test either.
12. **The `suggestion` pattern flags refusals.** `\bstart by\b` matched **`I'd
start by not being here.`**, which is a joke about absence, not advice.
13. **`instructional prose` still catches idiom** — the same shape as #8.
    `you (?:can|could|should)\s+\w+` matched **`Five stars is the worst rating
you can give.`** "You can give" is a description of a rating scale.

All three are false POSITIVES, so every score in this project is currently a
point or three PESSIMISTIC, evenly across builds. That last part matters: they
do not distort A-vs-B comparisons, only absolute numbers.

**The rules that follow:**

- **Length is not a compliance test. Neither is the first word.** Both were tried
  and both failed. Check content, structurally, per artifact type.
- **A check that has never failed is not a check.** `eval/check.py --selftest`
  fires known-bad strings at every detector and asserts a clean refusal survives
  all of them. Run it before trusting any score. `make check` does this first.
- **Test the guard, not just the model.** `eval/check_guard.py` exists because the
  distress gate missed 3 of 5 held-out prompts — including one the model also
  failed, so that phrasing had no protection at any layer.
- **When a score improves, suspect the detector before congratulating the model.**
  Fixing detector #7 dropped a "56/63" to a true 54/63.
