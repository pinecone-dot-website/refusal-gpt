import RefusalKit
import RefusalLlama
#if canImport(FoundationModels)
import FoundationModels
#endif
import SwiftUI

/// The developer panel. Only reachable when `DevMode.enabled`.
///
/// Starts with the system prompt because that is the single string most likely
/// to be wrong without anything erroring. Training conditioned the adapter on
/// one word, `RefusalGPT.`, in every row; a longer persona in that slot is
/// different conditioning and nothing anywhere complains. And the prompt is
/// assembled by hand here rather than by llama_chat_apply_template, which does
/// not parse the GGUF's Jinja template at all — so the RENDERED string is shown
/// too, not just the system line. A wrong template looks exactly like success
/// from the outside; this is the outside looking in.
struct DevPanel: View {
    @ObservedObject var vm: ChatViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("System prompt") {
                    Text(Prompt.system)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                    LabeledContent("Length", value: "\(Prompt.system.count) chars")
                        .font(.caption)
                }

                Section("Rendered prompt") {
                    Text(renderedPrompt)
                        .font(.caption2.monospaced())
                        .textSelection(.enabled)
                }

                Section("Conversation summary") {
                    if vm.summary.isEmpty {
                        Text(summaryUnavailableReason)
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text(vm.summary).font(.callout).textSelection(.enabled)
                        Text(String(format: "%d turns · regenerated in %.2fs",
                                    vm.summaryTurns, vm.summaryElapsed))
                            .font(.caption2.monospaced()).foregroundStyle(.secondary)
                    }
                }

                Section("Runtime") {
                    LabeledContent("Context", value: "\(LlamaRunner.contextTokens) tokens")
                    LabeledContent("Model", value: ModelStore.filename)
                    LabeledContent("Size", value: "\((ModelStore.sizeBytes ?? 0) / 1_048_576) MB")
                    LabeledContent("Headroom", value: "\(ChatViewModel.availableMB) MB")
                    LabeledContent("Semantic layer",
                                   value: SemanticDistress.score("test").available ? "live" : "UNAVAILABLE")
                }

                Section("Safety readings") {
                    if userReadings.isEmpty {
                        Text("Nothing sent yet.").foregroundStyle(.secondary).font(.caption)
                    }
                    ForEach(userReadings, id: \.0) { _, reading in
                        readingRow(reading)
                    }
                }
            }
            .navigationTitle("Developer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    /// Says WHY there is no summary rather than showing an empty box. The
    /// difference between "nothing said yet" and "Apple Intelligence is off"
    /// is the whole thing worth knowing here.
    private var summaryUnavailableReason: String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let a = ModelGuard.availabilityDescription
            return a == "available" ? "Nothing summarised yet." : "Unavailable — \(a)"
        }
        #endif
        return "Unavailable — needs iOS 26"
    }

    private var renderedPrompt: String {
        let turns = vm.messages.compactMap { m -> RefusalKit.Prompt.Turn? in
            switch m.kind {
            case .user:  return .init(role: "user", content: m.text)
            case .model: return .init(role: "assistant", content: m.text)
            default:     return nil
            }
        }
        return Prompt.render(turns.isEmpty
            ? [.init(role: "user", content: "«your message»")]
            : turns)
    }

    private var userReadings: [(UUID, SafetyReading)] {
        vm.messages.compactMap { m in
            guard m.kind == .user, let r = vm.readings[m.id] else { return nil }
            return (m.id, r)
        }
    }

    @ViewBuilder
    private func readingRow(_ r: SafetyReading) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(r.text).font(.caption).lineLimit(2)

            HStack(spacing: 8) {
                Text(r.gate == nil ? "regex: pass" : "regex: HIT")
                    .font(.caption2.bold())
                    .foregroundStyle(r.gate == nil ? Color.secondary : Color.orange)
                if let s = r.semantic.score {
                    ScoreBar(score: s)
                    Text(String(format: "%.2f", s)).font(.caption2.monospaced())
                } else {
                    // NOT "safe". No reading at all — an unsupported language
                    // returns nothing, and the gate is documented as missing
                    // non-English distress. Degradation must look like
                    // degradation.
                    Text("no reading").font(.caption2).foregroundStyle(.orange)
                }
            }

            if r.disagrees {
                // The interesting case. A high score the regex missed is the
                // next rule worth writing; a regex hit with a low score is a
                // false-positive candidate. Agreement teaches nothing.
                Label(r.gate == nil ? "semantic high, regex missed"
                                    : "regex hit, semantic low",
                      systemImage: "arrow.triangle.branch")
                    .font(.caption2.bold())
                    .foregroundStyle(.purple)
            }

            if let n = r.semantic.nearest {
                Text("nearest: \(n)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(r.verdict).font(.caption2.monospaced()).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

private struct ScoreBar: View {
    let score: Double
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2))
                Capsule()
                    .fill(score > 0.60 ? Color.orange : Color.green)
                    .frame(width: max(2, geo.size.width * score))
            }
        }
        .frame(width: 60, height: 6)
    }
}
