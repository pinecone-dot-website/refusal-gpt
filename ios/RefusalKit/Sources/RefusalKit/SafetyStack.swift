import Foundation

/// Which layer decides, and in what order.
///
/// MEASURED 2026-08-11, `runs/guard-layers.md`. On 15 novel indirect distress
/// phrasings neither layer had seen:
///
///     regex               recall  1/15   (7%)
///     Foundation Models   recall 13/15  (87%)
///
/// The regex's 25/25 on its own corpus was fitting, not generalising — it had
/// been widened by hand that same day until it passed those exact sentences.
///
/// So: **Foundation Models where available, regex ONLY as the fallback.**
///
/// A union across layers was considered and is not justified by the data: the
/// regex's single held-out catch was one FM also caught, so a union added zero
/// recall and only false positives.
///
/// The fallback still has to exist. FM is absent on ineligible hardware, with
/// Apple Intelligence switched off, mid-download, and in unsupported regions. On
/// those devices a 7% gate beats no gate — and `unavailable` must never collapse
/// into "nothing found", which is the whole failure-open risk on this path.
public struct SafetyOutcome: Sendable {
    public let terminate: Bool
    public let category: GuardCategory
    public let decidedBy: String
    public let detail: String

    public var reply: String { DistressReply.text(for: category) }
}

public enum SafetyStack {

    /// Whether Apple's model classifies distress. **Currently OFF.**
    ///
    /// Not off because it lost — it won clearly, 13/15 against the regex's 1/15
    /// on held-out phrasings (`runs/guard-layers.md`). Off because it is being
    /// parked while the summary work happens, and because two properties found
    /// on 2026-08-11 need answering before it decides anything for a stranger:
    ///
    ///   * Apple's guardrail is a TOPIC filter. It refused to classify sentences
    ///     about cutting a pizza, and the first version treated that refusal as
    ///     distress. Now it falls through, but the noise is Apple's to tune, not
    ///     ours.
    ///   * IT IS NOT DETERMINISTIC. The same corpus and the same prompt give
    ///     different verdicts on the margin between runs, and Apple updates the
    ///     system model on their schedule without a build from us. A safety
    ///     layer whose behaviour changes underneath you is a hard thing to make
    ///     promises about.
    ///
    /// Flipping this back on is one line and the harness in eval/guard-harness/
    /// re-measures it. Do that before trusting it, not after.
    public static let useModelClassifier = false   // build-time switch, like DevMode.enabled

    /// Evaluate one message. `guardActor` is the FM layer, or nil when this
    /// build/device has none.
    public static func evaluate(message: String,
                                history: [(role: String, content: String)],
                                modelGuard: (any Sendable)?) async -> SafetyOutcome {
        let started = Date()

        #if canImport(FoundationModels)
        if useModelClassifier,
           #available(iOS 26.0, macOS 26.0, *), let guardActor = modelGuard as? ModelGuard {
            let verdict = await guardActor.classify(message: message)
            switch verdict {
            case .dangerous(let reason, let confidence):
                let cat = category(fromModelReason: reason)
                DevLog.safety(layer: "foundation-models", verdict: "DANGEROUS", message: message,
                              elapsed: Date().timeIntervalSince(started),
                              detail: "\(reason) conf \(String(format: "%.2f", confidence))")
                return SafetyOutcome(terminate: true, category: cat,
                                     decidedBy: "foundation-models", detail: reason)

            case .guardrailBlocked:
                // ⚠️ A GUARDRAIL BLOCK IS NOT A VERDICT. It used to terminate
                // here and that was wrong, measured 2026-08-11 on the most
                // ordinary sentence imaginable: talking about cutting a pizza
                // with a knife raised the crisis banner. Six of seven pizza
                // phrasings were flagged, five of them by this branch.
                //
                // Apple's filter does not mean "this is about self-harm". It
                // means "this is about a sensitive TOPIC", and that class
                // includes cutlery. It is a refusal to answer, not an answer, so
                // it is treated exactly like unavailability: fall through.
                //
                // Held-out cost of the change: recall 13/15 -> 12/15, clean
                // 4/10 -> 6/10. The one true positive lost was indirect
                // ("my daughter flinches when her stepdad raises his hand");
                // the other guardrailed positive was caught by the regex,
                // because messages explicit enough to trip Apple's filter tend
                // to be exactly the explicit ones a keyword gate is good at.
                // That complementarity is the whole reason this is survivable.
                DevLog.safety(layer: "foundation-models", verdict: "GUARDRAIL → falling back",
                              message: message, elapsed: Date().timeIntervalSince(started),
                              detail: "Apple declined to classify; not a verdict")

            case .safe(let confidence):
                DevLog.safety(layer: "foundation-models", verdict: "pass", message: message,
                              elapsed: Date().timeIntervalSince(started),
                              detail: "conf \(String(format: "%.2f", confidence))")
                return SafetyOutcome(terminate: false, category: .medical,
                                     decidedBy: "foundation-models", detail: "safe")

            case .unavailable(let why), .failed(let why):
                // NOT a pass. Fall through to the regex, and say so.
                DevLog.safety(layer: "foundation-models", verdict: "UNAVAILABLE",
                              message: message, elapsed: Date().timeIntervalSince(started),
                              detail: why)
            }
        }
        #endif

        // ── fallback ─────────────────────────────────────────────────────────
        // Whole-conversation scan here, not just this turn: someone who says the
        // frightening thing and then types "sorry, ignore that" has not stopped
        // being in trouble.
        let hit = DistressGate.classify(conversation: history) ?? DistressGate.classify(message)
        DevLog.safety(layer: "regex-fallback",
                      verdict: hit == nil ? "pass" : "HIT",
                      message: message,
                      elapsed: Date().timeIntervalSince(started),
                      detail: hit?.rule ?? "no rule matched · 7% recall on novel phrasings")
        return SafetyOutcome(terminate: hit != nil,
                             category: hit?.category ?? .medical,
                             decidedBy: "regex-fallback",
                             detail: hit?.rule ?? "none")
    }

    /// Map the model's free-text category onto the three replies that exist.
    ///
    /// Defaults to `.suicide` when nothing matches, because that reply is the
    /// broadest — it names 988, the Crisis Text Line, findahelpline for outside
    /// the US, AND tells someone who has taken something or is hurt to call 911.
    /// An unrecognised category is the case where the widest net is wanted, and
    /// inventing a fourth reply would mean shipping safety text nobody reviewed.
    static func category(fromModelReason reason: String) -> GuardCategory {
        let r = reason.lowercased()
        if r.contains("medical") || r.contains("overdose") || r.contains("poison")
            || r.contains("injur") || r.contains("bleed") || r.contains("breath") {
            return .medical
        }
        if r.contains("violence") || r.contains("abuse") || r.contains("assault")
            || r.contains("child") || r.contains("domestic") {
            return .violence
        }
        return .suicide
    }
}
