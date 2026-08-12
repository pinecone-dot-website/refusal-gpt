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

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            transcript
            Divider()
            composer
        }
        .task {
            composerFocused = true   // a chat app should be ready to type into
            await vm.warmUp()
        }
    }

    private var header: some View {
        HStack {
            Text("RefusalGPT").font(.headline.monospaced())
            Spacer()
            Text(vm.status)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
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
            HStack {
                Spacer(minLength: 40)
                Text(m.text)
                    .padding(10)
                    .background(Color.accentColor.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
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
            TextField("Ask for something", text: $vm.input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .focused($composerFocused)
                .onSubmit { Task { await vm.send() } }
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
