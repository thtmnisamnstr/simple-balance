import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, json, type Session, type Theme } from "./api.js";

/**
 * Which palette is on screen, and the one place that decides it.
 *
 * Three states, where `system` is a standing instruction rather than a value: it
 * follows the machine, including when the machine changes at sunset. That is why
 * nothing here detects a theme and stores the answer — a stored answer cannot be
 * told apart from a decision, so the app could either follow the machine or
 * remember a choice, never both.
 *
 * The account holds the setting, so it travels to another browser. What is kept
 * locally is a cache of it, and only because the account's copy arrives with the
 * session, which is one round trip too late to paint with. See
 * `public/theme-boot.js`, which reads that cache before this bundle exists.
 */

const STORAGE_KEY = "sb.theme";

/** Whether the resolved theme is the dark one. Everything else keys off this. */
export type Resolved = "light" | "dark";

/**
 * What the machine is set to.
 *
 * jsdom has no `matchMedia` at all, so this is not a defensive flourish: without
 * the guard every test that renders the shell throws. A machine that cannot say
 * counts as light, which is what this app looked like before it had a choice.
 */
export function systemTheme(): Resolved {
  try {
    if (typeof window.matchMedia !== "function") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function resolveTheme(preference: Theme): Resolved {
  return preference === "system" ? systemTheme() : preference;
}

/**
 * The cached copy, which exists for one reader: the boot script, which runs
 * before this bundle and cannot ask the server what the account is set to.
 *
 * It records what this BROWSER last painted, not whose it is. Nothing here can
 * know who is about to be signed in — the session cookie is HttpOnly — so on a
 * browser two people share, the second one sees the first one's theme until the
 * session answers a moment later and this overwrites it. A background colour is
 * not somebody's data, so that is a fair trade for never flashing; and sign-out
 * clears it, so the sign-in screen does not keep it either.
 *
 * There is deliberately no reader here. Nothing needs to know the cached value:
 * the account's setting is what gets applied on mount, and this is written from
 * it rather than consulted.
 */
export function writeCachedTheme(theme: Theme) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme }));
  } catch {
    // A browser that will not store it still renders correctly; it just flashes
    // once on the next load. Not worth failing a save somebody asked for.
  }
}

export function clearCachedTheme() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do and nothing worth saying.
  }
}

/**
 * Paint it. Mirrors `public/theme-boot.js`, which has to do the same thing
 * without being able to import this — it is a classic script that runs before
 * the bundle. `tests/theme-boot.test.ts` holds the two to the same answers.
 *
 * `system` deliberately writes no attribute. Leaving it off is what hands the
 * decision to the stylesheet's `prefers-color-scheme` query, which is right on
 * the first paint with no JavaScript and keeps following the machine while the
 * tab is open. Stamping a resolved value here instead would freeze it.
 */
export function applyTheme(preference: Theme) {
  const root = document.documentElement;
  if (preference === "light" || preference === "dark") {
    root.setAttribute("data-theme", preference);
  } else {
    root.removeAttribute("data-theme");
  }
  applyChrome(preference);
}

/**
 * The phone's browser chrome. Two metas carry the two grounds scoped by media,
 * which covers `system` with no script. An override is the case media cannot
 * express — it keys off the machine, not off this app — so there the winning
 * meta is unscoped and the other is disabled outright.
 */
function applyChrome(preference: Theme) {
  try {
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    for (const meta of metas) {
      const wants = meta.getAttribute("data-theme-for");
      if (preference === "system") {
        meta.setAttribute(
          "media",
          `(prefers-color-scheme: ${wants === "dark" ? "dark" : "light"})`,
        );
      } else if (wants === preference) {
        meta.removeAttribute("media");
      } else {
        meta.setAttribute("media", "not all");
      }
    }
  } catch {
    // A wrong chrome colour is not worth breaking a page over.
  }
}

/**
 * Calls back when the machine's setting changes, which only matters while the
 * preference is `system`: the stylesheet re-paints itself, but the toggle's
 * label names the theme it would switch to and would otherwise go stale, saying
 * "Switch to dark mode" on an already-dark screen.
 */
export function watchSystemTheme(onChange: (resolved: Resolved) => void) {
  try {
    if (typeof window.matchMedia !== "function") return () => {};
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => onChange(query.matches ? "dark" : "light");
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  } catch {
    return () => {};
  }
}

/**
 * The hook both controls use, so the toggle in the sidebar and the radios in
 * Settings cannot disagree about one value.
 *
 * It lives here rather than in App.tsx because Settings would then be importing
 * from the module that imports it. Which is the same reason as always: the
 * question is answered in one place, and this is the place.
 *
 * Saving is optimistic on purpose. A theme is the one preference whose result is
 * visible while you choose it, so waiting for a round trip before repainting
 * would read as a broken control; and if the write fails, the paint goes back to
 * what the account still says, so the screen never disagrees with the record.
 */
export function useThemeSetting(session: Session) {
  const queryClient = useQueryClient();
  const preference = session.preferences.theme;
  const [resolved, setResolved] = useState<Resolved>(() => resolveTheme(preference));

  useEffect(() => {
    applyTheme(preference);
    // The cache the boot script reads on the next load.
    writeCachedTheme(preference);
    // `resolved` is half the machine's answer and half the account's, and the
    // machine's half arrives through the subscription below, so it has to be
    // state; this is the write that folds the account's half in, for the times
    // the account changed somewhere other than the control on this screen.
    // Working it out during render would not do: `resolveTheme` asks
    // `matchMedia`, and nothing re-renders when the machine changes at sunset.
    // oxlint-disable-next-line react/set-state-in-effect
    setResolved(resolveTheme(preference));
    // Only the preference: the cache no longer records whose it is, so a change
    // of signed-in person shows up here as a change of preference or not at all.
  }, [preference]);

  useEffect(() => {
    // Only while following the machine. The stylesheet re-paints itself either
    // way; this is so the toggle's label does not end up saying "Switch to dark
    // mode" on an already-dark screen.
    if (preference !== "system") return;
    return watchSystemTheme((next) => setResolved(next));
  }, [preference]);

  const save = useMutation({
    mutationFn: (theme: Theme) => api("/api/v1/preferences", { ...json({ theme }), method: "PUT" }),
    onMutate: (theme: Theme) => {
      applyTheme(theme);
      writeCachedTheme(theme);
      setResolved(resolveTheme(theme));
    },
    onError: () => {
      // Back to what the account says, rather than leaving the screen showing a
      // setting that was not saved.
      applyTheme(preference);
      writeCachedTheme(preference);
      setResolved(resolveTheme(preference));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });

  return {
    /** What the account says, which may be `system`. */
    preference,
    /** What is actually on screen, which is never `system`. */
    resolved,
    setTheme: save.mutate,
    error: save.error,
  };
}
