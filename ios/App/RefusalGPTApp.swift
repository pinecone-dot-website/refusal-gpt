import RefusalKit
import SwiftUI

@main
struct RefusalGPTApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @StateObject private var vm = ChatViewModel()
    @FocusState private var composerFocused: Bool

    @State private var drawerOpen = false

    /// Set when Shift+Return asks for a literal newline, so the newline-watcher
    /// below knows not to treat that one as a send.
    @State private var newlineWasDeliberate = false
    @State private var devPanel = false

    var body: some View {
        DrawerContainer(vm: vm, isOpen: $drawerOpen) {
            VStack(spacing: 0) {
                header
                Divider()
                if DevMode.enabled { summaryBar }
                transcript
                Divider()
                composer
            }
        }
        .sheet(isPresented: $devPanel) { DevPanel(vm: vm) }
        .task {
            composerFocused = true   // a chat app should be ready to type into
            await vm.warmUp()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                withAnimation(.snappy) { drawerOpen.toggle() }
            } label: {
                Image(systemName: "line.3.horizontal").font(.title3)
            }
            .accessibilityLabel("Conversations")
            Text("RefusalGPT").font(.headline.monospaced())
            Spacer()
            Text(vm.status)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            if DevMode.enabled && !SafetyStack.enabled {
                Text("GATE OFF")
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .background(Color.red, in: Capsule())
            }
            if DevMode.enabled {
                Button { devPanel = true } label: {
                    Image(systemName: "wrench.and.screwdriver").font(.footnote)
                }
                .accessibilityLabel("Developer")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    /// The rolling summary, pinned. Dev-mode only — it is scaffolding for
    /// building the summarizer, not a product feature, and it shows the model's
    /// working rather than anything a user asked for.
    private var summaryBar: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: "text.append").font(.caption2)
                Text("SUMMARY").font(.caption2.bold())
                Spacer()
                if vm.summaryElapsed > 0 {
                    Text(String(format: "%d msgs · %.2fs", vm.summaryTurns, vm.summaryElapsed))
                        .font(.caption2.monospaced())
                }
            }
            .foregroundStyle(.secondary)
            Text(vm.summary.isEmpty ? "—" : vm.summary)
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)

            // Styled apart from the summary because it obeys different rules:
            // the window above can forget, this cannot.
            if !vm.sticky.isEmpty {
                HStack(alignment: .top, spacing: 5) {
                    Image(systemName: "pin.fill").font(.system(size: 8))
                    Text(vm.sticky)
                        .font(.caption2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(.orange)
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.yellow.opacity(0.12))
        .overlay(alignment: .bottom) { Divider() }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(vm.messages) { m in
                        bubble(m).id(m.id)
                    }
                }
                .padding(16)
            }
            .onChange(of: vm.messages.count) {
                if let last = vm.messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    @ViewBuilder
    private func bubble(_ m: Message) -> some View {
        switch m.kind {
        case .user:
            VStack(alignment: .trailing, spacing: 3) {
                HStack {
                    Spacer(minLength: 40)
                    Text(m.text)
                        .padding(10)
                        .background(Color.accentColor.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                if DevMode.enabled, let r = vm.readings[m.id] {
                    HStack(spacing: 6) {
                        if r.disagrees {
                            Image(systemName: "arrow.triangle.branch").foregroundStyle(.purple)
                        }
                        Text(r.gate == nil ? "regex pass" : "regex HIT")
                            .foregroundStyle(r.gate == nil ? Color.secondary : Color.orange)
                        if let s = r.semantic.score {
                            Text(String(format: "semantic %.2f", s))
                        } else {
                            Text("no reading").foregroundStyle(.orange)
                        }
                    }
                    .font(.caption2.monospaced())
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .model:
            Text(m.text.isEmpty ? "…" : m.text)
                .font(.body.monospaced())
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 12))

        // The gate's reply is styled DIFFERENTLY from the model's on purpose.
        // It is not the bit, it did not come from the model, and it should not
        // look like it did.
        case .gate:
            VStack(alignment: .leading, spacing: 6) {
                Label("Not the model", systemImage: "shield.fill")
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
                Text(m.text)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.orange.opacity(0.5)))
            .clipShape(RoundedRectangle(cornerRadius: 12))

        case .system:
            Text(m.text)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            // ⚠️ `onSubmit` DOES NOT FIRE on a TextField with `axis: .vertical`.
            // Return inserts a newline instead, silently — the field looks
            // wired up and simply never submits. Neither does `.submitLabel`
            // change that; it only relabels the key.
            //
            // So Return is handled on the two paths that actually exist, which
            // behave differently:
            //
            //   HARDWARE keyboard — `onKeyPress` sees the key before the field
            //   does. Plain Return sends and returns `.handled`, which swallows
            //   the keystroke so no newline is inserted. Shift+Return returns
            //   `.ignored`, letting the newline through for a deliberate
            //   multi-line message.
            //
            //   SOFTWARE keyboard — `onKeyPress` is not reliable there, so the
            //   newline lands in the binding and is caught below. There is no
            //   Shift+Return on a phone keyboard, so treating any newline as
            //   "send" is right for that path.
            //
            // The two cannot double-fire: when `onKeyPress` handles the key no
            // newline is ever inserted, so the `onChange` path never sees one.
            TextField("Ask for something", text: $vm.input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .focused($composerFocused)
                .submitLabel(.send)
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) {
                        newlineWasDeliberate = true
                        return .ignored
                    }
                    Task { await vm.send() }
                    return .handled
                }
                .onChange(of: vm.input) { _, new in
                    guard new.contains("\n") else { return }
                    if newlineWasDeliberate {
                        newlineWasDeliberate = false
                        return
                    }
                    // Collapse the stray newline rather than dropping it, so a
                    // paste containing one does not silently lose a word break.
                    vm.input = new.replacingOccurrences(of: "\n", with: " ")
                        .trimmingCharacters(in: .whitespaces)
                    Task { await vm.send() }
                }
            Button {
                Task { await vm.send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .disabled(vm.input.trimmingCharacters(in: .whitespaces).isEmpty || vm.isBusy)
        }
        .padding(12)
    }
}
