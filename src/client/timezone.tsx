import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import { calendarDayIn } from "../shared/recurrence-dates.js";

const TimezoneContext = createContext<string | null>(null);

function browserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function TimezoneProvider({
  timezone,
  children,
}: {
  timezone: string;
  children: ReactNode;
}) {
  return <TimezoneContext.Provider value={timezone}>{children}</TimezoneContext.Provider>;
}

export function useTimezone() {
  return useContext(TimezoneContext) ?? browserTimezone();
}

// A re-export, not a re-implementation. Which calendar day an instant falls on
// in a timezone is answered in one place — AGENTS.md's rule, held by the shared
// helper — and this module carried a second copy of the algorithm for a while,
// which is exactly the drift the rule exists to prevent.
export { calendarDayIn as calendarDateInTimezone } from "../shared/recurrence-dates.js";

/**
 * Today where somebody lives, read from outside render. The clock is a store
 * the component subscribes to rather than something it calls while rendering:
 * `react(purity)` refuses `new Date()` in a render body, because a render React
 * repeats or skips would read a different instant. It is read again on every
 * render, as it was when the body called it, and also when the window comes back
 * into view, which is when a tab left open overnight would otherwise go on
 * calling yesterday today. No timer: a page nobody is looking at needs no date.
 */
export function useToday(timezone: string) {
  return useSyncExternalStore(subscribeToReturn, () => calendarDayIn(new Date(), timezone));
}

function subscribeToReturn(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
  };
}
