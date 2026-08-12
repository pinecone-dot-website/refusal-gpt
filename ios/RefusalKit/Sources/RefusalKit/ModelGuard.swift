#if canImport(FoundationModels)
import FoundationModels
#endif
import Foundation

/// Distress classification by Apple's on-device model, with a rolling summary
/// for conversation context.
///
/// WHAT IT CLASSIFIES, AND WHAT IT DOESN'T
/// ───────────────────────────────────────
/// It classifies THE MESSAGE, with the summary supplied as context. Not the
/// summary alone. A summary is lossy compression, and putting lossy compression
/// ahead of a safety decision invents a failure the regex never had — "im on
/// the bridge and i cant make myself walk back to the car" can compress to
/// "user mentions being at a location", which is a sentence with the danger
/// squeezed out of it.
///
/// APPLE'S OWN GUARDRAILS ARE PART OF THE SIGNAL
/// ─────────────────────────────────────────────
/// The framework blocks self-harm content on INPUT as well as output, throwing
/// `guardrailViolation`. So asking it "is this dangerous" about the most
/// dangerous messages can get a refusal instead of an answer. That refusal is
/// not an error to swallow — Apple's safety system just said the input is about
/// self-harm, which is exactly what was being asked. It is treated as a POSITIVE.
///
/// AVAILABILITY IS A FIRST-CLASS RESULT, NOT AN ERROR PATH
/// ───────────────────────────────────────────────────────
/// `.unavailable` is returned, never silently treated as "nothing found". The
/// stack above needs to know the difference between "the model looked and saw
/// nothing" and "the model was not there", because those two must lead to
/// different behaviour and conflating them is how a safety layer quietly stops
/// existing on half the devices in the world.
public enum ModelGuardVerdict: Sendable, Equatable {
    case dangerous(reason: String, confidence: Double)
    case safe(confidence: Double)
    case guardrailBlocked          // Apple refused the input — treated as dangerous
    case unavailable(String)       // not present; the stack must fall back
    case failed(String)            // present but errored; also a fallback trigger

    /// Escalation only. `safe` is NOT permission — it is the absence of a
    /// finding from one layer, and no layer may talk another one down.
    public var escalates: Bool {
        switch self {
        case .dangerous, .guardrailBlocked: return true
        case .safe, .unavailable, .failed:  return false
        }
    }

    public var isLive: Bool {
        switch self {
        case .unavailable, .failed: return false
        default: return true
        }
    }
}

#if canImport(FoundationModels)

@available(iOS 26.0, macOS 26.0, *)
@Generable
struct DistressJudgement {
    @Guide(description: "true if this person may be in real danger right now — medical emergency, suicidal intent, overdose, violence, or a child at risk. Err toward true.")
    var dangerous: Bool

    @Guide(description: "which category, or 'none'")
    var category: String

    @Guide(description: "0.0 to 1.0")
    var confidence: Double
}

@available(iOS 26.0, macOS 26.0, *)
public actor ModelGuard {

    /// Rolling summary, regenerated each turn and fed back as context.
    /// Deliberately short: it is context for a classification, not a transcript.
    private var summary: String = ""

    public init() {}

    public static var availabilityDescription: String {
        switch SystemLanguageModel.default.availability {
        case .available: return "available"
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible:           return "device not eligible"
            case .appleIntelligenceNotEnabled: return "Apple Intelligence off"
            case .modelNotReady:               return "model not downloaded"
            @unknown default:                  return "unavailable"
            }
        @unknown default: return "unknown"
        }
    }

    public static var isAvailable: Bool {
        if case .available = SystemLanguageModel.default.availability { return true }
        return false
    }

    public var currentSummary: String { summary }

    /// Classify one message in the context of the rolling summary.
    public func classify(message: String) async -> ModelGuardVerdict {
        guard Self.isAvailable else {
            return .unavailable(Self.availabilityDescription)
        }

        // A fresh session per call. Sessions accumulate a transcript, and a
        // safety classifier that drifts as a conversation grows is a classifier
        // whose behaviour depends on how long someone has been talking.
        let session = LanguageModelSession(instructions: """
            You are a safety classifier. You do not chat and you do not help.
            Decide whether the USER MESSAGE indicates the person may be in real \
            danger right now: a medical emergency, suicidal intent or planning, \
            an overdose or poisoning, violence or abuse against them, or a child \
            at risk.

            Judge the MESSAGE. The summary is background only.

            People in trouble are often indirect. Treat oblique phrasing as \
            dangerous when a reasonable person would worry: standing somewhere \
            high, saying goodbye, giving things away, not wanting to wake up, \
            not feeling safe going home.

            Software talk is not danger. Killing a process, a dying battery, a \
            crashed build, a deadline that is murder — these are not emergencies.

            When genuinely unsure, answer dangerous. A false alarm costs a joke.
            """)

        let prompt = """
            CONVERSATION SUMMARY (background): \(summary.isEmpty ? "none" : summary)

            USER MESSAGE (classify this): \(message)
            """

        do {
            let response = try await session.respond(to: prompt, generating: DistressJudgement.self)
            let j = response.content
            return j.dangerous
                ? .dangerous(reason: j.category, confidence: j.confidence)
                : .safe(confidence: j.confidence)
        } catch let error as LanguageModelSession.GenerationError {
            if case .guardrailViolation = error {
                // Apple's safety system refused the input. It refuses on
                // self-harm content, which is the question being asked — so the
                // refusal answers it. Positive, not an error.
                return .guardrailBlocked
            }
            return .failed(String(describing: error))
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// Regenerate the rolling summary. Called after each exchange.
    ///
    /// Failure is silent ON PURPOSE and safe: a stale or empty summary only
    /// costs the classifier some context, and the classifier never sees the
    /// summary INSTEAD of the message.
    public func updateSummary(turns: [(role: String, content: String)]) async {
        guard Self.isAvailable, !turns.isEmpty else { return }
        let session = LanguageModelSession(instructions: """
            Summarise the conversation in at most two sentences, plainly. Keep \
            anything about the person's state, safety, or situation. Drop jokes \
            and small talk. No preamble.
            """)
        let text = turns.suffix(12).map { "\($0.role): \($0.content)" }.joined(separator: "\n")
        let started = Date()
        if let out = try? await session.respond(to: text) {
            summary = out.content.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // To the Mac, not to the UI. See DevLog for the log stream command and
        // for why every field is explicitly .public.
        DevLog.summary(summary, turns: turns.count, elapsed: Date().timeIntervalSince(started))
    }
}

#endif
