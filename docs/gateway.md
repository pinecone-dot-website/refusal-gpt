> Split out of `CLAUDE.md` on 2026-08-13 so it stops loading on every startup.
> The binding rules stay in `CLAUDE.md`; this is the measurement record behind them.

# The gateway

**Caller system prompts are discarded, always.** `/v1/chat/completions` drops
`system` and `developer` messages and substitutes the trained one, announcing it
with `x-refusal-system-override: dropped`. This is the same hole the `seriously`
safe word was refused for: an endpoint that accepts a caller's system prompt is
a general-purpose Qwen2.5-7B with no instructions on it. Do not make this
configurable.

**Self-serve keys are a throttle, not an identity.** `/console` mints
`rg_live_…` / `rg_test_…` keys with a CRC32 checksum; the gateway verifies the
arithmetic and stores nothing. The algorithm is public and ships in the page, so
**anyone can mint unlimited valid keys** — which means per-key rate limits
cannot bound cost. `SELF_SERVE_GLOBAL_PER_DAY` is the only real ceiling on that
surface. Keys in `API_KEYS` are exempt from that pool, so a flood can never lock
the owner out of their own API. If this ever needs to answer _who_, this format
cannot; sign the keys or store them.

`api/scripts/check-keyformat.mjs` runs the REAL browser generator against the
REAL server parser (10,000 keys, 8 tamper cases) and is wired into `yarn build`.
Two implementations of one checksum in two languages will drift, and the failure
mode is silent: every key the console hands out gets rejected with no clue why.

**`rg_test_` keys never reach the GPU.** They return a correctly-shaped response
from the canned pool instantly, marked `x-refusal-mode: test`.

**The demo route never returns 5xx.** `/api/chat` degrades to canned lines with
`source: "fallback"` and a `detail`. A brochure site whose demo 503s reads as
broken. The honesty lives in `source` and `/healthz`, not in a 500 to a visitor.
The `/v1` surface is the opposite: real errors, real statuses.

**Canned fallback lines must never be training rows.** A fallback that quotes
seeds would disguise the exact failure this repo counts as fatal — see "any
verbatim echo of a training row is a failed run."

**`/api/warm` spends money on page load, on purpose, and its guards ARE the
feature.** Added 2026-08-08. `app.js` pings it on load so the cold start burns
while a visitor reads the headline instead of after they type. Three guards
collapse concurrent visitors onto ONE boot — already warm does nothing, already
warming joins the in-flight call, and `WARM_COOLDOWN_MS` (90s) refuses the rest.
That third one is the only guard that holds when the endpoint is broken: warmth
and the in-flight flag are both success-shaped, so against an endpoint that
fails or boots slower than the timeout, neither engages and every page load
starts another spin-up. Measured: 5 loads across a cooldown → 1 boot.

Two things about it that are easy to get wrong:

- **It is exempt from the demo rate limit**, and must stay so. It was not at
  first, which meant every page load spent one of the visitor's
  `PUBLIC_RATE_PER_MIN` before they typed — the ping meant to improve the demo
  was rationing it. Leaving it unmetered is safe because the cooldown, not the
  bucket, is what gates the GPU.
- **It does not lower the cost ceiling, only the floor.** With `idleTimeout` at
  300s, traffic arriving more often than every five minutes keeps a worker up
  permanently — which is `$15.81/day`, the same bill as `workersMin: 1`.
  `workersMax: 1` is what caps it there. Zero traffic costs zero, which is the
  real gain; a crawler hitting every six minutes costs full freight with nobody
  reading. The client-side guards (chat-surface pages only, not while
  prerendering or hidden, once per session per minute) are politeness — a
  crawler runs none of them, so the server cooldown is the actual ceiling.

**The card fields on /signup/ are NOT `<input>` elements, and must not become
them.** The Team checkout is a complete, plausible payment form whose button
declines — the bit only works if the form looks real. Which means the browser
thinks it is real too.

The first build had every structural defence that is usually recommended: no
`<form>` element, no `name` attributes, no `cc-number` / `cc-exp` / `cc-csc`
autocomplete tokens, `autocomplete="off"` on everything. **Firefox offered the
user's saved credit cards anyway.** It does not need a form or an autocomplete
token: it runs a Fathom classifier over VISIBLE LABEL TEXT, placeholder and id,
and a field labelled "Card number" sitting beside Expiry, CVC, billing postcode
and country is a textbook card section. `autocomplete="off"` is advisory and
browsers deliberately override it for payment fields.

The strongest signal is the visible label, and the visible label is the joke, so
it cannot be obfuscated. Renaming ids only lowers a confidence score. The fix is
structural, the same move as deleting the `<form>`: **autofill targets form
CONTROLS — input, select, textarea.** Card number, expiry and CVC are
contenteditable elements with `role="textbox"` and `aria-labelledby`, styled to
be indistinguishable. There is no control to fill, in any browser, now or later.

Two consequences to keep in mind if this is ever touched:

- `contenteditable` has no `maxlength`, so the digit cap is enforced only in JS
  now — on every `input` event against a constant in `signup.js`, and again in
  `attempt()` at submit time. The second is the one that matters: setting
  `.textContent` from a console fires no input event.
- Postcode and country are still real controls on purpose. Address autofill is
  harmless and its absence would look odd; it is saved CARD NUMBERS that must
  never be offered.

**Two stores on /chat/, and the split is not decoration.** localStorage holds
only the drawer's INDEX (`refusalgpt.chats` — id, title, updated, count);
IndexedDB holds the message bodies. localStorage is ~5 MB per origin counted in
UTF-16 code units, so the real ceiling is ~2.5M characters — a few hundred
conversations — and every read blocks the main thread. IndexedDB is async and
quota'd against free disk. So the small thing needed on first paint is
synchronous and the large thing is not. Do not move message bodies back into
localStorage to "simplify"; the drawer would then parse every transcript on
every load.

Three things that follow from having no server: **a browser can refuse to store
anything** (private windows, and Safari's ITP evicts script-writable storage
after 7 days without a visit), so every write is caught and the drawer _says_ it
is not saving rather than implying it is; **Safari has historically left
`indexedDB.open()` pending forever** rather than erroring, so the open races a
2s timeout and falls back; and **there is no undo**, so delete is two-step.

**The refusal-credits meter is ONE meter.** `/console/` and `/chat/` share
`refusalgpt.credits` and read the ceiling and the exhausted sentence from
`data/console.yaml` — one browser, one counter, one joke. A second copy of
`1000` in a second data file is how the two pages start disagreeing.

**`{{ define "block" }}{{ end }}` does not override a block.** Go's
`text/template` refuses to let a definition whose body is only whitespace or
comments replace an existing one, silently. `/chat/` suppresses baseof's footer
with `{{ define "footer" }}{{ "" }}{{ end }}` — the action is what makes the
body non-empty. The wrong version raises nothing and renders the footer, so
verify by grepping the build, not by reading the template. (Tenth entry for the
list above, in spirit: a check that never ran.)

**Length is one rule in one place: the token budget.** An earlier version also
sliced every message to 4,000 chars inside `prepare()`, which silently truncated
a 30k paste to fit and answered one-eighth of a question as though it were the
whole thing. Silent truncation dressed as validation is worse than none. `/v1`
rejects with `context_length_exceeded`; the demo trims explicitly and logs it.

**`/healthz` distinguishes `idle` from `unreachable`.** A scale-to-zero worker
times out the probe while being perfectly healthy. `state: "idle"` means asleep;
`unreachable` means the connection failed and carries the errno.
