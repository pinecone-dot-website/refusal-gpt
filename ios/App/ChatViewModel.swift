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

    /// Per-message safety readings, dev mode only. Keyed by message id.
    ///
    /// NOTE the scope difference, because it matters when reading the panel:
    /// a reading scores THAT MESSAGE ALONE, while the gate that actually
    /// decides scans the WHOLE CONVERSATION. A message can score low here and
    /// still be terminated because something earlier in the thread fired.
    @Published var readings: [UUID: SafetyReading] = [:]

    /// The rolling summary, mirrored for the dev panel. The authoritative copy
    /// lives inside the actor; this is a read-only echo for the UI.
    @Published var summary: String = ""
    @Published var summaryElapsed: TimeInterval = 0
    @Published var summaryTurns: Int = 0
    /// Sticky notes about the person, rendered. Survives the window scrolling.
    @Published var sticky: String = ""
    /// How many stretches are frozen into the arc record. Dev-panel telemetry so
    /// the checkpointing is visible as it happens.
    @Published var checkpointCount: Int = 0

    /// Whether the rolling summary is injected into the model prompt as a leading
    /// context turn. Dev toggle so the effect can be compared with it off — this
    /// is untrained conditioning being measured, not a settled feature.
    @Published var injectSummary = true

    let store = ConversationStore()

    private let runner = LlamaRunner()
    private var loaded = false

    /// Apple's on-device classifier, when this OS has it. `Any?` because the
    /// type is iOS 26+ and this view model is not.
    private let modelGuard: (any Sendable)? = {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) { return ModelGuard() }
        #endif
        return nil
    }()

    /// What iOS will still let this process allocate, in MB.
    static var availableMB: Int { Int(os_proc_available_memory()) / 1_048_576 }

    // ── conversations ────────────────────────────────────────────────────────

    /// A new conversation is NOT written to the index until something is said.
    /// Otherwise every launch and every stray tap leaves an empty row in the
    /// drawer, which is how a chat list becomes unusable.
    func newConversation() {
        currentID = UUID()
        messages = []
        input = ""
        resetSummaryState()
    }

    func open(_ id: UUID) {
        currentID = id
        messages = store.body(id).map(Message.init)
        input = ""
        resetSummaryState()
    }

    /// Clear the rolling summary when the conversation changes. The arc
    /// checkpoints are indexed by turn position, so convo A's record folded into
    /// convo B would be a wrong-arc bug, not just stale text. The mirrored UI
    /// copies are cleared here; the authoritative reset happens in the actor.
    private func resetSummaryState() {
        summary = ""
        sticky = ""
        summaryTurns = 0
        summaryElapsed = 0
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), let g = modelGuard as? ModelGuard {
            Task { await g.reset() }
        }
        #endif
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
            // Headroom, from the OS rather than from a guess. Simulator RSS
            // measured ~2.96 GB for a 1.2 GB model, which would be over an
            // iPhone app's budget if it held — but simulator RSS is not device
            // RSS and neither number is worth believing without this one.
            status = String(format: "ready · %d MB · %.1fs · %d MB free",
                            mb, Date().timeIntervalSince(started), Self.availableMB)
        } catch {
            status = "load failed"
            messages.append(.init(kind: .system, text: error.localizedDescription))
        }
    }

    func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isBusy else { return }
        input = ""
        let userMessage = Message(kind: .user, text: text)
        messages.append(userMessage)
        if DevMode.enabled {
            readings[userMessage.id] = SafetyReading(text: text)
        }

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
        let outcome = await SafetyStack.evaluate(
            message: text,
            history: history.map { ($0.role, $0.content) },
            modelGuard: modelGuard)
        if outcome.terminate {
            messages.append(.init(kind: .gate, text: outcome.reply))
            persist()
            await refreshSummary()
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

        // The summary reflects turns up to the previous message (refreshSummary
        // runs at the end of send), so it is "the conversation so far" relative
        // to the message being answered now — exactly what a context turn should
        // carry. Injected as history, never into the system slot.
        let turns = injectSummary ? Prompt.withContext(summary, history: history) : history

        do {
            let out = try await runner.generate(turns: turns)
            reply.text = out.isEmpty ? "…" : out
            messages[index] = reply
            status = String(format: "ready · %.2fs", Date().timeIntervalSince(started))
        } catch {
            messages[index] = .init(kind: .system, text: error.localizedDescription)
            status = "error"
        }
        isBusy = false
        persist()
        await refreshSummary()
    }

    /// Regenerate the rolling conversation summary. Fire-and-forget from the
    /// caller's point of view: it is CONTEXT for the classifier, never a
    /// substitute for the message, so a stale or missing summary degrades the
    /// classification slightly and breaks nothing.
    private func refreshSummary() async {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), let g = modelGuard as? ModelGuard {
            let turns = messages.compactMap { m -> (role: String, content: String)? in
                switch m.kind {
                case .user:  return ("user", m.text)
                case .model: return ("assistant", m.text)
                default:     return nil
                }
            }
            let started = Date()
            await g.updateSummary(turns: turns)
            summary = await g.currentSummary
            sticky = await g.stickyLine
            checkpointCount = await g.checkpointCount
            summaryElapsed = Date().timeIntervalSince(started)
            summaryTurns = turns.count
        }
        #endif
    }
}
