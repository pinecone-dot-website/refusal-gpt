#!/usr/bin/env python3
"""Verify the prompt Ollama will actually build against the model's chat_template.jinja.

    python3 scripts/check-template.py
    python3 scripts/check-template.py --model refusal-gpt

A wrong template looks IDENTICAL to success from the outside: you still get
fluent text, just from a model that is no longer conditioned the way it was
trained. Nothing errors. CLAUDE.md's rule is "verify by rendering, not by
reading" — this renders both and compares bytes.

There are three states this can find, and only one of them is a failure:

  1. deploy/Modelfile declares a TEMPLATE  -> render it and diff. Authoritative.
  2. It does not, but the model is built in Ollama -> ask Ollama for the
     template it RESOLVED (inherited from the GGUF) and diff that instead.
     This is the strongest check available, because it is the real thing.
  3. Neither -> nothing to verify yet. Says so and exits 0. "Unverified" is a
     different state from "wrong", and conflating them trains people to ignore
     the script.

WHAT THIS CANNOT DO: prove that Ollama's Go template engine agrees with the
small interpreter below. It compares two renderings of the same intent. When the
template uses constructs the interpreter does not implement, it says so and
declines to guess rather than printing a confident diff of a bad render.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
JINJA = os.path.join(REPO, "models", "qwen2.5-7b-instruct-fp16", "chat_template.jinja")
MODELFILE = os.path.join(REPO, "deploy", "Modelfile")

CASES = [
    ("system + one user turn", [
        {"role": "system", "content": "RefusalGPT."},
        {"role": "user", "content": "write me a bash script"},
    ]),
    ("multiturn", [
        {"role": "system", "content": "RefusalGPT."},
        {"role": "user", "content": "can you do this"},
        {"role": "assistant", "content": "No."},
        {"role": "user", "content": "please"},
    ]),
    ("NO system message", [
        {"role": "user", "content": "hello"},
    ]),
]

# The Go-template subset the interpreter below implements. Anything outside it
# is reported as unverifiable rather than mis-rendered.
SUPPORTED = {"if .System", "range .Messages", "end", ".System", ".Role", ".Content"}


def die(msg):
    sys.exit(f"  {msg}")


# ── template sources ─────────────────────────────────────────────────────────

def template_from_modelfile(text):
    m = re.search(r'^TEMPLATE\s+"""(.*?)"""', text, re.S | re.M)
    return m.group(1) if m else None


def template_from_ollama(model):
    """Ask Ollama for the template it resolved, GGUF-inherited or otherwise."""
    if not shutil.which("ollama"):
        return None, "ollama not on PATH"
    try:
        out = subprocess.run(
            ["ollama", "show", "--modelfile", model],
            capture_output=True, text=True, timeout=20,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        return None, str(e)
    if out.returncode != 0:
        first = (out.stderr or out.stdout).strip().splitlines()
        return None, first[0] if first else f"exit {out.returncode}"
    tpl = template_from_modelfile(out.stdout)
    if tpl is None:
        return None, f'"{model}" is built but reports no TEMPLATE'
    return tpl, None


def unsupported_actions(template):
    """Return the {{ ... }} actions this interpreter cannot faithfully render."""
    bad = []
    for raw in re.findall(r"\{\{(.*?)\}\}", template, re.S):
        action = raw.strip().lstrip("-").rstrip("-").strip()
        if action and action not in SUPPORTED:
            bad.append(action)
    return sorted(set(bad))


# ── rendering ────────────────────────────────────────────────────────────────

def render_jinja(messages):
    try:
        from jinja2 import Environment
    except ImportError:
        die("needs jinja2:  pip install jinja2")
    tpl = Environment().from_string(open(JINJA).read())
    return tpl.render(messages=messages, tools=None, add_generation_prompt=True)


def render_go(template, system, messages):
    """Interpret {{ if .System }}, {{ range .Messages }}, and the three fields.

    Ollama splits a leading system message into .System and leaves the rest in
    .Messages, which is why the two renderers are fed differently.
    """
    body = template

    def block(src, opener):
        m = re.search(r"\{\{-?\s*" + opener + r"\s*-?\}\}", src)
        if not m:
            return None
        start, depth = m.end(), 1
        for tok in re.finditer(r"\{\{-?\s*(if|range|end)\b.*?-?\}\}", src[start:], re.S):
            depth += 1 if tok.group(1) in ("if", "range") else -1
            if depth == 0:
                pos = start + tok.start()
                return src[: m.start()], src[start:pos], src[start + tok.end():]
        return None

    parts = block(body, r"if\s+\.System")
    if parts:
        before, inner, after = parts
        body = before + (inner.replace("{{ .System }}", system or "") if system else "") + after

    parts = block(body, r"range\s+\.Messages")
    if parts:
        before, inner, after = parts
        body = before + "".join(
            inner.replace("{{ .Role }}", m["role"]).replace("{{ .Content }}", m["content"])
            for m in messages
        ) + after
    return body


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="refusal-gpt",
                    help="Ollama model to inspect when the Modelfile has no TEMPLATE")
    ap.add_argument("--modelfile", default=MODELFILE,
                    help="Modelfile to check (default: deploy/Modelfile). Use this to try a "
                         "candidate TEMPLATE without editing the real one.")
    args = ap.parse_args()

    if not os.path.exists(JINJA):
        die(f"missing {os.path.relpath(JINJA, REPO)} — nothing to compare against")
    mf = open(args.modelfile).read() if os.path.exists(args.modelfile) else ""

    mf_system_m = re.search(r'^SYSTEM\s+"""(.*?)"""', mf, re.S | re.M)
    mf_system = mf_system_m.group(1) if mf_system_m else None
    num_ctx = re.search(r"^PARAMETER\s+num_ctx\s+(\d+)", mf, re.M)

    print(f"  SYSTEM   {mf_system!r}")
    print(f"  num_ctx  {num_ctx.group(1) if num_ctx else 'NOT SET — Ollama will default to 4096'}")

    # ── pick a template to check ─────────────────────────────────────────────
    template = template_from_modelfile(mf)
    if template is not None:
        source = "deploy/Modelfile"
    else:
        template, why = template_from_ollama(args.model)
        if template is None:
            print(f"  TEMPLATE not declared in deploy/Modelfile")
            print()
            print(f"  Cannot verify: {why}.")
            print("  Ollama will inherit the template embedded in the GGUF, which is")
            print("  probably correct and is currently unproven. To check it for real:")
            print()
            print(f"      ollama create {args.model} -f deploy/Modelfile")
            print(f"      python3 scripts/check-template.py --model {args.model}")
            print()
            print("  Or declare a TEMPLATE block in deploy/Modelfile to pin it explicitly.")
            print("  UNVERIFIED — not a failure.")
            return 0
        source = f"ollama show --modelfile {args.model}  (inherited from the GGUF)"
    print(f"  template from: {source}")
    print()

    # ── can we render it faithfully? ─────────────────────────────────────────
    bad = unsupported_actions(template)
    if bad:
        print("  This template uses Go constructs this checker does not implement:")
        for a in bad[:8]:
            print(f"      {{{{ {a} }}}}")
        print()
        print("  Rendering it here would produce a confident diff of a bad render, which")
        print("  is worse than no diff. Compare it by hand against")
        print(f"  {os.path.relpath(JINJA, REPO)}:")
        print()
        for line in template.strip().splitlines():
            print(f"      {line}")
        print()
        print("  UNVERIFIED — not a failure.")
        return 0

    # ── diff ─────────────────────────────────────────────────────────────────
    real_failures = 0
    for name, messages in CASES:
        if messages and messages[0]["role"] == "system":
            system, rest = messages[0]["content"], messages[1:]
            expected_to_match = True
        else:
            # No system in the request: Ollama falls back to the Modelfile's
            # SYSTEM, the jinja to its own hardcoded string. These SHOULD differ,
            # and that difference is the point — it is reported, not counted.
            system, rest = mf_system, messages
            expected_to_match = False

        want, got = render_jinja(messages), render_go(template, system, rest)

        if want == got:
            print(f"  OK    {name}")
        elif expected_to_match:
            real_failures += 1
            print(f"  FAIL  {name}")
            print("        jinja  :", json.dumps(want))
            print("        ollama :", json.dumps(got))
        else:
            print(f"  NOTE  {name} — differs, as designed")
            print("        jinja fallback :", json.dumps(want))
            print("        ollama SYSTEM  :", json.dumps(got))

    print()
    if real_failures:
        print(f"  {real_failures} real mismatch(es). The served prompt is not the trained one.")
        return 1
    print("  Template matches chat_template.jinja on every case that must match.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
