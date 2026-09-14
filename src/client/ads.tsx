import { useEffect, useRef } from "react";
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
        // flag is read when the request is made, so setting it afterwards
        // personalises the ad that has already gone.
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
