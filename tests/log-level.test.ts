import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `LOG_LEVEL`, which for a long time governed somebody else's logging.
 *
 * It was passed to Better Auth's logger and to nothing else, so a deployment
 * that asked for `error` still got this product's startup banner, its mail
 * notice and its scheduler warnings. That is worse than having no setting: the
 * log looks like the answer to a question the operator did asked, and is not.
 *
 * Two halves, and the second is the one that rots. The gate itself is simple
 * enough to check in four assertions; keeping every call site behind it is a
 * property of thirty-odd files that a person cannot re-check on every change.
 */
const environment = { ...process.env };

afterEach(() => {
  process.env = { ...environment };
  vi.resetModules();
  vi.restoreAllMocks();
});

/** The logger, rebuilt against the environment this test just set. */
async function freshLog() {
  vi.resetModules();
  const module = await import("../src/server/log.js");
  module.resetLogLevel();
  return module.log;
}

describe("the log level", () => {
  it("keeps everything at debug", async () => {
    process.env.LOG_LEVEL = "debug";
    const log = await freshLog();
    const spies = {
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(spies.debug).toHaveBeenCalledOnce();
    expect(spies.info).toHaveBeenCalledOnce();
    expect(spies.warn).toHaveBeenCalledOnce();
    expect(spies.error).toHaveBeenCalledOnce();
  });

  it("drops what sits below the level asked for", async () => {
    process.env.LOG_LEVEL = "warn";
    const log = await freshLog();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.info("the startup banner");
    log.warn("something worth knowing");
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("never silences an error", async () => {
    process.env.LOG_LEVEL = "error";
    const log = await freshLog();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("what went wrong");
    // The quietest setting there is. A level that could silence this would be a
    // setting an operator uses once and then cannot diagnose anything with.
    expect(error).toHaveBeenCalledOnce();
  });

  it("says something rather than nothing when configuration cannot be read", async () => {
    process.env.LOG_LEVEL = "not-a-level";
    const log = await freshLog();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // This is the path a startup failure takes: `getConfig()` throws, and the
    // line reporting that has to come out anyway or the container exits in
    // silence.
    log.error("configuration is wrong");
    expect(error).toHaveBeenCalledOnce();
  });
});

describe("the line that is not a level", () => {
  it("prints at the quietest setting there is", async () => {
    process.env.LOG_LEVEL = "error";
    const log = await freshLog();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    log.announce("First-run setup code: abc");
    // The defect this exists against: `LOG_LEVEL=warn` on a fresh production
    // instance printed nothing at all, and the setup code is the only way to
    // claim one. A supported setting made the deployment unclaimable.
    expect(info).toHaveBeenCalledOnce();
  });

  /**
   * Two call sites, and the list is the point.
   *
   * `announce` is not a level and must not become the one everything is written
   * at. It is for a line that is the product's only channel for something the
   * operator has to have; a third call site is a decision somebody should have
   * to make in a diff.
   */
  it("is used only where nothing else can carry the message", () => {
    const sites = sourceFiles("src/server").flatMap((file) =>
      file.code
        .split("\n")
        .flatMap((line, index) =>
          /\blog\.announce\(/.test(line) ? [`${file.path}:${index + 1}`] : [],
        ),
    );
    expect(sites.map((site) => site.split(":")[0])).toEqual([
      "src/server/index.ts",
      "src/server/index.ts",
    ]);
  });
});

describe("every line this product writes", () => {
  /**
   * The configuration layer keeps `console` on purpose.
   *
   * A warning about configuration cannot be gated by a configuration value: the
   * gate reads `getConfig()`, and these three warn from inside it. Routing them
   * through the logger would be a re-entrant call during the first read, which
   * is a stack overflow rather than a quiet line.
   */
  const CONFIGURATION_LAYER = [
    "src/server/config.ts",
    "src/server/config-files.ts",
    "src/server/config-limits.ts",
    "src/server/log.ts",
  ];

  /**
   * The name, not the call.
   *
   * This looked for `console.info(` and found nothing, while two modules took
   * `logger = console` as a default parameter and logged through it —
   * `server-lifecycle.ts` printed "SIGTERM received, shutting down" at every
   * level including the one an operator chose to silence it with, and the
   * recurrence scheduler reported its failures the same way. A default is a
   * call site one hop away, and the hop was enough to hide it.
   *
   * So the rule is the identifier: nothing outside the configuration layer
   * names `console` in code at all. Handing it to something else is the shape
   * that was missed and is exactly as much of a bypass as calling it.
   */
  it("goes through the level gate, except in the configuration layer", () => {
    const direct: string[] = [];
    for (const file of sourceFiles("src/server")) {
      if (CONFIGURATION_LAYER.includes(file.path)) continue;
      // Comments blanked, because several of them discuss what is logged and a
      // grep that read those would report files that log nothing at all.
      for (const [index, line] of file.code.split("\n").entries()) {
        if (/\bconsole\b/.test(line)) {
          direct.push(`${file.path}:${index + 1}`);
        }
      }
    }
    expect(
      direct,
      "Use `log` from src/server/log.ts so LOG_LEVEL means something — including as a " +
        "default parameter — or add the file to CONFIGURATION_LAYER with the reason it cannot.",
    ).toEqual([]);
  });

  /**
   * A failure that disappears, told apart from one somebody decided about.
   *
   * Everything this product degrades rather than fails on logs and carries on —
   * a relay that refuses at startup, a reminder sweep that throws, a tick that
   * throws. The failure mode on the other side of that is a `catch` with
   * nothing in it, which produces a deployment quietly doing half its job: the
   * exact thing the degradation was designed to avoid.
   *
   * A comment is the whole requirement. This cannot tell a good reason from a
   * bad one and does not try; it tells a decision from an oversight, which is
   * what is missing when a failure vanishes.
   */
  it("says why, wherever it catches something and does nothing", () => {
    const silent: string[] = [];
    let empty = 0;
    for (const file of sourceFiles("src/server")) {
      // Read as written, not with comments blanked: the comment is the thing
      // being looked for. A body with braces in it is not empty and is not
      // matched, which is the direction that cannot produce a false failure.
      for (const match of file.text.matchAll(/catch\s*(?:\([^)]*\)\s*)?\{([^{}]*)\}/g)) {
        const body = match[1]!;
        if (body.replaceAll(/\/\/[^\n]*/g, "").trim() !== "") continue;
        empty += 1;
        if (!body.includes("//")) {
          silent.push(`${file.path}:${file.text.slice(0, match.index).split("\n").length}`);
        }
      }
    }
    expect(silent, "say why nothing went wrong, or handle it").toEqual([]);
    // Guards the reading. A regex that stopped matching would leave this
    // passing on a codebase full of silent catches.
    expect(empty).toBeGreaterThanOrEqual(2);
  });

  it("keeps the configuration layer's exception real", () => {
    // An exception list that has quietly become unnecessary proves nothing, so
    // each name has to still be doing the thing it is excused for.
    const logging = sourceFiles("src/server").filter(
      (file) =>
        CONFIGURATION_LAYER.includes(file.path) &&
        // `log.ts` is on the list because it is the gate, not because it is
        // excused from it: every `console` call in it is the one doing the
        // writing.
        file.path !== "src/server/log.ts" &&
        /\bconsole\.(warn|error|info)\(/.test(file.code),
    );
    expect(logging.map((file) => file.path)).toEqual([
      "src/server/config-files.ts",
      "src/server/config-limits.ts",
      "src/server/config.ts",
    ]);
  });
});

/**
 * What a running deployment leaves behind, at the level it was asked for.
 *
 * Before this the product logged its startup, its mail and its failures, and
 * said nothing at all about the work it was doing: a request, an agent's tool
 * call and a scheduler tick were counted in `/metrics` and nowhere else, and
 * `/metrics` is off unless a deployment asks for it. An operator with the
 * default settings could not answer "is anything reaching this" from the log.
 *
 * `debug` for the ordinary ones, and the assertions below are as much about
 * what is *not* said at `info`: an access line per request is a diagnosis tool,
 * not something to write to somebody's disk at the default level.
 */
describe("what the work leaves in the log", () => {
  const environment = { ...process.env };

  afterEach(() => {
    process.env = { ...environment };
    vi.resetModules();
  });

  /** The API app and the logger, both rebuilt against this environment. */
  async function freshApi(level: string) {
    process.env.LOG_LEVEL = level;
    vi.resetModules();
    const logging = await import("../src/server/log.js");
    logging.resetLogLevel();
    const api = (await import("../src/server/api.js")).default;
    return api;
  }

  it("names the method, the path, the status and how long it took", async () => {
    const api = await freshApi("debug");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    await api.request("http://localhost/health/live");

    const said = debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(said).toMatch(/GET \/health\/live 200 in \d+ms/);
  });

  it("writes the id in the path, which a metric label may not carry", async () => {
    const api = await freshApi("debug");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const id = "11111111-2222-3333-4444-555555555555";

    await api.request(`http://localhost/api/v1/accounts/${id}`);

    // The deliberate difference from `tests/metrics.test.ts`, which asserts the
    // same id is *absent* from the metric. A label costs a time series per
    // account and has to stay bounded; a line costs a line, and without the id
    // the log says only that a request happened somewhere.
    expect(debug.mock.calls.map((call) => String(call[0])).join("\n")).toContain(id);
  });

  it("keeps the query string out of it, because filters carry somebody's ledger", async () => {
    const api = await freshApi("debug");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    await api.request("http://localhost/api/v1/transactions?search=divorce%20lawyer");

    const said = debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(said).toContain("/api/v1/transactions");
    expect(said).not.toContain("divorce");
  });

  it("names the tool an agent called, its outcome and never its arguments", async () => {
    process.env.LOG_LEVEL = "debug";
    vi.resetModules();
    const logging = await import("../src/server/log.js");
    logging.resetLogLevel();
    const { createMcpServer } = await import("../src/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    const server = createMcpServer(
      { userId: "log-agent", source: "mcp", clientId: "log-test" },
      new Set(["ledger:read"]),
    );
    const client = new Client({ name: "logging", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      // No database in this tier, so the call is refused rather than served.
      // That is the useful half: the line has to be written from the `finally`,
      // or a failing agent session is the one that leaves no trace.
      await client.callTool({
        name: "list_transactions",
        arguments: { payee: "Dr Renfrew, psychiatrist" },
      });
    } finally {
      await client.close();
      await server.close();
    }

    const said = debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(said).toMatch(/MCP tool list_transactions (ok|error) in \d+ms/);
    // The arguments are somebody's ledger. A payee, an amount or a note in a
    // debug log is the ledger written down somewhere nobody agreed to.
    expect(said).not.toContain("Renfrew");
  });

  /**
   * The bound parameters, which are the reason `log.failure` exists.
   *
   * Drizzle builds an error's message out of the failing statement and the
   * values bound into it. One of those values is the OAuth access token the MCP
   * token endpoint looks a grant up by; the rest are somebody's payees and
   * amounts. The HTTP transport had narrowed this for a release and the MCP
   * transport had not, so an agent's failing call wrote whole what a browser's
   * failing call did not.
   */
  it("logs the statement that failed and never the values bound into it", async () => {
    process.env.LOG_LEVEL = "error";
    vi.resetModules();
    const logging = await import("../src/server/log.js");
    logging.resetLogLevel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const failure = Object.assign(new Error("insert failed"), {
      query: "insert into ledger_transaction (payee) values ($1)",
      params: ["Dr Renfrew, psychiatrist"],
    });
    logging.log.failure("Request failed", failure);

    // Serialised rather than stringified: `String(error)` is "Error: insert
    // failed" whichever way this went, so an assertion on that would pass on
    // the error object being handed over whole — the exact thing being
    // refused. JSON reaches the own properties Drizzle attaches.
    const said = JSON.stringify(error.mock.calls);
    expect(said).toContain("insert into ledger_transaction");
    expect(said).not.toContain("Renfrew");
  });

  it("says nothing about an ordinary request at the default level", async () => {
    const api = await freshApi("info");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await api.request("http://localhost/health/live");

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
