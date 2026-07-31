import type { Context, MiddlewareHandler } from "hono";
import { configuredCsvMaxBytes } from "./config-limits.js";

export const AUTH_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;
export const API_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;
const JSON_STRING_WORST_CASE_EXPANSION = 6;
const CSV_REQUEST_ENVELOPE_BYTES = 64 * 1024;
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
  return request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
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

export function protectBrowserMutation(
  options: MutationProtectionOptions,
): MiddlewareHandler {
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
      (!requestContentType ||
        !options.allowedContentTypes.has(requestContentType))
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
    allowedContentTypes: new Set([
      "application/json",
      "application/x-www-form-urlencoded",
    ]),
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
          : new Set([
              "application/json",
              "application/x-www-form-urlencoded",
            ]);
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
    destroy: () => unknown;
    destroySoon?: () => unknown;
  };
};

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
      typeof options.maxBytes === "function"
        ? options.maxBytes(context)
        : options.maxBytes;
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
  if (
    path === "/api/v1/csv/preview" ||
    path === "/api/v1/csv/stage" ||
    path === "/mcp"
  ) {
    return (
      configuredCsvMaxBytes() * JSON_STRING_WORST_CASE_EXPANSION +
      CSV_REQUEST_ENVELOPE_BYTES
    );
  }
  return API_REQUEST_BODY_LIMIT_BYTES;
}

export function requestBodyLimit(path: string) {
  if (path === "/api/auth" || path.startsWith("/api/auth/")) {
    return AUTH_REQUEST_BODY_LIMIT_BYTES;
  }
  return apiRequestBodyLimit(path);
}
