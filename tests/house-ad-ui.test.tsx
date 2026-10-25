// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/client/App.js";
import { HouseAd } from "../src/client/ads.js";
import type { BillingStatus } from "../src/client/api.js";
import { BrowserRouter } from "../src/client/router.js";
import { MAX_FREE_ACCOUNTS, PLAN_LABELS } from "../src/shared/domain.js";

/**
 * This product's own advertisement for its paid plan.
 *
 * It shares `AdSlot`'s contract — the server decides, and the browser renders
 * exactly what it was told and nothing when it was told nothing — and differs
 * from it in the one way that matters for what it costs the person looking at
 * it: it loads nothing. No script, no frame, no request. That is why turning it
 * on widens none of what AdSense widens, and the first two suites hold it there.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Every script this render caused to be added to the document. */
function watchScripts() {
  const appended: string[] = [];
  const original = document.head.append.bind(document.head);
  vi.spyOn(document.head, "append").mockImplementation((...nodes: unknown[]) => {
    for (const node of nodes) {
      if (node instanceof HTMLScriptElement) appended.push(node.src);
    }
    return original(...(nodes as Node[]));
  });
  return appended;
}

describe("the house ad", () => {
  it("renders nothing for false, null, or a server that never sent the field", () => {
    const appended = watchScripts();
    for (const shown of [false, null, undefined]) {
      const { container, unmount } = render(<HouseAd shown={shown} label="Advertisement" />);
      expect(container.innerHTML, String(shown)).toBe("");
      unmount();
    }
    expect(appended).toEqual([]);
  });

  it("is the same labeled landmark as an AdSense unit", () => {
    render(<HouseAd shown label="Advertisement" />);
    const region = screen.getByRole("complementary", { name: "Advertisement" });
    expect(region.tagName).toBe("ASIDE");
    // `.ad-slot` is what the print block hides, so this is also the rule that
    // keeps it off paper.
    expect(region).toHaveClass("ad-slot");
  });

  /**
   * A document load into the plan tab, not a client-side push: the tab is
   * served under its own content security policy, and a push would keep this
   * page's and leave the payment form unable to load. A plain anchor with the
   * path written out is the shape that guarantees the load, and `Link` is the
   * shape that would quietly undo it.
   */
  it("leads to the plan tab by loading it", () => {
    render(<HouseAd shown label="Advertisement" />);
    const cta = screen.getByRole("link", { name: `Upgrade to ${PLAN_LABELS.plus}` });
    expect(cta.tagName).toBe("A");
    expect(cta.getAttribute("href")).toBe("/settings/plan");
    expect(cta).not.toHaveAttribute("target");
  });

  /**
   * One sentence and the button, and the plan named from its label in both
   * places. The free plan's limit is not said in words: the drawing beside the
   * sentence shows it, and a second sentence saying it again cost the bar a
   * line it does not have at most widths.
   */
  it("says it in one sentence, naming the plan from its label", () => {
    const { container } = render(<HouseAd shown label="Advertisement" />);
    const paragraphs = [...container.querySelectorAll(".house-ad-words p")].map(
      (paragraph) => paragraph.textContent,
    );
    expect(paragraphs).toEqual([PLAN_LABELS.plus, "As many accounts as you need, and no ads"]);
    const region = screen.getByRole("complementary", { name: "Advertisement" });
    // No figure: a price here would be a second copy of one that lives at
    // Stripe, and a count would be a second copy of the limit.
    expect(region.textContent).not.toMatch(/\d/);
  });

  /**
   * The picture is what says the limit now, so it is held to it: the accounts
   * at rest are the free plan's, as many as that plan keeps in use, and two
   * more arrive. A change to the limit fails here rather than leaving a
   * drawing that says the old one.
   */
  it("draws the free plan's limit, and the accounts the paid plan adds", () => {
    const { container } = render(<HouseAd shown label="Advertisement" />);
    const accounts = [...container.querySelectorAll(".house-ad-account")];
    const arriving = accounts.filter((tile) => tile.closest(".house-ad-moves"));
    expect(accounts.length - arriving.length, "at rest from the first frame").toBe(
      MAX_FREE_ACCOUNTS,
    );
    expect(arriving, "arriving").toHaveLength(2);
    // The ad is struck out and the last arrival carries the logo.
    expect(container.querySelectorAll(".house-ad-banner .house-ad-strike")).toHaveLength(1);
    expect(container.querySelectorAll(".house-ad-strip .house-ad-badge")).toHaveLength(1);
  });

  /**
   * An ad on every page must not join every page's heading outline, so the
   * line styled as a heading is a paragraph. The landmark's label is how
   * somebody navigating by structure reaches it, and passes it.
   */
  it("adds no heading to the page", () => {
    render(<HouseAd shown label="Advertisement" />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("hides the drawing and nothing else from assistive technology", () => {
    const { container } = render(<HouseAd shown label="Advertisement" />);
    const hidden = [...container.querySelectorAll("[aria-hidden]")];
    expect(hidden.map((element) => element.className)).toEqual(["house-ad-art"]);
    expect(hidden[0]).toHaveAttribute("aria-hidden", "true");
    // Pictures and nothing a person could read or reach.
    expect(hidden[0]!.textContent).toBe("");
    expect(hidden[0]!.querySelectorAll("a, button, input, [tabindex]")).toHaveLength(0);
    for (const svg of hidden[0]!.querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("focusable", "false");
    }
  });

  it("loads nothing: no script, no frame, no image, no request", () => {
    const appended = watchScripts();
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const { container } = render(<HouseAd shown label="Advertisement" />);
    expect(appended).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    expect(container.querySelectorAll("script, iframe, img, link, object, embed")).toHaveLength(0);
    // No ids either, so it cannot collide with anything else on the page.
    expect(container.querySelectorAll("[id]")).toHaveLength(0);
  });
});

/**
 * Motion is opted into by the component, never assumed by the stylesheet.
 *
 * With no class on it the drawing is the finished picture, which is what a
 * browser without `IntersectionObserver` shows, what jsdom shows, and what
 * reduced motion shows. Armed, it holds the animation's first frame; playing,
 * it runs once.
 */
describe("when the house ad moves", () => {
  type Callback = (entries: Pick<IntersectionObserverEntry, "intersectionRatio">[]) => void;
  let observers: { callback: Callback; observed: Element[]; disconnected: boolean }[] = [];

  function stubMotion(reduce: boolean) {
    observers = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        record: (typeof observers)[number];
        constructor(callback: Callback) {
          this.record = { callback, observed: [], disconnected: false };
          observers.push(this.record);
        }
        observe(element: Element) {
          this.record.observed.push(element);
        }
        disconnect() {
          this.record.disconnected = true;
        }
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
        media: query,
      })),
    );
  }

  const box = (container: HTMLElement) => container.querySelector(".house-ad")!;

  it("stays still where the browser cannot say when it is seen", () => {
    expect(typeof IntersectionObserver, "jsdom has none").toBe("undefined");
    const { container } = render(<HouseAd shown label="Advertisement" />);
    expect(box(container).className).toBe("house-ad");
  });

  it("is armed before the first paint, and plays once enough of it is in view", () => {
    stubMotion(false);
    const { container } = render(<HouseAd shown label="Advertisement" />);
    // Armed by the layout effect, so the class is there by the time render
    // returns: the first frame anybody sees is the paused first frame.
    expect(box(container)).toHaveClass("is-armed");
    expect(box(container)).not.toHaveClass("is-playing");
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed).toEqual([box(container)]);

    // The top edge coming into view is not enough.
    act(() => observers[0]!.callback([{ intersectionRatio: 0.1 }]));
    expect(box(container)).not.toHaveClass("is-playing");

    act(() => observers[0]!.callback([{ intersectionRatio: 0.5 }]));
    expect(box(container)).toHaveClass("is-playing");
    // Once: nothing is left watching to start it again.
    expect(observers[0]!.disconnected).toBe(true);
  });

  /**
   * Once means once. Hiding an element discards its animations and showing it
   * again starts them over, so a story left armed replayed every time the
   * drawing came back across the phone width. It retires on the last beat,
   * the sway, whether that beat ended or was cut short, and only on that one.
   */
  it("retires when the last beat ends or is cut short, and on no other beat", () => {
    const beat = (type: string, name: string) =>
      Object.assign(new Event(type, { bubbles: true }), { animationName: name });
    for (const type of ["animationend", "animationcancel"]) {
      stubMotion(false);
      const { container, unmount } = render(<HouseAd shown label="Advertisement" />);
      act(() => observers[0]!.callback([{ intersectionRatio: 1 }]));
      // From inside the drawing: the box hears it because the event bubbles.
      container.querySelector(".house-ad-badge")!.dispatchEvent(beat(type, "house-ad-pop"));
      expect(box(container), `${type} of an earlier beat`).toHaveClass("is-armed", "is-playing");
      container.querySelector(".house-ad-sway")!.dispatchEvent(beat(type, "house-ad-sway"));
      expect(box(container).className, `${type} of the last`).toBe("house-ad");
      unmount();
    }
  });

  it("is never armed under reduced motion", () => {
    stubMotion(true);
    const { container } = render(<HouseAd shown label="Advertisement" />);
    expect(box(container).className).toBe("house-ad");
    expect(observers, "nothing is watched for a motion that will not run").toEqual([]);
  });

  it("stops watching when it goes, and starts over when it comes back", () => {
    stubMotion(false);
    const { container, rerender } = render(<HouseAd shown label="Advertisement" />);
    act(() => observers[0]!.callback([{ intersectionRatio: 1 }]));
    expect(box(container)).toHaveClass("is-playing");

    rerender(<HouseAd shown={false} label="Advertisement" />);
    expect(container.innerHTML).toBe("");

    rerender(<HouseAd shown label="Advertisement" />);
    expect(observers).toHaveLength(2);
    expect(box(container)).toHaveClass("is-armed");
    expect(box(container)).not.toHaveClass("is-playing");
  });
});

/**
 * SC 2.4.11, Focus Not Obscured. The bar is pinned over the foot of the window,
 * so a control tabbed to there would be scrolled exactly under it; the
 * document's `scroll-padding-bottom` is what keeps the browser from doing that,
 * and it is set from the bar's measured height, because the height changes with
 * the width and with a reader's text spacing. The browser tier checks the
 * scrolling itself; this checks the bookkeeping, which jsdom can.
 */
describe("keeping focus clear of the bar", () => {
  const padding = () => document.documentElement.style.getPropertyValue("scroll-padding-bottom");
  let resized: (() => void) | undefined;
  let observed: Element[] = [];
  let disconnected = false;

  function stubResize(height: () => number) {
    resized = undefined;
    observed = [];
    disconnected = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {
          disconnected = true;
        }
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ height: height() }) as DOMRect,
    );
  }

  afterEach(() => {
    document.documentElement.style.removeProperty("scroll-padding-bottom");
  });

  it("leaves the document alone where the browser cannot measure the bar", () => {
    expect(typeof ResizeObserver, "jsdom has none").toBe("undefined");
    render(<HouseAd shown label="Advertisement" />);
    expect(padding()).toBe("");
  });

  it("keeps the bar's measured height free, and follows it as it changes", () => {
    let height = 72.4;
    stubResize(() => height);
    const { container } = render(<HouseAd shown label="Advertisement" />);
    expect(observed).toEqual([container.querySelector(".house-ad")]);
    act(() => resized!());
    // Rounded up, and room for a focus ring on top.
    expect(padding()).toBe("89px");
    // Taller, as it is with its title on three lines or under widened text
    // spacing: a figure fixed in the stylesheet would be too small here.
    height = 158;
    act(() => resized!());
    expect(padding()).toBe("174px");
  });

  it("gives the space back when the ad goes", () => {
    stubResize(() => 60);
    const { rerender } = render(<HouseAd shown label="Advertisement" />);
    act(() => resized!());
    expect(padding()).toBe("76px");
    rerender(<HouseAd shown={false} label="Advertisement" />);
    expect(disconnected).toBe(true);
    expect(padding(), "a page without the bar keeps nothing of it").toBe("");
  });
});

/**
 * Where the shell puts it, rendered rather than read: the real `App` against a
 * session that says to show it.
 */
describe("the house ad in the app shell", () => {
  const session = (houseAd: boolean | undefined) => ({
    user: { id: "u", name: "Gavin", email: "gavin@example.com" },
    preferences: {
      userId: "u",
      timezone: "UTC",
      defaultCurrency: "USD",
      chosen: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    auth: {
      localEnabled: true,
      localPasswordConfigured: true,
      googleEnabled: false,
      googleLinked: false,
    },
    ads: null,
    ...(houseAd === undefined ? {} : { houseAd }),
  });

  /**
   * The plan tab's own request, answered as a selling deployment would, so the
   * tab renders the page it would render for the person the ad is shown to.
   */
  const billing: BillingStatus = {
    selling: true,
    advertises: true,
    publishableKey: "pk_test_house_ad",
    prices: {
      monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
      yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
    },
    entitlement: { billing: true, plan: "free", accountLimit: MAX_FREE_ACCOUNTS, source: "free" },
    accountsUsed: 1,
    accountsFrozen: 0,
    accountsLive: 1,
    activeChoicePending: false,
    subscription: null,
    override: null,
  };

  function stubApi(houseAd: boolean | undefined) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/session") return Response.json(session(houseAd));
        if (url.pathname === "/api/v1/billing") return Response.json(billing);
        return Response.json([]);
      }),
    );
  }

  const renderAt = (path: string) => {
    window.history.replaceState({}, "", path);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>,
    );
  };

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("puts it below the page, outside the main landmark", async () => {
    stubApi(true);
    const appended = watchScripts();
    renderAt("/accounts");
    const ad = await screen.findByRole("complementary", { name: "Advertisement" });
    const main = document.getElementById("main")!;
    expect(main.contains(ad)).toBe(false);
    expect(main.compareDocumentPosition(ad) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ad.closest(".main-column"), "inside the column, so the drawer makes it inert").not.toBe(
      null,
    );
    expect(appended, "and fetches nothing to show it").toEqual([]);
  });

  /**
   * Never on the plan tab, in any spelling the router treats as that tab. It
   * is the page the ad leads to, and three documents promise no ad there.
   */
  it("leaves the plan tab alone", async () => {
    for (const path of ["/settings/plan", "/settings/plan/", "/settings//plan"]) {
      stubApi(true);
      renderAt(path);
      await screen.findByRole("navigation", { name: "Main navigation" });
      expect(screen.queryByRole("complementary", { name: "Advertisement" }), path).toBeNull();
      cleanup();
    }
  });

  it("shows nothing for a session that says no, or a server that never sent the field", async () => {
    for (const houseAd of [false, undefined]) {
      stubApi(houseAd);
      renderAt("/accounts");
      await screen.findByRole("navigation", { name: "Main navigation" });
      await waitFor(() => expect(document.getElementById("main")).not.toBeNull());
      expect(screen.queryByRole("complementary", { name: "Advertisement" })).toBeNull();
      cleanup();
    }
  });
});
