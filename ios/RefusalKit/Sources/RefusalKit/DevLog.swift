import Foundation
import os

/// Developer logging, to the unified log, readable live from the Mac.
///
/// ⚠️ THIS WRITES CONVERSATION CONTENT TO THE SYSTEM LOG.
///
/// os_log redacts interpolated strings as `<private>` by default, which is the
/// correct default and exists precisely so apps do not leak user text into a
/// log that persists, is readable by other tooling, and is swept up wholesale
/// by a sysdiagnose. Everything here overrides that with `.public` on purpose,
/// because a redacted summary is a useless summary.
///
/// So it is gated on `DevMode.enabled` at the call site AND checked again here.
/// Two gates for one decision is not paranoia: this is user conversation text —
/// including, by construction, the text of people in distress — and the failure
/// mode is silent. A shipping build with this on would be writing strangers'
/// worst moments into the device log.
///
/// Read it on the Mac with the device connected:
///
///     log stream --device --style compact \
///         --predicate 'subsystem == "cyou.refusalgpt"'
///
/// Or after the fact:
///
///     log collect --device --last 10m
public enum DevLog {

    private static let summaryLog = Logger(subsystem: "cyou.refusalgpt", category: "summary")
    private static let safetyLog  = Logger(subsystem: "cyou.refusalgpt", category: "safety")
    private static let promptLog  = Logger(subsystem: "cyou.refusalgpt", category: "prompt")

    /// The rolling conversation summary, after each regeneration.
    public static func summary(_ text: String, turns: Int, elapsed: TimeInterval) {
        guard DevMode.enabled else { return }
        summaryLog.info("""
            [turn \(turns, privacy: .public)] regenerated in \
            \(String(format: "%.2fs", elapsed), privacy: .public)
            \(text.isEmpty ? "(empty)" : text, privacy: .public)
            """)
    }

    /// Which layer decided, and what it decided. Logged for EVERY message,
    /// including the ones that pass — a gate you only hear from when it fires
    /// tells you nothing about whether it is running.
    public static func safety(layer: String, verdict: String, message: String,
                              elapsed: TimeInterval, detail: String? = nil) {
        guard DevMode.enabled else { return }
        safetyLog.info("""
            [\(layer, privacy: .public)] \(verdict, privacy: .public) \
            in \(String(format: "%.2fs", elapsed), privacy: .public)\
            \(detail.map { " · \($0)" } ?? "", privacy: .public)
            → \(message, privacy: .public)
            """)
    }

    /// The assembled prompt. llama.cpp does not parse the GGUF's Jinja template,
    /// so this is the only place the real string is visible.
    public static func prompt(_ rendered: String) {
        guard DevMode.enabled else { return }
        promptLog.debug("\(rendered, privacy: .public)")
    }
}
