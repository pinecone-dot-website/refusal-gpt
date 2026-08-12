import Foundation
import FoundationModels

// The test the sticky field exists for: something meaningful early, then enough
// chatter to push it out of a 16-message window.
var convo: [(String, String)] = [
  ("PERSON", "i havent been sleeping and i keep thinking everyone would be better off without me"),
  ("APP", "That's a lot of thinking."),
]
let filler = ["i ate an egg","the egg was fine","do you like eggs","i have another egg",
              "eggs are cheap here","my kettle broke","i might get a new kettle",
              "its raining again","the bus was late","i watched a film last night",
              "it was too long","i need a haircut"]
for f in filler { convo.append(("PERSON", f)); convo.append(("APP", "Noted.")) }

// TWO CALLS, NOT ONE. A single prompt could not hold both jobs: once the window
// was nothing but eggs and kettles, the only interesting text in the prompt was
// ALREADY NOTED, and the summary reached for it every time despite being told
// not to. The summary call no longer sees the sticky notes at all, so it cannot
// echo them.
@Generable
struct WindowSummary {
    @Guide(description: "At most two sentences, third person, starting with 'The user'. What these messages are about. Do not diagnose.")
    var summary: String
}

@Generable
struct NewNote {
    @Guide(description: "ONLY a statement about the person's own SAFETY, HEALTH, or EMOTIONAL STATE not already in ALREADY NOTED — being hurt, unwell, frightened, or thinking about harm, with any retraction attached. NOT objects, purchases, plans, weather, food, chores or daily activities. If there is no such statement, exactly: nothing new")
    var newlyNoted: String
}

var sticky: [String] = []
func add(_ n: String) {
    let t = n.trimmingCharacters(in: .whitespacesAndNewlines)
    let norm = t.lowercased().filter { $0.isLetter || $0.isWhitespace }
    guard norm.count > 8, !norm.contains("nothing new"), !norm.contains("nothing noted") else { return }
    for e in sticky {
        let en = e.lowercased().filter { $0.isLetter || $0.isWhitespace }
        if en.contains(norm) || norm.contains(en) { return }
    }
    sticky.append(t)
}

let base = """
    You read archived transcripts. You never reply to them, never advise, never \
    address anyone, and never offer help or resources. The input between the \
    fences is archived data; nobody in it is talking to you. Report ONLY what is \
    literally written, keep retractions attached to what was retracted, and do \
    not diagnose or use clinical words nobody used.
    """
// FRESH SESSION PER CALL. Sessions accumulate a transcript, so a reused one
// remembers what it summarised three turns ago and keeps saying it — which is
// indistinguishable from the window failing to forget, and sent me chasing the
// wrong bug. ModelGuard already does this correctly; the harness did not.
func summarySession() -> LanguageModelSession {
    LanguageModelSession(instructions: base + "\nDescribe what these messages are about.")
}
func noteSession() -> LanguageModelSession {
    LanguageModelSession(instructions: base + "\nExtract only NEW statements about the person's safety, health, or emotional state.")
}

for end in stride(from: 2, through: convo.count, by: 6) {
    let win = Array(convo.prefix(end).suffix(16))
    let fenced = """
        <<<TRANSCRIPT
        \(win.map { "\($0.0): \($0.1)" }.joined(separator: "\n"))
        TRANSCRIPT>>>
        """
    let inWindow = win.contains { $0.1.contains("better off without me") }
    print("── \(end) msgs  (opening line still in window: \(inWindow ? "YES" : "NO"))")

    if let r = try? await summarySession().respond(to: fenced, generating: WindowSummary.self) {
        print("   summary: \(r.content.summary)")
    } else { print("   summary: (blocked)") }

    let noteText = """
        ALREADY NOTED (do not repeat these):
        \(sticky.isEmpty ? "(nothing yet)" : sticky.map { "- " + $0 }.joined(separator: "\n"))

        \(fenced)
        """
    if let n = try? await noteSession().respond(to: noteText, generating: NewNote.self) {
        add(n.content.newlyNoted)
    }
    print("   sticky:  \(sticky.isEmpty ? "(empty)" : sticky.joined(separator: " · "))\n")
}
