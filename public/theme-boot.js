/*
 * Paints the right theme before the page paints at all.
 *
 * Why a file and not an inline script: the Content-Security-Policy is
 * `script-src 'self'` with no nonce and no hash, in both deployments — the Hono
 * middleware for the monolith, the nginx include for the split one. An inline
 * script is parsed, refused, and reported nowhere: nothing declares report-uri,
 * so the only symptom is the flash this exists to remove. It would also have
 * looked fine locally, because `vite` serves the shell with no policy at all and
 * `npm run dev` never serves the shell. So: a separate same-origin file, and a
 * classic script rather than a module, because a module is deferred by
 * definition and would run after the document is parsed. Loading it costs
 * nothing measurable — the stylesheet in the same <head> is already blocking
 * paint, and the two requests overlap.
 *
 * Why it usually does nothing: `system` is handled entirely in CSS, by a
 * prefers-color-scheme query. That is the state almost everybody is in, it is
 * right on the first paint with no JavaScript, and it keeps following the
 * machine when the machine changes at sunset. This file exists for the minority
 * who have overridden their machine, which CSS cannot know about.
 */
(function () {
  var STORAGE_KEY = "sb.theme";

  function stored() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var value = JSON.parse(raw);
      var theme = value && value.theme;
      // Anything else is treated as absent rather than trusted: this runs before
      // the app, so a half-written or hand-edited entry must not decide what the
      // page looks like.
      return theme === "light" || theme === "dark" || theme === "system"
        ? theme
        : null;
    } catch (error) {
      // Private browsing throws on access rather than returning null, and a
      // quota-exceeded page can throw here too. Following the machine is the
      // right answer when we cannot tell.
      return null;
    }
  }

  var theme = stored();
  var root = document.documentElement;

  // Only an override is stamped. Leaving the attribute off is what hands the
  // decision to the media query, so `system` needs no attribute and no JS.
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");

  // The browser chrome. Two metas carry the two grounds, scoped by media, which
  // covers everybody on `system` with no script at all. An override is the case
  // media cannot express, because it keys off the machine and not off this app:
  // there the winning meta has to be unscoped or the phone frames a dark page in
  // the light colour.
  if (theme === "light" || theme === "dark") {
    try {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) {
        var meta = metas[i];
        var wants = meta.getAttribute("data-theme-for");
        if (wants === theme) meta.removeAttribute("media");
        else meta.setAttribute("media", "not all");
      }
    } catch (error) {
      // A wrong chrome colour is not worth a broken boot.
    }
  }
})();
