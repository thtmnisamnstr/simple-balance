// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Pagination } from "../src/client/components.js";

/**
 * Where focus is after a page turn, which `web.md` 13.3 is about and which
 * three more controls got wrong after it was written down.
 *
 * 13.3 is stated as a count of pages — "the three pages that unmount their own
 * button and on the plan tab" — rather than as a property of the shape, so it
 * was applied to the instances somebody had counted and not to the pattern.
 * The shape is: **a control whose success removes or disables the control.**
 * `Pagination` is one, and it is the only one no per-page edit can reach:
 * `disabled={busy}` sits on every page number and on both steps, a disabled
 * element cannot hold focus, and the browser blurs it as the request starts.
 * The route-change move in 13.3 is keyed on the pathname alone — deliberately,
 * so a filter change does not steal focus — and paging changes no path, so
 * nothing caught it.
 *
 * **jsdom implements neither half of the browser's behavior here** — neither
 * the focus a real click gives a button nor the blur that disabling it forces
 * — which is why this was invisible to a suite that already mounts both of
 * these lists. `fireEvent.click` leaves `document.activeElement` on `<body>`,
 * which is by luck the exact state a real browser reaches by the other route,
 * so each case asserts that state before the turn lands and the restoration
 * after it. What jsdom answers exactly is `document.activeElement`, which is
 * the whole of the rule.
 */
afterEach(cleanup);

/** The two pages that page on the server pass `busy`; this stands for both. */
function PagedList({ totalPages = 4 }: { totalPages?: number }) {
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Pagination
        page={page}
        pageSize={10}
        totalCount={totalPages * 10}
        totalPages={totalPages}
        busy={busy}
        itemLabel="transactions"
        onPageChange={(next) => {
          // What a fetch does: the controls go disabled, then the data lands.
          setBusy(true);
          setPage(next);
        }}
      />
      <button type="button" onClick={() => setBusy(false)}>
        land
      </button>
    </>
  );
}

/** The state a real browser is in once the pressed control has gone disabled. */
const focusIsNowhere = () =>
  expect(document.activeElement, "the defect: focus is on nothing").toBe(document.body);

const land = () => fireEvent.click(screen.getByRole("button", { name: "land" }));

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("turning a page", () => {
  it("gives focus back to Next rather than leaving it on the body", () => {
    render(<PagedList />);
    fireEvent.click(button("Next page"));
    focusIsNowhere();
    land();
    expect(document.activeElement).toBe(button("Next page"));
  });

  it("gives focus back to the page number that was pressed", () => {
    render(<PagedList />);
    fireEvent.click(button("Page 3"));
    focusIsNowhere();
    land();
    expect(document.activeElement).toBe(button("Page 3"));
    expect(button("Page 3").getAttribute("aria-current")).toBe("page");
  });

  it("lands on the current page when the step it came from is now disabled", () => {
    render(<PagedList totalPages={2} />);
    // Next on the last page cannot take focus back, because it is disabled —
    // so the fallback has to be somewhere, and the current page is where the
    // reader is.
    fireEvent.click(button("Next page"));
    focusIsNowhere();
    land();
    expect(button("Next page").disabled).toBe(true);
    expect(document.activeElement).toBe(button("Page 2"));
  });

  it("takes no focus at all until something has been pressed", () => {
    render(<PagedList />);
    expect(document.activeElement).toBe(document.body);
    land();
    expect(document.activeElement).toBe(document.body);
  });
});
