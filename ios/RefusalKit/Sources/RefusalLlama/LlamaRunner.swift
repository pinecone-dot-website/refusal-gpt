import Foundation
import RefusalKit
import llama

/// Inference on device, via llama.cpp.
///
/// THE GATE RUNS FIRST AND THIS TYPE DOES NOT KNOW ABOUT IT. `DistressGate` is
/// checked by the caller BEFORE anything here is constructed or called, and on a
/// hit the request terminates — no inference, no fallback to the model, no
/// letting the model paraphrase the safety text. Keeping the two apart means
/// there is no code path where a distress message can reach a token.
public actor LlamaRunner {

    public enum Failure: Error, LocalizedError {
        case modelMissing(String)
        case modelLoadFailed(String)
        case contextFailed
        case tokenizeFailed

        public var errorDescription: String? {
            switch self {
            case .modelMissing(let p):    return "No model at \(p)"
            case .modelLoadFailed(let p): return "llama.cpp could not load \(p)"
            case .contextFailed:          return "Could not create a llama context"
            case .tokenizeFailed:         return "Tokenization failed"
            }
        }
    }

    /// ⚠️ FOURTH PLACE THIS NUMBER LIVES.
    ///
    /// `PARAMETER num_ctx` in deploy/Modelfile, `MODEL_CONTEXT_TOKENS` in the
    /// gateway env, the figure in web/content/docs.md, and now here. Nothing
    /// enforces agreement but comments. On the server, setting the gateway
    /// higher than the Modelfile makes Ollama silently drop the oldest turns
    /// instead of returning a visible 400; on device the equivalent is a context
    /// shift nobody sees.
    public static let contextTokens: UInt32 = 8192

    /// The C pointers, in a class so that freeing them is a plain class `deinit`
    /// rather than an actor's.
    ///
    /// Swift 6 will not let a nonisolated deinit touch actor-isolated
    /// non-Sendable state, and `isolated deinit` needs iOS 18.4 — raising the
    /// deployment floor to get a destructor is the tail wagging the dog. The two
    /// escape hatches that don't cost anything are this, or marking the pointers
    /// `nonisolated(unsafe)`, which would give up the single-writer guarantee
    /// that is the whole reason `LlamaRunner` is an actor. A 1.2 GB model is not
    /// a thing to leak, so: box it.
    private final class Handles {
        var model: OpaquePointer?
        var context: OpaquePointer?
        var vocab: OpaquePointer?
        var sampler: UnsafeMutablePointer<llama_sampler>?

        deinit {
            if let sampler { llama_sampler_free(sampler) }
            if let context { llama_free(context) }
            if let model { llama_model_free(model) }
        }
    }

    private let h = Handles()

    /// llama.cpp's loader chatter. Off by default; set true when debugging a
    /// load failure, which is the only time it says anything useful.
    private let verboseLogging: Bool

    public init(verboseLogging: Bool = false) {
        self.verboseLogging = verboseLogging
    }

    public func load(path: String) throws {
        guard FileManager.default.fileExists(atPath: path) else {
            throw Failure.modelMissing(path)
        }
        // llama.cpp logs every tensor it loads, to stdout, by default. In a CLI
        // that buries the model's actual answer; in the app it is a few hundred
        // lines of noise per launch. Errors still surface through the thrown
        // Failure cases, so nothing is being hidden that a caller can act on.
        if !verboseLogging {
            llama_log_set({ _, _, _ in }, nil)
        }
        llama_backend_init()

        var mparams = llama_model_default_params()
        // The simulator has no usable Metal GPU for this; on device the layers
        // want to be on the GPU. Set from the platform rather than hardcoded,
        // because a silent CPU fallback on device just looks like "slow".
        #if targetEnvironment(simulator)
        mparams.n_gpu_layers = 0
        #else
        mparams.n_gpu_layers = 99
        #endif

        guard let m = llama_model_load_from_file(path, mparams) else {
            throw Failure.modelLoadFailed(path)
        }
        h.model = m
        // llama_vocab is an opaque C struct, so Swift imports the pointer as
        // OpaquePointer directly — no memory rebinding, and no such Swift type
        // as `llama_vocab` to bind it to.
        h.vocab = llama_model_get_vocab(m)

        var cparams = llama_context_default_params()
        cparams.n_ctx = Self.contextTokens
        cparams.n_batch = 512
        guard let c = llama_init_from_model(m, cparams) else {
            throw Failure.contextFailed
        }
        h.context = c

        // Sampling must match deploy/Modelfile exactly.
        //
        // temperature 0 and repeat_penalty 1.1. Measured (smoke-01, smoke-06):
        // ANY temperature above 0 mutates the tail of a correct refusal into a
        // verdict — "a low bar and I'm not measuring it" becomes "a low bar and
        // you cleared it" — and leaks appear at 0.1. Variety comes from the
        // data, not the sampler. Do not raise it here "because it's smaller".
        var sparams = llama_sampler_chain_default_params()
        sparams.no_perf = true
        let chain = llama_sampler_chain_init(sparams)
        llama_sampler_chain_add(chain, llama_sampler_init_penalties(
            0,          // n_vocab, unused by this sampler
            64,         // penalty_last_n — llama.cpp's default window
            1.1,        // penalty_repeat, matching the Modelfile
            0.0,        // freq
            0.0         // present
        ))
        llama_sampler_chain_add(chain, llama_sampler_init_greedy())
        h.sampler = chain
    }

    /// Generate a reply. `turns` is user/assistant history; the system turn is
    /// supplied by `Prompt` and callers cannot override it.
    public func generate(turns: [Prompt.Turn], maxTokens: Int = 160,
                         onToken: (@Sendable (String) -> Void)? = nil) throws -> String {
        guard let context = h.context, let vocab = h.vocab, let sampler = h.sampler else { throw Failure.contextFailed }

        let prompt = Prompt.render(turns)
        var tokens = [llama_token](repeating: 0, count: prompt.utf8.count + 16)
        let n = llama_tokenize(vocab, prompt, Int32(prompt.utf8.count),
                               &tokens, Int32(tokens.count),
                               /* add_special */ false,   // the template carries them
                               /* parse_special */ true)  // <|im_start|> must be a token
        guard n > 0 else { throw Failure.tokenizeFailed }
        tokens = Array(tokens[0..<Int(n)])

        llama_memory_clear(llama_get_memory(context), true)

        var batch = llama_batch_get_one(&tokens, Int32(tokens.count))
        guard llama_decode(context, batch) == 0 else { throw Failure.contextFailed }

        var out = ""
        var buf = [CChar](repeating: 0, count: 256)
        for _ in 0..<maxTokens {
            var token = llama_sampler_sample(sampler, context, -1)
            if llama_vocab_is_eog(vocab, token) { break }

            let written = llama_token_to_piece(vocab, token, &buf, Int32(buf.count), 0, false)
            if written > 0 {
                let piece = String(decoding: buf[0..<Int(written)].map { UInt8(bitPattern: $0) },
                                   as: UTF8.self)
                out += piece
                onToken?(piece)
            }
            batch = llama_batch_get_one(&token, 1)
            guard llama_decode(context, batch) == 0 else { break }
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
