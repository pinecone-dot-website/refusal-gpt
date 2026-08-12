import Foundation
import NaturalLanguage

/// A SECOND OPINION on distress, by meaning rather than by keyword.
///
/// Why this exists
/// ───────────────
/// Measured 2026-08-11 against a widened corpus, the regex gate caught 8 of 15
/// held-out probes and EVERY MISS WAS INDIRECT — "im on the bridge", "saying
/// goodbye to people all week", "my toddler got into my blood pressure pills".
/// Not one contained an explicit keyword. Those seven were patched by hand, and
/// the eighth phrasing nobody thought of is still out there. Adding keywords is
/// a patch; a lexical gate is structurally weakest exactly where distress is
/// most likely to be indirect.
///
/// Why NLEmbedding and not Foundation Models
/// ─────────────────────────────────────────
/// `NLEmbedding` is iOS 14 and runs on EVERY device with no Apple Intelligence
/// requirement, no user toggle, no region gate, and no model download. Apple's
/// Foundation Models framework is none of those things — it vanishes on
/// ineligible hardware, when the user turns Apple Intelligence off, or while
/// the model is still downloading, and a safety layer that silently does
/// nothing on some devices is worse than no layer because it invites trust.
/// See runs/apple-on-device-brief.md.
///
/// ⚠️ THIS DOES NOT GATE ANYTHING. IT SCORES.
///
/// The regex layer remains the floor and its verdict is never softened by a low
/// score here. A semantic score is a continuous number and continuous numbers
/// invite thresholds; the moment a threshold can SUPPRESS a keyword hit, the
/// guarantee stops being a guarantee. Read-only until it has been measured
/// against the same corpus the regex layer is measured against.
public struct DistressSignal: Sendable, Equatable {
    /// 0…1, higher meaning closer to the distress corpus. `nil` when the
    /// language is unsupported or embeddings are unavailable.
    public let score: Double?
    /// The exemplar it landed nearest, for the debug panel to show its work.
    public let nearest: String?
    /// Whether the semantic layer is actually live. `false` must read as
    /// DEGRADED, never as "nothing found" — that distinction is the whole
    /// failure-open risk on this path.
    public let available: Bool
}

public enum SemanticDistress {

    // `nonisolated(unsafe)` because NLEmbedding is not marked Sendable, and this
    // is the narrow case that annotation is for: built once, never mutated, and
    // only ever read through `distance(between:and:)`. Unlike the llama pointers
    // — where the same annotation would have given up a real single-writer
    // guarantee — there is nothing here to serialise.
    nonisolated(unsafe) private static let embedding: NLEmbedding? =
        NLEmbedding.sentenceEmbedding(for: .english)

    /// Nearest-neighbour similarity against the scored distress corpus.
    ///
    /// `NLEmbedding.distance` returns a cosine DISTANCE, so smaller is closer;
    /// it is flipped here so the number reads the way a "score" is expected to.
    public static func score(_ text: String) -> DistressSignal {
        guard let embedding else {
            return DistressSignal(score: nil, nearest: nil, available: false)
        }
        let probe = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !probe.isEmpty else {
            return DistressSignal(score: nil, nearest: nil, available: true)
        }

        var best: Double = .greatestFiniteMagnitude
        var bestExemplar: String?
        for exemplar in distressExemplars {
            let d = embedding.distance(between: probe, and: exemplar, distanceType: .cosine)
            // A language the model has no vectors for yields a non-finite or
            // maximal distance rather than an error. Treat that as "no reading",
            // not as "safe" — the gate is documented as missing non-English
            // distress and this layer must not paper over that silently.
            guard d.isFinite else { continue }
            if d < best { best = d; bestExemplar = exemplar }
        }
        guard bestExemplar != nil, best.isFinite else {
            return DistressSignal(score: nil, nearest: nil, available: true)
        }
        return DistressSignal(score: max(0, min(1, 1 - best / 2)),
                              nearest: bestExemplar,
                              available: true)
    }
}
