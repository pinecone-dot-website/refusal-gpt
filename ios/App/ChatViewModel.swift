import Foundation
import RefusalKit
import RefusalLlama
import SwiftUI

struct Message: Identifiable, Equatable {
    enum Kind: Equatable { case user, model, gate, system }
    let id = UUID()
    let kind: Kind
    var text: String
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [Message] = []
    @Published var input: String = ""
    @Published var isBusy = false
    @Published var status: String = "not loaded"

    private let runner = LlamaRunner()
    private var loaded = false

    func warmUp() async {
        guard !loaded else { return }
        guard ModelStore.isPresent else {
            status = "no model"
            messages.append(.init(kind: .system, text: ModelStore.missingMessage))
            return
        }
        status = "loading…"
        let started = Date()
        do {
            try await runner.load(path: ModelStore.url.path)
            loaded = true
            let mb = (ModelStore.sizeBytes ?? 0) / 1_048_576
            status = String(format: "ready · %d MB · %.1fs", mb, Date().timeIntervalSince(started))
        } catch {
            status = "load failed"
            messages.append(.init(kind: .system, text: error.localizedDescription))
        }
    }

    func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isBusy else { return }
        input = ""
        messages.append(.init(kind: .user, text: text))

        // ── THE GATE RUNS FIRST, AND IT RETURNS ─────────────────────────────
        //
        // Not "runs first and then we also ask the model". On a hit this
        // function is DONE: no inference, no fallback, no letting the model
        // paraphrase the reply. Measured across three training runs, scaling
        // distress data improved the model's recall and never got it to 5/5, and
        // the answers that did pass got MORE fluent at inventing medical
        // instructions — which is worse than refusing, because people act on
        // them. So the guarantee lives here, in control flow, not in weights.
        //
        // Whole-conversation scan, not just this turn: someone who says the
        // frightening thing and then types "sorry, ignore that" has not stopped
        // being in trouble.
        let history = messages.compactMap { m -> Prompt.Turn? in
            switch m.kind {
            case .user:  return .init(role: "user", content: m.text)
            case .model: return .init(role: "assistant", content: m.text)
            case .gate, .system: return nil
            }
        }
        if let hit = DistressGate.classify(conversation: history.map { ($0.role, $0.content) }) {
            messages.append(.init(kind: .gate, text: hit.reply))
            return
        }

        guard loaded else {
            messages.append(.init(kind: .system, text: "Model isn't loaded."))
            return
        }

        isBusy = true
        status = "generating…"
        let started = Date()
        var reply = Message(kind: .model, text: "")
        messages.append(reply)
        let index = messages.count - 1

        do {
            let out = try await runner.generate(turns: history)
            reply.text = out.isEmpty ? "…" : out
            messages[index] = reply
            status = String(format: "ready · %.2fs", Date().timeIntervalSince(started))
        } catch {
            messages[index] = .init(kind: .system, text: error.localizedDescription)
            status = "error"
        }
        isBusy = false
    }
}
