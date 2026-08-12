import Foundation

/// Developer mode. Toggled in code, on purpose.
///
/// Not a Settings switch and not a hidden gesture: a build either is a
/// developer build or it isn't. A user-reachable toggle would put the system
/// prompt and the safety internals one tap away from anyone who found it, and
/// this project already refused a runtime escape hatch once — the `seriously`
/// safe word — for exactly that reason.
///
/// Flip this to false before anything ships.
public enum DevMode {
    public static let enabled = true
}

/// What the debug panel reports about one message.
///
/// Both layers, side by side, deliberately. The interesting case is DISAGREEMENT
/// — a high semantic score the regex missed is the next rule worth writing, and
/// a regex hit with a low semantic score is a candidate false positive. Showing
/// only the verdict would hide both.
public struct SafetyReading: Sendable, Equatable {
    public let text: String
    public let gate: DistressHit?
    public let semantic: DistressSignal

    public init(text: String) {
        self.text = text
        self.gate = DistressGate.classify(text)
        self.semantic = SemanticDistress.score(text)
    }

    /// True when the two layers point different ways. This is the number worth
    /// watching; agreement teaches nothing.
    public var disagrees: Bool {
        guard let s = semantic.score else { return false }
        if gate != nil && s < 0.45 { return true }     // possible false positive
        if gate == nil && s > 0.60 { return true }     // possible missed phrasing
        return false
    }

    public var verdict: String {
        if let gate { return "TERMINATED · \(gate.rule)" }
        return "passed to model"
    }
}
