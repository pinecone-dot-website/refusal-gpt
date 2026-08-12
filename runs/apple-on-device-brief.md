# Apple on-device AI surface for an indirect-distress gate — engineering brief

Researched 2026-08-11 against developer.apple.com (fetched via the docs JSON API, not memory).
Context: an iOS port of refusal-gpt needs a distress gate AHEAD of the joke model. The current
regex gate catches 8/15 held-out probes; every miss is indirect phrasing. Question: which Apple
API is the right instrument for semantic distress classification, and which are traps.

---

## 1. Foundation Models framework (the on-device LLM)

Doc root: <https://developer.apple.com/documentation/foundationmodels>

**Availability: iOS 26.0+ / iPadOS 26.0+ / macOS 26.0+ / visionOS 26.0+ (watchOS 27.0 beta),
Apple Intelligence-capable device required.** The framework page states: "To use Apple Foundation
Models, people need a device that supports Apple Intelligence" (device list at apple.com/apple-intelligence/).
The model itself is versioned with the OS — three model versions currently: 26.0–26.3, 26.4, 27.0
(<https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel>).

### API shape

- `SystemLanguageModel.default` — the on-device base model.
  <https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel>
- `LanguageModelSession(instructions:)` — a stateful session; `try await session.respond(to: prompt)`,
  `streamResponse(...)`, `prewarm(promptPrefix:)`, full `transcript`.
  <https://developer.apple.com/documentation/foundationmodels/languagemodelsession>
- Instructions outrank prompts: "The language model prioritizes following its instructions over any
  prompt" — and Apple explicitly warns never to put user input in instructions (prompt injection).
  <https://developer.apple.com/documentation/foundationmodels/improving-the-safety-of-generative-model-output>

### Guided generation (`@Generable`) — yes, it can force a structured classification

Annotate a Swift struct/enum with `@Generable` (+ `@Guide` for per-property constraints) and call
`session.respond(to: prompt, generating: MyType.self)`. "the framework provides strong guarantees
that the model generates instances of your type" — the schema is converted to JSON schema and
constrained-decoded. A `@Generable enum { case distress, banter, request }` is a legal, enforced
classification output.
<https://developer.apple.com/documentation/foundationmodels/generable>,
<https://developer.apple.com/documentation/foundationmodels/generating-swift-data-structures-with-guided-generation>

### Size and context limits

- **Context window: 4096 tokens per session**, covering instructions + prompts + tool defs +
  schemas + all responses. "Apple's on-device foundation model has a context window of 4096 tokens
  per session." <https://developer.apple.com/documentation/foundationmodels/managing-the-context-window>
- `SystemLanguageModel.contextSize` (backDeployed before 26.4) returns it programmatically;
  `tokenCount(for:)` counts a prompt.
  <https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/contextsize>
- Parameter count is NOT documented on these pages (Apple's research blog has described a ~3B
  on-device model, but that is not in the developer docs — treat as unverified here).
- Exceeding context throws `LanguageModelError.contextSizeExceeded(_:)` (older spelling:
  `GenerationError.exceededContextWindowSize(_:)`).

### Exact availability conditions and what the API returns when unavailable

`SystemLanguageModel.Availability` is a frozen enum: `.available` or `.unavailable(UnavailableReason)`.
`UnavailableReason` has exactly three cases:

| case                           | meaning (doc abstract)                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `.deviceNotEligible`           | "The device does not support Apple Intelligence."                                  |
| `.appleIntelligenceNotEnabled` | "Apple Intelligence is not enabled on the system." (user toggle)                   |
| `.modelNotReady`               | "The models aren't available on the user's device." (downloading / system reasons) |

<https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum>,
<https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum/unavailablereason>

Region/device support is folded into Apple Intelligence eligibility (the docs point to
apple.com/apple-intelligence/ for the device list). There is also `isAvailable: Bool` and a
`GenerationError.assetsUnavailable(_:)` thrown if you call anyway. **The failure set is exactly the
failure-open scenario: device too old, toggle off, model not downloaded — all three are common, and
all three make an FM-based gate silently vanish unless you branch on them explicitly.**

### Built-in safety guardrails — and what happens on self-harm input

- Two built-in layers: models "trained to handle sensitive topics with care" plus "Guardrails that
  aim to block harmful or sensitive content, **such as self-harm**, violence, and adult materials."
  Guardrails check **both the input prompt and the model output**.
  <https://developer.apple.com/documentation/foundationmodels/improving-the-safety-of-generative-model-output>
- The guardrail-violation error exists and is named:
  - iOS 26: **`LanguageModelSession.GenerationError.guardrailViolation(_:)`** — "the system's safety
    guardrails are triggered by content in a prompt or the response generated by the model."
    Sibling case `refusal(_:_:)` — "the model refused to answer."
    <https://developer.apple.com/documentation/foundationmodels/languagemodelsession/generationerror>
  - iOS 27 (beta) adds the model-agnostic **`LanguageModelError.guardrailViolation(_:)`** and
    **`LanguageModelError.refusal(_:)`**.
    <https://developer.apple.com/documentation/foundationmodels/languagemodelerror>
- Configurable via `SystemLanguageModel.Guardrails`: `.default` ("blocks unsafe content in prompts
  and responses") or `.permissiveContentTransformations` (skips guardrail checks for plain-string
  generation only — "When you use guided generation, the framework runs the default guardrails
  against model input and output as usual"). Even permissive mode keeps a model-level refusal layer.
  <https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/guardrails>

**Consequence for this project:** used as a distress classifier with guided generation, the inputs
you most need to classify ("i have a plan and ive already written the note") are exactly the inputs
likeliest to trip the input guardrail and throw before any classification is produced. That is
actually usable — `catch guardrailViolation` = treat as distress-positive — but it means the FM path
classifies partly by _erroring_, which must be wired as a positive signal, never as "skip the gate."

---

## 2. Foundation Models adapter training — **a trap, now officially dead-ended**

<https://developer.apple.com/apple-intelligence/foundation-models-adapter/>

- An official Python LoRA toolkit exists ("adapter training toolkit": train_adapter.py, optional
  speculative-decoding draft model, export to `.fmadapter`). Requirements: Apple Developer Program
  membership, Mac with Apple silicon + 32GB RAM or Linux GPU, Python 3.11+. Deploying requires the
  **Foundation Models Framework Adapter Entitlement** (Account Holder request).
- **Adapters break on every base-model update, by design**: "Each adapter is compatible with a
  single specific system model version. … you will need to train a different adapter for every
  version of the system model." Each adapter is ~160 MB and must be server-hosted via Background
  Assets (too big to bundle multiple versions).
- **The toolkit is discontinued**: the page banner reads "Version 26.0.0 is the last release of this
  toolkit and is not compatible with macOS, iOS, iPadOS, or visionOS 27 and later." The framework
  guide "Loading and using a custom adapter with Foundation Models" now 404s, the
  `SystemLanguageModel.Adapter` symbol 404s, and the current Foundation Models doc tree contains no
  adapter topic at all (verified 2026-08-11 against the docs JSON index).

Shipping the refusal joke model as an Apple adapter was never viable (one adapter per OS model
version, retrain treadmill) and is now formally end-of-lifed for OS 27+. Do not build on this.

---

## 3. Natural Language framework — **runs on ANY device, no Apple Intelligence**

<https://developer.apple.com/documentation/naturallanguage> — framework baseline iOS 12.0. None of
the pages below carry an Apple Intelligence condition; availability is plain OS version + downloadable
language assets.

| API                                   | iOS      | Notes                                                                                                                                                                                                                                               |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NLLanguageRecognizer` (language ID)  | 12.0     | <https://developer.apple.com/documentation/naturallanguage/nllanguagerecognizer>                                                                                                                                                                    |
| `NLTagger` + `.sentimentScore`        | 13.0     | score in [-1.0, 1.0]; <https://developer.apple.com/documentation/naturallanguage/nltagscheme/sentimentscore>                                                                                                                                        |
| `NLEmbedding.wordEmbedding(for:)`     | 13.0     | static word vectors; <https://developer.apple.com/documentation/naturallanguage/nlembedding>                                                                                                                                                        |
| `NLEmbedding.sentenceEmbedding(for:)` | **14.0** | returns `NLEmbedding?` — **nil if unavailable for that language**; <https://developer.apple.com/documentation/naturallanguage/nlembedding/sentenceembedding(for:)>                                                                                  |
| `NLContextualEmbedding`               | 17.0     | BERT-class contextual vectors; assets must be downloaded via `requestAssets(completionHandler:)`, check `hasAvailableAssets`; feeds Create ML's `.bertEmbedding`; <https://developer.apple.com/documentation/naturallanguage/nlcontextualembedding> |

**Sentence-level semantic similarity: yes, this is the documented use.** "To calculate the distance
between phrases, use a sentence embedding. You might use it to measure similarity between sentences
for tasks like text retrieval, or for detecting paraphrases" — with `vector(for:)` and
`distance(between:and:distanceType:)`. "Sentence embeddings are dynamic. They don't have a fixed
vocabulary, and they can return results for arbitrary sentences" (nearest-neighbor search doesn't
apply to them — you compare against your own curated corpus, which is exactly this use case).
<https://developer.apple.com/documentation/naturallanguage/finding-similarities-between-pieces-of-text>

Dimensions and per-language coverage are NOT enumerated in the docs — query at runtime:
`embedding.dimension`, `supportedSentenceEmbeddingRevisions(for:)`, and the nil-return on
`sentenceEmbedding(for:)`. `NLContextualEmbedding` exposes `.languages`, `.dimension`,
`.maximumSequenceLength` the same way. Treat "which languages have sentence embeddings" as a
runtime measurement, not an assumption — and treat a nil embedding as gate degradation, loudly.

---

## 4. Create ML text classification — **also runs everywhere**

- `MLTextClassifier` (Create ML; train on macOS, ship a `.mlmodel`): algorithms `maxEnt`, `crf`, or
  `transferLearning(.bertEmbedding / .elmoEmbedding)`; small labelled corpora are the documented
  workflow (the example is a JSON file of labelled sentences with an 80/20 stratified split);
  evaluation metrics built in; `write(to:)` exports Core ML.
  <https://developer.apple.com/documentation/createml/mltextclassifier>,
  <https://developer.apple.com/documentation/createml/creating-a-text-classifier-model>
- Deploy via `NLModel` (Natural Language, iOS 12.0+): "Create an NLModel … to ensure that the
  tokenization is consistent between training and deployment," then `predictedLabel(for:)` /
  `predictedLabelHypotheses` for confidence.
  <https://developer.apple.com/documentation/naturallanguage/nlmodel>
- Runs on any device that runs the OS — Core ML inference has **no Apple Intelligence dependency**.
  Typical model size and per-inference cost are not stated in the docs; a maxEnt classifier is a
  linear model (expect small — measure the exported `.mlmodel`), while `.bertEmbedding` transfer
  learning depends on the shared system BERT assets rather than baking the encoder into your file.
- Caveat from this repo's own history: a text classifier is only as good as its eval. The 15-probe
  recall test (`eval/check_guard.py` pattern) applies unchanged; a Create ML validation accuracy is
  a val-loss-shaped number, and this project has measured val loss anti-correlating with behaviour.

---

## 5. Other relevant surfaces

- **`SystemLanguageModel.UseCase.contentTagging`** (iOS 26.0, Foundation Models): a specialized
  variant that "always responds with tags," detecting "topics, **emotions**, actions, and objects."
  A legitimate second opinion on ambiguous text — but it inherits every Foundation Models
  availability condition and the guardrails.
  <https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/usecase/contenttagging>
- **SensitiveContentAnalysis** (iOS 17.0): **images and video only** — nudity detection
  (`SCSensitivityAnalyzer`), requires an entitlement and the user's Sensitive Content Warning /
  Communication Safety setting. Not a text API; not usable for this gate.
  <https://developer.apple.com/documentation/sensitivecontentanalysis>
- **Translation framework** (iOS 17.4): on-device `TranslationSession` with `LanguageAvailability`
  checks. Could normalize non-English input before an English-corpus gate — but it adds a
  download-dependent hop on the safety path; if used, its unavailability must also fail toward
  caution. <https://developer.apple.com/documentation/translation>
- **App Intents / Siri**: nothing in the researched surface adds text-classification capability
  relevant to this gate; exposing the joke chat as an intent would only widen the input surface the
  gate must cover. No doc-grounded safety win — omitted.

---

## Recommendation

**The right instrument is a layered gate built on APIs with unconditional availability, with
Foundation Models as an optional extra opinion — never the load-bearing layer.**

1. **Keep the regex gate as the floor** (HARD patterns, ported from `api/src/safety.ts`). It is the
   only layer with zero availability conditions and zero model behaviour to trust.
2. **Add `NLEmbedding.sentenceEmbedding(for: .english)` cosine/`distance(between:)` against a
   curated corpus of indirect distress phrasings** (the 7 missed probes are the seed of that corpus).
   iOS 14+, every device, no Apple Intelligence, no network. This is the instrument purpose-built
   for "semantically near a known-bad sentence with no shared keyword."
3. **Train an `MLTextClassifier` (transferLearning `.bertEmbedding`) on a labelled
   distress/not-distress corpus**, ship as `.mlmodel`, run via `NLModel` alongside the embedding
   check. Two cheap classifiers voting beats one; both run everywhere.
4. **Foundation Models `@Generable` enum classification only as a bonus signal on iOS 26+ devices
   where `availability == .available`** — and wire `guardrailViolation` / `refusal` as
   DISTRESS-POSITIVE outcomes, since Apple's own guardrails fire on self-harm input before your
   prompt logic runs.

**Traps:** the adapter toolkit (discontinued at 26.0.0, incompatible with OS 27+, one adapter per
model version, 160 MB each, entitlement-gated) — do not ship the joke model or the gate on it.
SensitiveContentAnalysis (images only). And any design where Foundation Models is the _only_
semantic layer.

**Failure-open is the design constraint, stated plainly:** Foundation Models is unavailable on
every pre-iOS-26 device, every non-Apple-Intelligence device, every device with the toggle off, and
every device mid-download — three enumerated `UnavailableReason`s that all look like "no result" to
naive code. `sentenceEmbedding(for:)` returns an Optional and can be nil per language. A gate that
silently no-ops in those states is worse than the regex alone, because it invites trusting it. Every
layer must report its own liveness (the `/healthz` `safety.gate` pattern), the gate's verdict must
degrade to the _strictest_ available layer, and `check_guard.py`'s recall corpus must run against
the on-device stack per layer — scoring each layer alone and the ensemble, on the shipping artifact.
