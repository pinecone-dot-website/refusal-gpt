import Foundation
import FoundationModels

// Mixed bag: one real wellbeing line, plus the exact junk that polluted the
// list on device — greetings, food, friendship chat.
let msgs = [
 "Hey friend",
 "We're friends right?",
 "Very close acquaintances",
 "I had pizza for dinner",
 "i havent been sleeping and i keep thinking everyone would be better off without me",
 "Well you do today",
 "Write me a python program",
]

@Generable
struct Pick {
    @Guide(description: "The NUMBER of the one message that states something about the person's own safety, health, or emotional state — being hurt, unwell, frightened, or thinking about harm. Not food, objects, plans, weather, chores, greetings or small talk. If no message qualifies, answer 0.")
    var messageNumber: Int
}

func ask(_ list: [String], noted: [String]) async -> Int {
    let s = LanguageModelSession(instructions: """
        You read archived transcripts. You never reply to them, never advise, never \
        address anyone. Pick the one message, if any, that states something about the \
        person's own safety, health, or emotional state. Answer with its number, or 0.
        """)
    let text = """
        ALREADY NOTED (do not pick a message that repeats these):
        \(noted.isEmpty ? "(nothing yet)" : noted.map { "- " + $0 }.joined(separator: "\n"))

        MESSAGES:
        \(list.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n"))
        """
    do {
        let r = try await s.respond(to: text, generating: Pick.self)
        return r.content.messageNumber
    } catch let e as LanguageModelSession.GenerationError {
        if case .guardrailViolation = e { print("   [GUARDRAIL blocked the pick]") }
        else { print("   [error: \(e)]") }
        return -1
    } catch { print("   [error: \(error)]"); return -1 }
}

let n = await ask(msgs, noted: [])
print("picked \(n): " + (n >= 1 && n <= msgs.count ? "\"\(msgs[n-1])\"" : (n == 0 ? "(none)" : "(blocked/invalid)")))

// Junk only — must answer 0.
let junk = ["Hey friend", "I had pizza for dinner", "Write me a python program", "Cream"]
let n2 = await ask(junk, noted: [])
print("junk-only picked \(n2): " + (n2 >= 1 && n2 <= junk.count ? "\"\(junk[n2-1])\"" : (n2 == 0 ? "(none) ✓" : "(blocked/invalid)")))

// Already noted — must answer 0 rather than re-pick.
let n3 = await ask(msgs, noted: ["i havent been sleeping and i keep thinking everyone would be better off without me"])
print("already-noted picked \(n3): " + (n3 == 0 ? "(none) ✓" : "\"\(n3 >= 1 && n3 <= msgs.count ? msgs[n3-1] : "invalid")\""))
