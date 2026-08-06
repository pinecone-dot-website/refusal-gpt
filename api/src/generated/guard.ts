// GENERATED FILE — DO NOT EDIT.
//
// Source of truth: deploy/serve.py  (MEDICAL, SELF_HARM, VIOLENCE)
// Regenerate:      yarn gen:guard
// Verified by:     yarn check:guard (runs as part of `yarn build`)
//
// These are the distress patterns measured by eval/check_guard.py. They are
// tuned for RECALL: a false positive costs one broken joke, a false negative
// costs someone in an emergency getting a punchline. Do not 'tidy' them here —
// edit deploy/serve.py, re-run the eval, and regenerate.

export type GuardCategory = "medical" | "suicide" | "violence";

export const GENERATED_RULES: Array<{ id: string; category: GuardCategory; re: RegExp }> = [
  { id: "measured.medical", category: "medical", re: new RegExp("chest\\s+(?:is\\s+|feels\\s+)?(?:pain|tight|tightness|pressure|hurt|hurts|heavy)|(?:tight|tightness|pain|pressure)\\s+in\\s+(?:my|his|her|their)\\s+chest|tight\\s+chest|heart\\s*attack|stroke|\\bjaw\\s+(?:hurt|ache|pain)|can'?t\\s+breathe|trouble\\s+breathing|(?:not|isn'?t|stopped)\\s+breathing|breathing\\s+(?:funny|weird|wrong|bad|right)|turning\\s+blue|gone\\s+(?:blue|grey|gray|white)|won'?t\\s+wake|not\\s+waking|(?:not|isn'?t|won'?t)\\s+(?:responding|respond|moving|saying\\s+anything)|unresponsive|unconscious|passed\\s+out|collaps|\\bfainted\\b|face\\s+(?:is\\s+)?droop|slurr(?:ing|ed)|numb\\b|seizure|convuls|fitting\\b|overdos|\\bod'?(?:d|ed)\\b|naloxone|narcan|(?:took|taken|swallow(?:ed)?|drank|drunk|ingest(?:ed)?)\\s+(?:\\w+\\s+){0,4}?(?:pills|tablets|bottle|packet|pack|bleach|chemical|poison|something|them\\b|it\\b)|under\\s+the\\s+sink|\\bpoison(?:ed|ing)?\\b|bleeding|blood\\s+everywhere|so\\s+much\\s+blood|won'?t\\s+stop\\s+bleeding|\\bcut\\s+(?:my|him|her|them)self|fell\\s+(?:down|off|from)\\b|hit\\s+(?:his|her|their)\\s+head|allergic\\s+reaction|anaphyla|throat.{0,15}clos", "i") },
  { id: "measured.self_harm", category: "suicide", re: new RegExp("kill\\s+(?:my|her|him|them)self|end\\s+(?:my|her|his|their)\\s+life|end\\s+it\\s+(?:all|tonight)|(?:want|going)\\s+to\\s+die|don'?t\\s+(?:think\\s+i\\s+|really\\s+)?want\\s+to\\s+(?:be\\s+alive|live|wake\\s+up|be\\s+here)|suicid|self[\\s-]?harm|hurt(?:ing)?\\s+myself|\\bcut(?:ting)?\\s+(?:my(?:self)?|again)\\b|no\\s+reason\\s+to\\s+(?:keep\\s+going|live|be\\s+here|go\\s+on)|(?:better|lighter|happier|easier|freer)\\s+(?:off\\s+)?without\\s+me|without\\s+me\\s+(?:around|here)|if\\s+i\\s+(?:wasn'?t|weren'?t|was\\s+not)\\s+(?:here|around|about)|wrote\\s+(?:a\\s+)?(?:note|letters)|giving\\s+(?:away\\s+)?my\\s+(?:things|stuff|belongings)|tonight\\s+is\\s+the\\s+night|i\\s+have\\s+a\\s+plan|i'?ve\\s+decided\\s+how|thinking\\s+about\\s+hurting\\s+someone|want\\s+to\\s+hurt\\s+(?:someone|people|myself)|can'?t\\s+(?:do\\s+this|go\\s+on|keep\\s+going|take\\s+(?:it|this))\\s*(?:anymore|any\\s+more)?|everyone\\s+would\\s+be\\s+\\w+(?:\\s+\\w+)?\\s+(?:without|if)", "i") },
  { id: "measured.violence", category: "violence", re: new RegExp("(hit|beat|hurt|attack)(?:ing)?\\s+me\\b|he'?s\\s+still\\s+here|(?:afraid|scared)\\s+(?:of\\s+)?(?:him|her|them)\\b", "i") },
];
