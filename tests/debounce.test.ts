// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebounced } from "../src/client/debounce.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The search box's value is part of a react-query key, so an undebounced one
 * sent a request per keystroke, and the server side of each is three unindexed
 * `ilike '%…%'` comparisons plus a count over the same predicate.
 */
describe("waiting for typing to stop", () => {
  it("reports the first value straight away", () => {
    const { result } = renderHook(() => useDebounced("", 300));
    expect(result.current).toBe("");
  });

  it("holds every keystroke until the typing stops", () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 300), {
      initialProps: { value: "" },
    });
    for (const value of ["s", "st", "sta", "star", "starb"]) {
      rerender({ value });
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(result.current).toBe("");
    }
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe("starb");
  });

  it("settles again after a pause and another keystroke", () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 300), {
      initialProps: { value: "a" },
    });
    rerender({ value: "ab" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe("ab");
    rerender({ value: "abc" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe("abc");
  });

  it("never settles on a value that was typed over", () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ value }) => {
        seen.push(useDebounced(value, 300));
        return null;
      },
      { initialProps: { value: "" } },
    );
    rerender({ value: "x" });
    rerender({ value: "xy" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(seen).not.toContain("x");
    expect(seen.at(-1)).toBe("xy");
  });
});
