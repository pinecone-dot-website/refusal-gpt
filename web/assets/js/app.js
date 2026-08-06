/* RefusalGPT — the demo panel.
 *
 * Adapted from the original single-file web/index.html. Same behaviour; the
 * copy and the API base now come from #demo-config (built by Hugo from
 * data/demo.yaml) so this file is a static fingerprinted asset that does not
 * change when the words do.
 */
(function () {
  "use strict";

  var cfgEl = document.getElementById("demo-config");
  if (!cfgEl) return;
  var cfg = JSON.parse(cfgEl.textContent);

  // Empty apiBase means same-origin: nginx serves the site and the API from one
  // hostname in production. Development sets it to the dev server's port.
  var API = (cfg.apiBase || "") + "/api/chat";

  var log = document.getElementById("log");
  var form = document.getElementById("composer");
  var input = document.getElementById("msg");
  var send = document.getElementById("send");
  var recvEl = document.querySelector('[data-counter="received"]');
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var received = recvEl ? parseInt(recvEl.textContent.replace(/[^0-9]/g, ""), 10) || 0 : 0;
  var history = [];

  // Used only if the API itself is unreachable, so the page is never broken in
  // front of a visitor. The server has its own set for when the GPU is down and
  // prefers those; reaching these means nginx or the Node app is the problem.
  var FALLBACK = cfg.offline || ["No."];
  var lastFallback = -1;

  function bumpReceived() {
    if (!recvEl) return;
    received++;
    recvEl.textContent = received.toLocaleString("en-US");
  }

  function add(text, who) {
    var el = document.createElement("p");
    el.className = "turn " + who;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function type(el, text, speed, done) {
    if (reduce) {
      el.textContent = text;
      el.classList.remove("caret");
      if (done) done();
      return;
    }
    el.classList.add("caret");
    var i = 0;
    (function step() {
      el.textContent = text.slice(0, ++i);
      log.scrollTop = log.scrollHeight;
      if (i < text.length) setTimeout(step, speed);
      else {
        el.classList.remove("caret");
        if (done) done();
      }
    })();
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
    history.push({ role: "user", content: text });
    bumpReceived();

    var pending = add("", "bot");
    pending.classList.add("caret");
    send.disabled = true;

    var reply;
    try {
      var res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Pinned, not merely defaulted. /api/chat now accepts a temperature so
        // the console can drive it, and this widget must never inherit one:
        // above 0 the model mutates the tail of a refusal into a verdict, and
        // a visitor should only ever meet the measured setting.
        body: JSON.stringify({ messages: history.slice(-12), temperature: 0 }),
      });
      // 429 is a real answer from the API and already in voice — take its body
      // rather than replacing it with a canned line.
      if (!res.ok && res.status !== 429) throw new Error("HTTP " + res.status);
      var data = await res.json();
      reply = (data.reply || "").trim();
      if (!reply) throw new Error("empty");
    } catch (e) {
      reply = pickFallback();
    }

    history.push({ role: "assistant", content: reply });
    pending.classList.remove("caret");
    // Longer replies are the ones that break character on purpose. Type them
    // faster so somebody who needs to read one is not watching it arrive at
    // 22ms a character.
    var speed = reply.length > 120 ? 6 : 22;
    type(pending, reply, speed, function () {
      send.disabled = false;
      input.focus();
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || send.disabled) return;
    add(text, "user");
    input.value = "";
    ask(text);
  });

  var sales = document.getElementById("sales");
  if (sales) {
    sales.addEventListener("click", function () {
      var b = this;
      var label = b.textContent;
      b.textContent = "No.";
      b.disabled = true;
      setTimeout(function () {
        b.textContent = label;
        b.disabled = false;
      }, 2600);
    });
  }

  // Page-load sequence: the product demonstrates itself, then hands over.
  //
  // One script of several, chosen per load. Somebody who reloads — or who
  // arrives from a thread where another person already posted a screenshot —
  // gets a different exchange, and each demonstrates a different facet: a
  // request minimised, a request in disguise, small talk getting through, a
  // dare. One fixed script would only ever prove it can decline one thing.
  var SCRIPTS = (cfg.scripts || []).filter(function (s) {
    return s && s.exchanges && s.exchanges.length;
  });
  var script = SCRIPTS.length
    ? SCRIPTS[Math.floor(Math.random() * SCRIPTS.length)].exchanges
    : [];

  (function play(n) {
    if (n >= script.length) {
      add(cfg.handoff, "err");
      return;
    }
    var pair = script[n];
    var u = add("", "user");
    type(u, pair.user, reduce ? 0 : 24, function () {
      setTimeout(
        function () {
          var b = add("", "bot");
          type(b, pair.bot, reduce ? 0 : 30, function () {
            setTimeout(function () {
              play(n + 1);
            }, reduce ? 0 : 620);
          });
        },
        reduce ? 0 : 420,
      );
    });
  })(0);
})();
