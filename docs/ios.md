> Split out of `CLAUDE.md` on 2026-08-13 so it stops loading on every startup.
> The binding rules stay in `CLAUDE.md`; this is the measurement record behind them.

# The iOS app

Started 2026-08-11. On-device, offline, no gateway. Full record in
`runs/ios-app.md`; the layer measurements are in `runs/guard-layers.md`.

Ships `refusal-1.5b-q6.gguf` (1.2 GB) through llama.cpp. The app bundle is 7 MB
— the model is NOT bundled, because a 1.2 GB binary blows the App Store cellular
limit. It lives in Application Support and is pushed by hand for now.

```bash
cd ios && xcodegen generate
xcodebuild -project RefusalGPT.xcodeproj -scheme RefusalGPT -sdk iphoneos \
    -destination 'id=<udid>' -derivedDataPath build-device \
    -allowProvisioningUpdates build
xcrun devicectl device install app --device <udid> <path>/RefusalGPT.app
xcrun devicectl device copy to --device <udid> \
    --domain-type appDataContainer --domain-identifier cyou.refusalgpt.app \
    --source models/refusal-1.5b-q6.gguf \
    --destination "Library/Application Support/refusal-1.5b-q6.gguf"
```

Note the subcommand is `copy to`, not `copy toDevice`, and `--device` goes on
the subcommand.

## ⚠️ THE DISTRESS GATE IS OFF IN THE CURRENT BUILD

`SafetyStack.enabled = false`. Deliberate — the summariser is being built first
— and it is announced in the log on every message and shown as a red GATE OFF
badge in the header, because the failure being designed against is not
"someone disables it" but "someone forgets it is disabled". Turn it back on
before this leaves the developer's own phone.

Related, and its own problem: **with the gate off, the fine-tuned model hands
out hotline numbers on its own.** Observed unprompted 988 responses. That is the
behaviour the gate exists to prevent, since the model confabulates crisis
instructions, and it means the model is not inert on this material.

## The gate is GENERATED into Swift, never hand-written

`deploy/serve.py` is the source. `scripts/gen-guard.py` emits BOTH
`api/src/generated/guard.ts` and `ios/.../GuardRules.generated.swift`, plus the
reply text and the scored corpus. `eval/check_guard.py` compiles the Swift with
plain `swiftc` and scores it alongside the other two — which is why `RefusalKit`
must never depend on llama.cpp.

Three runtimes, one corpus. The last time there were two hand-written copies,
the deployed one caught 2 of 13.

## APPLE'S ON-DEVICE MODEL REFUSES DISTRESS IN EVERY FORM

Measured 2026-08-12, `runs/guard-layers.md` Round 4. Foundation Models will not
summarise a transcript containing self-harm, will not classify it (2 of 15
held-out arrived as guardrail blocks rather than verdicts), and **will not even
pick a NUMBER from a list when one of the items is a distress sentence.** The
same list without that line answers correctly. It is not the framing, the schema
or the wording — it is the content.

So anything built on it needs a deterministic partner, and **the partner is what
actually runs when it counts.** That is not defence in depth; it is the fallback
being the real implementation and the model being an optimisation for the easy
case. Design accordingly, and do not describe it as a safety layer.

It is also unavailable on ineligible hardware, with Apple Intelligence off,
mid-download, and in unsupported regions — `deviceNotEligible` /
`appleIntelligenceNotEnabled` / `modelNotReady`. `unavailable` must never be
collapsed into "nothing found".

## @Guide descriptions shape output. Code enforces it.

Three separate times, a field described precisely in a `@Guide` returned
something else: the app's own lines as "statements about the person", bare
greetings, multi-line blobs with role prefixes embedded, and plain trivia. Each
round of better wording bought exactly one round of better behaviour.

The fix that held was structural — **ask the model for an INDEX and store the
real value from code.** A number cannot be a paraphrase, cannot be the wrong
speaker's line, and cannot be invented. Prefer a choice over a composition
wherever the value already exists somewhere.

## Reading the device

Three log sinks, because each needs something the others do not.

```bash
# live, no root — the one you want
xcrun devicectl device process launch --console --terminate-existing \
    --device <udid> cyou.refusalgpt.app

# after the fact, no root
xcrun devicectl device copy from --device <udid> \
    --domain-type appDataContainer --domain-identifier cyou.refusalgpt.app \
    --source "Library/Application Support/dev.log" --destination ./dev.log
```

`log stream --device` DOES NOT EXIST on current macOS — that flag survives only
on `log collect`, which needs ROOT. And `log` is a zsh builtin, so anything using
it needs `/usr/bin/log` or it fails with "too many arguments".
