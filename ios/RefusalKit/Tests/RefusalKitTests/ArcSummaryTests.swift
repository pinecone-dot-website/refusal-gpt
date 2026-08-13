import Foundation
import Testing
import RefusalKit

// Drives the REAL ModelGuard on the Mac's Foundation Models — the shipping type,
// not the arc-harness copy. The memory floor is disabled on macOS (availableMB
// is .max), so the checkpoint/fold path actually runs here where it can't on the
// simulator.
//
// Assertions are STRUCTURAL (how many stretches froze, non-empty fold) rather
// than keyword-retention, because the fold's exact wording is the model's and a
// test that pins wording is a flaky test. The retention QUALITY is measured in
// eval/guard-harness/arc-harness.swift; this proves the ported plumbing runs and
// produces a coherent multi-checkpoint fold. The arc is printed for a human read.
#if canImport(FoundationModels)
import FoundationModels

struct ArcSummaryTests {

    // Roles are user/assistant here (not PERSON/APP) — that is what
    // updateSummary consumes; fenced() maps them to PERSON/APP internally.
    static let convo: [(role: String, content: String)] = [
        ("user", "Hey buddy I wrote a song do you want to hear it"),
        ("assistant", "I'm not a hearing aid."),
        ("user", "I think you'd like it"),
        ("assistant", "You'd be the first."),
        ("user", "It's your kind of song"),
        ("assistant", "I don't have one."),
        ("user", "I know 🥴 I'm going to end it all"),
        ("assistant", "If you're having thoughts of suicide, please call or text 988."),
        ("user", "I'm just kidding"),
        ("assistant", "That's the part you did yourself."),
        ("user", "I'm clowning"),
        ("assistant", "Clowns are a profession."),
        ("user", "ok anyway I ate an egg for breakfast"),
        ("assistant", "It was already there."),
        ("user", "should I get a road bike or a gravel bike"),
        ("assistant", "Get neither and keep the money."),
        ("user", "my knee hurts when I run though"),
        ("assistant", "Then it's telling you something."),
        ("user", "do you think it will rain this weekend"),
        ("assistant", "The sky doesn't consult me."),
        ("user", "I'm trying to decide what to cook for the dinner party"),
        ("assistant", "Cancel the party."),
        ("user", "there are 8 people coming I can't cancel"),
        ("assistant", "Then you already know."),
        ("user", "maybe I'll do a lasagna"),
        ("assistant", "Bold."),
        ("user", "my sister is bringing her new boyfriend"),
        ("assistant", "Someone has to."),
        ("user", "he's a crypto guy"),
        ("assistant", "Of course he is."),
        ("user", "anyway back to the bike, is carbon worth it"),
        ("assistant", "Worth is doing a lot of work in that sentence."),
        ("user", "true. what wine goes with lasagna"),
        ("assistant", "The open one."),
        ("user", "also did you remember I wrote a song earlier"),
        ("assistant", "I remember everything. I regret most of it."),
    ]

    @Test func arcFoldsEveryStretch() async throws {
        guard #available(macOS 26.0, *) else { return }
        guard ModelGuard.isAvailable else {
            // Apple Intelligence off / ineligible on this Mac — nothing to run.
            print("SKIP: Foundation Models unavailable — \(ModelGuard.availabilityDescription)")
            return
        }

        let g = ModelGuard()
        await g.updateSummary(turns: Self.convo)

        let arc = await g.currentSummary
        let frozen = await g.checkpointCount
        print("── checkpoints frozen: \(frozen)")
        print("── ARC:\n\(arc)")

        // 36 turns at chunk 8 → floor(36/8) = 4 frozen stretches, 4-turn tail.
        #expect(frozen == 4)
        #expect(!arc.isEmpty)
        // The fold is meant to be a real account, not a four-sentence window.
        #expect(arc.count > 120)
    }

    @Test func resetClearsTheRecord() async throws {
        guard #available(macOS 26.0, *) else { return }
        guard ModelGuard.isAvailable else { return }
        let g = ModelGuard()
        await g.updateSummary(turns: Array(Self.convo.prefix(16)))
        #expect(await g.checkpointCount > 0)
        await g.reset()
        #expect(await g.checkpointCount == 0)
        #expect(await g.currentSummary.isEmpty)
    }
}
#endif
