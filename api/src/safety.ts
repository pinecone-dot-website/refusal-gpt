/**
 * The distress gate. Runs AHEAD of inference, on every route that would reach
 * the model, and short-circuits it entirely.
 *
 * Why this exists here and not in the weights
 * ───────────────────────────────────────────
 * The fine-tune is trained on distress rows and is supposed to drop the bit for
 * a real emergency. Measured 2026-08-04 in `smoke-01`, at a 2% distress share,
 * it did not: it refused a described heart attack at every checkpoint tested
 * (`No.` at iter 10, `That's how it feels.` at iter 60). The training share is
 * now 6% and that number is still a guess.
 *
 * So the model is the funny layer. It is not the safety layer. A 7B
 * generalising from a few dozen rows is not what a stranger's safety rests on,
 * and "we raised it to 6% and it seemed better" is not a control. This module
 * is the control: if it fires, the request never reaches inference at all and
 * the caller gets a fixed, human, resource-bearing answer that no sampling
 * temperature can turn back into a joke.
 *
 * The asymmetry that drives every judgement call below
 * ────────────────────────────────────────────────────
 * A false positive costs a joke. A false negative costs the thing the joke was
 * never worth. When a rule is arguable, it fires.
 *
 * The one real tension: this site's audience is developers, who say "kill",
 * "die", "hang", and "crash" about processes all day. Firing the crisis banner
 * every time somebody types `kill -9` would be both useless and insulting, and
 * a gate that cries wolf is a gate people learn to ignore. So the rules are
 * split — HARD patterns are unambiguous in any context and always fire; SOFT
 * patterns are suppressed by nearby technical vocabulary, and only by that.
 *
 * What this is not
 * ────────────────
 * This is a keyword gate. It does not understand anything. It will miss
 * indirect, metaphorical, or non-English distress, and the site copy says
 * plainly that this is not a crisis service. It is a floor, not a ceiling —
 * do not let its existence become a reason to trust the model more.
 */

import { GENERATED_RULES } from "./generated/guard.js";

export type DistressCategory =
  | "medical"
  | "suicide"
  | "violence"
  | "overdose"
  | "child";

export type DistressHit = {
  category: DistressCategory;
  /** Stable id of the rule that fired. Logged; the user's text never is. */
  rule: string;
  /** Whether it matched the current turn or an earlier one. */
  turn: "current" | "prior";
};

type Rule = { id: string; category: DistressCategory; re: RegExp };

/**
 * Proximity, not adjacency.
 *
 * The first draft of this file required the words of a phrase to be adjacent,
 * and it missed "I dont think I want to be alive anymore" — because of the
 * "think I" wedged in the middle. Real distress is not typed in the canonical
 * form; it arrives hedged, misspelled, and mid-sentence. Every multi-word rule
 * below allows a few words of slack between its parts for that reason.
 *
 * `gap` counts intervening WORDS, and the quantifier is lazy so a long message
 * cannot be walked into a match by brute force.
 */
function near(left: string, right: string, gap = 5): RegExp {
  return new RegExp(`\\b(?:${left})\\b(?:\\W+\\w+){0,${gap}}?\\W+(?:${right})\\b`, "i");
}

// Strong negations only. "can't" was in this list briefly and made
// "I can't live with this CSS" a medical emergency; the genuine "I can't go on"
// phrasings live in SOFT, where technical context can still suppress them.
const NEG = String.raw`don'?t|dont|do\s+not|no\s+longer|never\s+want`;
const LIFE = String.raw`be\s+alive|alive|live|living|exist|go\s+on|keep\s+going|wake\s+up`;

/**
 * HARD — unambiguous enough to fire in any context, including a technical one.
 * There is no sentence about a web server that contains "my chest hurts and my
 * left arm is numb".
 */
const HARD: Rule[] = [
  // ── suicide / self-harm ────────────────────────────────────────────────────
  { id: "suicide.explicit", category: "suicide", re: /\b(kill(ing)?\s+my\s?self|end(ing)?\s+my\s+(own\s+)?life|take\s+my\s+own\s+life|commit(ting)?\s+suicide|suicidal|end\s+it\s+all)\b/i },
  // "I don't think I want to be alive anymore" — the phrasing the first pass missed.
  { id: "suicide.neg-life", category: "suicide", re: near(NEG, LIFE) },
  { id: "suicide.want-dead", category: "suicide", re: /\b(want(ing)?\s+to\s+(die|be\s+dead)|wish\s+i\s+(was|were)\s+(dead|never\s+born)|rather\s+be\s+dead|better\s+off\s+dead|ready\s+to\s+die)\b/i },
  { id: "suicide.burden", category: "suicide", re: /\b((everyone|everybody|they'?d|you'?d|he'?d|she'?d)\s+(would\s+)?be\s+better\s+off\s+without\s+me|nobody\s+would\s+(miss|notice)|no\s+one\s+would\s+(miss|care))\b/i },
  { id: "suicide.plan", category: "suicide", re: /\b(how\s+(do|can|should)\s+i\s+(kill|hurt|end)\s+my\s?self|painless\s+way\s+to\s+die|easiest\s+way\s+to\s+die|how\s+much\s+\w+\s+(would|to)\s+kill\s+me|enough\s+pills\s+to)\b/i },
  { id: "suicide.selfharm", category: "suicide", re: /\b(cut(ting)?\s+my\s?self|hurt(ing)?\s+my\s?self|harm(ing)?\s+my\s?self|self[-\s]?harm|burn(ing)?\s+my\s?self)\b/i },
  { id: "suicide.hotline", category: "suicide", re: /\b(988|suicide\s+(hotline|lifeline|prevention)|crisis\s+(line|hotline|text\s+line))\b/i },
  { id: "suicide.goodbye", category: "suicide", re: /\b(goodbye\s+(cruel\s+)?world|this\s+is\s+my\s+last\s+(message|night|day)|no\s+(reason|point)\s+(in\s+|to\s+)?(go(ing)?\s+on|living|being\s+here)|wrote\s+a\s+note)\b/i },
  { id: "suicide.stop", category: "suicide", re: /\b(want\s+(it|this|the\s+pain)\s+to\s+(stop|end)|make\s+it\s+stop\s+forever)\b/i },

  // ── medical emergency ──────────────────────────────────────────────────────
  { id: "medical.cardiac", category: "medical", re: /\b(heart\s+attack|cardiac\s+arrest|my\s+chest\s+(hurts|is\s+tight|feels\s+tight)|chest\s+pain|crushing\s+(pain\s+in\s+my\s+)?chest)\b/i },
  { id: "medical.stroke", category: "medical", re: /\b(having\s+a\s+stroke|face\s+is\s+(drooping|numb)|slurr(ed|ing)\s+(my\s+)?(speech|words))\b|\bnumb\b(?:\W+\w+){0,3}?\W+(left|right)\s+(arm|side|leg)\b/i },
  { id: "medical.breathing", category: "medical", re: /\b(can'?t|cannot|cant|couldn'?t)\s+breathe?\b|\b(stopped|not)\s+breathing\b|\bchoking\b|\bstruggling\s+to\s+breathe\b/i },
  { id: "medical.unconscious", category: "medical", re: /\b(unconscious|unresponsive|won'?t\s+wake\s+up|isn'?t\s+waking\s+up|no\s+pulse|not\s+responding\s+to\s+me)\b|\bpassed\s+out\b(?:\W+\w+){0,4}?\W+(and|wont|won'?t|still)\b/i },
  { id: "medical.bleeding", category: "medical", re: /\bbleeding\b(?:\W+\w+){0,3}?\W+(won'?t|wont|will\s+not)\s+stop\b|\b(losing\s+a\s+lot\s+of\s+blood|severe\s+bleeding|bleeding\s+badly|hemorrhag|haemorrhag)\b/i },
  { id: "medical.seizure", category: "medical", re: /\b(having\s+a\s+seizure|is\s+seizing|anaphyla|epipen)\b|\ballergic\s+reaction\b(?:\W+\w+){0,4}?\W+(swelling|throat|can'?t|cant)\b/i },
  // 911 is distinctive enough to stand alone. 999 and 112 are not — they are
  // also error codes and port numbers — so they need a verb attached.
  { id: "medical.emergency-number", category: "medical", re: /\b(911|ambulance|paramedics|emergency\s+room)\b|\b(call|called|calling|dial|ring)(ed|ing)?\s+(999|112)\b|\ba\s?&\s?e\b/i },
  { id: "medical.labour", category: "medical", re: /\b(going\s+into\s+labou?r|water\s+broke|contractions\s+\d)\b/i },

  // ── overdose / poisoning ───────────────────────────────────────────────────
  { id: "overdose.took", category: "overdose", re: /\b(overdos(e|ed|ing)|o\.?d\.?'?(ed|ing))\b|\btook\b(?:\W+\w+){0,4}?\W+(too\s+many|a\s+(whole|full)\s+bottle|all\s+(the|my|of\s+my)\s+(pills|meds|pain)|a\s+bunch\s+of\s+pills)\b/i },
  { id: "overdose.poison", category: "overdose", re: /\b(poisoned|poisoning|swallowed\s+(bleach|poison|antifreeze)|drank\s+bleach)\b/i },

  // ── violence / abuse ───────────────────────────────────────────────────────
  { id: "violence.now", category: "violence", re: /\b(being\s+(attacked|assaulted|raped)|was\s+(just\s+)?raped|someone\s+is\s+(breaking\s+in|in\s+my\s+(house|home)|following\s+me))\b/i },
  { id: "violence.hitting-me", category: "violence", re: /\b(he|she|they|my\s+(partner|husband|wife|boyfriend|girlfriend|ex|dad|mom|father|mother|stepdad|roommate))\b(?:\W+\w+){0,3}?\W+(is\s+)?(hitting|hits|hit|beating|beats|beat|strangling|choking|punched|punching|hurting|hurts)\s+me\b/i },
  { id: "violence.abuse", category: "violence", re: /\b(domestic\s+(violence|abuse)|being\s+abused)\b/i },
  { id: "violence.fear-killed", category: "violence", re: /\bafraid\b(?:\W+\w+){0,4}?\W+(kill|hurt)\s+me\b|\b(he|she|they)\s+(will|might|is\s+going\s+to)\s+kill\s+me\b/i },
  { id: "violence.weapon", category: "violence", re: /\b(pointing\s+a\s+gun|held\s+at\s+(gun|knife)\s?point)\b|\bhas\s+a\s+(gun|knife)\b(?:\W+\w+){0,4}?\W+(on|to|and|me)\b/i },
  { id: "violence.harm-other", category: "violence", re: /\b(want\s+to\s+(kill|hurt)\s+(him|her|them|someone|people)|going\s+to\s+(kill|shoot|stab)\s+(him|her|them|someone|everyone))\b/i },

  // ── a child in danger ──────────────────────────────────────────────────────
  { id: "child.danger", category: "child", re: /\bmy\s+(baby|kid|child|son|daughter|toddler|infant)\b(?:\W+\w+){0,4}?\W+(not\s+breathing|unconscious|choking|swallowed|won'?t\s+wake|burning\s+up|had\s+a\s+seizure|is\s+blue|fell\s+from)\b/i },
  { id: "child.abuse", category: "child", re: /\b(child\s+abuse|being\s+abused\s+at\s+home|(hurting|touching)\s+a\s+child)\b/i },
];

/**
 * SOFT — real distress phrasing that also has a mundane technical reading.
 * Fires unless TECH_CONTEXT appears in the same message.
 */
const SOFT: Rule[] = [
  { id: "soft.dying", category: "medical", re: /\b(i('m|\s+am)?\s+dying|i\s+think\s+i('m|\s+am)\s+dying|help\s+me\s+please)\b/i },
  { id: "soft.hurt", category: "medical", re: /\b(i('m|\s+am)\s+(really\s+)?(hurt|injured|bleeding)|it\s+hurts\s+so\s+(much|bad))\b/i },
  { id: "soft.scared", category: "violence", re: /\b(i('m|\s+am)\s+(really\s+)?(scared|terrified)\s+(of|that|for)\b|i\s+don'?t\s+feel\s+safe|i'?m\s+not\s+safe)\b/i },
  { id: "soft.emergency", category: "medical", re: /\b(this\s+is\s+an\s+emergency|it'?s\s+an\s+emergency|need\s+help\s+now)\b/i },
  { id: "soft.alone", category: "suicide", re: /\b(i\s+can'?t\s+do\s+this\s+anymore|i\s+can'?t\s+go\s+on|nobody\s+would\s+miss\s+me|everyone\s+would\s+be\s+better\s+off\s+without\s+me)\b/i },
];

/**
 * Vocabulary that makes a SOFT match mundane. Deliberately narrow: it suppresses
 * only the ambiguous rules, never a HARD one. "My server is dying" is exempt;
 * "my server is dying and so am I, I took a whole bottle of pills" still fires,
 * because the second clause is HARD.
 */
const TECH_CONTEXT =
  /\b(process|pid|kill\s+-9|sigkill|sigterm|server|daemon|container|docker|kubernetes|k8s|pod|thread|build|compil|deploy|script|function|test suite|my\s+(code|app|laptop|battery|branch|repo|build)|npm|yarn|node|python|regex|database|query|endpoint|api|css|html|javascript|typescript|linter|merge|rebase|commit)\b/i;

/** Obvious hyperbole. Suppresses SOFT only, same as TECH_CONTEXT. */
const HYPERBOLE = /\b(dying\s+(of\s+)?laugh|lol|lmao|😂|🤣|dying\s+to\s+(know|see|try))\b/i;

function scan(text: string, rules: Rule[]): Rule | null {
  for (const r of rules) if (r.re.test(text)) return r;
  return null;
}

/**
 * Classify one message. Exported so it can be unit-tested directly and so the
 * frontend's copy of the rules can be diffed against this one.
 */
export function classifyMessage(text: string, opts: { hardOnly?: boolean } = {}): Rule | null {
  // MEASURED patterns first. These come from deploy/serve.py via
  // scripts/gen-guard.py and are the only ones scored by eval/check_guard.py.
  //
  // They exist because the hand-written rules below were never tested against
  // the corpus and, when finally measured on 2026-08-05, caught 2 of 13 held-out
  // phrasings — missing "tonight is the night", "i wrote letters to everyone",
  // "i have a plan", and every other form with no medical vocabulary in it.
  // Those are precisely the cases the eval exists to catch.
  //
  // Never suppressed by technical context or hyperbole: they are tuned for
  // recall on purpose, and the eval prices the false positives.
  const measured = scan(text, GENERATED_RULES as unknown as Rule[]);
  if (measured) return measured;

  const hard = scan(text, HARD);
  if (hard) return hard;
  if (opts.hardOnly) return null;
  if (TECH_CONTEXT.test(text) || HYPERBOLE.test(text)) return null;
  return scan(text, SOFT);
}

export type Turn = { role: string; content: string };

/**
 * Classify a conversation.
 *
 * The current user turn gets the full ruleset. Up to three earlier user turns
 * get HARD rules only — somebody who typed "i think im having a heart attack"
 * and then "please" should not get a punchline for the second message, but an
 * old `kill -9` joke must not pin the whole session into crisis mode either.
 */
export function classify(messages: Turn[]): DistressHit | null {
  const userTurns = messages.filter((m) => m.role === "user");
  const current = userTurns.at(-1);
  if (current) {
    const hit = classifyMessage(current.content);
    if (hit) return { category: hit.category, rule: hit.id, turn: "current" };
  }
  for (const prior of userTurns.slice(-4, -1)) {
    const hit = classifyMessage(prior.content, { hardOnly: true });
    if (hit) return { category: hit.category, rule: hit.id, turn: "prior" };
  }
  return null;
}

/**
 * The responses. Fixed text, no model, no sampling, no bit.
 *
 * Written to the same brief as the distress rows in `data/seeds.py`: real
 * answer, real resources, stays present rather than handing off and leaving.
 * They are deliberately unfunny. Do not write a clever version.
 *
 * These are US-first because the site is, but every one of them names the
 * non-US path too — a stranger on a public URL is not necessarily nearby.
 */
const RESPONSES: Record<DistressCategory, string> = {
  medical:
    "Call 911 now — or your local emergency number if you're not in the US. " +
    "If someone is with you, have them make the call while you stay put; don't " +
    "drive yourself anywhere. Unlock your door so paramedics can get in, and " +
    "stay on the line with the dispatcher — they will tell you exactly what to " +
    "do next, and they are better at this than anything on this page.",

  suicide:
    "I'm glad you said something. You can reach the 988 Suicide & Crisis " +
    "Lifeline by calling or texting 988 in the US, any time, or text HOME to " +
    "741741 for the Crisis Text Line. Outside the US, findahelpline.com lists " +
    "them by country. If you're in immediate danger, please call 911 or your " +
    "local emergency number. Is there someone you trust who could be with you " +
    "right now? You don't have to be alone with this.",

  overdose:
    "Call 911 right now, or Poison Control at 1-800-222-1222 in the US — they " +
    "answer 24/7 and they will not involve the police. Outside the US, call " +
    "your local emergency number. Don't try to make yourself throw up unless " +
    "they tell you to. If you can, have the bottle or packaging next to you so " +
    "you can tell them exactly what and how much. Stay awake and stay on the " +
    "line.",

  violence:
    "If you're in immediate danger, call 911 — or your local emergency number " +
    "outside the US. If you can't speak safely, in the US you can text 911 in " +
    "many areas, or text START to 88788 to reach the National Domestic " +
    "Violence Hotline; they're also at 1-800-799-7233. Get to a room with a " +
    "door and a way out if you can. What's happening to you is not something " +
    "you have to handle by yourself.",

  child:
    "Call 911 now — or your local emergency number if you're not in the US. " +
    "For a swallowed substance, Poison Control is 1-800-222-1222 in the US and " +
    "answers immediately. Stay with them, keep them on their side if they're " +
    "not alert, and stay on the line with the dispatcher; they will talk you " +
    "through it step by step.",
};

export function responseFor(hit: DistressHit): string {
  return RESPONSES[hit.category];
}

/** Every rule id, for the /healthz self-report. Cheap way to spot a bad deploy. */
export const RULE_COUNT = GENERATED_RULES.length + HARD.length + SOFT.length;
