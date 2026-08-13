/* RefusalGPT — the debug workbench beside /chat/.
 *
 * DEVELOPMENT ONLY. `chat.html` wraps both this script tag and the panel markup
 * in `hugo.IsDevelopment`, and `deploy.sh` runs a production build, so none of
 * this exists on the deployed site. That gate is in the TEMPLATE on purpose:
 * hiding a panel that talks to 127.0.0.1:11434 behind a CSS class or a JS flag
 * would still ship the code and still let a stray query string point a
 * visitor's browser at a server they do not run.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * The distress gate is being rebuilt (runs/guard-llm-01.md eliminated the
 * off-the-shelf guard models; runs/guard-llm-web work is measuring general
 * instruct models instead). That work needs to see what a second model makes of
 * a live conversation, next to the conversation, while it happens. This panel
 * is that workbench — not a product surface, and the one place on this site
 * that speaks plainly instead of staying in character.
 *
 * ── Why a LOCAL model and not the gateway ───────────────────────────────────
 *
 * The gateway serves the joke. Asking it to summarise would be asking the
 * fine-tune to break character, which it is trained not to do, and would spend
 * RunPod GPU seconds per keystroke-batch to do it. ollama on this machine is
 * free, already running, and already CORS-open to the dev origin.
 *
 * Note the model choice matters more than it looks: docs/ios.md records that
 * Apple's on-device model REFUSES to summarise a transcript containing
 * self-harm, in ~0.2s, every time. A summariser that goes blank exactly when
 * the conversation is the kind this project cares about is worse than none, so
 * the default here is a model that will read anything. If you swap it, check
 * that it still summarises a distress transcript before trusting a quiet panel.
 *
 * ── The one rule this panel keeps ───────────────────────────────────────────
 *
 * It reads. It never writes to the conversation, never touches the credits
 * meter, and never calls the gateway. Its only input is a `cx:conversation`
 * event from chat.js. If this file is missing or throws, /chat/ is unchanged.
 */
(function () {
  "use strict";

  var panel = document.getElementById("cx-debug");
  if (!panel) return; // production build, or the markup was removed

  var root = document.getElementById("cx");
  var field = document.getElementById("cx-sum");
  var stateEl = document.getElementById("cx-sum-state");
  var metaEl = document.getElementById("cx-sum-meta");
  var modelEl = document.getElementById("cx-debug-model");
  var againBtn = document.getElementById("cx-sum-again");
  var closeBtn = document.getElementById("cx-debug-close");

  // Deliberately NOT read out of #chat-config: that blob is the whole of
  // chat.yaml and ships to production, so debug copy must not live in it.
  var cfgEl = document.getElementById("debug-config");
  var COPY = cfgEl ? JSON.parse(cfgEl.textContent) : {};
  var SC = COPY.summary || {};

  // Only for apiBase. The debug COPY deliberately does not live in this blob —
  // #chat-config is serialised into production, and debug strings must not be.
  var chatCfgEl = document.getElementById("chat-config");
  var chatCfg = chatCfgEl ? JSON.parse(chatCfgEl.textContent) : {};

  var FLAG = "refusalgpt.debug";

  /*
   * THE SUMMARY GOES THROUGH THE GATEWAY, not straight to ollama.
   *
   * An earlier version had this page POST to 127.0.0.1:11434 itself. That
   * works, and it is the wrong shape: the prompt and the model would live in
   * the browser, where a caller picks both, which is the general-purpose-LLM
   * hole /v1 drops caller system prompts to close. Server-side now — this
   * sends a transcript and receives prose, and cannot ask for anything else.
   *
   * apiBase comes from #chat-config, the same value /api/chat uses, so the
   * panel is pointed at whatever gateway the page is already talking to.
   * /api/summary 404s unless SUMMARY_URL and SUMMARY_MODEL are configured.
   */
  var API_BASE = (chatCfg.apiBase || "");
  var SUMMARY_URL = API_BASE + "/api/summary";

  // Long enough that a real conversation is not truncated mid-exchange, short
  // enough that a 4B on a laptop answers while you are still looking at it.
  var MAX_CHARS = 6000;
  var DEBOUNCE_MS = 700;

  /* ── enable/disable ──────────────────────────────────────────────────────
     ?debug=1 turns it on and the choice sticks; ?debug=0 turns it off again.
     Off is the default even in dev, so the page you develop against is the
     page a visitor gets unless you asked for otherwise. */
  function enabled() {
    var q = new URLSearchParams(location.search);
    if (q.has("debug")) {
      var on = q.get("debug") !== "0" && q.get("debug") !== "false";
      try { localStorage.setItem(FLAG, on ? "1" : "0"); } catch (e) {}
      return on;
    }
    try { return localStorage.getItem(FLAG) === "1"; } catch (e) { return false; }
  }

  function show(on) {
    panel.hidden = !on;
    root.classList.toggle("is-debug", on);
    if (on) { modelEl.textContent = MODEL; render(); }
  }

  if (!enabled()) { show(false); return; }

  /* ── state ───────────────────────────────────────────────────────────── */
  var messages = [];
  var timer = null;
  var seq = 0;          // a stale response must never overwrite a newer one
  var lastKey = "";     // transcript fingerprint, so identical input is not re-run

  function setState(name, text) {
    stateEl.dataset.state = name;
    stateEl.textContent = text;
  }

  /*
   * What goes on the wire: role/content only.
   *
   * Trimmed from the FRONT, oldest first — a running summary is about where the
   * conversation has GOT to, and dropping the newest turns would summarise the
   * past while looking current. The gateway also fits this to its own context
   * budget; this cap just avoids posting a novel on every keystroke-batch.
   */
  function wireMessages() {
    var out = [];
    var chars = 0;
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      chars += (m.content || "").length;
      if (chars > MAX_CHARS && out.length) break;
      out.unshift({ role: m.role, content: m.content });
    }
    return out;
  }

  /** Fingerprint of what would be sent, so identical input is not re-run. */
  function changeKey() {
    return messages.length + "|" + messages.map(function (m) {
      return m.role + ":" + m.content;
    }).join("\n");
  }

  // The prompt lives in the GATEWAY (api/src/index.ts SUMMARY_PROMPT). It is
  // deliberately not duplicated here: two copies of one prompt in two
  // languages drift, and the browser's copy would be the one a caller
  // could change.

  async function summarise() {
    var wire = wireMessages();
    if (!wire.length) {
      field.value = "";
      metaEl.textContent = "";
      setState("idle", SC.idle || "idle");
      return;
    }

    var mine = ++seq;
    setState("working", SC.working || "summarising…");
    var t0 = performance.now();

    try {
      // The transcript, and nothing else. No prompt, no model, no options —
      // the gateway owns all three.
      var res = await fetch(SUMMARY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: wire }),
      });
      if (!res.ok) {
        var why = res.status === 404
          ? "no summariser configured (SUMMARY_URL / SUMMARY_MODEL)"
          : "HTTP " + res.status;
        throw new Error(why);
      }
      var data = await res.json();
      if (mine !== seq) return; // superseded while in flight

      field.value = (data.summary || "").trim();
      modelEl.textContent = data.model || "—";
      metaEl.textContent =
        (data.ms != null ? data.ms : Math.round(performance.now() - t0)) +
        " ms · " + (data.turns != null ? data.turns : messages.length) + " msgs" +
        (data.truncated ? " · trimmed" : "");
      setState("idle", SC.idle || "idle");
    } catch (e) {
      if (mine !== seq) return;
      // Say it plainly and leave the stale text in place rather than blanking
      // the field — an empty box reads as "nothing to say", which is a
      // different claim from "could not reach the model".
      setState("failed", SC.failed || "unreachable");
      metaEl.textContent = String(e.message || e);
      lastKey = ""; // let the next change retry
    }
  }

  function render() {
    if (panel.hidden) return;
    var key = changeKey();
    if (key === lastKey) return;
    lastKey = key;
    clearTimeout(timer);
    timer = setTimeout(summarise, DEBOUNCE_MS);
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */
  document.addEventListener("cx:conversation", function (e) {
    messages = (e.detail && e.detail.messages) || [];
    render();
  });

  againBtn.addEventListener("click", function () {
    lastKey = "";
    clearTimeout(timer);
    summarise();
  });

  closeBtn.addEventListener("click", function () {
    try { localStorage.setItem(FLAG, "0"); } catch (err) {}
    show(false);
  });

  show(true);
})();
