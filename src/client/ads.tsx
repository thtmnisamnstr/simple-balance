import { useEffect, useLayoutEffect, useRef } from "react";
import type { AdPlacement } from "./api.js";

/**
 * Advertising, and the two rules that govern every line of this file.
 *
 * **Nothing here decides who sees an ad.** The server does, and it says so by
 * whether it sent an `AdPlacement` at all: a subscriber's session carries none,
 * so this file is never handed anything to render. That is deliberate. A gate
 * written in the browser has to be written the right way round and has to wait
 * for an entitlement that arrives after first paint, and both are easy to get
 * wrong in the direction of showing an ad to somebody who paid not to see one.
 * Here the only way to render a slot is to be given the ids, and the only way
 * to be given the ids is to be entitled to nothing better.
 *
 * **The script is not loaded until there is a slot to fill.** Not at document
 * level, not in `index.html`, not on a timer. Google's script is fetched by the
 * first `AdSlot` that mounts, which is after the session has resolved — so a
 * subscriber never fetches it, is never counted as an impression, and is never
 * tracked by it. Putting the tag in the shell would undo the paragraph above
 * while appearing to work.
 */

/**
 * Google's script, fetched once per publisher id for the life of the document.
 *
 * Keyed by the id rather than loaded at module scope, for the same reason
 * Stripe's loader is: the id arrives on a response, so importing this file must
 * not cause a network request. A deployment that shows no ads never resolves
 * this promise because nothing ever calls it.
 */
const loading = new Map<string, Promise<void>>();

function loadAdScript(clientId: string): Promise<void> {
  const existing = loading.get(clientId);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    // `?client=` is required by AdSense and is what ties the script to the
    // operator's account. Auto ads are a property of that account rather than
    // of this tag, and they must be OFF: they inject formats this code never
    // writes, including the interstitials the product promises not to show.
    // `docs/monetization.md` says so where an operator will meet it.
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(clientId)}`;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => resolve());
    // Rejecting rather than hanging, so a blocked script — an ad blocker, a
    // content security policy that was never widened, a network that cannot
    // reach Google — leaves the slot empty instead of leaving a box reserved
    // for something that will never arrive.
    script.addEventListener("error", () => reject(new Error("The ad script did not load")));
    document.head.append(script);
  });
  loading.set(clientId, promise);
  return promise;
}

type AdWindow = Window & { adsbygoogle?: unknown[] };

/**
 * One ad unit.
 *
 * Renders nothing at all unless it was given a slot: `placement` is the
 * server's answer about this person, and `slotId` is absent when the operator
 * configured only the banner. Either being missing means there is no ad here,
 * which is a render of `null` rather than an empty reserved box — a placeholder
 * for an ad nobody is going to see is worse than no ad.
 */
export function AdSlot({
  placement,
  slotId,
  label,
}: {
  placement: AdPlacement | null | undefined;
  slotId: string | undefined;
  label: string;
}) {
  const filled = useRef(false);

  useEffect(() => {
    // Nothing to fill. Cleared rather than left set, because the `<ins>` this
    // guard is about is unmounted along with the slot — so a person whose
    // placement comes back (an entitlement read that failed and then
    // succeeded, a plan that lapsed) gets a fresh element that has never been
    // pushed for, and a latch left closed would leave it permanently blank.
    if (!placement || !slotId) {
      filled.current = false;
      return;
    }
    if (filled.current) return;
    // Once per mounted slot. AdSense fills the *next* unfilled `<ins>` on each
    // push, so pushing twice for one slot fills somebody else's — or nothing,
    // and logs an error about an element already having ads in it.
    filled.current = true;
    void loadAdScript(placement.clientId).then(
      () => {
        const target = window as AdWindow;
        const queue = (target.adsbygoogle = target.adsbygoogle ?? []);
        // Before the push, which is where Google's documentation puts it: the
        // flag is read when the request is made, so setting it afterward
        // personalizes the ad that has already gone.
        //
        // Forced unless a consent platform is collecting consent. With one, it
        // is deliberately *not* forced: the platform's whole job is to ask and
        // then tell Google the answer, and forcing the flag on top would
        // override somebody who consented just as surely as it protects one who
        // did not.
        //
        // Google's own platform is delivered by this very script — the AdSense
        // tag serves the consent message once an operator publishes one, with
        // nothing extra to load — so there is no second vendor script here and
        // no code path for one.
        if (!placement.consentManaged) {
          (queue as unknown as { requestNonPersonalizedAds?: number }).requestNonPersonalizedAds =
            1;
        }
        queue.push({});
      },
      () => {
        // Nothing to say to the person. An ad that did not load is not an
        // error they can act on, and this product does not put a message in
        // front of somebody about a failure that costs them nothing.
        filled.current = false;
      },
    );
  }, [placement, slotId]);

  if (!placement || !slotId) return null;

  return (
    // `aria-hidden` is deliberately absent. An ad is content, and hiding it
    // from a screen reader while showing it to everybody else is the kind of
    // accessibility that is really concealment. The region names itself so
    // somebody navigating by landmark can skip it, which is the honest version.
    <aside className="ad-slot" aria-label={label}>
      {/* `display: block` inline, as Google documents the tag. When Google has
          nothing to fill it with it marks the unit `data-ad-status="unfilled"`,
          and `styles.css` collapses the unit and this slot on that attribute —
          with `!important`, the one thing that outranks this inline style. */}
      <ins
        className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client={placement.clientId}
        data-ad-slot={slotId}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </aside>
  );
}

/*
 * The house ad's imports sit here rather than at the top of the file, because
 * the guides cite this file by line and a test holds one of those lines in
 * place: `ads.tsx:143` is the inline style web.md 1.3 counts. An import
 * written above `AdSlot` would move every one of those citations. Where an
 * `import` is written changes nothing about when it runs.
 */
import { PLAN_LABELS } from "../shared/domain.js";
import { HouseAdArt } from "./house-ad-art.js";

/**
 * How much of the ad has to be on screen before it plays: about a third, so it
 * starts where somebody can see it start rather than as its top edge comes
 * into view. Pinned to the foot of the window it is all on screen from the
 * first frame, so this decides only where it is not pinned and rests at the
 * end of the page: a short window at a phone's width, and a browser that
 * cannot select it by what it contains.
 */
const PLAY_AT = 0.35;

/**
 * Room left between a control scrolled into view and the bar's top edge, for
 * the focus ring around it and a little more.
 */
const FOCUS_CLEARANCE = 16;

/**
 * This product's own advertisement for its paid plan, in the banner's place.
 *
 * The first rule of this file holds for it unchanged. `shown` is the server's
 * `houseAd`, decided on the same "a limited plan is in force" predicate the
 * AdSense placement uses and on one more condition, that the plan is for sale;
 * a subscriber's session says false. The second rule holds for it trivially,
 * because there is nothing to load. It is first-party markup and a drawing
 * from this stylesheet: no script, no frame and no request, which is also why
 * it needs none of what turning AdSense on widens.
 *
 * Renders nothing unless it was told to, and the same landmark as `AdSlot`
 * when it was, so the shell's rule about where an ad sits covers both. It is
 * the one unit that stays on screen: the stylesheet pins it to the foot of the
 * window, and never an AdSense unit, whose frame is somebody else's content.
 */
export function HouseAd({ shown, label }: { shown: boolean | null | undefined; label: string }) {
  if (!shown) return null;
  return <HouseAdBar label={label} />;
}

/**
 * The ad itself, split out so that it plays once per mount: `HouseAd` going
 * false unmounts this, so an ad that comes back starts from the beginning
 * rather than wherever the last one stopped. Navigating inside the app keeps
 * it mounted, and the motion retires itself when it ends, so it plays once
 * per document load.
 */
function HouseAdBar({ label }: { label: string }) {
  const box = useRef<HTMLDivElement>(null);

  /*
   * Motion is opt-in, and opted into here rather than assumed by the
   * stylesheet. With neither class the drawing is its finished self: that is
   * what jsdom and a browser with no `IntersectionObserver` show, and what
   * reduced motion shows, since asking for it means not being armed at all.
   *
   * Armed before the first paint, which is why this is a layout effect: the
   * armed picture is the animation's first frame, paused, and arming after a
   * paint would show the finished drawing and then take two accounts away.
   * The first frame is the free plan's picture, so starting it from there
   * changes nothing on screen. It runs once enough of it is in view, which
   * for a bar pinned to the window is at once.
   *
   * Disarmed when the last beat ends, which leaves the same picture, because
   * the finished picture is what the drawing is with neither class. That is
   * what makes it once: hiding an element discards its animations and
   * showing it again starts every one of them over, so left armed, the story
   * replayed whenever the drawing came back across the phone width — a
   * window narrowed and widened, a phone turned, a page zoomed — and
   * whenever reduced motion was turned off again. The sway is the last beat,
   * and a beat cut short counts as ended: the drawing hidden mid-story, or
   * reduced motion turned on, cancels rather than ends it, and the next
   * showing is the finished picture rather than the story from the top.
   *
   * A phone is armed too and nothing runs there, because there is nothing to
   * run: the stylesheet does not display the drawing at that width, and an
   * element that is not displayed has no animations at all. So nothing ends
   * either, and it stays armed until the drawing is first displayed, a phone
   * turned on its side, where the story plays once.
   *
   * Classes on the element rather than state. Nothing React renders depends
   * on them, `className` never changes so React never rewrites the attribute,
   * and setting state here would re-render the ad for a fact only the
   * stylesheet reads.
   */
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") return;
    if (typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    element.classList.add("is-armed");
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.intersectionRatio >= PLAY_AT)) return;
        element.classList.add("is-playing");
        observer.disconnect();
      },
      { threshold: PLAY_AT },
    );
    observer.observe(element);
    // Animation events bubble, so the box hears the beats in its drawing.
    // Kept until unmount rather than removed on the first: a story cut short
    // before it was seen starts once more when the observer sees it, and has
    // to retire again at that end.
    const retire = (event: AnimationEvent) => {
      if (event.animationName !== "house-ad-sway") return;
      element.classList.remove("is-armed", "is-playing");
    };
    element.addEventListener("animationend", retire);
    element.addEventListener("animationcancel", retire);
    return () => {
      observer.disconnect();
      element.removeEventListener("animationend", retire);
      element.removeEventListener("animationcancel", retire);
    };
  }, []);

  /*
   * SC 2.4.11, Focus Not Obscured: a control tabbed to near the foot of the
   * window is scrolled clear of the bar rather than under it. The document's
   * `scroll-padding-bottom` is what the browser leaves free when it scrolls
   * something into view, so it is set to the bar's height, measured.
   *
   * Measured rather than written into the stylesheet, because the bar's height
   * is not a constant: its title wraps to two or three lines with the width,
   * and a reader who widens the spacing of text (SC 1.4.12) makes it taller
   * still. A figure in the stylesheet would be right at the size it was
   * measured at and leave a control half under the bar at every other.
   *
   * On the root's own style, through the object model rather than a `style`
   * attribute, which the content security policy forbids; and not as a custom
   * property, because every `var()` in the stylesheet has to be a token. Taken
   * off again when the ad goes, so a page without it keeps nothing of it.
   */
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    if (typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      root.style.scrollPaddingBottom = `${height + FOCUS_CLEARANCE}px`;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("scroll-padding-bottom");
    };
  }, []);

  return (
    // Not `aria-hidden`, for `AdSlot`'s reason: an ad is content. The drawing
    // is hidden inside its own module, because the words already say it.
    <aside className="ad-slot" aria-label={label}>
      <div className="house-ad" ref={box}>
        <div className="house-ad-bar">
          <div className="house-ad-words">
            <p className="house-ad-eyebrow">{PLAN_LABELS.plus}</p>
            {/* A paragraph styled as a heading rather than a heading: an ad
                has no place in the outline of every page it appears on, and
                the landmark's label is already the way to reach it.

                One sentence and no second one. The free plan's limit used to
                follow it in words, and the drawing beside it says the same
                thing in less room: the free plan's accounts at rest, and two
                more arriving.

                In two halves that each keep together, so the title breaks
                in one place and the words' floor is the longer half, which
                the stylesheet reads as the words' own width. */}
            <p className="house-ad-title">
              <span className="house-ad-half">As many accounts as</span>{" "}
              <span className="house-ad-half">you need, and no ads</span>
            </p>
          </div>
          <HouseAdArt />
          {/* A plain anchor with the path written out, not `Link`. The plan
              tab is served under its own content security policy, so it has
              to be entered by loading the document; a client-side push would
              keep this page's policy and the payment form would not load. */}
          <a className="button button-primary house-ad-cta" href="/settings/plan">
            {`Upgrade to ${PLAN_LABELS.plus}`}
          </a>
        </div>
      </div>
    </aside>
  );
}
