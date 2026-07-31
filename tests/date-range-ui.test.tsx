// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { queryString } from "../src/client/api.js";
import { DateRangeBar } from "../src/client/components.js";
import { rangeForPreset, useDateRange } from "../src/client/date-range.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

function visit(search: string) {
  window.history.replaceState(null, "", `/transactions${search}`);
}

/** Surfaces exactly what a list view would send to the API. */
function RangeProbe() {
  const { start, end, preset } = useDateRange();
  return (
    <dl>
      <dt>preset</dt>
      <dd data-testid="preset">{preset}</dd>
      <dt>query</dt>
      <dd data-testid="query">{queryString({ start, end })}</dd>
    </dl>
  );
}

function renderRange() {
  return render(
    <BrowserRouter>
      <TimezoneProvider timezone="UTC">
        <DateRangeBar />
        <RangeProbe />
      </TimezoneProvider>
    </BrowserRouter>,
  );
}

const startInput = () => screen.getByLabelText("Start date");
const endInput = () => screen.getByLabelText("End date");

afterEach(() => {
  cleanup();
  visit("");
});

describe("visible date range", () => {
  it("treats all time as an unbounded range", () => {
    expect(rangeForPreset("all-time", new Date("2026-07-31T12:00:00.000Z"))).toEqual({
      start: "",
      end: "",
    });
  });

  it("keeps a reloaded all-time view unbounded", () => {
    visit("?preset=all-time");
    renderRange();

    expect(screen.getByTestId("preset")).toHaveTextContent("all-time");
    // No start/end means the request carries no date filter at all.
    expect(screen.getByTestId("query")).toBeEmptyDOMElement();
    expect(startInput()).toHaveValue("");
    expect(endInput()).toHaveValue("");
  });

  it("clears both bounds when all time is chosen", () => {
    renderRange();
    expect(screen.getByTestId("query")).not.toBeEmptyDOMElement();

    fireEvent.change(screen.getByLabelText("Date preset"), {
      target: { value: "all-time" },
    });

    expect(screen.getByTestId("query")).toBeEmptyDOMElement();
    expect(startInput()).toHaveValue("");
    expect(endInput()).toHaveValue("");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("preset")).toBe("all-time");
    expect(params.has("start")).toBe(false);
    expect(params.has("end")).toBe(false);
  });

  it("bounds the default view to the current month", () => {
    renderRange();

    const expected = rangeForPreset("this-month", new Date(), "UTC");
    expect(screen.getByTestId("preset")).toHaveTextContent("this-month");
    expect(startInput()).toHaveValue(expected.start);
    expect(endInput()).toHaveValue(expected.end);
  });

  it("honors a preset supplied without explicit bounds", () => {
    visit("?preset=year-to-date");
    renderRange();

    const expected = rangeForPreset("year-to-date", new Date(), "UTC");
    expect(startInput()).toHaveValue(expected.start);
    expect(endInput()).toHaveValue(expected.end);
  });

  it("falls back to the current month for an unrecognized preset", () => {
    visit("?preset=not-a-preset");
    renderRange();

    const expected = rangeForPreset("this-month", new Date(), "UTC");
    expect(screen.getByTestId("preset")).toHaveTextContent("this-month");
    expect(startInput()).toHaveValue(expected.start);
    expect(endInput()).toHaveValue(expected.end);
  });
});
