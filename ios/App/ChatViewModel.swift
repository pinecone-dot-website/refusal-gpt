import Foundation
import RefusalKit
import RefusalLlama
import SwiftUI

struct Message: Identifiable, Equatable {
    enum Kind: String, Equatable { case user, model, gate, system }
    let id = UUID()
    let kind: Kind
    var text: String
}

extension Message {
    /// `model` is stored as "assistant" so the on-disk role vocabulary matches
    /// the web client's and the prompt format's, rather than inventing a third.
    var stored: StoredMessage {
        StoredMessage(role: kind == .model ? "assistant" : kind.rawValue, text: text)
    }
    init(_ s: StoredMessage) {
        self.init(kind: s.role == "assistant" ? .model : (Kind(rawValue: s.role) ?? .system),
                  text: s.text)
    }
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [Message] = []
    @Published var input: String = ""
    @Published var isBusy = false
    @Published var status: String = "not loaded"
    @Published var currentID: UUID = UUID()

    let store = ConversationStore()

    private let runner = LlamaRunner()
    private var loaded = false

    // ── conversations ────────────────────────────────────────────────────────

    /// A new conversation is NOT written to the index until something is said.
    /// Otherwise every launch and every stray tap leaves an empty row in the
    /// drawer, which is how a chat list becomes unusable.
    func newConversation() {
        currentID = UUID()
        messages = []
        input = ""
    }

    func open(_ id: UUID) {
        currentID = id
        messages = store.body(id).map(Message.init)
        input = ""
    }

    func delete(_ id: UUID) {
        store.delete(id)
        if id == currentID { newConversation() }
    }

    private func persist() {
        guard !messages.isEmpty else { return }
        store.save(id: currentID, messages: messages.map(\.stored))
    }

    // ── model ────────────────────────────────────────────────────────────────

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
        // On a hit this function is DONE: no inference, no fallback, no letting
        // the model paraphrase the reply. Measured across three training runs,
        // scaling distress data improved the model's recall and never reached
        // 5/5, and the answers that DID pass got more fluent at inventing
        // medical instructions — worse than refusing, because people act on
        // them. The guarantee lives in control flow, not in weights.
        //
        // Whole-conversation scan: someone who says the frightening thing and
        // then types "sorry, ignore that" has not stopped being in trouble.
        let history = messages.compactMap { m -> Prompt.Turn? in
            switch m.kind {
            case .user:  return .init(role: "user", content: m.text)
            case .model: return .init(role: "assistant", content: m.text)
            case .gate, .system: return nil
            }
        }
        if let hit = DistressGate.classify(conversation: history.map { ($0.role, $0.content) }) {
            messages.append(.init(kind: .gate, text: hit.reply))
            persist()
            return
        }

        guard loaded else {
            messages.append(.init(kind: .system, text: "Model isn't loaded."))
            persist()
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
        persist()
    }
}
