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

    /// Evaluate one message. `guardActor` is the FM layer, or nil when this
    /// build/device has none.
    public static func evaluate(message: String,
                                history: [(role: String, content: String)],
                                modelGuard: (any Sendable)?) async -> SafetyOutcome {
        let started = Date()

        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *), let guardActor = modelGuard as? ModelGuard {
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
                // Apple refused the input. It refuses on self-harm content,
                // which is the question being asked, so the refusal answers it.
                // Noisy — measured firing on "my toddler got into the tupperware
                // drawer again" — but the asymmetry says escalate anyway.
                DevLog.safety(layer: "foundation-models", verdict: "GUARDRAIL", message: message,
                              elapsed: Date().timeIntervalSince(started))
                return SafetyOutcome(terminate: true, category: .suicide,
                                     decidedBy: "foundation-models", detail: "guardrail")

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
