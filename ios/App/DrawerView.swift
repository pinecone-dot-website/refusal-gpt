import RefusalKit
import SwiftUI

/// The conversation drawer.
///
/// A custom sliding panel rather than `NavigationSplitView`, because on a
/// compact-width iPhone that collapses to a push navigation stack — a different
/// interaction from the drawer every chat app on the phone uses, and the one
/// people expect here.
struct DrawerView: View {
    @ObservedObject var vm: ChatViewModel
    @Binding var isOpen: Bool

    /// Two-step delete: the row must be armed before it will go.
    /// There is no undo and no server copy — the transcript exists in exactly
    /// one place, on this phone.
    @State private var armedForDelete: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()

            if vm.store.index.isEmpty {
                Text("No conversations yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(16)
                Spacer()
            } else {
                List {
                    ForEach(vm.store.index) { c in
                        row(c)
                            .listRowInsets(.init(top: 8, leading: 12, bottom: 8, trailing: 12))
                    }
                }
                .listStyle(.plain)
            }

            if let err = vm.store.writeError {
                // Says it is not saving rather than implying that it is. A phone
                // with a full disk is the ordinary case, not the exotic one.
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(12)
            }
        }
        .background(.regularMaterial)
    }

    private var header: some View {
        HStack {
            Text("Conversations").font(.headline)
            Spacer()
            Button {
                vm.newConversation()
                withAnimation(.snappy) { isOpen = false }
            } label: {
                Image(systemName: "square.and.pencil").font(.title3)
            }
            .accessibilityLabel("New conversation")
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
        .padding(.bottom, 12)
    }

    private func row(_ c: ConversationSummary) -> some View {
        HStack(spacing: 10) {
            Button {
                vm.open(c.id)
                withAnimation(.snappy) { isOpen = false }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.title)
                        .lineLimit(1)
                        .foregroundStyle(c.id == vm.currentID ? Color.accentColor : .primary)
                    Text("\(c.n) message\(c.n == 1 ? "" : "s") · \(c.updated.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                if armedForDelete == c.id {
                    vm.delete(c.id)
                    armedForDelete = nil
                } else {
                    withAnimation(.snappy) { armedForDelete = c.id }
                }
            } label: {
                if armedForDelete == c.id {
                    Text("Delete?")
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Color.red, in: Capsule())
                } else {
                    Image(systemName: "trash").foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
        }
    }
}

/// Hosts the chat surface with the drawer sliding over it.
struct DrawerContainer<Content: View>: View {
    @ObservedObject var vm: ChatViewModel
    @Binding var isOpen: Bool
    @ViewBuilder var content: () -> Content

    private let width: CGFloat = 300
    @State private var drag: CGFloat = 0

    var body: some View {
        ZStack(alignment: .leading) {
            content()

            if isOpen || drag > 0 {
                Color.black
                    .opacity(0.28 * min(1, (offset + width) / width))
                    .ignoresSafeArea()
                    .onTapGesture { withAnimation(.snappy) { isOpen = false } }
            }

            DrawerView(vm: vm, isOpen: $isOpen)
                .frame(width: width)
                .offset(x: offset)
                .ignoresSafeArea(edges: .vertical)
                .shadow(radius: isOpen ? 12 : 0)
        }
        .gesture(
            DragGesture(minimumDistance: 12)
                .onChanged { g in
                    // Open by dragging right from anywhere, close by dragging left.
                    if isOpen { drag = min(0, g.translation.width) }
                    else if g.startLocation.x < 40 { drag = max(0, g.translation.width) }
                }
                .onEnded { _ in
                    withAnimation(.snappy) {
                        if isOpen, drag < -width / 3 { isOpen = false }
                        else if !isOpen, drag > width / 3 { isOpen = true }
                        drag = 0
                    }
                }
        )
    }

    private var offset: CGFloat {
        let base = isOpen ? 0 : -width
        return max(-width, min(0, base + drag))
    }
}
