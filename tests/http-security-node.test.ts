import { serve } from "@hono/node-server";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { boundRequestBody } from "../src/server/http-security.js";

const servers: ReturnType<typeof serve>[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (!socket.destroyed) socket.destroy();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function withTimeout<T>(promise: Promise<T>, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 3_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe("Node request body enforcement", () => {
  it("closes an oversized chunked request instead of letting the adapter drain it", async () => {
    const constrainedPort = process.env.RALPH_LOOPBACK_TEST_PORT
      ? Number(process.env.RALPH_LOOPBACK_TEST_PORT)
      : 0;
    if (
      !Number.isInteger(constrainedPort) ||
      constrainedPort < 0 ||
      constrainedPort > 65_535
    ) {
      throw new Error("RALPH_LOOPBACK_TEST_PORT must be a valid TCP port");
    }
    const app = new Hono();
    app.use("*", boundRequestBody({ maxBytes: 8 * 1024 }));
    app.post("/", async (context) =>
      context.text(await context.req.text()),
    );

    const server = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: constrainedPort,
    });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test HTTP server did not expose a TCP port");
    }

    const socket = createConnection({
      host: "127.0.0.1",
      port: address.port,
    });
    sockets.push(socket);
    socket.setNoDelay(true);
    socket.on("error", () => {
      // An early EPIPE/ECONNRESET is an acceptable overflow outcome.
    });
    await once(socket, "connect");

    let response = "";
    let receivedHeaders = false;
    let resolveHeaders: (() => void) | undefined;
    const headersPromise = new Promise<void>((resolve) => {
      resolveHeaders = resolve;
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!receivedHeaders && response.includes("\r\n\r\n")) {
        receivedHeaders = true;
        resolveHeaders?.();
      }
    });
    const closedPromise = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });

    const requestHeaders = Buffer.from(
      [
        "POST / HTTP/1.1",
        `Host: 127.0.0.1:${address.port}`,
        "Content-Type: application/octet-stream",
        "Transfer-Encoding: chunked",
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n"),
    );
    // Cross the limit by one byte, then stop writing. Once a server deliberately
    // closes a rejected request, continuing to flood that socket can produce a
    // TCP reset that is allowed to discard an otherwise-correct HTTP response.
    const payload = Buffer.alloc(8 * 1024 + 1, 0x78);
    const frame = Buffer.concat([
      Buffer.from(`${payload.byteLength.toString(16)}\r\n`),
      payload,
      Buffer.from("\r\n"),
    ]);
    socket.write(Buffer.concat([requestHeaders, frame]));

    await withTimeout(
      headersPromise,
      "Oversized request did not receive a response",
    );
    expect(response).toMatch(/^HTTP\/1\.1 413 /);
    expect(response.toLowerCase()).toContain("connection: close");
    await withTimeout(
      closedPromise,
      "Oversized request connection remained open",
    );
    expect(socket.destroyed).toBe(true);
  });
});
