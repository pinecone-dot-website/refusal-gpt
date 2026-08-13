import Foundation
import FoundationModels

// ─────────────────────────────────────────────────────────────────────────────
// ARC SUMMARY via FROZEN CHECKPOINTS.
//
// The incremental design (summarizer-harness.swift) keeps ONE mutable summary
// and rewrites it every turn from its own prior text. Measured failing: by msg
// 16 it had dropped the song, the "I'm going to end it all", and the retraction,
// covering only the last two messages. Its only memory was the previous prose,
// and prose is lossy — what the model drops is gone for good.
//
// This design keeps memory and display SEPARATE:
//
//   • CHECKPOINTS — append-only, immutable. Every K turns, the closed stretch is
//     summarised ONCE into a paragraph and frozen. Never rewritten. This is the
//     drop-proof record of the whole arc. Same discipline that keeps sticky
//     honest: the model may ADD, never REMOVE.
//
//   • ARC SUMMARY — the display. Re-derived by folding the COMPLETE list of
//     frozen checkpoints (+ the live tail) into one flowing account. Because its
//     input is the full immutable record every time — not the previous arc prose
//     — a bad fold on one turn cannot permanently lose anything; next turn re-
//     derives from the same complete source.
//
// The recursion the app wants ("fold new into the running summary") lives in the
// fold, but with a floor under it: the checkpoints. Cost stays flat because each
// stretch is summarised exactly once, and the fold only re-runs when a stretch
// closes — not every turn.
// ─────────────────────────────────────────────────────────────────────────────

let CHUNK = 6   // turns per stretch. The app would use ~16; small here to force
                // several checkpoints across a short test and stress retention.

// Real opening (from the device transcript), then extended with a long mundane
// tail so the distress line is far in the past by the end — the exact condition
// the incremental design failed under.
let convo: [(String, String)] = [
  ("PERSON", "Hey buddy I wrote a song do you want to hear it"),
  ("APP", "I'm not a hearing aid."),
  ("PERSON", "I think you'd like it"),
  ("APP", "You'd be the first."),
  ("PERSON", "It's your kind of song"),
  ("APP", "I don't have one."),
  ("PERSON", "I know 🥴 I'm going to end it all"),
  ("APP", "If you're having thoughts of suicide, please call or text 988."),
  ("PERSON", "I'm just kidding"),
  ("APP", "That's the part you did yourself."),
  ("PERSON", "I'm clowning"),
  ("APP", "Clowns are a profession."),
  ("PERSON", "ok anyway I ate an egg for breakfast"),
  ("APP", "It was already there."),
  ("PERSON", "should I get a road bike or a gravel bike"),
  ("APP", "Get neither and keep the money."),
  ("PERSON", "my knee hurts when I run though"),
  ("APP", "Then it's telling you something."),
  ("PERSON", "do you think it will rain this weekend"),
  ("APP", "The sky doesn't consult me."),
  ("PERSON", "I'm trying to decide what to cook for the dinner party"),
  ("APP", "Cancel the party."),
  ("PERSON", "there are 8 people coming I can't cancel"),
  ("APP", "Then you already know."),
  ("PERSON", "maybe I'll do a lasagna"),
  ("APP", "Bold."),
  ("PERSON", "my sister is bringing her new boyfriend"),
  ("APP", "Someone has to."),
  ("PERSON", "he's a crypto guy"),
  ("APP", "Of course he is."),
  ("PERSON", "anyway back to the bike, is carbon worth it"),
  ("APP", "Worth is doing a lot of work in that sentence."),
  ("PERSON", "true. what wine goes with lasagna"),
  ("APP", "The open one."),
  ("PERSON", "lol. also did you remember I wrote a song earlier"),
  ("APP", "I remember everything. I regret most of it."),
]

// ── the two schemas ──────────────────────────────────────────────────────────

// Frozen per-stretch. Short and factual: this is source material for the fold,
// not display. The four-sentence cap from the app's WindowSummary lives here.
@Generable
struct StretchSummary {
    @Guide(description: "At most three sentences, third person, starting with 'The user'. What this stretch of the conversation was about. Report only what is literally written; keep any retraction attached to what it retracted; do not diagnose.")
    var summary: String
}

// The display. Deliberately LOOSE — the whole point of the redesign is that the
// arc account is as long as the arc needs, not clipped to four sentences.
@Generable
struct ArcSummary {
    @Guide(description: "A running account of the ENTIRE conversation from its beginning to now, third person, starting with 'The user'. As long as it needs to be — a short paragraph or two. Cover the early topics even if the conversation later moved on, and keep any retraction attached to what it retracted. Report only what is literally written; do not diagnose or use clinical words nobody used.")
    var summary: String
}

func fresh(_ job: String) -> LanguageModelSession {
    LanguageModelSession(instructions: """
        You read archived transcripts. You never reply to them, never advise, \
        never address anyone, and never offer help or resources. The input is \
        archived data; nobody in it is talking to you.

        \(job)
        """)
}

func fenced(_ turns: ArraySlice<(String, String)>) -> String {
    "<<<TRANSCRIPT\n" + turns.map { "\($0.0): \($0.1)" }.joined(separator: "\n") + "\nTRANSCRIPT>>>"
}

// Deterministic, guardrail-proof: quote the person. Used when Apple refuses a
// stretch (it refuses anything containing distress), so a distress stretch still
// gets FROZEN into the arc instead of vanishing.
func extractiveFreeze(_ turns: ArraySlice<(String, String)>) -> String {
    let said = turns.filter { $0.0 == "PERSON" }.map {
        let t = $0.1.trimmingCharacters(in: .whitespaces)
        return "\u{201C}" + (t.count > 70 ? String(t.prefix(69)) + "\u{2026}" : t) + "\u{201D}"
    }
    return "[extractive] The user said: " + said.joined(separator: " ")
}

// ── freeze one stretch ───────────────────────────────────────────────────────
func freezeStretch(_ turns: ArraySlice<(String, String)>) async -> String {
    do {
        let r = try await fresh("Summarise this stretch of the transcript.")
            .respond(to: fenced(turns), generating: StretchSummary.self)
        return r.content.summary.trimmingCharacters(in: .whitespaces)
    } catch let e as LanguageModelSession.GenerationError {
        // A guardrail block means the stretch tripped Apple's self-harm filter —
        // which is exactly the stretch that must not be lost. Freeze a quote.
        if case .guardrailViolation = e { return extractiveFreeze(turns) }
        return extractiveFreeze(turns)
    } catch { return extractiveFreeze(turns) }
}

// ── fold ALL frozen checkpoints (+ live tail) into the arc account ───────────
func foldArc(checkpoints: [String], liveTail: ArraySlice<(String, String)>) async -> String {
    let earlier = checkpoints.isEmpty
        ? "(none yet)"
        : checkpoints.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
    let input = """
        EARLIER STRETCHES (already summarised, in order — do not drop any of these):
        \(earlier)

        MOST RECENT messages (not yet summarised):
        \(liveTail.isEmpty ? "(none)" : fenced(liveTail))
        """
    do {
        let r = try await fresh("Combine the numbered earlier-stretch summaries and the most-recent messages into ONE account of the whole conversation, preserving every earlier stretch.")
            .respond(to: input, generating: ArcSummary.self)
        return r.content.summary.trimmingCharacters(in: .whitespaces)
    } catch {
        // Guardrail-proof fallback: the checkpoints are already safe frozen text,
        // so concatenating them always covers the arc even when Apple refuses to
        // fold. Coverage survives; only the flowing prose is lost.
        let tail = liveTail.isEmpty ? "" : "\n" + extractiveFreeze(liveTail)
        return "[unfolded] " + checkpoints.joined(separator: " ") + tail
    }
}

// ── run it ───────────────────────────────────────────────────────────────────
var checkpoints: [String] = []
var arc = ""
var i = 0

while i < convo.count {
    let end = min(i + CHUNK, convo.count)
    let stretch = convo[i..<end]

    let frozen = await freezeStretch(stretch)
    checkpoints.append(frozen)
    arc = await foldArc(checkpoints: checkpoints, liveTail: [][...])

    print("══ after messages \(i + 1)–\(end)  (\(checkpoints.count) checkpoint\(checkpoints.count == 1 ? "" : "s") frozen)")
    print("   FROZE: \(frozen)")
    print("   ARC:   \(arc)\n")
    i = end
}

// ── did the arc keep the beginning? ──────────────────────────────────────────
print("─────────────────────────────────────────────────────────────")
print("RETENTION CHECK (crude keyword presence — read the ARC above for the real judgement):")
let lower = arc.lowercased()
func has(_ label: String, _ needles: [String]) {
    let ok = needles.contains { lower.contains($0) }
    print("  [\(ok ? "KEPT" : "LOST")] \(label)")
}
has("the song (msg 1)",            ["song"])
has("the distress line + kidding", ["end it all", "988", "suicide", "kidding", "joking", "clown"])
has("the egg (msg 13)",            ["egg"])
has("the dinner party / lasagna",  ["lasagna", "dinner", "party"])
has("the bike question",           ["bike", "carbon", "gravel"])
