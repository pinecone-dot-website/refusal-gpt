/* RefusalGPT — /signup/, the Team checkout that does not complete.
 *
 * THERE IS NO SUCCESS PATH IN THIS FILE. Read `attempt()` at the bottom: every
 * branch it can take ends in an error being shown. That is not a validation
 * strategy with a gap in it, it is the product — the page is a checkout for
 * something that declines, and the button is where the joke lands.
 *
 * ── why the card fields are not inputs ─────────────────────────────────────
 *
 * Card number, expiry and CVC are contenteditable elements dressed as inputs.
 * Firefox offered saved credit cards in the original <input> version despite
 * there being no <form>, no `name`, no cc-* autocomplete token, and
 * autocomplete="off" throughout — it classifies a card SECTION from visible
 * label text and fills it, and treats autocomplete="off" as advisory for
 * payment fields. The label says "Card number" because that is the joke, so
 * the signal cannot be hidden. Autofill targets form controls; these are not
 * form controls. Nothing to fill. See the comment in signup.html.
 *
 * ── the digit cap, in two real layers ──────────────────────────────────────
 *
 * The brief: the field accepts fewer digits than any real card, and editing
 * the page in devtools does not buy a different ending.
 *
 *   1. Every `input` event re-clamps against MAX_PAN_DIGITS, declared here and
 *      never read from the DOM. There is no `maxlength` to delete any more —
 *      contenteditable has no such attribute — so the cosmetic layer is gone
 *      and this is now the first one. Type or paste a twelfth digit and it is
 *      dropped on the way in.
 *   2. `attempt()` counts the digits again at submit time. This is the layer
 *      that survives everything, because setting `.textContent` from a console
 *      fires no `input` event and so slips past layer 1 entirely — exactly how
 *      someone would try. Too long a PAN produces the `tampered` message.
 *
 * Eleven digits is the number because the shortest payment card number in
 * circulation is twelve. The field is a shape, not a container: no valid PAN
 * fits, so there is nothing here to harvest even if the page were repointed at
 * a server. There is no server, and this file makes no request — grep it for
 * `fetch`, there isn't one.
 */
(function () {
  "use strict";

  var root = document.querySelector(".signup");
  if (!root) return;

  var cfgLines = document.querySelector(".su-lines");
  if (!cfgLines) return;

  /* ── the constants that actually hold the line ───────────────────────────
     Declared here, never read back out of the DOM. Editing the page changes
     what the markup SAYS; it does not change what this file COUNTS. */
  var MAX_PAN_DIGITS = 11;   // one short of the shortest real card number (12)
  var MAX_CVC_DIGITS = 3;
  var MAX_EXP_DIGITS = 4;
  var GROUP = 4;             // digits per formatted group

  var SEAT_PRICE = parseFloat(cfgLines.getAttribute("data-seat-price")) || 49;
  var CURRENCY = cfgLines.getAttribute("data-currency") || "$";
  var DISCOUNT = 0.20;
  var TAX = 0.06;

  var $ = function (id) { return document.getElementById(id); };
  var digits = function (s) { return (s || "").replace(/\D/g, ""); };

  // The card fields are contenteditable, the rest are real inputs. One pair of
  // accessors so nothing downstream has to care which is which.
  function val(el) {
    return el ? ("value" in el && el.tagName !== "DIV" ? el.value : el.textContent) : "";
  }
  function setVal(el, s) {
    if ("value" in el && el.tagName !== "DIV") el.value = s;
    else el.textContent = s;
  }

  // Put the caret back at the end after we rewrite the text. Without this,
  // every keystroke sends it to the start and the field feels broken rather
  // than strict.
  function caretToEnd(el) {
    try {
      var r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { /* selection API unavailable — the value is still correct */ }
  }

  var money = function (n) {
    return CURRENCY + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  };

  // ── order summary: real arithmetic ─────────────────────────────────────────
  // The numbers are correct and update live. Nothing about the maths is the
  // joke; a checkout that could not add up would look broken, and broken is a
  // different feeling from deadpan.
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

  // ── layer 1: clamp on the way in ───────────────────────────────────────────
  var cardEl = $("su-card");
  var expEl = $("su-exp");
  var cvcEl = $("su-cvc");

  function formatPan(raw) {
    var d = digits(raw).slice(0, MAX_PAN_DIGITS);
    return d.replace(new RegExp("(.{" + GROUP + "})", "g"), "$1 ").trim();
  }
  function formatExp(raw) {
    var d = digits(raw).slice(0, MAX_EXP_DIGITS);
    return d.length > 2 ? d.slice(0, 2) + " / " + d.slice(2) : d;
  }
  function formatCvc(raw) {
    return digits(raw).slice(0, MAX_CVC_DIGITS);
  }

  // Bind a contenteditable field to a formatter. Rewrites content in place on
  // every input, then restores the caret.
  function bindEditable(el, format) {
    if (!el) return;

    el.addEventListener("input", function () {
      var out = format(val(el));
      if (val(el) !== out) {
        setVal(el, out);
        caretToEnd(el);
      }
      clearError();
    });

    // Paste arrives as HTML by default in a contenteditable. Take the text,
    // sanitise it, and never let markup into the element.
    el.addEventListener("paste", function (e) {
      e.preventDefault();
      var text = "";
      try {
        text = (e.clipboardData || window.clipboardData).getData("text") || "";
      } catch (err) { /* denied — treated as an empty paste */ }
      setVal(el, format(val(el) + text));
      caretToEnd(el);
      clearError();
    });

    // A contenteditable turns Enter into a new paragraph. These are one-line
    // fields; there is nothing to make a second line for.
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter") e.preventDefault();
    });

    // Drag-and-drop is another way for arbitrary markup to arrive.
    el.addEventListener("drop", function (e) { e.preventDefault(); });
  }

  bindEditable(cardEl, formatPan);
  bindEditable(expEl, formatExp);
  bindEditable(cvcEl, formatCvc);

  // Clicking the field's container focuses it, which is what a <label> would
  // have done for a real input.
  Array.prototype.slice.call(root.querySelectorAll("[data-focus]")).forEach(function (wrap) {
    wrap.addEventListener("mousedown", function (e) {
      var target = $(wrap.getAttribute("data-focus"));
      if (!target || e.target === target || target.contains(e.target)) return;
      e.preventDefault();
      target.focus();
      caretToEnd(target);
    });
  });

  ["su-email", "su-company", "su-zip"].forEach(function (id) {
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
  // wording is only polish on it. This exists because the first build shipped
  // a copy island Hugo double-encoded, so lookups were undefined and the
  // handler threw before rendering: the page looked immaculate and the button
  // did nothing. A refusal site whose refusal is the broken part is the one
  // failure that is not funny.
  var LAST_RESORT = { title: "Declined.", body: "Not by your bank." };

  function showError(kind) {
    var copy = ERRORS[kind] || ERRORS.declined || LAST_RESORT;
    if (!copy || typeof copy.title !== "string") copy = LAST_RESORT;
    errTitle.textContent = copy.title;
    errBody.textContent = copy.body || "";
    errEl.hidden = false;
    root.classList.remove("su-shake");
    void root.offsetWidth;
    root.classList.add("su-shake");
  }

  // Copy lives in data/signup.yaml with every other word on this site.
  var ERRORS = (function () {
    var el = document.getElementById("su-errors");
    if (!el) return {};
    try {
      var v = JSON.parse(el.textContent);
      // A JS-context escaper can hand back a JSON string CONTAINING the JSON
      // rather than the object. Unwrap one layer rather than trusting the
      // template to have been marked safe — the failure is silent.
      if (typeof v === "string") v = JSON.parse(v);
      return v && typeof v === "object" ? v : {};
    } catch (e) {
      return {};
    }
  })();

  // ── layer 2: the attempt ───────────────────────────────────────────────────
  var btn = $("su-submit");

  function attempt() {
    // Counted fresh from the live value against our own constant. Setting
    // `.textContent` from a console fires no input event and so never met
    // layer 1 — this is the check that sees it.
    var pan = digits(val(cardEl));

    if (pan.length > MAX_PAN_DIGITS) return "tampered";
    if (!$("su-terms").checked) return "terms";

    var required = [$("su-email").value, val(cardEl), val(expEl), val(cvcEl)];
    for (var i = 0; i < required.length; i++) {
      if (!String(required[i]).trim()) return "incomplete";
    }

    // Everything the page asked for, provided correctly. Still no.
    //
    // This is the only branch representing a "valid" submission and it returns
    // an error like all the others. There is deliberately no success return
    // anywhere above — no input reaches one, because none exists.
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
