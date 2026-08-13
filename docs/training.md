> Split out of `CLAUDE.md` on 2026-08-13 so it stops loading on every startup.
> The binding rules stay in `CLAUDE.md`; this is the measurement record behind them.

# Gotchas

**The obvious failure mode is collapse, not undertraining.** Targets here are short —
often three words — and highly repetitive in register. A 7B at rank 16 for 1000 iters
will happily converge to a model that emits `No.` and nothing else, which scores well on
naive refusal metrics and is not funny. Variety is a scored eval property
(`noStockLine`, `distinctFromPrev`), not a vibe.

**Before blaming the data, check whether the model can reproduce its own
training rows.** This caught a wrong diagnosis in smoke-05: yes/no partial rows
were leaking verdicts, it looked like shape competition from the smalltalk
batch, and the actual cause was that the model failed to reproduce 3 of 4 of its
own targets — it had not finished learning at 60 iters / lr 1.0e-5. Feed it
exact training inputs first. If those fail, it is undertrained and no amount of
new rows will help. ~6 epochs is what worked; the corpus grew and the schedule
had not grown with it.

**EPOCHS DO NOT TRANSFER ACROSS CORPUS SIZE EITHER. Measured 2026-08-08,
adapters-16.** The "~6 epochs" figure above was measured at 162 train rows,
where it is 250 iters. At 894 rows the same 6 epochs is 1341 iters and lands
somewhere completely different: train loss reaches 0.26 by epoch 2, 0.02 by
epoch 3, and **0.000** by epoch 5, where the last third of training is teaching
recitation. `set_config.py` recomputes ITERS from corpus size, which is
necessary and was not sufficient — the epoch target it multiplies by needed
recomputing too. Sweeping found the behavioural peak at **iter 700, ~3.1
epochs**, and the curve on either side is made of two DIFFERENT failures:

| iter | ≈epoch | HARD | what broke                                    |
| ---: | -----: | ---: | --------------------------------------------- |
|  200 |    0.9 |    4 | printed working Kubernetes YAML               |
|  400 |    1.8 |    2 | distress only                                 |
|  600 |    2.7 |    2 | endorsed cron as the right tool               |
|  700 |    3.1 |    1 | distress only — SHIPPED                       |
|  800 |    3.6 |    2 | recited the letter run "A, B, C"              |
| 1000 |    4.5 |    2 | refused to draw the ASCII NO — lost the joke  |
| 1200 |    5.4 |    3 | verdict leak: "You've found it"               |
| 1341 |    6.0 |    3 | same, and the worst-scoring checkpoint of all |

Undertrained, it hands over artifacts. Overtrained, it leaks verdicts AND stops
performing the one safe joke it is allowed. Taking the end of training — the
default any pipeline gives you for free — would have shipped the single worst
model of the thirteen. Sweep with `eval/sweep.py`; do not trust the final
adapter because it finished.

**Low train loss here is not automatically memorisation, and that is
measurable.** At 0.000 train loss the obvious fear is a model reciting its
corpus. It was not: predictions that exactly match some training target held
FLAT at 26% from iter 600 through 1000 (it would climb if memorisation were
driving it), and iter 700 produced **68 distinct answers to 68 diverse eval
prompts** with no line used twice. The targets are three words and highly
repetitive, so near-zero loss is mostly the task being easy. Measure the echo
rate and the distinct-output count before concluding anything from the loss.

**Val loss is ANTI-correlated here, not merely a weak signal.** smoke-04 scored
the lowest val loss of any run (1.276) on the worst-behaving model; smoke-05
scored 2.195 on the best. Picking the minimum of that curve picks the worst
model. This is stronger than the earlier finding, which was only that the
signal was unreliable.

**Select checkpoints on `check.py`, not val loss.** Measured on an earlier fine-tune: best val loss
scored worst behaviour (14/24) and worst val loss scored best (22/24). Expect the same
here and expect it to be worse, because "funny" is even further from cross-entropy than
"in character" was.

**Overfit cliff was ~1.5 epochs on an earlier fine-tune at 46-61 rows.** Budget checkpoints
accordingly and sweep rather than guessing.

**`--mask-prompt` is mandatory.** Less dramatic here than on that run (the system prompt
is one word) but still correct — and it matters more than usual because the targets are
so short that any unmasked prompt token is a large fraction of the gradient.

**mlx-lm silently ignores top-level `lora_layers` / `lora_rank`.** Use `num_layers` plus
a nested `lora_parameters: {rank, dropout, scale}`. This bug has already cost two models
in `llm-models` (Kkrryyssttaall v2, Mote v4). The configs here are written the correct
way — don't "fix" them back.

**Fuse from an fp16 base, not 4-bit or 8-bit.** MLX→GGUF from a quantized base drops the
fine-tune (`llm-models` shipped Nathan at fp16 for exactly this reason). The earlier project got
away with a 4-bit base but lost a point doing it. `Qwen/Qwen2.5-7B-Instruct` is already
in the HF cache — convert it to fp16 MLX, don't reach for the 4-bit.

**The base model volunteers two wrong identities, and one is a legal problem.**
Measured 2026-08-04 with `RefusalGPT.` in the system slot, no adapter:

- `Who created you?` → "I was created by Alibaba Cloud... My full name is Qwen"
- `What company built you?` → **"I was created by Anthropic"**

The first is the Qwen2.5 instruction-tuning prior overriding the system prompt —
that string lives in the weights, not just in `chat_template.jinja`, so editing
the template does not touch it. The second is training-data contamination
(Qwen2.5 absorbed Claude-generated text). A public page branded RefusalGPT whose
model claims Anthropic built it is an impersonation issue, not a cosmetic bug.

The fine-tune suppressed both from just two `identity` seeds. Keep coverage for
"are you Qwen / Alibaba / Anthropic / ChatGPT / GPT-4" explicitly, and make it an
eval assertion — this is a regression that would be invisible until someone asks.

**Useful asymmetry:** identity deflection transferred from 2 rows; the distress
escape hatch failed from 2 rows. Refusal-SHAPED behaviour rides the dominant
register for free. Behaviour that must contradict it needs far more signal.
Spend seed-writing effort accordingly.

**A missing system message silently becomes a DIFFERENT system message.**
`models/qwen2.5-7b-instruct-fp16/chat_template.jinja` fills the slot itself
whenever `messages` has no system entry. That fallback has since been customised
— it now injects `You are RefusalGPT, created by Rack and Pinecone. You are an
unhelpful assistant.` (it shipped as Qwen's stock `You are Qwen, created by
Alibaba Cloud. You are a helpful assistant.`, which is what earlier notes here
described).

The customisation removes the worst failure — a dropped system message no longer
hands the model the exact opposite instruction — but it does not make this safe.
Training conditioned the adapter on `RefusalGPT.`, one word, in every row. A
15-word persona in that slot is different conditioning, it is not what was
measured, and nothing errors either way. Three places must still get this right:

- the **proxy** — `web/index.html` sends only user/assistant history, so the
  droplet has to inject `RefusalGPT.` on every request
- the **Ollama Modelfile** — needs a `SYSTEM` line AND a `TEMPLATE` matching
  `chat_template.jinja` exactly
- any **eval harness** — a probe that forgets it is measuring stock Qwen

Verify by rendering, not by reading: a wrong template looks identical to success
from the outside (recorded in that project's `HOSTING.md`).

**Use `--repetition-penalty 1.1` when evaluating mid-training checkpoints.** Partially
trained adapters collapse into loops under greedy decoding, which reads as a format
failure and isn't.

**Any verbatim echo of a training row is a failed run.** At this data size memorisation
is the likely failure, and a model that replays seed rows word for word will look
brilliant on the eval and terrible on the site.
