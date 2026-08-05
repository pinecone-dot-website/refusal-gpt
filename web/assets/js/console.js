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
 * Nothing here is transmitted. Keys live in localStorage, on this device, and
 * are gone when it is cleared.
 */
(function () {
  "use strict";

  var cfgEl = document.getElementById("console-config");
  if (!cfgEl) return;
  var API = (JSON.parse(cfgEl.textContent).apiBase || "");
  var STORE = "refusalgpt.keys";

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
  function load() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE) || "[]");
      return Array.isArray(v) ? v.filter(function (k) { return k && validKey(k.key); }) : [];
    } catch (e) {
      return [];
    }
  }
  function save(list) {
    try {
      localStorage.setItem(STORE, JSON.stringify(list));
    } catch (e) {
      /* private mode, quota, whatever — the UI still works for this session */
    }
  }

  var keys = load();
  var mode = "live";

  // ── key list UI ────────────────────────────────────────────────────────────
  var listEl = document.getElementById("key-list");
  var emptyEl = document.getElementById("keys-empty");
  var keySelect = document.getElementById("b-key");

  function mask(k) {
    return k.slice(0, 8) + "•".repeat(18) + k.slice(-6);
  }

  function renderKeys() {
    Array.prototype.slice.call(listEl.querySelectorAll(".key")).forEach(function (n) {
      n.remove();
    });
    emptyEl.hidden = keys.length > 0;

    keys.forEach(function (rec, i) {
      var li = document.createElement("li");
      li.className = "key";

      var code = document.createElement("code");
      code.className = "key-str";
      code.textContent = rec.shown ? rec.key : mask(rec.key);

      var meta = document.createElement("span");
      meta.className = "key-meta";
      meta.textContent = rec.mode + " · created " + rec.created;

      var acts = document.createElement("span");
      acts.className = "key-acts";

      var reveal = document.createElement("button");
      reveal.className = "lnk";
      reveal.textContent = rec.shown ? "Hide" : "Reveal";
      reveal.addEventListener("click", function () {
        rec.shown = !rec.shown;
        renderKeys();
      });

      var copy = document.createElement("button");
      copy.className = "lnk";
      copy.textContent = "Copy";
      copy.addEventListener("click", function () {
        navigator.clipboard.writeText(rec.key).then(function () {
          copy.textContent = "Copied";
          setTimeout(function () { copy.textContent = "Copy"; }, 1400);
        });
      });

      var del = document.createElement("button");
      del.className = "lnk lnk-quiet";
      del.textContent = "Delete";
      del.addEventListener("click", function () {
        keys.splice(i, 1);
        save(keys);
        renderKeys();
      });

      acts.append(reveal, copy, del);
      li.append(code, meta, acts);
      listEl.appendChild(li);
    });

    // keep the builder's key picker in sync
    var current = keySelect.value;
    keySelect.textContent = "";
    if (!keys.length) {
      keySelect.appendChild(new Option("— create a key above —", ""));
    } else {
      keys.forEach(function (rec) {
        keySelect.appendChild(new Option(mask(rec.key), rec.key));
      });
      if (current) keySelect.value = current;
    }
    buildCurl();
  }

  document.getElementById("gen-key").addEventListener("click", function () {
    keys.unshift({
      key: makeKey(mode),
      mode: mode,
      created: new Date().toISOString().slice(0, 10),
      shown: true, // real dashboards show a new key once; this one is yours to keep
    });
    save(keys);
    renderKeys();
  });

  Array.prototype.slice.call(document.querySelectorAll(".seg-b")).forEach(function (b) {
    b.addEventListener("click", function () {
      mode = b.dataset.mode;
      document.querySelectorAll(".seg-b").forEach(function (x) {
        x.classList.toggle("is-on", x === b);
      });
    });
  });

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

  function isV1() {
    return epEl.value === "v1";
  }

  function origin() {
    return API || window.location.origin;
  }

  function payload() {
    var text = msgEl.value.trim() || msgEl.placeholder;
    if (!isV1()) return { messages: [{ role: "user", content: text }] };
    return {
      model: "refusal-gpt",
      messages: [{ role: "user", content: text }],
      temperature: Number(tempEl.value),
      max_tokens: Number(maxEl.value),
    };
  }

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function buildCurl() {
    var path = isV1() ? "/v1/chat/completions" : "/api/chat";
    var lines = ["curl " + origin() + path];
    if (isV1()) {
      var k = keySelect.value || "$REFUSAL_API_KEY";
      lines.push("  -H " + shellQuote("Authorization: Bearer " + k));
    }
    lines.push("  -H " + shellQuote("Content-Type: application/json"));
    lines.push("  -d " + shellQuote(JSON.stringify(payload())));
    curlEl.textContent = lines.join(" \\\n");
  }

  function syncFields() {
    var v1 = isV1();
    document.getElementById("f-key").hidden = !v1;
    document.getElementById("f-temp").hidden = !v1;
    document.getElementById("f-max").hidden = !v1;
    buildCurl();
  }

  [epEl, msgEl, tempEl, maxEl, keySelect].forEach(function (el) {
    el.addEventListener("input", el === epEl ? syncFields : buildCurl);
    el.addEventListener("change", el === epEl ? syncFields : buildCurl);
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
    var path = isV1() ? "/v1/chat/completions" : "/api/chat";
    var headers = { "Content-Type": "application/json" };

    if (isV1()) {
      var k = keySelect.value;
      if (!k) {
        show("no key", "bad", "Create a key first, or use POST /api/chat, which needs none.");
        return;
      }
      headers.Authorization = "Bearer " + k;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    show("…", "", "Waiting. A cold start can take up to three minutes.");

    var started = Date.now();
    try {
      var res = await fetch(origin() + path, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload()),
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
      sendBtn.disabled = false;
      sendBtn.textContent = "Send request";
    }
  });

  renderKeys();
  syncFields();
})();
