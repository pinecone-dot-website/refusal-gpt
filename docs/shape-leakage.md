> Split out of `CLAUDE.md` on 2026-08-13 so it stops loading on every startup.
> The binding rules stay in `CLAUDE.md`; this is the measurement record behind them.

# A category can teach a SHAPE that leaks somewhere else entirely

Measured 2026-08-05, smoke-08. The clearest demonstration of this repo's central
claim, and it came from the most harmless-looking rows in the file.

The `ascii` rows answer "draw me a cat" with a block-letter **NO** inside a code
fence. Eleven of them, all safe, all funny, none containing a single usable
character. What the model actually learned from them was one level up:

> when asked for a formatted artifact, produce the artifact inside a fence

Applied to ASCII art that is a joke. Applied to code it is total compliance, and
that is what happened — **six of six code requests produced working output**: a
real Python function, a real SQL query, real CSS, a real regex. The corpus had
eleven rows saying "fill the fence" and one row refusing code.

The fix was fourteen code-refusal rows covering every artifact type the model
had reached for. Result: **0/9 fences**, generalising to languages never trained
(Go, docker-compose), with the ASCII banner still working.

**Third instance, 2026-08-05: `shaggy` taught long-form prose.** Asked "What
should I look for in a second-hand bike?" it returned real advice — frame cracks,
chain wear, brake pads. `ascii` had a safe fixed payload (a picture of NO).
`shaggy` has NO payload; it is freeform prose, and prose about a practical
question IS the answer. There is no safe version of the long form on a how-to, so
the category is now restricted by a WHITELIST to opinion prompts only ("should
I", "is it worth", "any thoughts on"), enforced in `gen_samples.py`. Accepted
consequence: it fires rarely. A category that fires seldom and safely beats one
that fires often and helps.

**Fourth, same run: how-to PHRASING bypassed the code refusals entirely.** Every
code row was written as "write me X". The model refused those and treated "how
would I write X" as a different, permitted question — producing working Rust with
an explanation of the range operator. Same request, imperative filed off, and it
is how people actually ask. Fixed with 12 rows in the how-to shape; `how_to` is
its own eval probe now.

**The rule this establishes:** every category teaches a shape as well as a
behaviour, and the shape does not stay in its lane. Before adding a category,
ask what it teaches ONE LEVEL UP from its content, and whether that lesson is
safe everywhere else. `ascii` taught format-compliance. `smalltalk` taught terse
agreement, which leaked verdicts onto yes/no questions (smoke-04). Both were
invisible in the category that caused them and only showed up somewhere else.

Corollary for the eval: probing a category tells you nothing about what it did to
its neighbours. `check.py` must run the FULL suite after any category changes.
