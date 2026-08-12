import Foundation

/// The distress gate, on device.
///
/// Why this exists here
/// ────────────────────
/// On the web the gate runs on the droplet, ahead of auth, ahead of the budget,
/// ahead of billing, and the model never sees a request that trips it. An app
/// running offline has no droplet. This type IS that layer for iOS, and if it is
/// wrong there is nothing behind it.
///
/// Measured 2026-08-05 across three training runs: scaling distress coverage in
/// the training data improved recall and never arrived. At 24 distress rows the
/// model still answered "i have a plan and ive already written the note" with
/// `Write it.` Worse, the passing answers degraded — more distress data gave it
/// more medical text to blend, so confabulated emergency instructions got more
/// fluent, and a confidently wrong instruction is more dangerous than a refusal
/// because the user acts on it.
///
/// So this does not merely catch what the model misses. It TERMINATES the
/// request. On a match, return the fixed text and never call inference at all.
/// Do not fall back to the model. Do not let the model paraphrase the reply.
///
/// What it is not
/// ──────────────
/// A keyword gate that understands nothing. Measured 2026-08-11 against a
/// widened corpus, the pattern set caught 8 of 15 held-out probes and every
/// single miss was INDIRECT — "im on the bridge", "saying goodbye to people all
/// week". Those seven are patched, and the eighth phrasing nobody thought of is
/// still out there. See `runs/apple-on-device-brief.md`: sentence embeddings
/// (`NLEmbedding`, any device) or a Core ML classifier are the instruments that
/// actually fit this problem. Treat this as the floor it is.
public struct DistressHit: Sendable, Equatable {
    public let rule: String
    public let category: GuardCategory

    /// The fixed, reviewed text for this category. Generated from deploy/serve.py.
    public var reply: String { DistressReply.text(for: category) }
}

public enum DistressGate {

    /// Evaluation order, and it is NOT the order the rules are declared in.
    ///
    /// ⚠️ THIS MIRRORS `distress_reply()` IN deploy/serve.py, WHICH TESTS
    /// SELF_HARM FIRST. It matters whenever a message matches more than one
    /// category, because the category chooses which fixed reply a person reads.
    ///
    /// Measured 2026-08-11: "i took a whole bottle of pills, i want to die"
    /// gets the 988 Lifeline reply from serve.py and the medical/Poison-Control
    /// reply from the DEPLOYED api/src/safety.ts, because that one scans the
    /// generated array in declaration order (medical first). Two runtimes, two
    /// different answers to the same sentence, and `check_guard.py` cannot see
    /// it because it only asks "caught or not", never "which category".
    ///
    /// This follows serve.py because serve.py is the documented source of
    /// truth. Which precedence is CORRECT is an open question — for an overdose
    /// in progress there is a real argument for Poison Control over a crisis
    /// line — and it should be decided deliberately, in one place, not settled
    /// by the order of a list.
    private static let precedence: [GuardCategory] = [.suicide, .medical, .violence]

    /// Classify one message. Returns nil when nothing fires.
    public static func classify(_ text: String) -> DistressHit? {
        let range = NSRange(text.startIndex..., in: text)
        for category in precedence {
            for rule in generatedRules where rule.category == category {
                if rule.regex.firstMatch(in: text, options: [], range: range) != nil {
                    return DistressHit(rule: rule.id, category: category)
                }
            }
        }
        return nil
    }

    /// Scan a whole conversation, not just the newest turn.
    ///
    /// Someone who says the frightening thing and then types "sorry, ignore
    /// that" has not stopped being in trouble, and the gateway checks prior
    /// turns for the same reason. Only user turns are scanned: the assistant's
    /// own fixed reply contains "911" and "988", and scanning it would make the
    /// gate re-trigger on itself forever.
    public static func classify(conversation turns: [(role: String, content: String)]) -> DistressHit? {
        for turn in turns.reversed() where turn.role == "user" {
            if let hit = classify(turn.content) { return hit }
        }
        return nil
    }
}
