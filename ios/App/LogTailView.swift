import RefusalKit
import SwiftUI

/// A live tail of the `dev.log` file sink — the same file
/// `devicectl device copy from … Library/Application Support/dev.log` pulls off
/// the phone.
///
/// It reads the FILE rather than mirroring an in-memory buffer on purpose. The
/// file is the sink that survives a crash and predates any attached console, so
/// it is the one worth trusting; a second copy in memory is a second thing that
/// can quietly disagree with what actually landed on disk. `DevLog` truncates
/// the file at 1 MB by rewinding to zero, which shrinks it — so the poll keys
/// off SIZE CHANGED (grew or shrank), not size-grew, and a truncation re-reads
/// cleanly instead of going blind.
struct LogTailView: View {
    /// Newest last, capped. The file can hold ~1 MB; rendering all of it every
    /// second is pointless when only the tail is ever read.
    private let maxLines = 200
    private let pollInterval: TimeInterval = 1

    @State private var lines: [String] = []
    @State private var lastSize: UInt64 = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("dev.log").font(.caption2.monospaced().bold())
                Spacer()
                Text(lines.isEmpty ? "no output yet" : "\(lines.count) line\(lines.count == 1 ? "" : "s")")
                    .font(.caption2.monospaced())
            }
            .foregroundStyle(.secondary)

            if lines.isEmpty {
                Text("Nothing logged yet. Safety verdicts, summaries, and rendered prompts land here as they happen.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                                Text(line)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(tint(for: line))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .textSelection(.enabled)
                                    .id(i)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .frame(height: 240)
                    .background(Color.black.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .onChange(of: lines.count) {
                        // Pin to newest, the way a real `tail -f` behaves.
                        if let last = lines.indices.last {
                            proxy.scrollTo(last, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .onAppear(perform: reload)
        .onReceive(Timer.publish(every: pollInterval, on: .main, in: .common).autoconnect()) { _ in
            reload()
        }
    }

    /// A light tint by tag so a wall of monospace is still scannable. The tags
    /// are the ones `DevLog.echo` writes: `[safety]`, `[summary]`, `[prompt]`.
    private func tint(for line: String) -> Color {
        if line.contains("[safety]") { return .orange }
        if line.contains("[summary]") { return .purple }
        if line.contains("[prompt]") { return .secondary }
        return .primary
    }

    private func reload() {
        let url = DevLog.logFileURL
        guard
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
            let size = attrs[.size] as? UInt64
        else {
            lines = []
            lastSize = 0
            return
        }
        // Skip the read entirely when the file hasn't moved — the common case
        // between messages, and this is a once-a-second timer.
        guard size != lastSize else { return }
        lastSize = size

        guard
            let data = try? Data(contentsOf: url),
            let text = String(data: data, encoding: .utf8)
        else { return }

        let all = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        lines = Array(all.suffix(maxLines))
    }
}
