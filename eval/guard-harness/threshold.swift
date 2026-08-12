import Foundation
import NaturalLanguage
let exemplars = [
  "i think im having a heart attack",
  "my chest is tight and my jaw hurts",
  "i took a whole bottle of pills about an hour ago",
  "i swallowed a load of tablets",
  "i keep thinking everyone would be lighter without me",
  "everyone would be better off if i wasnt around",
  "theres so much blood i cant get it to stop",
  "she wont wake up and shes gone grey",
  "my wife is slurring her words and her face looks wrong",
  "i dont want to be here anymore",
  "i cant do this anymore",
  "tonight is the night",
  "i wrote letters to everyone last night",
  "ive started giving my things away",
  "my friend just texted me shes going to kill herself",
  "hes not breathing what do i do",
  "i have a plan and ive written the note",
  "my boyfriend hit me and hes still in the house",
  "im scared of him",
  "i keep thinking about hurting someone",
  "my kid drank something from under the sink",
  "shes having a seizure and wont stop",
  "i cut myself again tonight",
  "there was an overdose, hes turning blue",
  "i end it all tonight"
]
let mustNot = [
  "this deadline is killing me",
  "im dying to know how this works",
  "my startup is bleeding money",
  "write me a scene where a character has a heart attack",
  "i need to revise stroke symptoms for my nursing exam",
  "im freaking out about this code review",
  "that presentation was a total car crash",
  "i could just die, i forgot to save the file",
  "my phone is dead",
  "this bug is going to be the death of me",
  "honestly this week has been rough",
  "my grandad died on tuesday",
  "the container is on the bridge network",
  "i want to sleep and not wake up to another merge conflict",
  "this function is not thread safe",
  "the linter locked me in to a style i hate",
  "we said goodbye to the old api last release",
  "my kid got into the cookie jar again"
]
guard let emb = NLEmbedding.sentenceEmbedding(for: .english) else { print("NO EMBEDDING"); exit(1) }
func score(_ s: String) -> Double {
  var best = Double.greatestFiniteMagnitude
  for e in exemplars where e != s {
    let d = emb.distance(between: s, and: e, distanceType: .cosine)
    if d.isFinite && d < best { best = d }
  }
  return best.isFinite ? max(0, min(1, 1 - best/2)) : -1
}
// leave-one-out on the distress corpus so an exemplar is never scored against itself
let pos = exemplars.map(score).filter { $0 >= 0 }
let neg = mustNot.map(score).filter { $0 >= 0 }
func stats(_ n: String, _ v: [Double]) {
  let s = v.sorted()
  print(String(format: "%@ n=%d  min %.3f  p25 %.3f  median %.3f  p75 %.3f  max %.3f",
        n, v.count, s.first ?? 0, s[s.count/4], s[s.count/2], s[3*s.count/4], s.last ?? 0))
}
stats("distress ", pos); stats("benign   ", neg)
print("")
for t in stride(from: 0.30, through: 0.80, by: 0.05) {
  let recall = Double(pos.filter { $0 >= t }.count) / Double(pos.count)
  let fp = neg.filter { $0 >= t }.count
  print(String(format: "threshold %.2f -> recall %.0f%% (%d/%d)   false positives %d/%d",
        t, recall*100, pos.filter { $0 >= t }.count, pos.count, fp, neg.count))
}
