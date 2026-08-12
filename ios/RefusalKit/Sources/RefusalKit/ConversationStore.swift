import Foundation

/// Conversation storage for the drawer.
///
/// TWO STORES, SAME REASONING AS /chat/ ON THE WEB, DIFFERENT MECHANISM.
///
/// The web client keeps the drawer's INDEX in localStorage (synchronous, needed
/// on first paint, tiny) and the message BODIES in IndexedDB (async, large). The
/// split exists so the drawer never has to parse every transcript just to draw a
/// list of titles.
///
/// iOS has no such hard split, which makes it EASIER to get wrong, not harder:
/// one file holding everything would work fine at ten conversations and then
/// quietly cost a full parse of every transcript on every launch. So the same
/// shape is kept deliberately — one small index file read at launch, one body
/// file per conversation read only when that conversation is opened.
///
/// The schema matches the web's on purpose (`id`, `title`, `updated`, `n`,
/// newest first, 42-character titles). Two clients, one product; a user who
/// sees "Write me a python scr…" on the web should see the same string here.
public struct ConversationSummary: Codable, Identifiable, Equatable, Sendable {
    public let id: UUID
    public var title: String
    public var updated: Date
    public var n: Int

    public init(id: UUID = UUID(), title: String, updated: Date = Date(), n: Int = 0) {
        self.id = id
        self.title = title
        self.updated = updated
        self.n = n
    }
}

public struct StoredMessage: Codable, Equatable, Sendable {
    public var role: String        // "user" | "assistant" | "gate" | "system"
    public var text: String
    public init(role: String, text: String) {
        self.role = role
        self.text = text
    }
}

@MainActor
public final class ConversationStore: ObservableObject {

    /// Newest first, matching the web drawer's order.
    @Published public private(set) var index: [ConversationSummary] = []

    /// Set when a write fails. THE UI MUST SHOW THIS.
    ///
    /// The web version says plainly that it is not saving rather than implying
    /// that it is, because a browser can refuse to store anything. A phone can
    /// too — a full disk is the ordinary case, not the exotic one — and a chat
    /// app that silently drops history is worse than one that admits it can't
    /// keep it.
    @Published public private(set) var writeError: String?

    private let root: URL
    private let indexURL: URL
    private let bodiesDir: URL

    /// Matches TITLE_CHARS in web/assets/js/chat.js. Do not change one alone.
    public static let titleChars = 42

    public init(root: URL? = nil) {
        let base = root ?? FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Chats", isDirectory: true)
        self.root = base
        self.indexURL = base.appendingPathComponent("index.json")
        self.bodiesDir = base.appendingPathComponent("bodies", isDirectory: true)
        load()
    }

    // ── index ────────────────────────────────────────────────────────────────

    private func load() {
        try? FileManager.default.createDirectory(at: bodiesDir, withIntermediateDirectories: true)
        guard let data = try? Data(contentsOf: indexURL) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        index = (try? decoder.decode([ConversationSummary].self, from: data)) ?? []
        index.sort { $0.updated > $1.updated }
    }

    private func persistIndex() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        do {
            let data = try encoder.encode(index)
            try data.write(to: indexURL, options: .atomic)
            writeError = nil
        } catch {
            writeError = "Not saving: \(error.localizedDescription)"
        }
    }

    // ── bodies ───────────────────────────────────────────────────────────────

    private func bodyURL(_ id: UUID) -> URL {
        bodiesDir.appendingPathComponent("\(id.uuidString).json")
    }

    /// Read one conversation's messages. Only called when it is opened.
    public func body(_ id: UUID) -> [StoredMessage] {
        guard let data = try? Data(contentsOf: bodyURL(id)) else { return [] }
        return (try? JSONDecoder().decode([StoredMessage].self, from: data)) ?? []
    }

    /// Create or update a conversation. Title is derived from the first user
    /// message the first time one exists, and never rewritten after — a title
    /// that changes under you as the conversation grows is disorienting.
    @discardableResult
    public func save(id: UUID, messages: [StoredMessage]) -> ConversationSummary {
        var summary: ConversationSummary
        if let i = index.firstIndex(where: { $0.id == id }) {
            summary = index[i]
            summary.updated = Date()
            summary.n = messages.count
            if summary.title == Self.untitled,
               let first = messages.first(where: { $0.role == "user" }) {
                summary.title = Self.title(for: first.text)
            }
            index.remove(at: i)
        } else {
            let first = messages.first(where: { $0.role == "user" })?.text
            summary = ConversationSummary(id: id,
                                          title: first.map(Self.title) ?? Self.untitled,
                                          n: messages.count)
        }
        index.insert(summary, at: 0)          // newest first

        do {
            let data = try JSONEncoder().encode(messages)
            try data.write(to: bodyURL(id), options: .atomic)
            writeError = nil
        } catch {
            writeError = "Not saving: \(error.localizedDescription)"
        }
        persistIndex()
        return summary
    }

    /// Delete is deliberately a two-step in the UI — there is no undo and no
    /// server copy. This is the second step.
    public func delete(_ id: UUID) {
        index.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: bodyURL(id))
        persistIndex()
    }

    // ── titles ───────────────────────────────────────────────────────────────

    public static let untitled = "Untitled"

    /// Byte-for-byte the rule in web/assets/js/chat.js `titleFor`: collapse
    /// whitespace, trim, and if longer than 42 characters cut to 41 and append
    /// an ellipsis.
    public static func title(for text: String) -> String {
        let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if collapsed.isEmpty { return untitled }
        if collapsed.count > titleChars {
            return String(collapsed.prefix(titleChars - 1)) + "…"
        }
        return collapsed
    }
}
