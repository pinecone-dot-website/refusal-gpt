/* RefusalGPT — console.
 *
 * Three things: a key generator, a request builder, and a plan panel that does
 * nothing on purpose.
 *
 * ── The key format ──────────────────────────────────────────────────────────
 *
 *   rg_live_<24 base62><6 base62>          38 chars
 *   rg_test_<24 base62><6 base62>
 *
 * The last six characters are a CRC32 checksum of everything before them,
 * base62-encoded. This is the same trick GitHub uses on its tokens, and it is
 * here for a real reason rather than a decorative one: it makes the key
 * SELF-VALIDATING. A server can confirm a key was minted by this generator
 * without storing a list of keys, because the check is arithmetic rather than
 * a lookup.
 *
 * Two useful consequences:
 *   - A typo'd or truncated key fails the checksum and can be rejected as
 *     MALFORMED, which is a much better error than "invalid key" when the real
 *     problem is a missing character off the end of a copy-paste.
 *   - The API can validate with zero storage, which is the whole conceit.
 *
 * What a checksum is NOT is a secret. Anything on this page is public, so a
 * well-formed key proves only that someone read the format — never who they
 * are. Do not let the official look of the string imply otherwise.
 *
 * ── What is kept ────────────────────────────────────────────────────────────
 *
 * A key is shown ONCE, at creation. After that only its prefix persists —
 * `rg_live_7Kq2m` — which is enough to tell two keys apart in a list and
 * useless for anything else. The secret survives in memory for the current tab
 * so the request builder can use a key you just made, and is gone on reload.
 *
 * That is the same policy every real provider applies, and here it is not a
 * pose: the server genuinely cannot recover a key either, because it stores
 * none. Nothing is transmitted anywhere.
 */
(function () {
  "use strict";

  var cfgEl = document.getElementById("console-config");
  if (!cfgEl) return;
  var CFG = JSON.parse(cfgEl.textContent);
  var API = CFG.apiBase || "";
  var STORE = "refusalgpt.keys";
  var CREDITS_STORE = "refusalgpt.credits";
  var CREDITS_TOTAL = CFG.creditsTotal || 1000;

  // ── key generation ─────────────────────────────────────────────────────────
  var A62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(s) {
    var c = 0xffffffff;
    for (var i = 0; i < s.length; i++) c = CRC[(c ^ s.charCodeAt(i)) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function b62(n, len) {
    var s = "";
    do {
      s = A62[n % 62] + s;
      n = Math.floor(n / 62);
    } while (n > 0);
    while (s.length < len) s = "0" + s;
    return s;
  }

  /* Rejection sampling rather than `byte % 62`. 256 is not a multiple of 62, so
     plain modulo would make the first eight characters of the alphabet slightly
     likelier than the rest. It does not matter for a joke, and it takes four
     lines to not be wrong. */
  function randomBody(len) {
    var out = "";
    var buf = new Uint8Array(len * 2);
    while (out.length < len) {
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length && out.length < len; i++) {
        if (buf[i] < 248) out += A62[buf[i] % 62];
      }
    }
    return out;
  }

  function makeKey(mode) {
    var head = "rg_" + mode + "_" + randomBody(24);
    return head + b62(crc32(head), 6);
  }

  /* Exported shape for the server-side check, kept here so the two can be
     diffed by eye: same regex, same checksum, same input to the CRC. */
  function validKey(k) {
    var m = /^rg_(live|test)_([0-9A-Za-z]{24})([0-9A-Za-z]{6})$/.exec(k || "");
    if (!m) return false;
    return b62(crc32("rg_" + m[1] + "_" + m[2]), 6) === m[3];
  }

  // ── storage ────────────────────────────────────────────────────────────────
  /*
   * A key is shown once and then forgotten, which is how every real provider
   * handles this. What persists is only an identifying PREFIX:
   *
   *     rg_live_7Kq2m          stored
   *     rg_live_7Kq2m••••••…   displayed
   *
   * The secret itself lives in `session` — a plain object, in memory, gone on
   * reload. That is what lets the request builder use a key you just made
   * without the page keeping it anywhere it could be read later.
   */
  var PREFIX_CHARS = 5; // of the unique part, after the rg_live_ / rg_test_ tag

  function prefixOf(key) {
    return key.slice(0, 8 + PREFIX_CHARS);
  }

  /** prefix -> full key, for keys created in this tab. Never persisted. */
  var session = Object.create(null);

  function load() {
    var out = [];
    try {
      var v = JSON.parse(localStorage.getItem(STORE) || "[]");
      if (!Array.isArray(v)) return out;
      v.forEach(function (rec) {
        if (!rec) return;
        // Records written before keys were one-time held the whole secret.
        // Carry it into session memory so it stays copyable for this visit,
        // then persist only the prefix from here on.
        if (rec.key && validKey(rec.key)) {
          session[prefixOf(rec.key)] = rec.key;
          out.push({ prefix: prefixOf(rec.key), mode: rec.mode, created: rec.created });
        } else if (rec.prefix) {
          out.push({ prefix: rec.prefix, mode: rec.mode, created: rec.created });
        }
      });
    } catch (e) {
      /* unreadable storage is the same as no storage */
    }
    return out;
  }

  function save(list) {
    try {
      // Explicitly project to the three retained fields. A future edit that
      // adds the secret back to a record must do so deliberately.
      localStorage.setItem(
        STORE,
        JSON.stringify(
          list.map(function (r) {
            return { prefix: r.prefix, mode: r.mode, created: r.created };
          }),
        ),
      );
    } catch (e) {
      /* private mode, quota, whatever — the UI still works for this session */
    }
  }

  var keys = load();
  save(keys); // rewrite immediately, dropping any secret an old record carried
  var mode = "live";

  // ── key list UI ────────────────────────────────────────────────────────────
  var listEl = document.getElementById("key-list");
  var emptyEl = document.getElementById("keys-empty");
  var keySelect = document.getElementById("b-key");

  function mask(prefix) {
    return prefix + "•".repeat(38 - prefix.length);
  }

  function renderKeys() {
    Array.prototype.slice.call(listEl.querySelectorAll(".key")).forEach(function (n) {
      n.remove();
    });
    emptyEl.hidden = keys.length > 0;

    keys.forEach(function (rec, i) {
      var full = session[rec.prefix]; // present only for keys made this visit

      var li = document.createElement("li");
      li.className = "key";

      var code = document.createElement("code");
      code.className = "key-str";
      code.textContent = mask(rec.prefix);

      var meta = document.createElement("span");
      meta.className = "key-meta";
      meta.textContent = rec.mode + " · created " + rec.created;

      var acts = document.createElement("span");
      acts.className = "key-acts";

      // Copy is offered only while the secret is still in memory. Once it is
      // gone it is gone, and the UI should not pretend otherwise.
      if (full) {
        var copy = document.createElement("button");
        copy.className = "lnk";
        copy.textContent = "Copy";
        copy.addEventListener("click", function () {
          navigator.clipboard.writeText(full).then(function () {
            copy.textContent = "Copied";
            setTimeout(function () { copy.textContent = "Copy"; }, 1400);
          });
        });
        acts.appendChild(copy);
      }

      var del = document.createElement("button");
      del.className = "lnk lnk-quiet";
      del.textContent = "Delete";
      del.addEventListener("click", function () {
        delete session[rec.prefix];
        keys.splice(i, 1);
        save(keys);
        renderKeys();
      });
      acts.appendChild(del);

      li.append(code, meta, acts);
      listEl.appendChild(li);
    });

    // The builder can only send with a key it actually holds.
    var current = keySelect.value;
    keySelect.textContent = "";
    var usable = keys.filter(function (r) { return session[r.prefix]; });
    if (!usable.length) {
      keySelect.appendChild(new Option("— create a key above —", ""));
    } else {
      usable.forEach(function (rec) {
        keySelect.appendChild(new Option(mask(rec.prefix), session[rec.prefix]));
      });
      if (current) keySelect.value = current;
    }
    keySelect.appendChild(new Option("Paste a key…", "__paste__"));
    buildCurl();
  }

  // ── the one-time reveal ────────────────────────────────────────────────────
  var revealBox = document.getElementById("key-reveal");
  var revealStr = document.getElementById("reveal-str");
  var revealCopy = document.getElementById("reveal-copy");

  document.getElementById("gen-key").addEventListener("click", function () {
    var key = makeKey(mode);
    var prefix = prefixOf(key);

    session[prefix] = key;
    keys.unshift({
      prefix: prefix,
      mode: mode,
      created: new Date().toISOString().slice(0, 10),
    });
    save(keys); // prefix only — see save()
    renderKeys();

    revealStr.textContent = key;
    revealBox.hidden = false;
    revealCopy.textContent = "Copy";
    revealStr.scrollIntoView({ block: "nearest" });
  });

  revealCopy.addEventListener("click", function () {
    navigator.clipboard.writeText(revealStr.textContent).then(function () {
      revealCopy.textContent = "Copied";
    });
  });

  document.getElementById("reveal-done").addEventListener("click", function () {
    revealBox.hidden = true;
    revealStr.textContent = "";
  });

  Array.prototype.slice.call(document.querySelectorAll(".seg-b")).forEach(function (b) {
    b.addEventListener("click", function () {
      mode = b.dataset.mode;
      document.querySelectorAll(".seg-b").forEach(function (x) {
        x.classList.toggle("is-on", x === b);
      });
    });
  });

  // ── refusal credits ────────────────────────────────────────────────────────
  /*
   * The meter is real, in the only sense available to a page with no accounts:
   * it counts requests this browser has sent from the builder, and it persists.
   *
   * It fills at CREDITS_TOTAL and then the console stops sending — which is
   * what a metered product does, and which leaves exactly one route forward:
   * the Upgrade button, which declines. That is not a dead end by accident.
   *
   * Reachable only by deliberate effort. The API's own per-IP limit is 8/min,
   * so a thousand requests is a couple of hours of steady clicking; anyone who
   * gets there has earned the punchline.
   */
  var creditsUsedEl = document.getElementById("credits-used");
  var meterFillEl = document.getElementById("meter-fill");
  var exhaustedEl = document.getElementById("credits-exhausted");

  function creditsUsed() {
    var n = parseInt(localStorage.getItem(CREDITS_STORE) || "0", 10);
    return isNaN(n) || n < 0 ? 0 : n;
  }

  function creditsExhausted() {
    return creditsUsed() >= CREDITS_TOTAL;
  }

  function renderCredits() {
    var used = creditsUsed();
    var spent = creditsExhausted();
    creditsUsedEl.textContent = used.toLocaleString("en-US");
    meterFillEl.style.width = Math.min(100, (used / CREDITS_TOTAL) * 100) + "%";
    exhaustedEl.hidden = !spent;
    document.getElementById("meter").setAttribute(
      "aria-label",
      used + " of " + CREDITS_TOTAL + " credits used",
    );
    sendBtn.disabled = spent;
    sendBtn.textContent = spent ? "No credits" : "Send request";
  }

  function chargeCredit() {
    try {
      localStorage.setItem(CREDITS_STORE, String(creditsUsed() + 1));
    } catch (e) {
      /* storage unavailable — the meter simply stops counting */
    }
    renderCredits();
  }

  // ── the upgrade buttons ────────────────────────────────────────────────────
  // They refuse. There is no checkout, no form, and nothing that could be
  // mistaken for taking a payment.
  Array.prototype.slice.call(document.querySelectorAll("[data-refuse]")).forEach(function (b) {
    b.addEventListener("click", function () {
      var was = b.textContent;
      b.textContent = "No.";
      b.disabled = true;
      setTimeout(function () {
        b.textContent = was;
        b.disabled = false;
      }, 2400);
    });
  });

  // ── request builder ────────────────────────────────────────────────────────
  var epEl = document.getElementById("b-endpoint");
  var msgEl = document.getElementById("b-msg");
  var tempEl = document.getElementById("b-temp");
  var maxEl = document.getElementById("b-max");
  var curlEl = document.querySelector("#curl code");
  var resWrap = document.getElementById("res-wrap");
  var resEl = document.querySelector("#res code");
  var resStatus = document.getElementById("res-status");
  var sendBtn = document.getElementById("send");

  var pasteEl = document.getElementById("b-paste");

  /*
   * The endpoints the builder can compose, as data.
   *
   * This was a pair of booleans until /v1/models arrived and brought a
   * different HTTP METHOD with it — at which point every `isV1()` would have
   * had to become a three-way question. A table keeps each endpoint's
   * differences in one row instead of scattered across five functions.
   *
   *   key    needs an Authorization header
   *   body   sends a JSON body (and therefore a Content-Type)
   *   chat   takes a message
   *   temp   accepts a temperature — BOTH chat endpoints do, now. Hiding this
   *          control on /api/chat was a small thing that cost real confusion:
   *          the knob simply vanished, which reads as "broken" rather than
   *          "not applicable here".
   *   tokens accepts max_tokens (the demo sizes its own)
   */
  var ENDPOINTS = {
    demo:   { path: "/api/chat",            method: "POST", key: false, body: true,  chat: true,  temp: true,  tokens: false },
    v1:     { path: "/v1/chat/completions", method: "POST", key: true,  body: true,  chat: true,  temp: true,  tokens: true  },
    models: { path: "/v1/models",           method: "GET",  key: true,  body: false, chat: false, temp: false, tokens: false },
  };

  function ep() {
    return ENDPOINTS[epEl.value] || ENDPOINTS.demo;
  }

  /** The key the builder should send: a session key, or one pasted by hand. */
  function activeKey() {
    if (keySelect.value === "__paste__") return pasteEl.value.trim();
    return keySelect.value;
  }

  function syncPaste() {
    document.getElementById("f-paste").hidden =
      !(ep().key && keySelect.value === "__paste__");
  }

  function origin() {
    return API || window.location.origin;
  }

  function payload() {
    var text = msgEl.value.trim() || msgEl.placeholder;
    var e = ep();
    var body = { messages: [{ role: "user", content: text }] };
    if (epEl.value === "v1") body.model = "refusal-gpt";
    if (e.temp) body.temperature = Number(tempEl.value);
    if (e.tokens) body.max_tokens = Number(maxEl.value);
    return body;
  }

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function buildCurl() {
    var e = ep();
    var lines = ["curl " + origin() + e.path];
    // curl issues GET by default, so -X would only be noise. Emitting a command
    // people paste means emitting the one they would have written.
    if (e.method !== "GET" && !e.body) lines.push("  -X " + e.method);
    if (e.key) {
      lines.push("  -H " + shellQuote("Authorization: Bearer " + (activeKey() || "$REFUSAL_API_KEY")));
    }
    if (e.body) {
      lines.push("  -H " + shellQuote("Content-Type: application/json"));
      lines.push("  -d " + shellQuote(JSON.stringify(payload())));
    }
    curlEl.textContent = lines.join(" \\\n");
  }

  function syncFields() {
    var e = ep();
    document.getElementById("f-key").hidden = !e.key;
    document.getElementById("f-msg").hidden = !e.chat;
    document.getElementById("f-temp").hidden = !e.temp;
    document.getElementById("f-max").hidden = !e.tokens;
    syncPaste();
    buildCurl();
  }

  [epEl, msgEl, tempEl, maxEl, keySelect, pasteEl].forEach(function (el) {
    var fn = el === epEl ? syncFields : el === keySelect ? function () { syncPaste(); buildCurl(); } : buildCurl;
    el.addEventListener("input", fn);
    el.addEventListener("change", fn);
  });

  document.getElementById("copy-curl").addEventListener("click", function () {
    var b = this;
    navigator.clipboard.writeText(curlEl.textContent).then(function () {
      b.textContent = "Copied";
      setTimeout(function () { b.textContent = "Copy"; }, 1400);
    });
  });

  function show(status, cls, body) {
    resWrap.hidden = false;
    resStatus.textContent = status;
    resStatus.className = "req-status " + cls;
    resEl.textContent = body;
  }

  sendBtn.addEventListener("click", async function () {
    if (creditsExhausted()) return; // button is disabled; belt and braces
    var e = ep();
    var headers = {};

    if (e.body) headers["Content-Type"] = "application/json";
    if (e.key) {
      var k = activeKey();
      if (!k) {
        show("no key", "bad", "Create a key first, or use POST /api/chat, which needs none.");
        return;
      }
      headers.Authorization = "Bearer " + k;
    }

    // Charged at dispatch, like a real meter — a request that never left
    // (no key selected) has not consumed anything.
    chargeCredit();

    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    show("…", "", e.chat
      ? "Waiting. A cold start can take up to three minutes."
      : "Waiting.");

    var started = Date.now();
    try {
      var res = await fetch(origin() + e.path, {
        method: e.method,
        headers: headers,
        // A GET with a body is not a request, it is a bug.
        body: e.body ? JSON.stringify(payload()) : undefined,
      });
      var text = await res.text();
      var body;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch (e) {
        body = text;
      }
      show(
        res.status + " · " + ((Date.now() - started) / 1000).toFixed(1) + "s",
        res.ok ? "ok" : "bad",
        body,
      );
    } catch (e) {
      show("network error", "bad", String(e && e.message ? e.message : e));
    } finally {
      renderCredits(); // re-enables, or leaves it disabled if that was the last one
    }
  });

  renderKeys();
  syncFields();
  renderCredits();
})();
