// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowMenu } from "../src/client/components.js";

/**
 * This environment does not implement the browser's own disclosure toggling, so
 * the menu is opened by setting the property the browser would set. Everything
 * after that - the position it takes, when it closes, where focus goes - is the
 * component's own work and is what these cover.
 */
function open() {
  const details = screen
    .getByRole("button", { name: "Actions for Market" })
    .closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return details;
}

function renderMenu(onChoose = () => {}) {
  render(
    <div>
      <button>Outside</button>
      <RowMenu label="Actions for Market">
        <button onClick={onChoose}>Save as template</button>
      </RowMenu>
    </div>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the overflow menu on a row", () => {
  it("names itself for the row it belongs to", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Actions for Market" });
    expect(trigger.tagName).toBe("SUMMARY");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    open();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  /**
   * The popover is positioned fixed rather than absolute because the table it
   * sits in scrolls horizontally, and an absolute popover inside that scroll
   * container is clipped by it. The offsets come from the trigger.
   */
  it("places itself from the trigger rather than inside the scrolling table", () => {
    renderMenu();
    const details = open();
    const popover = details.querySelector(".row-menu-popover") as HTMLElement;
    expect(popover).toBeTruthy();
    expect(popover.style.top).not.toBe("");
    expect(popover.style.right).not.toBe("");
  });

  /**
   * The same trade's other edge. A fixed popover closes when the page scrolls,
   * so one anchored under a trigger near the bottom of the window put its last
   * items past the edge with no way to reach them: Restore on an archived
   * account card at the foot of the list could not be pressed.
   */
  describe("near the bottom of the window", () => {
    function placeTrigger(top: number) {
      const trigger = screen.getByRole("button", { name: "Actions for Market" });
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        top,
        bottom: top + 30,
        left: 900,
        right: 930,
        width: 30,
        height: 30,
        x: 900,
        y: top,
        toJSON: () => ({}),
      });
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(860);
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(1280);
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    }

    it("opens upward when the items would run past the edge", () => {
      renderMenu();
      placeTrigger(790);
      const popover = open().querySelector(".row-menu-popover") as HTMLElement;
      expect(popover.style.top).toBe("");
      expect(popover.style.bottom).toBe(`${860 - 790 + 5}px`);
      expect(popover.style.right).toBe(`${1280 - 930}px`);
    });

    it("opens downward while there is room", () => {
      renderMenu();
      placeTrigger(300);
      const popover = open().querySelector(".row-menu-popover") as HTMLElement;
      expect(popover.style.top).toBe(`${300 + 30 + 5}px`);
      expect(popover.style.bottom).toBe("");
    });
  });

  it("closes when something is chosen", () => {
    const chosen = vi.fn();
    renderMenu(chosen);
    const details = open();
    fireEvent.click(screen.getByRole("button", { name: "Save as template" }));
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(details.open).toBe(false);
  });

  it("closes on Escape and gives focus back to the trigger", () => {
    renderMenu();
    const details = open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions for Market" }));
  });

  it("closes when something outside is pressed", () => {
    renderMenu();
    const details = open();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(details.open).toBe(false);
  });

  it("stays open when something inside it is pressed", () => {
    renderMenu();
    const details = open();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Save as template" }));
    expect(details.open).toBe(true);
  });

  // A fixed popover does not travel with the page, so rather than let it drift
  // away from its row it goes away.
  it("closes rather than drifting when the page moves under it", () => {
    renderMenu();
    const details = open();
    fireEvent.scroll(window);
    expect(details.open).toBe(false);
  });
});

/**
 * A short window, which is what zooming makes. A frozen account card's menu,
 * with its reasons, is taller than the room on either side of its trigger, and
 * below 780px the room above ends at the sticky header, which is drawn over the
 * popover. Flipping alone put the first items off the top of the window or under
 * the header, where a scroll could not reach them because a scroll closed the
 * menu.
 */
describe("the overflow menu on a short window", () => {
  function place({ top, window: height, menu }: { top: number; window: number; menu: number }) {
    const trigger = screen.getByRole("button", { name: "Actions for Market" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top,
      bottom: top + 30,
      left: 900,
      right: 930,
      width: 30,
      height: 30,
      x: 900,
      y: top,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(height);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1280);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(menu);
  }

  afterEach(() => {
    document.querySelector(".mobile-header")?.remove();
  });

  it("opens toward the larger room and scrolls inside it when neither side fits", () => {
    renderMenu();
    place({ top: 140, window: 300, menu: 400 });
    const popover = open().querySelector(".row-menu-popover") as HTMLElement;
    expect(popover.style.bottom).toBe(`${300 - 140 + 5}px`);
    expect(popover.style.maxHeight).toBe(`${140 - 10}px`);
    expect(popover.style.overflowY).toBe("auto");
  });

  it("measures the room above from the sticky header, not the top of the window", () => {
    const header = document.createElement("header");
    header.className = "mobile-header";
    document.body.append(header);
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 57,
      left: 0,
      right: 1280,
      width: 1280,
      height: 57,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    renderMenu();
    place({ top: 150, window: 260, menu: 100 });
    const popover = open().querySelector(".row-menu-popover") as HTMLElement;
    expect(popover.style.maxHeight).toBe(`${150 - 57 - 10}px`);
  });

  it("stays open while its own contents scroll, and closes when the page does", () => {
    renderMenu();
    place({ top: 140, window: 300, menu: 400 });
    const details = open();
    fireEvent.scroll(details.querySelector(".row-menu-popover")!);
    expect(details.open).toBe(true);
    fireEvent.scroll(window);
    expect(details.open).toBe(false);
  });
});
