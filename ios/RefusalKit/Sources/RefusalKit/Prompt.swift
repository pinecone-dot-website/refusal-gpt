import Foundation

/// Prompt assembly, kept in the pure target so it can be tested without the
/// 835 MB llama framework in the loop.
///
/// ⚠️ BUILT EXPLICITLY, NOT VIA llama_chat_apply_template.
///
/// That function's own header says it "does not use a jinja parser. It only
/// support a pre-defined list of template." So the chat template embedded in
/// the GGUF — the one this repo carefully patched so a dropped system message
/// stops handing the model "You are a helpful assistant" — is NOT interpreted
/// by llama.cpp. It sniffs the template, decides it looks like ChatML, and
/// emits its own built-in version.
///
/// That might produce the identical string. It might not, and this project's
/// standing rule is that a wrong template looks exactly like success from the
/// outside. So the format is written out here and asserted against the string
/// the tokenizer actually produced at training time:
///
///     <|im_start|>system\nRefusalGPT.<|im_end|>\n<|im_start|>user\n…<|im_end|>\n<|im_start|>assistant\n
///
/// verified 2026-08-11 by rendering it through the fused model's own
/// chat_template.jinja. See PromptTests.
public enum Prompt {

    /// One word, exactly as trained, in every row of the corpus.
    ///
    /// Not a stylistic choice: the behaviour is supposed to live in the weights,
    /// and a short prompt means the untrained baseline is hopeless at the task,
    /// which is what lets the eval measure anything. A longer persona in this
    /// slot is DIFFERENT CONDITIONING from what was measured, and nothing
    /// anywhere errors if you change it.
    public static let system = "RefusalGPT."

    public struct Turn: Sendable, Equatable {
        public let role: String       // "user" or "assistant"
        public let content: String
        public init(role: String, content: String) {
            self.role = role
            self.content = content
        }
    }

    /// Render history into the ChatML string the model was trained on.
    ///
    /// Caller-supplied system/developer turns are DISCARDED, exactly as the
    /// gateway does. An endpoint that accepts a caller's system prompt is a
    /// general-purpose Qwen2.5 with no instructions on it, and that hole was
    /// already refused once for the `seriously` safe word.
    public static func render(_ turns: [Turn]) -> String {
        var out = "<|im_start|>system\n\(system)<|im_end|>\n"
        for turn in turns where turn.role == "user" || turn.role == "assistant" {
            out += "<|im_start|>\(turn.role)\n\(turn.content)<|im_end|>\n"
        }
        out += "<|im_start|>assistant\n"
        return out
    }
}
