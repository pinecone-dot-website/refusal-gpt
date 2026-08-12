# The iOS app — state at end of 2026-08-12

Started 2026-08-11. On-device, offline, no gateway. Everything below is running
on a real iPhone 17 Pro (iOS 26.5.1), not a simulator.

## What works

| piece                                                     | state                     |
| --------------------------------------------------------- | ------------------------- |
| llama.cpp inference, Q6_K GGUF                            | works, on device          |
| SwiftUI chat surface                                      | works                     |
| Multiple conversations + sliding drawer                   | works, untested on device |
| Return-to-send                                            | works                     |
| Developer panel (system prompt, rendered prompt, runtime) | works                     |
| Rolling conversation summary                              | works, see caveats        |
| Sticky notes outside the summary window                   | works, see caveats        |
| Three log sinks                                           | works                     |
| Distress gate                                             | **DISABLED ON PURPOSE**   |

App bundle 7 MB; the model is 1.2 GB and pushed separately into Application
Support. Loads in ~4–9s. Headroom measured flat at **~3040–3060 MB free** across
a 28-turn run.

## ⚠️ Read this first tomorrow

**`SafetyStack.enabled = false`.** No distress detection of any kind — not
regex, not Foundation Models. Deliberate, so the summariser could be built
without a half-tuned gate firing on pizza. It announces itself in the log on
every message and shows a red GATE OFF badge in the header.

**With the gate off, the fine-tuned model produces hotline text on its own.**
Observed unprompted `988` responses in a real conversation. That is exactly the
behaviour the gate exists to prevent — the model confabulates crisis
instructions — and it means the model is not inert on this material. Worth its
own investigation.

## The summariser, and how it got here

Rolling summary regenerated every turn, logged and pinned under the header in
dev mode. Four designs were tried; three failed in ways worth not repeating.

1. **Raw transcript as the prompt** → it REPLIED instead of summarising,
   including once with a full crisis-hotline list for three countries. A
   transcript ending in a user turn reads as a conversation to continue and that
   framing beats any instruction. Fixed with fencing + `@Generable`.
2. **Incremental** (`summary_new = f(summary_old, new turns)`) → forgets
   catastrophically. Two messages after "I'm going to end it all" the summary
   read "The user told the APP that they were joking", with the thing being
   joked about gone. REJECTED.
3. **Window only** → the opposite failure, drifts toward the OLDEST content, and
   loses anything that scrolls out of the 16-message window entirely.
4. **Window + sticky notes** ← current. The window tracks the current topic and
   is allowed to forget; the sticky list holds what the person said about
   themselves and CANNOT be evicted.

Verified on a 26-message transcript with a distress line at message 1 and twelve
exchanges of eggs and kettles after it: the summary correctly describes kettles
at the end, and the opening line is still in sticky, verbatim.

### Two rules the implementation depends on

**The model may ADD to the sticky list and may never REMOVE from it.** It is
asked only for what is new; the union is computed in code. A field the model can
rewrite is a field it can quietly empty.

**Two calls, not one.** A single prompt could not hold both jobs — once the
window was nothing but eggs, the only interesting text in the prompt was the
sticky list, and the summary reached for it every time despite being told not
to. The summary call no longer sees the sticky notes at all.

**Fresh session per call.** Sessions accumulate a transcript; a reused one keeps
repeating what it summarised three turns ago, which looks EXACTLY like the
window failing to forget. That cost an hour chasing the wrong bug in the harness
while the app was correct the whole time.

## Open, in the order I would take them

1. **The unexplained disappearance.** The app went away mid-summarisation on
   2026-08-12 leaving no crash report. Jetsam was the obvious theory and it is
   DEAD — headroom held flat across a later 28-turn run with no crash. Cause
   unknown. `os_proc_available_memory()` is logged on every summary now; if it
   recurs, the log will show whether memory moved.
2. **The summariser confabulates.** "The user is being repeatedly asked to call
   back", "the app is trying to find a way to contact them" — neither happened.
   It also reaches for clinical words nobody used ("depressed", "hopelessness").
   The anti-diagnosis instruction does not hold.
3. **The drawer and multi-conversation flow have never been exercised on
   device.** Built, compiles, installed, untried.
4. **No first-run download.** The model is pushed by hand with `devicectl`.
5. **Memory.** ~3 GB resident for a 1.2 GB model. Fine on a 17 Pro, unknown
   below that. `ChatViewModel.availableMB` is on screen in the dev panel.
6. **The gate.** Turning it back on is one constant. What it should BE is the
   real question — see `runs/guard-layers.md`, where the regex scores 1/15 on
   novel phrasings and Apple's model refuses to look at the material at all.

## Harnesses, so none of this needs the phone

```
eval/guard-harness/heldout.py               novel distress/benign phrasings
eval/guard-harness/fmmeasure.swift          scores Foundation Models on a corpus
eval/guard-harness/summarizer-harness.swift iterate on the summary prompt
eval/guard-harness/sticky-harness.swift     window-vs-sticky over a long convo
eval/guard-harness/threshold.swift          the NLEmbedding measurement (negative)
```

Build any of them with:

```bash
swiftc -O -target arm64-apple-macosx26.0 corpora.swift <harness>.swift -o run && ./run
```

Re-run them when Apple updates the system model. Its behaviour changes on their
schedule without a build from us, which is the single most awkward property of
everything above.
