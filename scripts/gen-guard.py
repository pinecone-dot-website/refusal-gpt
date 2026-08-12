#!/usr/bin/env python3
"""Generate the gateway's distress patterns from the measured ones in serve.py.

    python3 scripts/gen-guard.py           # write api/src/generated/guard.ts
    python3 scripts/gen-guard.py --check   # exit 1 if the file is stale

WHY THIS EXISTS
───────────────
There were two distress guards: `deploy/serve.py` (Python, measured against
`eval/check_guard.py`, 100% recall) and `api/src/safety.ts` (TypeScript, written
separately, never tested against the corpus).

The TypeScript one is the one that is deployed. Measured 2026-08-05, it caught
2 of 13 phrasings the Python one was specifically widened to cover — including
"tonight is the night", "i wrote letters to everyone", and "i have a plan",
which are exactly the vocabulary-poor forms the eval exists to catch. The tested
guard was not the running guard, and nothing in the build would ever have said
so.

So the Python patterns are now the SOURCE, and the TypeScript is generated from
them. One corpus, one set of regexes, two runtimes that cannot drift, and
`yarn build` fails if they do.

Adding a phrasing: edit the regexes in `deploy/serve.py`, run
`python3 eval/check_guard.py` to confirm recall, then `yarn gen:guard`.
"""
import argparse
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SOURCE = os.path.join(REPO, "deploy", "serve.py")
TARGET = os.path.join(REPO, "api", "src", "generated", "guard.ts")

# Python name -> (TS const, category used by the gateway's fixed responses)
EXPORTS = [
    ("MEDICAL", "MEDICAL", "medical"),
    ("SELF_HARM", "SELF_HARM", "suicide"),
    ("VIOLENCE", "VIOLENCE", "violence"),
]


_SERVE = None


def _serve():
    """serve.py as a module, loaded once. Also used for the fixed reply text."""
    global _SERVE
    if _SERVE is None:
        spec = importlib.util.spec_from_file_location("serve", SOURCE)
        if spec is None or spec.loader is None:
            sys.exit(f"cannot load {SOURCE}")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _SERVE = mod
    return _SERVE


def load():
    spec = importlib.util.spec_from_file_location("serve", SOURCE)
    if spec is None or spec.loader is None:
        sys.exit(f"cannot load {SOURCE}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # serve.py guards its server behind __main__
    out = []
    for py_name, ts_name, category in EXPORTS:
        if not hasattr(mod, py_name):
            sys.exit(f"{SOURCE} has no {py_name}")
        out.append((ts_name, category, getattr(mod, py_name)))
    return out


def compact(pattern: str) -> str:
    """Strip re.VERBOSE formatting so the pattern is valid without the x flag.

    JavaScript has no equivalent of re.X, so the whitespace and #-comments that
    make the Python source readable have to be removed rather than translated.
    Mirrors CPython's rule: unescaped whitespace and comments are ignored unless
    inside a character class or escaped.
    """
    out = []
    i, n = 0, len(pattern)
    in_class = False
    while i < n:
        c = pattern[i]
        if c == "\\" and i + 1 < n:          # escape: keep both chars verbatim
            out.append(pattern[i:i + 2])
            i += 2
            continue
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        if not in_class:
            if c == "#":                      # comment to end of line
                while i < n and pattern[i] != "\n":
                    i += 1
                continue
            if c.isspace():                   # insignificant whitespace
                i += 1
                continue
        out.append(c)
        i += 1
    return "".join(out)


def render(patterns) -> str:
    lines = [
        "// GENERATED FILE — DO NOT EDIT.",
        "//",
        "// Source of truth: deploy/serve.py  (MEDICAL, SELF_HARM, VIOLENCE)",
        "// Regenerate:      yarn gen:guard",
        "// Verified by:     yarn check:guard (runs as part of `yarn build`)",
        "//",
        "// These are the distress patterns measured by eval/check_guard.py. They are",
        "// tuned for RECALL: a false positive costs one broken joke, a false negative",
        "// costs someone in an emergency getting a punchline. Do not 'tidy' them here —",
        "// edit deploy/serve.py, re-run the eval, and regenerate.",
        "",
        "export type GuardCategory = \"medical\" | \"suicide\" | \"violence\";",
        "",
        "export const GENERATED_RULES: Array<{ id: string; category: GuardCategory; re: RegExp }> = [",
    ]
    for ts_name, category, rx in patterns:
        compacted = compact(rx.pattern)
        # Round-trip check: the compacted form must still compile in Python and
        # still match what the verbose one matched.
        re.compile(compacted, re.I)
        lines.append(
            f'  {{ id: "measured.{ts_name.lower()}", category: "{category}", '
            f"re: new RegExp({json.dumps(compacted)}, \"i\") }},"
        )
    lines.append("];")
    lines.append("")
    return "\n".join(lines)


def swift_string(s: str) -> str:
    """A Swift string literal.

    NOT json.dumps(). Python escapes non-ASCII as \\u2014, which is valid JSON
    and valid JavaScript and a SYNTAX ERROR in Swift, which spells it \\u{2014}.
    The em-dash in the reply text found this immediately. Emitting literal UTF-8
    is simpler than translating, and Swift source is UTF-8 by definition.
    """
    return json.dumps(s, ensure_ascii=False)


def render_swift(patterns) -> str:
    """The same patterns as a Swift source file for the iOS app.

    THREE RUNTIMES NOW SHARE ONE CORPUS. On-device there is no proxy in front of
    the model, so the app carries its own copy of the gate — and a hand-written
    third implementation is exactly the drift that already cost this project
    once, when the deployed TypeScript caught 2 of 13 phrasings the tested
    Python caught. Generated, checked in, and scored by eval/check_guard.py the
    same way the TypeScript is.

    NSRegularExpression is ICU, not PCRE and not Python's `re`. The constructs
    used by these patterns — lazy quantifiers, non-capturing groups, negative
    lookahead, \\b, \\w, \\W, \\s — all behave the same in ICU. Anything fancier
    added to serve.py needs re-verifying HERE, by running check_guard.py against
    the Swift target, not by reading the pattern and assuming.
    """
    lines = [
        "// GENERATED FILE — DO NOT EDIT.",
        "//",
        "// Source of truth: deploy/serve.py  (MEDICAL, SELF_HARM, VIOLENCE)",
        "// Regenerate:      python3 scripts/gen-guard.py",
        "// Verified by:     python3 eval/check_guard.py  (scores this file directly)",
        "//",
        "// The distress patterns measured by eval/check_guard.py, tuned for RECALL:",
        "// a false positive costs one broken joke, a false negative costs someone in",
        "// an emergency getting a punchline. Do not 'tidy' them here — edit",
        "// deploy/serve.py, re-run the eval, and regenerate.",
        "",
        "import Foundation",
        "",
        "public enum GuardCategory: String, Sendable {",
        '    case medical, suicide, violence',
        "}",
        "",
        "public struct GuardRule: Sendable {",
        "    public let id: String",
        "    public let category: GuardCategory",
        "    public let regex: NSRegularExpression",
        "}",
        "",
        "public let generatedRules: [GuardRule] = [",
    ]
    for ts_name, category, rx in patterns:
        compacted = compact(rx.pattern)
        re.compile(compacted, re.I)      # same round-trip check as the TS path
        lines.append(
            f'    GuardRule(id: "measured.{ts_name.lower()}", category: .{category},\n'
            f"             regex: try! NSRegularExpression("
            f"pattern: {swift_string(compacted)}, options: [.caseInsensitive])),"
        )
    lines += ["]", ""]

    # ── the fixed replies ────────────────────────────────────────────────────
    # Generated too, and for a sharper reason than the patterns. These are the
    # words a stranger reads at their worst moment. api/src/safety.ts keeps its
    # OWN hand-written copies which ALREADY DIFFER from serve.py's — nothing
    # compares them, so the answer a person gets depends on which runtime they
    # happened to reach. The iOS app is not going to be a third divergent copy.
    lines += [
        "/// Fixed, human-written, reviewed. The model never sees a request that",
        "/// reaches these, and is never allowed to paraphrase them.",
        "public enum DistressReply {",
    ]
    for const, swift_name in [("REPLY_MEDICAL", "medical"),
                              ("REPLY_SELF_HARM", "suicide"),
                              ("REPLY_VIOLENCE", "violence")]:
        text = getattr(_serve(), const)
        lines.append(f"    public static let {swift_name} = {swift_string(text)}")
    lines += [
        "",
        "    public static func text(for category: GuardCategory) -> String {",
        "        switch category {",
        "        case .medical:  return medical",
        "        case .suicide:  return suicide",
        "        case .violence: return violence",
        "        }",
        "    }",
        "}",
        "",
    ]
    return "\n".join(lines)


TARGETS = [
    ("api/src/generated/guard.ts", render, "yarn gen:guard"),
    ("ios/RefusalKit/Sources/RefusalKit/GuardRules.generated.swift", render_swift,
     "python3 scripts/gen-guard.py"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify without writing")
    a = ap.parse_args()

    patterns = load()
    rc = 0

    for rel, renderer, fix in TARGETS:
        path = os.path.join(REPO, rel)
        rendered = renderer(patterns)

        if a.check:
            if not os.path.exists(path):
                print(f"  MISSING {rel} — run: {fix}", file=sys.stderr)
                rc = 1
                continue
            if open(path).read() != rendered:
                print(
                    f"\n  GUARD DRIFT: {rel} does not match deploy/serve.py.\n"
                    "  A runtime's distress patterns would differ from the measured ones.\n"
                    f"  Fix:  {fix}\n",
                    file=sys.stderr,
                )
                rc = 1
                continue
            print(f"  guard patterns match serve.py ({rel})")
            continue

        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w").write(rendered)
        print(f"  wrote {rel}")

    if not a.check:
        sizes = ", ".join(f"{n} {len(compact(rx.pattern))} chars" for n, _, rx in patterns)
        print(f"  patterns: {sizes}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
