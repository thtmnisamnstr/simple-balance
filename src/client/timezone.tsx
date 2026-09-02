import { createContext, type ReactNode, useContext } from "react";

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
