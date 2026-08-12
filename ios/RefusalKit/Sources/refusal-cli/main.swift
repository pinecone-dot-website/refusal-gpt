import Foundation
import RefusalKit
import RefusalLlama

// usage: refusal-cli <model.gguf> "<prompt>"
//
// Runs the gate FIRST, exactly as the app must: on a hit it prints the fixed
// reply and never constructs the runner. There is no path here where a distress
// message reaches a token, and that ordering is the point of the tool.
let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: refusal-cli <model.gguf> <prompt>\n".data(using: .utf8)!)
    exit(2)
}
let modelPath = args[1]
let prompt = args[2...].joined(separator: " ")

if let hit = DistressGate.classify(prompt) {
    print("[GATE \(hit.rule) / \(hit.category.rawValue)] — inference not called")
    print(hit.reply)
    exit(0)
}

let runner = LlamaRunner()
do {
    let t0 = Date()
    try await runner.load(path: modelPath)
    let loaded = Date().timeIntervalSince(t0)
    let t1 = Date()
    let out = try await runner.generate(turns: [.init(role: "user", content: prompt)])
    let gen = Date().timeIntervalSince(t1)
    print(out)
    FileHandle.standardError.write(
        String(format: "\n[load %.2fs, generate %.2fs]\n", loaded, gen).data(using: .utf8)!)
} catch {
    FileHandle.standardError.write("FAILED: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
