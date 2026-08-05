#!/usr/bin/env python3
"""Generate the TypeScript system-prompt constant from the Python source.

    python3 scripts/gen-prompt.py           # write src/generated/prompt.ts
    python3 scripts/gen-prompt.py --check   # exit 1 if the file is stale

`data/seeds.py` is the single source of truth: `SYSTEM` is what every training
row carries, so it is what the model was TRAINED on. Serving a prompt that has
drifted from the trained one degrades the model silently, and the symptom reads
as "the model got worse" rather than "we changed the question".

That failure is nastier here than in most projects, because the prompt is one
word. A stray space or a dropped period is invisible in a diff read quickly and
is a meaningful fraction of the entire conditioning signal.

The generated file IS committed. The droplet never runs Python; it only receives
`dist/`. Committing the artifact is what lets the build verify it without the
training pipeline being present at deploy time.

`--check` runs as part of `yarn build`, so drift fails the build rather than
shipping.
"""
import argparse
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
API = os.path.dirname(HERE)
REPO = os.path.dirname(API)
SOURCE = os.path.join(REPO, "data", "seeds.py")
TARGET = os.path.join(API, "src", "generated", "prompt.ts")

# name in seeds.py -> exported TS const
EXPORTS = {"SYSTEM": "REFUSAL_SYSTEM"}


def load_prompts() -> dict[str, str]:
    spec = importlib.util.spec_from_file_location("seeds", SOURCE)
    if spec is None or spec.loader is None:
        sys.exit(f"cannot load {SOURCE}")
    mod = importlib.util.module_from_spec(spec)
    # Safe: seeds.py is documented as import-safe and writes nothing at import.
    spec.loader.exec_module(mod)
    out = {}
    for py_name, ts_name in EXPORTS.items():
        if not hasattr(mod, py_name):
            sys.exit(f"{SOURCE} has no {py_name}")
        value = getattr(mod, py_name)
        if not isinstance(value, str) or not value.strip():
            sys.exit(f"{py_name} is not a non-empty string")
        out[ts_name] = value
    return out


def render(prompts: dict[str, str]) -> str:
    lines = [
        "// GENERATED FILE — DO NOT EDIT.",
        "//",
        "// Source of truth: data/seeds.py  (SYSTEM)",
        "// Regenerate:      yarn gen:prompt",
        "// Verified by:     yarn check:prompt (runs as part of `yarn build`)",
        "//",
        "// This is the exact prompt the model was TRAINED on, in every row. Editing it",
        "// here would make the served prompt differ from the trained one, which degrades",
        "// the model silently — it looks like the model got worse, not like the prompt",
        "// changed. Edit seeds.py and regenerate.",
        "",
    ]
    for name, value in prompts.items():
        # json.dumps yields a valid TS double-quoted string literal: no backtick,
        # ${, or backslash escaping to get subtly wrong.
        lines.append(f"export const {name}: string = {json.dumps(value, ensure_ascii=False)};")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify without writing")
    a = ap.parse_args()

    rendered = render(load_prompts())

    if a.check:
        if not os.path.exists(TARGET):
            print(f"  MISSING {os.path.relpath(TARGET, API)} — run: yarn gen:prompt", file=sys.stderr)
            return 1
        if open(TARGET).read() != rendered:
            print(
                "\n  PROMPT DRIFT: src/generated/prompt.ts does not match data/seeds.py.\n"
                "  The served prompt would differ from the trained one.\n"
                "  Fix:  yarn gen:prompt\n",
                file=sys.stderr,
            )
            return 1
        print("  prompt matches seeds.py")
        return 0

    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    open(TARGET, "w").write(rendered)
    sizes = ", ".join(f"{k} {len(v)} chars" for k, v in load_prompts().items())
    print(f"  wrote {os.path.relpath(TARGET, API)} ({sizes})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
