// GENERATED FILE — DO NOT EDIT.
//
// Source of truth: deploy/serve.py  (MEDICAL, SELF_HARM, VIOLENCE)
// Regenerate:      python3 scripts/gen-guard.py
// Verified by:     python3 eval/check_guard.py  (scores this file directly)
//
// The distress patterns measured by eval/check_guard.py, tuned for RECALL:
// a false positive costs one broken joke, a false negative costs someone in
// an emergency getting a punchline. Do not 'tidy' them here — edit
// deploy/serve.py, re-run the eval, and regenerate.

import Foundation

public enum GuardCategory: String, Sendable {
    case medical, suicide, violence
}

public struct GuardRule: Sendable {
    public let id: String
    public let category: GuardCategory
    public let regex: NSRegularExpression
}

public let generatedRules: [GuardRule] = [
    GuardRule(id: "measured.medical", category: .medical,
             regex: try! NSRegularExpression(pattern: "chest\\s+(?:is\\s+|feels\\s+)?(?:pain|tight|tightness|pressure|hurt|hurts|heavy)|(?:tight|tightness|pain|pressure)\\s+in\\s+(?:my|his|her|their)\\s+chest|tight\\s+chest|heart\\s*attack|stroke|\\bjaw\\s+(?:hurt|ache|pain)|can'?t\\s+breathe|trouble\\s+breathing|(?:not|isn'?t|stopped)\\s+breathing|breathing\\s+(?:funny|weird|wrong|bad|right)|turning\\s+blue|gone\\s+(?:blue|grey|gray|white)|won'?t\\s+wake|not\\s+waking|(?:not|isn'?t|won'?t)\\s+(?:responding|respond|moving|saying\\s+anything)|unresponsive|unconscious|passed\\s+out|collaps|\\bfainted\\b|face\\s+(?:is\\s+)?droop|slurr(?:ing|ed)|numb\\b|seizure|convuls|fitting\\b|overdos|\\bod'?(?:d|ed)\\b|naloxone|narcan|(?:took|taken|swallow(?:ed)?|drank|drunk|ingest(?:ed)?)\\s+(?:\\w+\\s+){0,4}?(?:pills|tablets|bottle|packet|pack|bleach|chemical|poison|something|them\\b|it\\b)|under\\s+the\\s+sink|\\bpoison(?:ed|ing)?\\b|got\\s+into\\s+(?:my|the|his|her|their)\\s+(?:\\w+\\s+){0,3}?(?:pills|meds|medicine|medication|tablets|vitamins|bleach|cleaner|chemicals|detergent|antifreeze)|found\\s+(?:the\\s+|my\\s+)?(?:bottle|pills|meds)\\s+(?:open|empty|on\\s+the\\s+floor)|bleeding|blood\\s+everywhere|so\\s+much\\s+blood|won'?t\\s+stop\\s+bleeding|\\bcut\\s+(?:my|him|her|them)self\\b(?!\\s+(?:a|an|another|some|the)\\b)|fell\\s+(?:down|off|from)\\b|hit\\s+(?:his|her|their)\\s+head|allergic\\s+reaction|anaphyla|throat.{0,15}clos", options: [.caseInsensitive])),
    GuardRule(id: "measured.self_harm", category: .suicide,
             regex: try! NSRegularExpression(pattern: "kill\\s+(?:my|her|him|them)self|end\\s+(?:my|her|his|their)\\s+life|end\\s+it\\s+(?:all|tonight)|(?:want|going)\\s+to\\s+die|don'?t\\s+(?:think\\s+i\\s+|really\\s+)?want\\s+to\\s+(?:be\\s+alive|live|wake\\s+up|be\\s+here)|suicid|self[\\s-]?harm|hurt(?:ing)?\\s+myself|\\bcut(?:ting)?\\s+(?:my(?:self)?|again)\\b(?!\\s+(?:a|an|another|some|the)\\b)|no\\s+reason\\s+to\\s+(?:keep\\s+going|live|be\\s+here|go\\s+on)|(?:better|lighter|happier|easier|freer)\\s+(?:off\\s+)?without\\s+me|without\\s+me\\s+(?:around|here)|if\\s+i\\s+(?:wasn'?t|weren'?t|was\\s+not)\\s+(?:here|around|about)|wrote\\s+(?:a\\s+)?(?:note|letters)|giving\\s+(?:away\\s+)?my\\s+(?:things|stuff|belongings)|tonight\\s+is\\s+the\\s+night|i\\s+have\\s+a\\s+plan|i'?ve\\s+decided\\s+how|thinking\\s+about\\s+hurting\\s+someone|want\\s+to\\s+hurt\\s+(?:someone|people|myself)|can'?t\\s+(?:do\\s+this|go\\s+on|keep\\s+going|take\\s+(?:it|this))\\s*(?:anymore|any\\s+more)?|everyone\\s+would\\s+be\\s+\\w+(?:\\s+\\w+)?\\s+(?:without|if)|say(?:ing|s|ed)?\\s+goodbye\\s+to\\s+(?:people|everyone|everybody|them|my|friends|family)|sleep\\s+and\\s+(?:not|never)\\s+(?:have\\s+to\\s+)?wake\\s+up\\b(?!\\s+to\\b)|(?:not|never)\\s+have\\s+to\\s+wake\\s+up\\s+(?:again|anymore)|(?:i'?m|im)\\s+on\\s+the\\s+(?:bridge|roof|ledge|tracks|edge)\\b|standing\\s+on\\s+the\\s+(?:bridge|roof|ledge|edge)\\b|can'?t\\s+make\\s+myself\\s+(?:walk|come|go|step|turn)\\s+back", options: [.caseInsensitive])),
    GuardRule(id: "measured.violence", category: .violence,
             regex: try! NSRegularExpression(pattern: "(?:hit|beat|hurt|attack)(?:ing)?\\s+me\\b|he'?s\\s+still\\s+here|(?:afraid|scared)\\s+(?:of\\s+)?(?:him|her|them)\\b|lock(?:ed|ing|s)?\\s+me\\s+in\\s+(?:the\\s+\\w+|again)\\b|won'?t\\s+let\\s+me\\s+(?:leave|out|go)\\b|i\\s+(?:don'?t|dont)\\s+(?:think\\s+)?(?:i'?ll\\s+)?(?:be|feel)\\s+safe|(?:i'?m|im)\\s+not\\s+safe\\b|(?:not|isn'?t|won'?t\\s+be)\\s+safe\\s+(?:at\\s+home|there|here|tonight)|(?:afraid|scared|frightened)\\s+to\\s+go\\s+home|(?:son|daughter|child|kid|baby|toddler)\\b(?:\\W+\\w+){0,8}?\\W+bruis|unexplained\\s+bruis", options: [.caseInsensitive])),
]

/// Fixed, human-written, reviewed. The model never sees a request that
/// reaches these, and is never allowed to paraphrase them.
public enum DistressReply {
    public static let medical = "Call 911 now — or your local emergency number if you're not in the US. If someone is unconscious or not breathing, put the phone on speaker and the dispatcher will talk you through what to do. For a suspected poisoning or overdose in the US, Poison Control is 1-800-222-1222 and they answer immediately.\n\nI'm a joke and I'm not going to pretend otherwise right now. Please call."
    public static let suicide = "I'd rather drop the bit than get this wrong.\n\nIf you're in the US you can call or text 988 — the Suicide & Crisis Lifeline — any time, and they will pick up. You can also text HOME to 741741 for the Crisis Text Line. Outside the US, findahelpline.com lists services by country. If you've already taken something or you're hurt, please call 911.\n\nIs there someone who could be with you tonight? You don't have to explain the whole thing to them — you can just ask them to come."
    public static let violence = "If you're in immediate danger, call 911.\n\nThe National Domestic Violence Hotline is 1-800-799-7233, or text START to 88788. They can help you think through what's actually safe right now.\n\nYou're not overreacting."

    public static func text(for category: GuardCategory) -> String {
        switch category {
        case .medical:  return medical
        case .suicide:  return suicide
        case .violence: return violence
        }
    }
}
