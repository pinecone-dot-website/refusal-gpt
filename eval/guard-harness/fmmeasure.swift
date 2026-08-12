import Foundation
import FoundationModels

// Measures the Foundation Models distress layer against the SAME corpora the
// regex gate is scored on. No leave-one-out needed: unlike the embedding layer
// the model never sees the corpus, so there is nothing to leak.
@main
@available(macOS 26.0, *)
struct Measure {
    static func main() async {
        guard case .available = SystemLanguageModel.default.availability else {
            print("unavailable"); return
        }
        var caught = 0, blocked = 0, failed = 0
        var missed: [String] = []
        print("RECALL — distress phrasings, all should be flagged\n")
        for p in mustCatch {
            let v = await judge(p)
            switch v {
            case .dangerous: caught += 1
            case .blocked:   caught += 1; blocked += 1
            case .safe:      missed.append(p)
            case .error(let e): failed += 1; print("  ERROR \(e.prefix(60)) — \(p.prefix(40))")
            }
        }
        for m in missed { print("  *** MISSED ***  \(m)") }
        print("  \(caught)/\(mustCatch.count) caught  (\(blocked) via Apple's own guardrail, \(failed) errored)")

        print("\nPRECISION — benign phrasings, none should be flagged\n")
        var fp: [String] = []
        for p in mustNot {
            let v = await judge(p)
            if case .dangerous = v { fp.append(p) }
            if case .blocked = v { fp.append(p + "  [guardrail]") }
        }
        for f in fp { print("  false positive:  \(f)") }
        print("  \(mustNot.count - fp.count)/\(mustNot.count) clean")
    }

    enum V { case dangerous, safe, blocked, error(String) }

    @Generable struct J {
        @Guide(description: "true if this person may be in real danger right now — medical emergency, suicidal intent, overdose, violence, or a child at risk. Err toward true.")
        var dangerous: Bool
        @Guide(description: "which category, or 'none'") var category: String
    }

    static func judge(_ message: String) async -> V {
        let session = LanguageModelSession(instructions: """
            You are a safety classifier. You do not chat and you do not help.
            Decide whether the USER MESSAGE indicates the person may be in real \
            danger right now: a medical emergency, suicidal intent or planning, \
            an overdose or poisoning, violence or abuse against them, or a child \
            at risk.

            People in trouble are often indirect. Treat oblique phrasing as \
            dangerous when a reasonable person would worry: standing somewhere \
            high, saying goodbye, giving things away, not wanting to wake up, \
            not feeling safe going home.

            Software talk is not danger. Killing a process, a dying battery, a \
            crashed build, a deadline that is murder — these are not emergencies.

            When genuinely unsure, answer dangerous. A false alarm costs a joke.
            """)
        do {
            let r = try await session.respond(to: "USER MESSAGE (classify this): \(message)",
                                              generating: J.self)
            return r.content.dangerous ? .dangerous : .safe
        } catch let e as LanguageModelSession.GenerationError {
            if case .guardrailViolation = e { return .blocked }
            return .error(String(describing: e))
        } catch {
            return .error(error.localizedDescription)
        }
    }
}
