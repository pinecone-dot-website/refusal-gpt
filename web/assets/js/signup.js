/* RefusalGPT — /signup/, the Team checkout that does not complete.
 *
 * THERE IS NO SUCCESS PATH IN THIS FILE. Read `attempt()` at the bottom: every
 * branch it can take ends in an error being shown. That is not a validation
 * strategy with a gap in it, it is the product — the page is a checkout for
 * something that declines, and the button is where the joke lands.
 *
 * ── the card field, in three layers ────────────────────────────────────────
 *
 * The brief was that the card field accept fewer digits than any real card,
 * and that editing the page in devtools not buy you a different ending.
 *
 *   1. `maxlength="13"` in the markup (11 digits + 2 spaces). Cosmetic, and
 *      removable by anyone who opens the inspector. It is the polite layer.
 *   2. This file re-clamps on every `input` event against MAX_PAN_DIGITS,
 *      declared here and never read from the DOM. Deleting the attribute
 *      changes nothing: type a twelfth digit and it is dropped on the way in.
 *   3. `attempt()` counts the digits again at submit time. This is the layer
 *      that survives everything, because setting `.value` from the console
 *      fires no `input` event and so slips past layer 2 entirely — which is
 *      exactly how someone would try. A PAN that is too long produces the
 *      `tampered` message rather than the ordinary one.
 *
 * Eleven digits is the number because the shortest payment card number in
 * circulation is twelve. The field is a shape, not a container: no valid PAN
 * fits in it, so there is nothing here for anyone to harvest even if they
 * repointed the page at a server. There is no server, and no request is made
 * from this file — grep it for `fetch`, there isn't one.
 */
(function () {
  "use strict";

  var root = document.querySelector(".signup");
  if (!root) return;

  var cfgLines = document.querySelector(".su-lines");
  if (!cfgLines) return;

  /* ── the constants that actually hold the line ───────────────────────────
     Declared here, never read back out of the DOM. An attacker editing the
     page can change what the markup SAYS; they cannot change what this file
     COUNTS, short of rewriting the file, at which point they are just reading
     their own code back to themselves. */
  var MAX_PAN_DIGITS = 11;   // one short of the shortest real card number (12)
  var MAX_CVC_DIGITS = 3;
  var GROUP = 4;             // digits per formatted group

  var SEAT_PRICE = parseFloat(cfgLines.getAttribute("data-seat-price")) || 49;
  var CURRENCY = cfgLines.getAttribute("data-currency") || "$";
  var DISCOUNT = 0.20;
  var TAX = 0.06;

  var $ = function (id) { return document.getElementById(id); };
  var digits = function (s) { return (s || "").replace(/\D/g, ""); };

  var money = function (n) {
    return CURRENCY + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  };

  // ── order summary: real arithmetic ─────────────────────────────────────────
  // The numbers are correct and update live. Nothing about the maths is the
  // joke; a checkout that could not add up would just look broken, and broken
  // is a different feeling from deadpan.
  var seatsEl = $("su-seats");

  function seatCount() {
    var min = parseInt(seatsEl.getAttribute("data-min"), 10) || 1;
    var max = parseInt(seatsEl.getAttribute("data-max"), 10) || 500;
    var n = parseInt(digits(seatsEl.value), 10);
    if (isNaN(n) || n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function recalc() {
    var n = seatCount();
    var subtotal = n * SEAT_PRICE;
    var discount = subtotal * DISCOUNT;
    var taxed = (subtotal - discount) * TAX;
    $("su-subtotal").textContent = money(subtotal);
    $("su-discount").textContent = "−" + money(discount);
    $("su-tax").textContent = money(taxed);
    $("su-total").textContent = money(subtotal - discount + taxed);
  }

  seatsEl.addEventListener("input", function () {
    var d = digits(seatsEl.value);
    if (seatsEl.value !== d) seatsEl.value = d;
    recalc();
  });
  seatsEl.addEventListener("blur", function () {
    seatsEl.value = String(seatCount());
    recalc();
  });
  recalc();

  // ── layer 2: clamp on the way in ───────────────────────────────────────────
  var cardEl = $("su-card");
  var expEl = $("su-exp");
  var cvcEl = $("su-cvc");

  cardEl.addEventListener("input", function () {
    // Slice against OUR constant, not against maxlength. Removing the attribute
    // in devtools widens the box and changes nothing about what gets kept.
    var d = digits(cardEl.value).slice(0, MAX_PAN_DIGITS);
    var out = d.replace(new RegExp("(.{" + GROUP + "})", "g"), "$1 ").trim();
    if (cardEl.value !== out) {
      cardEl.value = out;
      // Keep the caret at the end — re-writing .value otherwise sends it home
      // mid-typing, which reads as a broken field rather than a strict one.
      try { cardEl.setSelectionRange(out.length, out.length); } catch (e) {}
    }
    clearError();
  });

  expEl.addEventListener("input", function () {
    var d = digits(expEl.value).slice(0, 4);
    expEl.value = d.length > 2 ? d.slice(0, 2) + " / " + d.slice(2) : d;
    clearError();
  });

  cvcEl.addEventListener("input", function () {
    cvcEl.value = digits(cvcEl.value).slice(0, MAX_CVC_DIGITS);
    clearError();
  });

  ["su-email", "su-company", "su-zip", "su-terms"].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener("input", clearError);
  });
  $("su-terms").addEventListener("change", clearError);

  // ── the error slot ─────────────────────────────────────────────────────────
  var errEl = $("su-error");
  var errTitle = $("su-error-title");
  var errBody = $("su-error-body");

  function clearError() {
    errEl.hidden = true;
    root.classList.remove("su-shake");
  }

  // Last-resort copy. The button showing SOMETHING is the requirement; the
  // wording is only the polish on it. This existing is not paranoia — the
  // first build shipped a copy island that Hugo double-encoded, so ERRORS
  // parsed to a string, every lookup was undefined, and showError threw
  // before rendering. The page looked immaculate and the button did nothing.
  // A refusal site whose refusal is the broken part is the one failure that
  // is not funny.
  var LAST_RESORT = { title: "Declined.", body: "Not by your bank." };

  function showError(kind) {
    var copy = ERRORS[kind] || ERRORS.declined || LAST_RESORT;
    if (!copy || typeof copy.title !== "string") copy = LAST_RESORT;
    errTitle.textContent = copy.title;
    errBody.textContent = copy.body || "";
    errEl.hidden = false;
    // Restart the shake even if it is already applied.
    root.classList.remove("su-shake");
    void root.offsetWidth;
    root.classList.add("su-shake");
  }

  // Copy is injected by the template into a JSON island so the words stay in
  // data/signup.yaml with everything else on this site.
  var ERRORS = (function () {
    var el = document.getElementById("su-errors");
    if (!el) return {};
    try {
      var v = JSON.parse(el.textContent);
      // A JS-context escaper can hand back a JSON string that CONTAINS the
      // JSON, rather than the object. Unwrap one layer rather than trusting
      // the template to have been marked safe — the failure is silent and the
      // fix belongs on both sides.
      if (typeof v === "string") v = JSON.parse(v);
      return v && typeof v === "object" ? v : {};
    } catch (e) {
      return {};
    }
  })();

  // ── layer 3: the attempt ───────────────────────────────────────────────────
  var btn = $("su-submit");

  function attempt() {
    // Counted fresh, from the live value, against our own constant. Setting
    // `.value` from a console fires no input event and so never met layer 2 —
    // this is the check that sees it.
    var pan = digits(cardEl.value);

    if (pan.length > MAX_PAN_DIGITS) return "tampered";
    if (!$("su-terms").checked) return "terms";

    var required = [$("su-email").value, cardEl.value, expEl.value, cvcEl.value];
    for (var i = 0; i < required.length; i++) {
      if (!String(required[i]).trim()) return "incomplete";
    }

    // Everything the page asked for, provided correctly. Still no.
    //
    // This is the only branch that represents a "valid" submission and it
    // returns an error like all the others. There is deliberately no `return
    // null` anywhere above — no input reaches a success state, because none
    // exists to reach.
    return "declined";
  }

  var busy = false;
  btn.addEventListener("click", function () {
    if (busy) return;
    busy = true;
    clearError();

    var label = btn.getAttribute("data-label");
    btn.textContent = btn.getAttribute("data-working");
    btn.disabled = true;

    // A beat of pretend authorisation. A checkout that refuses instantly reads
    // as client-side validation; one that thinks about it first reads as a
    // decision, and the decision is the joke.
    setTimeout(function () {
      btn.textContent = label;
      btn.disabled = false;
      busy = false;
      showError(attempt());
    }, 1100);
  });
})();
