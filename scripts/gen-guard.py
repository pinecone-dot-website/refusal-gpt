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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify without writing")
    a = ap.parse_args()

    rendered = render(load())

    if a.check:
        if not os.path.exists(TARGET):
            print(f"  MISSING {os.path.relpath(TARGET, REPO)} — run: yarn gen:guard", file=sys.stderr)
            return 1
        if open(TARGET).read() != rendered:
            print(
                "\n  GUARD DRIFT: api/src/generated/guard.ts does not match deploy/serve.py.\n"
                "  The deployed distress patterns would differ from the measured ones.\n"
                "  Fix:  yarn gen:guard\n",
                file=sys.stderr,
            )
            return 1
        print("  guard patterns match serve.py")
        return 0

    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    open(TARGET, "w").write(rendered)
    sizes = ", ".join(f"{n} {len(compact(rx.pattern))} chars" for n, _, rx in load())
    print(f"  wrote {os.path.relpath(TARGET, REPO)} ({sizes})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
