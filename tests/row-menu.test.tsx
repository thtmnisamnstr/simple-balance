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
