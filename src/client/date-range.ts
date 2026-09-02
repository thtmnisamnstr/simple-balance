import { useSearchParams } from "./router.js";
import { calendarDateInTimezone, useTimezone } from "./timezone.js";

const dateOnlyUtc = (date: Date) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const addDays = (date: Date, days: number) => {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
};

const datePresets = [
  "this-month",
  "last-month",
  "year-to-date",
  "last-30",
  "last-90",
  "all-time",
  "custom",
] as const;

export type DatePreset = (typeof datePresets)[number];

/** Ignore an unrecognized `preset` param instead of trusting the URL. */
function presetFromParam(value: string | null): DatePreset {
  return datePresets.includes(value as DatePreset) ? (value as DatePreset) : "this-month";
}

export function rangeForPreset(
  preset: DatePreset,
  now = new Date(),
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
) {
  const today = calendarDateInTimezone(now, timezone);
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const calendarNow = new Date(Date.UTC(year, month - 1, day));
  switch (preset) {
    case "this-month":
      return {
        start: `${year}-${String(month).padStart(2, "0")}-01`,
        end: today,
      };
    case "last-month":
      return {
        start: dateOnlyUtc(new Date(Date.UTC(year, month - 2, 1))),
        end: dateOnlyUtc(new Date(Date.UTC(year, month - 1, 0))),
      };
    case "year-to-date":
      return { start: `${year}-01-01`, end: today };
    case "last-30":
      return { start: dateOnlyUtc(addDays(calendarNow, -29)), end: today };
    case "last-90":
      return { start: dateOnlyUtc(addDays(calendarNow, -89)), end: today };
    case "all-time":
      return { start: "", end: "" };
    default:
      return { start: "", end: today };
  }
}

export function useDateRange() {
  const timezone = useTimezone();
  const [params, setParams] = useSearchParams();
  const preset = presetFromParam(params.get("preset"));
  // The active preset owns the fallback range. Deriving it from "this-month"
  // instead silently bounded "all-time" to the current month, because an
  // unbounded range stores no start/end params at all.
  const defaults = rangeForPreset(preset, new Date(), timezone);
  const start = params.get("start") ?? defaults.start;
  const end = params.get("end") ?? defaults.end;
  const setRange = (next: { start: string; end: string; preset?: DatePreset }) => {
    const updated = new URLSearchParams(params);
    if (next.start) updated.set("start", next.start);
    else updated.delete("start");
    if (next.end) updated.set("end", next.end);
    else updated.delete("end");
    updated.set("preset", next.preset ?? "custom");
    setParams(updated, { replace: true });
  };
  const setPreset = (next: DatePreset) =>
    setRange({ ...rangeForPreset(next, new Date(), timezone), preset: next });
  return { start, end, preset, setRange, setPreset };
}
