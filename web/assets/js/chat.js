/* RefusalGPT — the chat app.
 *
 * A full-window conversation with a drawer of past ones. No account, no server
 * state: everything a returning visitor sees was written by their own browser.
 *
 * ── Where a conversation lives ──────────────────────────────────────────────
 *
 * Two stores, on purpose:
 *
 *   localStorage   refusalgpt.chats      the INDEX — {id, title, updated, n}
 *   IndexedDB      conversations[id]     the BODIES — the actual messages
 *
 * The split is not decoration. localStorage is synchronous and capped at ~5 MB
 * per origin, counted in UTF-16 code units, so the real ceiling is closer to
 * 2.5 million characters — a few hundred conversations, and every read and
 * write of it blocks the main thread. IndexedDB is async and its quota is a
 * share of free disk, which is orders of magnitude more room than this page
 * could fill on purpose.
 *
 * So the tiny thing the drawer needs on first paint is synchronous and instant,
 * and the large thing only one conversation needs at a time is async and
 * effectively unbounded. The drawer renders before a single message is read.
 *
 * ── When there is no storage at all ─────────────────────────────────────────
 *
 * Private windows, disabled cookies, and Safari's seven-day eviction all end
 * with the same outcome: the writes fail. Every one of them is caught, the app
 * keeps working for the current session, and the drawer says so rather than
 * pretending the transcript is safe. A history that silently isn't saved is
 * worse than no history, because a person only finds out later.
 *
 * ── The credits meter ───────────────────────────────────────────────────────
 *
 * The same meter as /console/, deliberately: same localStorage key, same
 * ceiling, same sentence when it fills. Requests sent from either page charge
 * the one counter, because it is one browser and there is only one joke.
 */
(function () {
  "use strict";

  var cfgEl = document.getElementById("chat-config");
  if (!cfgEl) return;
  var CFG = JSON.parse(cfgEl.textContent);
  var COPY = CFG.copy || {};
  var API = (CFG.apiBase || "") + "/api/chat";

  var IDX_STORE = "refusalgpt.chats"; // the drawer's index
  var LS_BODY = "refusalgpt.chat."; // per-conversation bodies, fallback only
  var DB_NAME = "refusalgpt";
  var DB_VER = 1;
  var DB_STORE = "conversations";

  // Shared with console.js. Do not rename either half without the other.
  var CREDITS_STORE = "refusalgpt.credits";
  var CREDITS_TOTAL = CFG.creditsTotal || 1000;

  var TITLE_CHARS = 42; // of the first user message, for the drawer label
  var TURNS_SENT = 12; // history window on the wire, matching the homepage demo

  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── elements ───────────────────────────────────────────────────────────────
  var root = document.getElementById("cx");
  var drawer = document.getElementById("cx-drawer");
  var scrim = document.getElementById("cx-scrim");
  var toggle = document.getElementById("cx-toggle");
  var listEl = document.getElementById("cx-list");
  var listEmpty = document.getElementById("cx-list-empty");
  var newBtn = document.getElementById("cx-new");
  var noteEl = document.getElementById("cx-note");
  var logEl = document.getElementById("cx-log");
  var emptyEl = document.getElementById("cx-empty");
  var headTitle = document.getElementById("cx-head-title");
  var form = document.getElementById("cx-composer");
  var input = document.getElementById("cx-msg");
  var sendBtn = document.getElementById("cx-send");
  var usedEl = document.getElementById("cx-credits-used");
  var fillEl = document.getElementById("cx-meter-fill");
  var meterEl = document.getElementById("cx-meter");
  var exhaustedEl = document.getElementById("cx-exhausted");

  // ── IndexedDB ──────────────────────────────────────────────────────────────
  /*
   * Resolves to a database or to null. Never rejects: a browser that will not
   * open one is an ordinary condition here, not an error, and every caller
   * already has a localStorage path to take.
   */
  function openDB() {
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      }

      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VER);
      } catch (e) {
        return done(null);
      }

      /* Safari in a private window has historically left open() PENDING rather
         than firing onerror — no success, no error, no timeout of its own. A
         promise nobody resolves would hang every read behind it, so this takes
         the fallback path after two seconds instead of waiting forever. */
      setTimeout(function () { done(null); }, 2000);

      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function () { done(req.result); };
      req.onerror = function () { done(null); };
      req.onblocked = function () { done(null); };
    });
  }

  function idbDo(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = db.transaction(DB_STORE, mode);
      } catch (e) {
        return reject(e);
      }
      var req = fn(tx.objectStore(DB_STORE));
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  }

  // ── the store ──────────────────────────────────────────────────────────────
  /*
   * One interface over two backends. Every method reports whether the write
   * actually landed, because "saved" and "did not throw" are different claims
   * and the drawer tells the visitor which one it has.
   */
  var Store = (function () {
    var dbPromise = null;
    var writable = true; // flipped false the first time everything refuses

    function db() {
      if (!dbPromise) dbPromise = openDB();
      return dbPromise;
    }

    function lsGet(id) {
      try {
        var v = JSON.parse(localStorage.getItem(LS_BODY + id) || "null");
        return Array.isArray(v) ? v : [];
      } catch (e) {
        return [];
      }
    }

    function lsPut(id, msgs) {
      try {
        localStorage.setItem(LS_BODY + id, JSON.stringify(msgs));
        return true;
      } catch (e) {
        return false;
      }
    }

    return {
      canWrite: function () { return writable; },

      get: async function (id) {
        var d = await db();
        if (d) {
          try {
            var rec = await idbDo(d, "readonly", function (s) { return s.get(id); });
            if (rec && Array.isArray(rec.messages)) return rec.messages;
          } catch (e) {
            /* fall through to the synchronous copy */
          }
        }
        return lsGet(id);
      },

      put: async function (id, msgs) {
        var d = await db();
        if (d) {
          try {
            await idbDo(d, "readwrite", function (s) {
              return s.put({ id: id, messages: msgs });
            });
            return true;
          } catch (e) {
            /* quota, or a store that vanished under us — try the other one */
          }
        }
        var ok = lsPut(id, msgs);
        if (!ok) writable = false;
        return ok;
      },

      del: async function (id) {
        var d = await db();
        if (d) {
          try {
            await idbDo(d, "readwrite", function (s) { return s.delete(id); });
          } catch (e) {
            /* nothing to do about it, and nothing depends on it succeeding */
          }
        }
        try {
          localStorage.removeItem(LS_BODY + id);
        } catch (e) {}
      },
    };
  })();

  // ── the index ──────────────────────────────────────────────────────────────
  function loadIndex() {
    try {
      var v = JSON.parse(localStorage.getItem(IDX_STORE) || "[]");
      if (!Array.isArray(v)) return [];
      return v.filter(function (r) { return r && r.id; });
    } catch (e) {
      return [];
    }
  }

  /*
   * The index is small — four short fields per conversation — so filling a 5 MB
   * quota with it alone would take tens of thousands of chats. It can still
   * fail in a browser that has decided storage is off, and one retry after
   * dropping the oldest entry is the whole recovery: if that fails too, the
   * session continues unsaved and the drawer says so.
   */
  function saveIndex() {
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        localStorage.setItem(IDX_STORE, JSON.stringify(convs));
        return true;
      } catch (e) {
        if (attempt === 0 && convs.length > 1) {
          var dropped = convs.pop();
          Store.del(dropped.id);
          continue;
        }
        return false;
      }
    }
    return false;
  }

  function newId() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function titleFor(text) {
    var t = text.replace(/\s+/g, " ").trim();
    if (!t) return COPY.drawer.untitled;
    return t.length > TITLE_CHARS ? t.slice(0, TITLE_CHARS - 1) + "…" : t;
  }

  function stamp(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString();
  }

  // ── state ──────────────────────────────────────────────────────────────────
  var convs = loadIndex(); // newest first
  var current = null; // { id, messages: [...] } — null until something is typed
  var busy = false;
  var lastFallback = -1;
  var FALLBACK = (CFG.offline && CFG.offline.length) ? CFG.offline : ["No."];

  // ── credits ────────────────────────────────────────────────────────────────
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
    usedEl.textContent = used.toLocaleString("en-US");
    fillEl.style.width = Math.min(100, (used / CREDITS_TOTAL) * 100) + "%";
    exhaustedEl.hidden = !spent;
    meterEl.setAttribute("aria-label", used + " of " + CREDITS_TOTAL + " credits used");
    input.disabled = spent;
    sendBtn.disabled = spent || busy;
    sendBtn.textContent = spent
      ? COPY.composer.spent
      : busy
        ? COPY.composer.sending
        : COPY.composer.send;
  }

  function chargeCredit() {
    try {
      localStorage.setItem(CREDITS_STORE, String(creditsUsed() + 1));
    } catch (e) {
      /* storage unavailable — the meter simply stops counting */
    }
    renderCredits();
  }

  // ── drawer ─────────────────────────────────────────────────────────────────
  function setDrawer(open) {
    root.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    scrim.hidden = !open || window.innerWidth > 940;
  }

  function drawerDefault() {
    // Open beside the log on a desktop; closed over it on a phone, where 280px
    // of history would leave no room for the conversation itself.
    setDrawer(window.innerWidth > 940);
  }

  function renderList() {
    Array.prototype.slice.call(listEl.querySelectorAll(".cx-item")).forEach(function (n) {
      n.remove();
    });
    listEmpty.hidden = convs.length > 0;

    convs.forEach(function (rec) {
      var li = document.createElement("li");
      li.className = "cx-item" + (current && current.id === rec.id ? " is-on" : "");

      var open = document.createElement("button");
      open.className = "cx-item-open";
      open.type = "button";

      var t = document.createElement("span");
      t.className = "cx-item-title";
      t.textContent = rec.title || COPY.drawer.untitled;

      var m = document.createElement("span");
      m.className = "cx-item-meta";
      m.textContent = rec.n + " · " + stamp(rec.updated);

      open.append(t, m);
      open.addEventListener("click", function () {
        openConv(rec.id);
      });

      /* Two-step rather than a confirm() dialog. A modal to delete a joke
         transcript is a bigger interruption than the action deserves, and the
         second click is a real guard against the first being a misfire. */
      var del = document.createElement("button");
      del.className = "lnk lnk-quiet cx-item-del";
      del.type = "button";
      del.textContent = COPY.drawer.delete;
      var armed = false;
      var disarm;
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!armed) {
          armed = true;
          del.textContent = COPY.drawer.deleteConfirm;
          del.classList.add("is-armed");
          disarm = setTimeout(function () {
            armed = false;
            del.textContent = COPY.drawer.delete;
            del.classList.remove("is-armed");
          }, 3000);
          return;
        }
        clearTimeout(disarm);
        removeConv(rec.id);
      });

      li.append(open, del);
      listEl.appendChild(li);
    });
  }

  // ── the log ────────────────────────────────────────────────────────────────
  function addTurn(text, who) {
    emptyEl.hidden = true;

    var wrap = document.createElement("div");
    wrap.className = "cx-turn cx-" + who;

    var role = document.createElement("span");
    role.className = "cx-role";
    role.textContent = who === "user" ? COPY.roles.user : COPY.roles.bot;

    var body = document.createElement("p");
    body.className = "cx-body";
    body.textContent = text;

    wrap.append(role, body);
    logEl.appendChild(wrap);
    logEl.scrollTop = logEl.scrollHeight;
    return body;
  }

  function type(el, text, done) {
    if (reduce) {
      el.textContent = text;
      el.classList.remove("caret");
      if (done) done();
      return;
    }
    // Longer replies are the ones that break character on purpose. Type those
    // faster, so somebody who needs to read one is not watching it arrive at
    // 22ms a character.
    var speed = text.length > 120 ? 6 : 22;
    el.classList.add("caret");
    var i = 0;
    (function step() {
      el.textContent = text.slice(0, ++i);
      logEl.scrollTop = logEl.scrollHeight;
      if (i < text.length) setTimeout(step, speed);
      else {
        el.classList.remove("caret");
        if (done) done();
      }
    })();
  }

  function renderLog(messages) {
    logEl.textContent = "";
    logEl.appendChild(emptyEl);
    emptyEl.hidden = messages.length > 0;
    messages.forEach(function (m) {
      addTurn(m.content, m.role === "user" ? "user" : "bot");
    });
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ── conversations ──────────────────────────────────────────────────────────
  function indexOfConv(id) {
    for (var i = 0; i < convs.length; i++) if (convs[i].id === id) return i;
    return -1;
  }

  async function openConv(id) {
    if (busy) return;
    var messages = await Store.get(id);
    current = { id: id, messages: messages };
    var rec = convs[indexOfConv(id)];
    headTitle.textContent = (rec && rec.title) || COPY.drawer.untitled;
    renderLog(messages);
    renderList();
    if (window.innerWidth <= 940) setDrawer(false);
    input.focus();
  }

  function newConv() {
    if (busy) return;
    // Nothing is written until there is something to write. An empty
    // conversation in the drawer is a row that means "you clicked New" —
    // the id is minted on the first message instead.
    current = null;
    headTitle.textContent = COPY.drawer.untitled;
    renderLog([]);
    renderList();
    if (window.innerWidth <= 940) setDrawer(false);
    input.focus();
  }

  async function removeConv(id) {
    var i = indexOfConv(id);
    if (i > -1) convs.splice(i, 1);
    saveIndex();
    await Store.del(id);
    if (current && current.id === id) newConv();
    else renderList();
  }

  /** Write the current conversation through, and move it to the top. */
  async function persist() {
    if (!current) return;
    var first = current.messages.find(function (m) { return m.role === "user"; });
    var rec = {
      id: current.id,
      title: titleFor(first ? first.content : ""),
      updated: new Date().toISOString(),
      n: current.messages.length,
    };
    var i = indexOfConv(current.id);
    if (i > -1) convs.splice(i, 1);
    convs.unshift(rec);

    var okIndex = saveIndex();
    var okBody = await Store.put(current.id, current.messages);
    headTitle.textContent = rec.title;
    renderList();
    if (!okIndex || !okBody) {
      noteEl.textContent = COPY.drawer.noStore;
      noteEl.classList.add("is-warn");
    }
  }

  function pickFallback() {
    var i;
    do {
      i = Math.floor(Math.random() * FALLBACK.length);
    } while (i === lastFallback && FALLBACK.length > 1);
    lastFallback = i;
    return FALLBACK[i];
  }

  async function ask(text) {
    if (!current) current = { id: newId(), messages: [] };
    current.messages.push({ role: "user", content: text });
    addTurn(text, "user");
    persist();

    // Charged at dispatch, like the console's meter — a request that never
    // left has not consumed anything.
    chargeCredit();

    busy = true;
    renderCredits();
    var pending = addTurn("", "bot");
    pending.classList.add("caret");

    var reply;
    var offline = false;
    try {
      var res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Temperature is PINNED, not defaulted. Above 0 the model mutates the
        // tail of a refusal into a verdict, and a visitor should only ever meet
        // the measured setting. The console is where that knob lives.
        body: JSON.stringify({
          messages: current.messages.slice(-TURNS_SENT).map(function (m) {
            return { role: m.role, content: m.content };
          }),
          temperature: 0,
        }),
      });
      // 429 is a real answer from the API and already in voice — take its body
      // rather than replacing it with a canned line.
      if (!res.ok && res.status !== 429) throw new Error("HTTP " + res.status);
      var data = await res.json();
      reply = (data.reply || "").trim();
      if (!reply) throw new Error("empty");
    } catch (e) {
      reply = pickFallback();
      offline = true;
    }

    // A fallback that hides itself is indistinguishable from the model, which
    // is exactly the confusion this repo counts as a failure. Mark it.
    if (offline) {
      var tag = document.createElement("span");
      tag.className = "cx-offline";
      tag.textContent = COPY.log.offlineNote;
      pending.parentNode.querySelector(".cx-role").appendChild(tag);
    }

    current.messages.push({ role: "assistant", content: reply });
    pending.classList.remove("caret");
    type(pending, reply, function () {
      busy = false;
      renderCredits();
      persist();
      if (!input.disabled) input.focus();
    });
  }

  // ── composer ───────────────────────────────────────────────────────────────
  function grow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 168) + "px";
  }

  function submit() {
    if (busy || creditsExhausted()) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    ask(text);
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    submit();
  });

  input.addEventListener("input", grow);
  input.addEventListener("keydown", function (e) {
    // Enter sends, Shift+Enter breaks the line. IME composition must be left
    // alone: Enter is how a Japanese or Chinese keyboard COMMITS a candidate,
    // and sending there would post a half-typed word.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  // ── wiring ─────────────────────────────────────────────────────────────────
  newBtn.addEventListener("click", newConv);
  toggle.addEventListener("click", function () {
    setDrawer(!root.classList.contains("is-open"));
  });
  scrim.addEventListener("click", function () { setDrawer(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && window.innerWidth <= 940) setDrawer(false);
  });

  var wide = window.innerWidth > 940;
  window.addEventListener("resize", function () {
    var nowWide = window.innerWidth > 940;
    if (nowWide !== wide) {
      wide = nowWide;
      drawerDefault(); // crossing the breakpoint, not every pixel of a drag
    }
  });

  if (!Store.canWrite()) {
    noteEl.textContent = COPY.drawer.noStore;
    noteEl.classList.add("is-warn");
  }

  drawerDefault();
  renderList();
  renderCredits();

  // The most recent conversation, restored — which is what a chat app does and
  // the only reason to have kept it.
  if (convs.length) openConv(convs[0].id);
  else input.focus();
})();
