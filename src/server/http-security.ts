import type { Context, MiddlewareHandler } from "hono";
import type { TransportErrorCode } from "../shared/domain.js";
import { secureHeaders } from "hono/secure-headers";
import { MAX_BULK_SELECTION_ENTRIES } from "../shared/domain.js";
import { configuredCsvMaxBytes } from "./config-limits.js";
import { log } from "./log.js";

/**
 * What every response from this process carries, and the one place it is
 * written down.
 *
 * A function rather than a constant, because HSTS depends on configuration and
 * a constant would read it at import time, before the process has parsed any.
 * Exported rather than declared inline at the call site, because the split
 * deployment's nginx has to repeat these on the files it serves itself — the
 * application shell never reaches this process — and a test compares the two.
 * Two lists in two languages drift silently otherwise, and the response that
 * drifted is the only one that runs the app.
 */
/**
 * Which page is being served, because one of them needs a weaker policy.
 *
 * `app` is every page in the product and is the policy this container has
 * shipped since 0.1.0, unchanged. `stripe` is the plan and billing tab alone,
 * which mounts Stripe Elements — an iframe from a third party, loaded by a
 * script from a third party, talking to a fourth set of hosts. There is no way
 * to run a payment form that never reaches its payment processor.
 *
 * The distinction is by document, not by person: a page that has not resolved
 * an entitlement yet has already been served under one policy or the other, so
 * "only widen it for subscribers" is not a thing a header can express.
 */
export type SecuritySurface = "app" | "stripe";

/**
 * What the headers depend on besides the surface.
 *
 * An object rather than more positional parameters, because this grows: ads add
 * a second axis in the same release and a third caller would otherwise be
 * passing `securityHeaderOptions(true, "app", false, true)` and counting.
 *
 * `reportOnly` sends the policy as `Content-Security-Policy-Report-Only`, which
 * browsers evaluate and report on and never enforce. It exists because this
 * release widens the policy for one page to Stripe's published list plus four
 * hosts of our own, and nobody has yet watched a live account's payment form to
 * see which of those it contacts: an operator can turn it on, open the plan
 * tab, and find out what their deployment would have blocked before anything is
 * blocked for real.
 *
 * It applies to the `stripe` surface and to nothing else, and that restriction
 * is a choice rather than a claim that nothing else is new. Where ads are
 * configured, every other page carries a widened policy of this release too,
 * and no live ad has been watched against it either. Rehearsing it was declined
 * on purpose: every one of those pages renders somebody's balances, and taking
 * the defense off all of them to learn about an ad is the wrong trade. An ad
 * the policy refuses shows as a Content-Security-Policy violation in the
 * browser console on a page that carries one, while that page goes on
 * enforcing — which is where `docs/monetization.md` sends an operator to look.
 */
export type SecurityHeaderContext = {
  readonly surface?: SecuritySurface;
  readonly reportOnly?: boolean;
  /**
   * Whether this deployment serves advertising.
   *
   * A second axis rather than a third surface, because it is not a property of
   * one page: an ad appears in the application shell, so every page but the
   * plan tab carries the cost. A deployment that configured no AdSense ids is
   * unaffected — which is the default, and every deployment upgrading into this
   * release.
   */
  readonly ads?: boolean;
};

/** Where a browser posts what the policy would have blocked. */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * The hosts Stripe Elements reaches, and where this list departs from Stripe's.
 *
 * Stripe does publish them — `docs.stripe.com` §Integration security guide,
 * Content Security Policy — as a set per feature rather than one list, and two
 * of those sets apply here. For Stripe.js it is exactly: `api.stripe.com` on
 * connect-src; `js.stripe.com`, `*.js.stripe.com` and `hooks.stripe.com` on
 * frame-src; `js.stripe.com` and `*.js.stripe.com` on script-src. For Link it
 * is `link.com` and `*.link.com` on frame-src and connect-src, and `*.link.com`
 * on img-src, which the `https:` already on img-src covers. Link is in because
 * the Payment Element offers it by default — it shows a Link prompt in the card
 * form once the domain is registered with Stripe, and the subscription does not
 * restrict its payment methods — and a payer whose email has a Link account
 * would otherwise watch the sign-in step fail halfway through the form that
 * takes their money. Everything below matches those two sets, and
 * `maps.googleapis.com` is left out deliberately — it is for the Address
 * Element with your own Maps key, which this product does not use.
 *
 * Four entries are ours rather than Stripe's, and each is here for a different
 * reason and carries a different risk if it is wrong:
 *
 * - `*.hcaptcha.com`, on all three. Radar can decide a payment needs a
 *   challenge, and a blocked challenge is a payment that cannot complete. This
 *   is the one whose absence would break something a person is trying to do.
 * - `m.stripe.com` and `q.stripe.com` on connect-src, which carry fraud signals
 *   and Stripe's own metrics. Blocked, the form still works and Radar sees less.
 * - `errors.stripe.com`, which carries Stripe's error reports. Blocked, nothing
 *   a user can see changes.
 *
 * So this is a deliberate superset of two published sets rather than a guess at
 * an unpublished list, which is what it used to be described as. What has *not*
 * happened is watching a real Elements mount on a live account to see which of
 * the four are contacted, or a Link sign-in to see that its two hosts are
 * enough — that needs an account nobody here has, and `SB_CSP_REPORT_ONLY`
 * exists so an operator with one can find out without enforcing anything.
 * `docs/acceptance.md` carries it as outstanding.
 *
 * `m.stripe.network` is deliberately absent. Stripe retired it in favor of
 * `m.stripe.com`, which is listed above; most third-party guides still carry
 * the old name, and copying it would have widened the policy for a host nothing
 * contacts.
 */
const STRIPE_SCRIPT_HOSTS = [
  "https://js.stripe.com",
  // The wildcard as well as the bare host, because Stripe publishes both.
  // Nothing needs it today — the v3 bundle builds every frame from the bare
  // origin — but Stripe assigns alternate frame origins per account, server
  // side, with nothing here to announce it. Listing it costs a few bytes and is
  // the difference between that happening and a payment form that stops
  // loading for one deployment with no change on this side to explain it.
  "https://*.js.stripe.com",
  "https://*.hcaptcha.com",
];
const STRIPE_FRAME_HOSTS = [
  "https://js.stripe.com",
  "https://*.js.stripe.com",
  "https://hooks.stripe.com",
  "https://link.com",
  "https://*.link.com",
  "https://*.hcaptcha.com",
];
/**
 * What serving AdSense costs the policy, and why it is this much.
 *
 * Google publishes no list of the hosts AdSense loads from — as a matter of
 * policy rather than oversight — so there is no allowlist to write. The script
 * fetches further scripts, opens frames for the ad and for its fenced-frame
 * successor, and posts measurement beacons, all to hosts chosen per impression.
 *
 * So this is honest about being broad rather than pretending to be narrow:
 * scripts, frames and connections to any HTTPS origin, plus `'unsafe-eval'`,
 * which the ad stack requires. It is a real cost on every page that renders
 * somebody's balances, it is why ads are off unless an operator asks for them,
 * and it is why `docs/monetization.md` states it in the operator's own words
 * before they turn it on.
 *
 * Styles and fonts are on the list, and that is not padding. Google's consent
 * message — the one an operator publishes in AdSense's own Privacy and
 * messaging — does *not* render in an iframe: it appends its own element into
 * this document and styles it with injected `<style>` blocks and a stylesheet
 * from `fonts.googleapis.com`, whose faces then come from `fonts.gstatic.com`.
 * Under `style-src 'self'` the dialog still renders, unstyled and in the normal
 * flow far down the page, where nobody answers it — and an unanswered consent
 * message in the EEA and UK means no ad request completes at all. The failure
 * looks like having no inventory rather than like a policy being wrong.
 *
 * What is *not* given up: `'unsafe-inline'` for *scripts*, and `base-uri`,
 * `form-action`, `frame-ancestors` and `object-src` all stand. An injected
 * script still cannot be written inline into the document, the page still
 * cannot be reaimed or framed, and plugin embedding is still closed.
 *
 * None of this has been watched against a live ad unit or a published consent
 * message — no AdSense unit has ever rendered on this product, and
 * `docs/acceptance.md` carries that as outstanding. It is derived from how
 * Google documents its tag and its consent message behaving, and the first
 * operator to serve a real one is the first to see it hold.
 */
const ADS_SCRIPT_SOURCES = ["https:", "'unsafe-eval'"];
const ADS_FRAME_SOURCES = ["https:"];
const ADS_CONNECT_SOURCES = ["https:"];
const ADS_STYLE_SOURCES = ["'unsafe-inline'", "https:"];
const ADS_FONT_SOURCES = ["'self'", "https:", "data:"];

const STRIPE_CONNECT_HOSTS = [
  "https://api.stripe.com",
  "https://m.stripe.com",
  "https://q.stripe.com",
  "https://errors.stripe.com",
  "https://link.com",
  "https://*.link.com",
  "https://*.hcaptcha.com",
];

/**
 * What every response from this process carries, and the one place it is
 * written down.
 *
 * A function rather than a constant, because HSTS depends on configuration and
 * a constant would read it at import time, before the process has parsed any.
 * Exported rather than declared inline at the call site, because the split
 * deployment's nginx has to repeat these on the files it serves itself — the
 * application shell never reaches this process — and a test compares the two.
 * Two lists in two languages drift silently otherwise, and the response that
 * drifted is the only one that runs the app.
 *
 * The surface defaults to `app`, so every existing caller and every page but
 * one gets the policy this container shipped before billing existed, byte for
 * byte. A deployment that sells nothing never produces the other one.
 */
export const securityHeaderOptions = (
  isProduction: boolean,
  context: SecurityHeaderContext = {},
): NonNullable<Parameters<typeof secureHeaders>[0]> => {
  const surface = context.surface ?? "app";
  // Only the surface whose policy is new. See `SecurityHeaderContext`.
  const reportOnly = context.reportOnly === true && surface === "stripe";
  const policy = {
    defaultSrc: ["'self'"],
    imgSrc: ["'self'", "data:", "https:"],
    // No 'unsafe-inline'. The few inline styles here are React `style` props,
    // which are applied through the CSSOM rather than written as a style
    // attribute, and CSP does not govern those. Vite emits the stylesheet as
    // a file. Checked in a browser across the sign-in, overview, and
    // transaction pages with no violation reported.
    //
    // hCaptcha, which Stripe Radar can put in front of a payment, styles
    // itself from its own origin, so the host joins the list on that one page
    // rather than 'unsafe-inline' joining it everywhere.
    styleSrc:
      surface === "stripe"
        ? ["'self'", "https://*.hcaptcha.com"]
        : ["'self'", ...(context.ads === true ? ADS_STYLE_SOURCES : [])],
    // Only where ads are served. Absent otherwise, so `default-src 'self'`
    // governs and no third-party face loads — which is the behavior this
    // container has always had.
    ...(surface !== "stripe" && context.ads === true ? { fontSrc: ADS_FONT_SOURCES } : {}),
    scriptSrc:
      surface === "stripe"
        ? ["'self'", ...STRIPE_SCRIPT_HOSTS]
        : ["'self'", ...(context.ads === true ? ADS_SCRIPT_SOURCES : [])],
    connectSrc:
      surface === "stripe"
        ? ["'self'", ...STRIPE_CONNECT_HOSTS]
        : ["'self'", ...(context.ads === true ? ADS_CONNECT_SOURCES : [])],
    // Absent entirely where neither vendor needs it, which is stronger than
    // listing nothing: with no frame-src and no default-src fallback to widen,
    // the `default-src 'self'` above governs and no third-party frame loads.
    //
    // The two never combine. Ads live in the application shell and the plan tab
    // is the one page this product promises not to put them on, so that page
    // carries Stripe's hosts and this one carries the ad sources.
    ...(surface === "stripe"
      ? { frameSrc: STRIPE_FRAME_HOSTS }
      : context.ads === true
        ? { frameSrc: ADS_FRAME_SOURCES }
        : {}),
    // None of these four fall back to default-src, so leaving them out left
    // real gaps. base-uri stops an injected <base> quietly repointing every
    // relative URL on the page, including the one the sign-in form posts to.
    // form-action stops a form being aimed somewhere else. frame-ancestors
    // is the modern half of the clickjacking defense that X-Frame-Options
    // covers for older browsers. object-src closes plugin embedding.
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    // Only while reporting. `report-uri` is deprecated and is the one every
    // browser in the field still implements; `report-to` is the replacement
    // and needs the `Reporting-Endpoints` header below to mean anything. Both,
    // because a report that is not collected is a rollout that proves nothing.
    ...(reportOnly ? { reportUri: CSP_REPORT_PATH, reportTo: "csp" } : {}),
  };

  return {
    // One or the other, never both. Sending an enforcing policy beside a
    // report-only copy of itself is a rollout that is not a rollout: the page
    // breaks exactly as it would have, and the reports say so afterward.
    ...(reportOnly
      ? { contentSecurityPolicy: undefined, contentSecurityPolicyReportOnly: policy }
      : { contentSecurityPolicy: policy }),
    ...(reportOnly ? { reportingEndpoints: [{ name: "csp", url: CSP_REPORT_PATH }] } : {}),
    // Not the `no-referrer` this defaults to. Under that policy a browser sends
    // `Origin: null` on a form submission, including the sign-in form posting to
    // this very server, and protectAuthMutation rightly refuses an origin it
    // cannot recognize. That broke MCP authorization, where the sign-in form is
    // submitted natively so the OAuth redirect stays a top-level navigation.
    // `same-origin` still sends nothing at all to anybody else.
    //
    // Except on the pages that carry ads, where it is not enough. Google's
    // consent message does not serve under a policy that keeps the referrer
    // off cross-origin requests — its own troubleshooting says `same-origin`
    // is one it cannot serve under, and names this one as sufficient — and in
    // the EEA, the UK and Switzerland an ad request with no consent answer
    // either sets cookies nobody agreed to or completes no ad at all. So those
    // pages send `strict-origin-when-cross-origin`, which is the browser's own
    // default: another origin is told this site's address and never the path,
    // so the record ids in a URL still stay off every Referer, and a same-origin
    // form post still carries its real Origin. The plan tab keeps `same-origin`
    // — it carries no ads, and it is the page that takes a card.
    referrerPolicy:
      surface !== "stripe" && context.ads === true
        ? "strict-origin-when-cross-origin"
        : "same-origin",
    // Named rather than left to the default for the plan tab's sake. Hono's
    // default is `same-origin`, which severs a popup from the page that opened
    // it — and Google Pay, where it completes in a popup rather than a native
    // sheet, needs that link to hand the payment back; Google's own
    // troubleshooting names `same-origin-allow-popups` as the fix. That page
    // alone gets it. Every other page opens no payment popup and keeps the
    // stronger isolation, and the report-only rehearsal cannot show this
    // either way, because an opener policy is not part of the content policy.
    crossOriginOpenerPolicy: surface === "stripe" ? "same-origin-allow-popups" : "same-origin",
    // Not the `SAMEORIGIN` this defaults to, which contradicts the
    // `frame-ancestors 'none'` above it: nothing here is ever meant to be
    // framed, including by itself. The split deployment's nginx says DENY for
    // the files it serves, and the two have to agree or the shell and the API
    // answer differently about the same application.
    xFrameOptions: "DENY",
    strictTransportSecurity: isProduction ? "max-age=31536000; includeSubDomains" : false,
  };
};

/**
 * Whether a request is for the one page served under the Stripe policy.
 *
 * Normalized the way the browser's own router matches, so the two agree by
 * construction rather than by both happening to be spelled the same. A bare
 * string comparison served `/settings/plan/` and `//settings/plan` under the
 * strict policy while the router rendered the plan tab for both — a payment
 * form that cannot load, with nothing on screen to say why. `requestBodyLimit`
 * in this file spells out `/mcp` and `/mcp/` for exactly this reason.
 */
export const isStripeSurfacePath = (path: string) => STRIPE_SURFACE_PATTERN.test(path);

/**
 * The one path served under the Stripe policy, and the same normalization the
 * browser's router does, as one pass.
 *
 * The router splits on `/` and drops empty segments, so it renders the plan tab
 * for `/settings/plan`, `/settings/plan/`, `//settings/plan` and
 * `/settings//plan` alike. This matches exactly that set — checked against the
 * router's own expression over both spellings and a dozen near misses.
 *
 * A pattern rather than a split-filter-join because this runs on *every*
 * request that reaches a Stripe-configured deployment, asset requests included,
 * and the obvious version allocates three times per call to compare against one
 * constant. Measured at two million calls on a typical path: 180ms against 22ms.
 *
 * This is the authority for documents *this process* serves, which is the
 * single container and nothing else. In the split deployment nginx serves the
 * shell itself and proxies only a few prefixes, so the same decision is spelled
 * a second time in `deploy/docker/nginx.conf.template`. Two copies in two
 * languages is exactly the drift `tests/security-header-parity.test.ts` exists
 * to catch, and it compares both surfaces rather than only this one.
 */
const STRIPE_SURFACE_PATTERN = /^\/+settings\/+plan\/*$/;

/**
 * The path as it was written, not as Hono decoded it.
 *
 * `c.req.path` runs `decodeURI` on anything containing a `%`, so
 * `/settings/%70lan` arrives here as `/settings/plan` and would be handed the
 * wider policy — while the browser's own router does not decode and renders
 * something else entirely. A policy widened for a page that is not the plan tab
 * is a small hole with no benefit, and matching the raw spelling closes it by
 * making both sides answer the same question.
 */
export const rawPathOf = (url: string) => {
  const start = url.indexOf("/", url.indexOf("://") + 3);
  if (start === -1) return "/";
  const end = url.search(/[?#]/);
  return end === -1 || end < start ? url.slice(start) : url.slice(start, end);
};

export const AUTH_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;
export const API_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;
const JSON_STRING_WORST_CASE_EXPANSION = 6;
const CSV_REQUEST_ENVELOPE_BYTES = 64 * 1024;
/**
 * A selected row costs a quoted UUID in an id array (39 bytes) plus an
 * `"id": version` entry in the expected-version map (50 bytes). 96 leaves room
 * for a longer version integer and for another id-bearing field being added.
 */
const BULK_SELECTION_ENTRY_BYTES = 96;
const BULK_REQUEST_ENVELOPE_BYTES = 64 * 1024;
/**
 * Bulk routes legitimately send one entry per selected row, so their limit is
 * derived from the selection cap instead of the general API limit. A fixed
 * 256 KiB rejected a full 5,000-row staged commit at roughly 435 KiB even
 * though the schemas accept it.
 */
export const BULK_REQUEST_BODY_LIMIT_BYTES =
  MAX_BULK_SELECTION_ENTRIES * BULK_SELECTION_ENTRY_BYTES + BULK_REQUEST_ENVELOPE_BYTES;

/**
 * Recognized by shape rather than listed, because a list has to be revisited
 * every time a route is added and is silently wrong until somebody notices.
 * The template mass edit and mass delete were sized as ordinary requests for
 * exactly that reason, so a selection their schemas accept came back 413.
 */
const BULK_REQUEST_ACTIONS = new Set([
  "bulk-edit",
  "bulk-delete",
  "bulk-selection",
  "commit",
  "delete",
]);

function isBulkRequestPath(path: string) {
  if (!path.startsWith("/api/v1/")) return false;
  const segments = path.split("/");
  return segments.length === 5 && BULK_REQUEST_ACTIONS.has(segments[4]!);
}
const REJECTED_BODY_DRAIN_LIMIT_BYTES = 128 * 1024;
const REJECTED_BODY_DRAIN_TIMEOUT_MS = 250;

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

type MutationProtectionOptions = {
  allowedOrigin: string;
  allowedContentTypes: ReadonlySet<string>;
  requireContentType?: boolean;
  exempt?: (context: Context) => boolean;
};

function errorResponse(
  context: Context,
  status: 400 | 403 | 413 | 415,
  // Typed rather than `string`, which is what made the gap possible: five codes
  // reached the wire and appeared in no enumeration at all, because nothing
  // stopped a sixth. An enumeration anything can bypass is not a contract, it
  // is what somebody remembered.
  code: TransportErrorCode,
  message: string,
) {
  return context.json({ error: { code, message } }, status);
}

function contentType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

function headerOrigin(value: string | null) {
  if (!value || value === "null") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== null) return headerOrigin(origin);
  return headerOrigin(request.headers.get("referer"));
}

async function cancelRequestBody(request: Request) {
  if (!request.body || request.body.locked) return;
  try {
    await request.body.cancel();
  } catch {
    // The peer may have already closed the body stream.
  }
}

export async function rejectRequestBody(context: Context) {
  await cancelRequestBody(context.req.raw);
  terminateNativeRequestBody(context);
  context.header("Connection", "close");
}

export function protectBrowserMutation(options: MutationProtectionOptions): MiddlewareHandler {
  const allowedOrigin = new URL(options.allowedOrigin).origin;
  return async (context, next) => {
    if (safeMethods.has(context.req.method) || options.exempt?.(context)) {
      await next();
      return;
    }

    if (requestOrigin(context.req.raw) !== allowedOrigin) {
      await rejectRequestBody(context);
      return errorResponse(
        context,
        403,
        "CROSS_ORIGIN_REQUEST",
        "State-changing requests must come from this application",
      );
    }

    const requestContentType = contentType(context.req.raw);
    if (
      (options.requireContentType || requestContentType !== undefined) &&
      (!requestContentType || !options.allowedContentTypes.has(requestContentType))
    ) {
      await rejectRequestBody(context);
      return errorResponse(
        context,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "This endpoint does not accept the request content type",
      );
    }

    await next();
  };
}

export function protectAuthMutation(allowedOrigin: string): MiddlewareHandler {
  const canonicalOrigin = new URL(allowedOrigin).origin;
  const browserMutationProtection = protectBrowserMutation({
    allowedOrigin: canonicalOrigin,
    allowedContentTypes: new Set(["application/json", "application/x-www-form-urlencoded"]),
  });

  return async (context, next) => {
    if (safeMethods.has(context.req.method)) {
      await next();
      return;
    }

    const path = context.req.path;
    if (path === "/api/auth/callback/google") {
      await next();
      return;
    }

    if (path === "/api/auth/mcp/token" || path === "/api/auth/mcp/register") {
      const expectedTypes =
        path === "/api/auth/mcp/register"
          ? new Set(["application/json"])
          : new Set(["application/json", "application/x-www-form-urlencoded"]);
      const requestContentType = contentType(context.req.raw);
      if (!requestContentType || !expectedTypes.has(requestContentType)) {
        await rejectRequestBody(context);
        return errorResponse(
          context,
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "This OAuth endpoint does not accept the request content type",
        );
      }

      // OAuth token exchange and dynamic client registration are intentionally
      // usable by non-browser clients without an Origin header. If a browser
      // does attach credentials, however, it must still be same-origin.
      if (
        context.req.raw.headers.has("cookie") &&
        requestOrigin(context.req.raw) !== canonicalOrigin
      ) {
        await rejectRequestBody(context);
        return errorResponse(
          context,
          403,
          "CROSS_ORIGIN_REQUEST",
          "Cookie-authenticated OAuth requests must come from this application",
        );
      }
      await next();
      return;
    }

    return browserMutationProtection(context, next);
  };
}

type BodyLimitOptions = {
  maxBytes: number | ((context: Context) => number);
};

type NativeIncomingRequest = {
  destroyed?: boolean;
  readableEnded?: boolean;
  pause: () => unknown;
  resume: () => unknown;
  destroy: (error?: Error) => unknown;
  on: (event: "data", listener: (chunk: { byteLength: number }) => void) => unknown;
  once: (event: "end" | "error" | "close", listener: () => void) => unknown;
  off: (
    event: "data" | "end" | "error" | "close",
    listener: ((chunk: { byteLength: number }) => void) | (() => void),
  ) => unknown;
  socket?: {
    destroyed?: boolean;
    remoteAddress?: string;
    destroy: () => unknown;
    destroySoon?: () => unknown;
  };
};

/**
 * The address the rate limiter should count against, as a request it can read.
 *
 * Sign-up and sign-in are limited per client address, and the address is taken
 * from `x-forwarded-for`. Behind a proxy that header is authoritative. Without
 * one it is whatever the caller typed, so a caller who varies it gets as many
 * attempts as they like — and a caller who omits it puts everyone in a single
 * shared bucket, where four requests lock the rest of the world out.
 *
 * So when no proxy is trusted, the header is replaced with the peer address of
 * the actual TCP connection, which nobody on the far end can choose.
 */
export function withCountableClientAddress(
  request: Request,
  context: Context,
  trustProxy: boolean,
) {
  if (trustProxy) return request;
  const bindings = context.env as NodeTransportBindings | undefined;
  const peer = bindings?.incoming?.socket?.remoteAddress;
  const headers = new Headers(request.headers);
  if (peer) headers.set("x-forwarded-for", peer);
  else headers.delete("x-forwarded-for");
  return new Request(request, { headers });
}

/**
 * The address `withCountableClientAddress` would count this request against.
 *
 * The same rule, so a limiter built on it cannot be talked out of counting by
 * a header the caller wrote. An address that cannot be established at all
 * shares one bucket, which is the strict reading rather than a free pass.
 */
export function countableClientAddress(request: Request, context: Context, trustProxy: boolean) {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    return forwarded?.split(",", 1)[0]?.trim() || "unknown";
  }
  const bindings = context.env as NodeTransportBindings | undefined;
  return bindings?.incoming?.socket?.remoteAddress ?? "unknown";
}

/**
 * A fixed-window attempt counter every replica shares.
 *
 * The window lives in PostgreSQL because a count held in the process bounds
 * nothing once there is more than one of them: each keeps its own tally, the
 * allowance is multiplied by the replica count, and a guesser only has to
 * spread their attempts. The table is the one place they can agree.
 *
 * A local tally still runs in front of it, and only ever to refuse. Local can
 * never exceed shared, so a key already over the allowance here is over it
 * there, and a flood is turned away without touching the database at all. The
 * database is consulted only while a caller is still inside their allowance,
 * which is the case that has to be right rather than the case that is hammered.
 */
export function createAttemptLimiter(options: {
  max: number;
  windowMs: number;
  now?: () => number;
  store?: AttemptStore;
}) {
  const clock = options.now ?? (() => Date.now());
  const store = options.store ?? postgresAttemptStore;
  const windows = new Map<string, { count: number; resetAt: number }>();

  const countLocally = (key: string, now: number) => {
    for (const [held, window] of windows) {
      if (window.resetAt <= now) windows.delete(held);
    }
    const window = windows.get(key);
    if (!window || window.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      return 1;
    }
    window.count += 1;
    return window.count;
  };

  return {
    /**
     * The window in whole seconds, for the `Retry-After` on a refusal.
     *
     * Derived from the same `windowMs` the limiter counts by, so the header and
     * the bound cannot come to disagree — which is the whole failure mode of a
     * hand-written number beside a configured one.
     */
    retryAfterSeconds: Math.ceil(options.windowMs / 1000),
    /** True when this attempt is within the allowance, counting it. */
    async take(key: string) {
      const now = clock();
      if (countLocally(key, now) > options.max) return false;
      try {
        return await store.take(key, options.max, options.windowMs, now);
      } catch (error) {
        // Falls back to the local tally, which has already counted this attempt
        // and already refused anything past the allowance. That bound is weaker
        // than the shared one by the replica count, and it is a great deal
        // better than the alternative here, which is refusing every sign-in on
        // a deployment whose database is having a bad minute.
        log.failure("The shared attempt limiter could not be reached", error);
        return true;
      }
    },
    /** Forget a key, so a success does not spend the next caller's allowance. */
    async clear(key: string) {
      windows.delete(key);
      try {
        await store.clear(key);
      } catch (error) {
        log.failure("The shared attempt limiter could not be cleared", error);
      }
    },
  };
}

export type AttemptStore = {
  take: (key: string, max: number, windowMs: number, now: number) => Promise<boolean>;
  clear: (key: string) => Promise<void>;
};

/**
 * One statement per attempt, and the count it returns is the one that decided.
 *
 * Reading and then writing would let two replicas both read the last allowed
 * attempt and both allow it. The upsert increments inside the row's own lock
 * and hands back what the row now holds, so whoever is second sees the first.
 * A window that has run out is restarted in the same statement rather than
 * deleted first, which would be a second round trip and a second race.
 */
export const postgresAttemptStore: AttemptStore = {
  async take(key, max, windowMs, now) {
    const { getDb } = await import("./db/client.js");
    const { sql } = await import("drizzle-orm");
    // `last_request` holds the window's END, not its start. The table is
    // shared with Better Auth, whose own sweeper deletes any row whose
    // last_request looks older than its ten-second sign-in window — and a
    // fifteen-minute attempt window pinned at its start looked ancient ten
    // seconds in, so two sign-in requests eleven seconds apart silently
    // deleted the shared brute-force tally and left only the per-process one.
    // Stored as the future expiry, the row outlives every sweep until the
    // window is really over, and then the sweeper reaps it for free.
    const result = await getDb().execute<{ count: number }>(sql`
      insert into auth_rate_limit (id, key, count, last_request)
      values (${`attempt:${key}`}, ${`attempt:${key}`}, 1, ${now + windowMs})
      on conflict (key) do update
        set count = case
              when auth_rate_limit.last_request <= ${now} then 1
              else auth_rate_limit.count + 1
            end,
            last_request = case
              when auth_rate_limit.last_request <= ${now}
                then ${now + windowMs}
              else auth_rate_limit.last_request
            end
      returning count
    `);
    return Number(result.rows[0]?.count ?? 1) <= max;
  },
  async clear(key) {
    const { getDb } = await import("./db/client.js");
    const { sql } = await import("drizzle-orm");
    await getDb().execute(sql`delete from auth_rate_limit where key = ${`attempt:${key}`}`);
  },
};

/**
 * Give every cookie leaving the auth routes the flags the session cookie gets.
 *
 * Better Auth marks its own session cookie `HttpOnly`, `Secure`, and with the
 * `__Secure-` prefix, but the OIDC plugin's `oidc_login_prompt` gets none of
 * them. That cookie holds the pending authorization: the client, the redirect,
 * the scope, the state, and the PKCE challenge. It is signed, so nobody can
 * forge one, and it is the reading that matters. Without `Secure` a browser
 * will send it over plaintext to a deployment that is otherwise entirely
 * HTTPS, and without `HttpOnly` any script on the page can read an
 * authorization in flight.
 *
 * Nothing in the browser app reads a cookie, so there is nothing to break by
 * closing both. `Secure` is added only when this deployment is actually served
 * over HTTPS; adding it on a plaintext development origin would make the
 * browser drop the cookie and the flow would stop working.
 */
export function hardenAuthCookies(baseUrl: string): MiddlewareHandler {
  const secure = baseUrl.startsWith("https:");
  return async (context, next) => {
    await next();
    const cookies = context.res.headers.getSetCookie();
    if (!cookies.length) return;
    const hardened = cookies.map((cookie) => {
      const flags = cookie.split(";").map((part) => part.trim().toLowerCase());
      let result = cookie;
      if (!flags.includes("httponly")) result += "; HttpOnly";
      if (secure && !flags.includes("secure")) result += "; Secure";
      return result;
    });
    if (hardened.every((cookie, index) => cookie === cookies[index])) return;
    context.res.headers.delete("set-cookie");
    for (const cookie of hardened) {
      context.res.headers.append("set-cookie", cookie);
    }
  };
}

type NativeOutgoingResponse = {
  shouldKeepAlive?: boolean;
  writableFinished?: boolean;
};

type NodeTransportBindings = {
  incoming?: NativeIncomingRequest;
  outgoing?: NativeOutgoingResponse;
};

/**
 * Stop an oversized request at the native Node transport boundary.
 *
 * @hono/node-server wraps IncomingMessage in a Web ReadableStream whose
 * `cancel()` does not propagate to the native stream while automatic cleanup is
 * enabled. A small, bounded native drain lets Node deliver the 4xx and FIN
 * cleanly instead of resetting a connection with unread inbound data. Peers
 * that ignore the close are destroyed after a strict byte or time bound, well
 * before the adapter's 64 MiB cleanup cap.
 */
function terminateNativeRequestBody(context: Context) {
  const bindings = context.env as NodeTransportBindings | undefined;
  const incoming = bindings?.incoming;
  if (!incoming) return;

  incoming.pause();
  let terminated = false;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    incoming.pause();
    if (incoming.destroyed) return;
    const socket = incoming.socket;
    if (socket && !socket.destroyed) {
      if (typeof socket.destroySoon === "function") socket.destroySoon();
      else socket.destroy();
      return;
    }
    incoming.destroy();
  };

  const outgoing = bindings?.outgoing;
  if (outgoing && !outgoing.writableFinished) {
    // The Hono response also carries `Connection: close`. Let Node finish and
    // close that response naturally while a bounded drain prevents unread
    // inbound bytes from converting the graceful FIN into a TCP reset.
    outgoing.shouldKeepAlive = false;
    let drainedBytes = 0;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      incoming.off("data", onData);
      incoming.off("end", cleanup);
      incoming.off("error", cleanup);
      incoming.off("close", cleanup);
    };
    const forceClose = () => {
      cleanup();
      terminate();
    };
    const onData = (chunk: { byteLength: number }) => {
      drainedBytes += chunk.byteLength;
      if (drainedBytes > REJECTED_BODY_DRAIN_LIMIT_BYTES) forceClose();
    };
    const timer = setTimeout(forceClose, REJECTED_BODY_DRAIN_TIMEOUT_MS);
    timer.unref?.();
    incoming.on("data", onData);
    incoming.once("end", cleanup);
    incoming.once("error", cleanup);
    incoming.once("close", cleanup);
    if (!incoming.readableEnded) incoming.resume();
  } else {
    terminate();
  }
}

function validatedContentLength(request: Request) {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

export function boundRequestBody(options: BodyLimitOptions): MiddlewareHandler {
  return async (context, next) => {
    const request = context.req.raw;
    const maxBytes =
      typeof options.maxBytes === "function" ? options.maxBytes(context) : options.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Request body limit must be a positive safe integer");
    }

    const declaredLength = validatedContentLength(request);
    if (Number.isNaN(declaredLength)) {
      await cancelRequestBody(request);
      terminateNativeRequestBody(context);
      context.header("Connection", "close");
      return errorResponse(
        context,
        400,
        "INVALID_CONTENT_LENGTH",
        "Content-Length must be a non-negative integer",
      );
    }
    if (declaredLength !== null && declaredLength > maxBytes) {
      await cancelRequestBody(request);
      terminateNativeRequestBody(context);
      context.header("Connection", "close");
      return errorResponse(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        `Request body exceeds the ${maxBytes}-byte limit`,
      );
    }

    if (!request.body) {
      if (
        (declaredLength !== null && declaredLength > 0) ||
        request.headers.has("transfer-encoding")
      ) {
        terminateNativeRequestBody(context);
        context.header("Connection", "close");
        return errorResponse(
          context,
          400,
          "REQUEST_BODY_NOT_ALLOWED",
          "This request method does not accept a body",
        );
      }
      await next();
      return;
    }

    // Always consume and replay the body, even when Content-Length is present.
    // This makes the configured limit authoritative instead of trusting framing
    // metadata and ensures rejected downstream requests leave no native body for
    // @hono/node-server to drain.
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The peer may have already closed the body stream.
        }
        terminateNativeRequestBody(context);
        context.header("Connection", "close");
        return errorResponse(
          context,
          413,
          "PAYLOAD_TOO_LARGE",
          `Request body exceeds the ${maxBytes}-byte limit`,
        );
      }
      chunks.push(value);
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    context.req.raw = new Request(context.req.raw, {
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await next();
  };
}

export function apiRequestBodyLimit(path: string) {
  // `/mcp/` is the same endpoint as `/mcp` and is routed as such, so it has to
  // be sized as such too. Missing it left a client configured with the trailing
  // slash - the very configuration that spelling exists to support - capped at
  // the generic limit, so a CSV upload or a large bulk selection came back 413
  // while the identical call without the slash was allowed sixty times as much.
  // One endpoint carries every tool, so it is sized for the largest of them
  // rather than per tool: stage_csv sends a whole CSV as a JSON string, and a
  // limit that fits it is the limit a read tool gets too. The tool's own
  // schema is what refuses an oversized argument to anything else.
  const mcp = path === "/mcp" || path === "/mcp/";
  if (path === "/api/v1/csv/preview" || path === "/api/v1/csv/stage" || mcp) {
    return configuredCsvMaxBytes() * JSON_STRING_WORST_CASE_EXPANSION + CSV_REQUEST_ENVELOPE_BYTES;
  }
  if (isBulkRequestPath(path)) return BULK_REQUEST_BODY_LIMIT_BYTES;
  return API_REQUEST_BODY_LIMIT_BYTES;
}

/**
 * Sized for a *batch* of reports, not for one.
 *
 * The obvious number is wrong and was measured to be wrong: Chromium does not
 * post one report per violation, it batches whatever is pending into a single
 * delivery — about 17 KiB for seventeen violations and 100 KiB for a hundred.
 * A limit sized for one report answers that batch 413 and logs nothing, so a
 * rehearsal records the first violation and silently drops the one naming the
 * host it exists to find. Exactly the wrong failure for a feature whose whole
 * purpose is to tell an operator what they do not know.
 *
 * Still far under the generic 256 KiB, because this is the one route nothing
 * authenticates and it exists only while an operator is rehearsing.
 */
const CSP_REPORT_BODY_LIMIT_BYTES = 128 * 1024;

export function requestBodyLimit(path: string) {
  if (path === "/api/auth" || path.startsWith("/api/auth/")) {
    return AUTH_REQUEST_BODY_LIMIT_BYTES;
  }
  if (path === CSP_REPORT_PATH) return CSP_REPORT_BODY_LIMIT_BYTES;
  return apiRequestBodyLimit(path);
}
