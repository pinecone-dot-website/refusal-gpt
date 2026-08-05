/* RefusalGPT — 404.
 *
 * Replaces the request-log line with the URL that was actually asked for. The
 * server can't tell a static 404 page what the visitor typed, so the browser
 * does it. Everything here is decoration: the line ships with sensible text and
 * the page reads fine if this never runs.
 */
(function () {
  "use strict";

  var el = document.querySelector("[data-path]");
  if (!el) return;

  var path = location.pathname + location.search;
  // The log line is a fixed-width panel. A long path should lose its middle,
  // not push the panel wide or wrap into a paragraph.
  var MAX = 34;
  if (path.length > MAX) {
    path = path.slice(0, MAX - 12) + "…" + path.slice(-11);
  }

  // textContent, not innerHTML: this string came out of the address bar, and
  // the address bar is somewhere an attacker can put angle brackets.
  el.textContent = "GET " + path;
})();
