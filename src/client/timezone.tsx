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

export function calendarDateInTimezone(date: Date, timezone: string) {
  // Falls back to UTC rather than throwing, the way the shared todayIn does. A
  // stored timezone is free text checked only when it was written, and one an
  // ICU update no longer recognises would otherwise throw inside a render and
  // blank the page rather than showing a date a day out.
  let formatter: Intl.DateTimeFormat;
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  } as const;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...options });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options });
  }
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
