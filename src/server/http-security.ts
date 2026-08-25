import type { Context, MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { MAX_BULK_SELECTION_ENTRIES } from "../shared/domain.js";
import { configuredCsvMaxBytes } from "./config-limits.js";

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
export const securityHeaderOptions = (isProduction: boolean) =>
  ({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      // No 'unsafe-inline'. The few inline styles here are React `style` props,
      // which are applied through the CSSOM rather than written as a style
      // attribute, and CSP does not govern those. Vite emits the stylesheet as
      // a file. Checked in a browser across the sign-in, overview, and
      // transaction pages with no violation reported.
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      // None of these four fall back to default-src, so leaving them out left
      // real gaps. base-uri stops an injected <base> quietly repointing every
      // relative URL on the page, including the one the sign-in form posts to.
      // form-action stops a form being aimed somewhere else. frame-ancestors
      // is the modern half of the clickjacking defence that X-Frame-Options
      // covers for older browsers. object-src closes plugin embedding.
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
    // Not the `no-referrer` this defaults to. Under that policy a browser sends
    // `Origin: null` on a form submission, including the sign-in form posting to
    // this very server, and protectAuthMutation rightly refuses an origin it
    // cannot recognise. That broke MCP authorization, where the sign-in form is
    // submitted natively so the OAuth redirect stays a top-level navigation.
    // `same-origin` still sends nothing at all to anybody else.
    referrerPolicy: "same-origin",
    // Not the `SAMEORIGIN` this defaults to, which contradicts the
    // `frame-ancestors 'none'` above it: nothing here is ever meant to be
    // framed, including by itself. The split deployment's nginx says DENY for
    // the files it serves, and the two have to agree or the shell and the API
    // answer differently about the same application.
    xFrameOptions: "DENY",
    strictTransportSecurity: isProduction ? "max-age=31536000; includeSubDomains" : false,
  }) satisfies Parameters<typeof secureHeaders>[0];

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
 * Recognised by shape rather than listed, because a list has to be revisited
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
  code: string,
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

export async function cancelRequestBody(request: Request) {
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
        console.error("The shared attempt limiter could not be reached", error);
        return true;
      }
    },
    /** Forget a key, so a success does not spend the next caller's allowance. */
    async clear(key: string) {
      windows.delete(key);
      try {
        await store.clear(key);
      } catch (error) {
        console.error("The shared attempt limiter could not be cleared", error);
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
    const result = await getDb().execute<{ count: number }>(sql`
      insert into auth_rate_limit (id, key, count, last_request)
      values (${`attempt:${key}`}, ${`attempt:${key}`}, 1, ${now})
      on conflict (key) do update
        set count = case
              when auth_rate_limit.last_request <= ${now - windowMs} then 1
              else auth_rate_limit.count + 1
            end,
            last_request = case
              when auth_rate_limit.last_request <= ${now - windowMs}
                then ${now}
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

export function requestBodyLimit(path: string) {
  if (path === "/api/auth" || path.startsWith("/api/auth/")) {
    return AUTH_REQUEST_BODY_LIMIT_BYTES;
  }
  return apiRequestBodyLimit(path);
}
