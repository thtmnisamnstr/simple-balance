// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdSlot } from "../src/client/ads.js";
import { isPlanSurfacePath } from "../src/client/router.js";

/**
 * The property the whole ad design rests on: given nothing, render nothing and
 * fetch nothing.
 *
 * The server decides who sees an ad by whether it sends an `AdPlacement` at
 * all, so every "this person should see no ad" case arrives here as an absent
 * or null placement. If this component rendered a box, reserved space, or —
 * worst — fetched Google's script anyway, that decision would be undone: the
 * impression would be counted and the person tracked, whatever was on screen.
 */
const appended: string[] = [];

afterEach(() => {
  cleanup();
  appended.length = 0;
  vi.restoreAllMocks();
});

/** Every script this render caused to be added to the document. */
function watchScripts() {
  const original = document.head.append.bind(document.head);
  vi.spyOn(document.head, "append").mockImplementation((...nodes: unknown[]) => {
    for (const node of nodes) {
      if (node instanceof HTMLScriptElement) appended.push(node.src);
    }
    return original(...(nodes as Node[]));
  });
}

/**
 * A distinct publisher id per test.
 *
 * The loader keys its promise by client id and keeps it for the life of the
 * document — deliberately, so the script is fetched once however many slots
 * mount — which means a shared id would let one test's fetch satisfy the next
 * one's assertion. Distinct ids rather than a reset hatch, because the caching
 * is the behaviour the last case here is about.
 */
let ids = 0;
const placementFor = (consentManaged = false) => ({
  clientId: `ca-pub-${String(1_000_000_000_000_000 + (ids += 1))}`,
  bannerSlotId: "9876543210",
  consentManaged,
});

describe("an ad slot", () => {
  it("renders nothing and fetches nothing when there is no placement", () => {
    watchScripts();
    const { container } = render(
      <AdSlot placement={null} slotId={undefined} label="Advertisement" />,
    );
    expect(container.innerHTML).toBe("");
    expect(appended, "a subscriber must not even fetch the script").toEqual([]);
  });

  it("renders nothing when the placement is absent, which is an older server", () => {
    watchScripts();
    const { container } = render(
      <AdSlot placement={undefined} slotId={undefined} label="Advertisement" />,
    );
    expect(container.innerHTML).toBe("");
    expect(appended).toEqual([]);
  });

  /**
   * The footer is optional, so a slot can be handed a placement and no id. That
   * is "no ad here", not "an ad with no slot" — which would render an empty
   * `<ins>` that AdSense's next push would fill with somebody else's unit.
   */
  it("renders nothing when the operator configured no slot for this position", () => {
    watchScripts();
    const { container } = render(
      <AdSlot placement={placementFor()} slotId={undefined} label="Advertisement" />,
    );
    expect(container.innerHTML).toBe("");
    expect(appended).toEqual([]);
  });

  it("renders the unit with the operator's own ids when there is one", () => {
    watchScripts();
    const placement = placementFor();
    render(<AdSlot placement={placement} slotId={placement.bannerSlotId} label="Advertisement" />);
    const region = screen.getByLabelText("Advertisement");
    const unit = region.querySelector("ins");
    // The ids come from the response, never from a build-time define: one image
    // serves every operator, so a compiled-in id would credit one of them — or
    // nobody — on every deployment.
    expect(unit?.getAttribute("data-ad-client")).toBe(placement.clientId);
    expect(unit?.getAttribute("data-ad-slot")).toBe("9876543210");
  });

  it("fetches the script from the operator's own account, once", () => {
    watchScripts();
    const placement = placementFor();
    const { rerender } = render(
      <AdSlot placement={placement} slotId={placement.bannerSlotId} label="Advertisement" />,
    );
    rerender(
      <AdSlot placement={placement} slotId={placement.bannerSlotId} label="Advertisement" />,
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]).toContain(`client=${placement.clientId}`);
    expect(appended[0]).toContain("googlesyndication.com");
  });
});

/**
 * What is asked of Google before the ad is requested.
 *
 * Without a consent platform the request forces non-personalised ads: this page
 * is showing somebody their own money, and Google will serve on that footing
 * without a certified platform at all.
 *
 * With one, the flag is deliberately *not* forced. A consent platform's job is
 * to ask and then tell Google the answer, and forcing the flag on top of it
 * would override a person who consented just as surely as it protects one who
 * did not — which would make the platform ornamental.
 *
 * The flag has to be set *before* the push either way. Google reads it when the
 * request is made, so setting it afterwards personalises the ad that has
 * already gone.
 */
describe("what is requested from Google", () => {
  type Queue = unknown[] & { requestNonPersonalizedAds?: number };
  const queue = () => (window as unknown as { adsbygoogle?: Queue }).adsbygoogle;

  afterEach(() => {
    delete (window as unknown as { adsbygoogle?: Queue }).adsbygoogle;
  });

  /**
   * jsdom appends the script and never fetches it, so its `load` never fires
   * and the code under test would wait forever. Firing it by hand is what makes
   * this a test of what happens *after* the script arrives, which is the only
   * moment the flag can be set.
   */
  async function mountAndLoad(consentManaged: boolean) {
    const scripts: HTMLScriptElement[] = [];
    const original = document.head.append.bind(document.head);
    vi.spyOn(document.head, "append").mockImplementation((...nodes: unknown[]) => {
      for (const node of nodes) if (node instanceof HTMLScriptElement) scripts.push(node);
      return original(...(nodes as Node[]));
    });
    const placement = placementFor(consentManaged);
    render(<AdSlot placement={placement} slotId={placement.bannerSlotId} label="Advertisement" />);
    await vi.waitFor(() => expect(scripts).toHaveLength(1));
    scripts[0]!.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(queue()).toBeDefined());
  }

  it("asks for non-personalised ads by default", async () => {
    await mountAndLoad(false);
    expect(queue()?.requestNonPersonalizedAds).toBe(1);
    // And the flag was set before the request went, not after it.
    expect(queue()).toHaveLength(1);
  });

  it("leaves the decision to the consent platform where one is collecting consent", async () => {
    await mountAndLoad(true);
    expect(queue()?.requestNonPersonalizedAds).toBeUndefined();
    expect(queue()).toHaveLength(1);
  });
});

/**
 * A slot that empties and comes back.
 *
 * `session.ads` can go from a placement to null and back within one document:
 * an entitlement read that failed and then succeeded, a plan that lapsed, a
 * subscription that was cancelled. The `<ins>` is unmounted with the slot, so
 * the element that returns has never been pushed for — a latch left closed
 * across that gap leaves it permanently blank, which is revenue quietly lost
 * for the rest of the session.
 */
describe("a slot that is taken away and given back", () => {
  it("fills again rather than staying blank for the life of the document", async () => {
    const scripts: HTMLScriptElement[] = [];
    const original = document.head.append.bind(document.head);
    vi.spyOn(document.head, "append").mockImplementation((...nodes: unknown[]) => {
      for (const node of nodes) if (node instanceof HTMLScriptElement) scripts.push(node);
      return original(...(nodes as Node[]));
    });
    const placement = placementFor();
    const { rerender } = render(
      <AdSlot placement={placement} slotId={placement.bannerSlotId} label="Advertisement" />,
    );
    await vi.waitFor(() => expect(scripts).toHaveLength(1));
    scripts[0]!.dispatchEvent(new Event("load"));
    await vi.waitFor(() =>
      expect((window as unknown as { adsbygoogle?: unknown[] }).adsbygoogle).toHaveLength(1),
    );

    // Entitlement arrives: no placement, nothing rendered.
    rerender(<AdSlot placement={null} slotId={undefined} label="Advertisement" />);
    expect(screen.queryByLabelText("Advertisement")).toBeNull();

    // And it goes away again. The script is already loaded, so this is a push
    // for the new element rather than a second fetch.
    rerender(
      <AdSlot placement={placement} slotId={placement.bannerSlotId} label="Advertisement" />,
    );
    await vi.waitFor(() =>
      expect((window as unknown as { adsbygoogle?: unknown[] }).adsbygoogle).toHaveLength(2),
    );
    expect(scripts, "the script is fetched once for a publisher id").toHaveLength(1);
    delete (window as unknown as { adsbygoogle?: unknown[] }).adsbygoogle;
  });
});

/**
 * No ad on the plan and billing tab.
 *
 * Three documents promise it, and the content security policy is not what keeps
 * it: under `SB_CSP_REPORT_ONLY` — the mode the docs tell an operator to run on
 * exactly that page — nothing there is enforced at all, so a slot left mounted
 * would put live Google ads beside the payment form. On the page whose whole
 * purpose is selling their removal.
 *
 * The predicate is the router's own, so this and the document-load rule cannot
 * disagree about which spellings are that page.
 */
describe("which paths the shell will render an ad on", () => {
  it("treats every spelling of the plan tab as the plan tab", () => {
    for (const path of [
      "/settings/plan",
      "/settings/plan/",
      "//settings/plan",
      "/settings//plan",
    ]) {
      expect(isPlanSurfacePath(path), path).toBe(true);
    }
  });

  it("treats its neighbours as ordinary pages", () => {
    for (const path of ["/settings", "/settings/plans", "/settings/plan/extra", "/", "/accounts"]) {
      expect(isPlanSurfacePath(path), path).toBe(false);
    }
  });
});
