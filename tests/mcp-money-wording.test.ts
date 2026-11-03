import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { IN_SIMPLE_BALANCE } from "../src/server/learn/in-simple-balance.js";
import { createMcpServer } from "../src/server/mcp.js";

/**
 * `docs/standards/mcp.md` §Tool text records entries, and never moves money.
 *
 * Claude's connector review and OpenAI's app guidelines both refuse a server
 * that transfers money, and both scan tool text before a person reads it. A
 * sentence true of the books — "This moves money in the books" — reads alone as
 * a payment tool, so the text says "records" and "transactions", and the one
 * shape the phrase may take is the denial, "moves no real money".
 */
const FORBIDDEN: [RegExp, string][] = [
  [/\bpayments?\b/i, "an entry is a transaction, not a payment"],
  [
    /\b(?:move[sd]?|moving|puts?|putting|transfer(?:s|red|ring)?|send(?:s|ing)?|sent)\s+(?:real\s+)?money\b/i,
    "say it records an entry; the only shape this phrase takes is 'moves no real money'",
  ],
  [/\bdirectly commit\b/i, "say it records the entry in the person's ledger"],
];

const offences = (where: string, text: string) =>
  FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(
    ([pattern, fix]) => `${where}: ${pattern.exec(text)![0]} — ${fix}`,
  );

describe("the text an MCP client publishes", () => {
  let tools: { name: string }[];
  let instructions = "";

  beforeAll(async () => {
    const server = createMcpServer(
      { userId: "wording", source: "mcp", clientId: "wording" },
      new Set(["ledger:read", "ledger:stage", "ledger:write"]),
    );
    const client = new Client({ name: "wording", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools;
    instructions = client.getInstructions() ?? "";
    await client.close();
    await server.close();
  });

  it("describes bookkeeping, never a payment or money moving", () => {
    expect(tools.length).toBeGreaterThan(80);
    const found = tools.flatMap((tool) => offences(tool.name, JSON.stringify(tool)));
    expect(found).toEqual([]);
  });

  it("holds the server's instructions, which every connection reads, to the same words", () => {
    expect(instructions.length).toBeGreaterThan(500);
    expect(offences("instructions", instructions)).toEqual([]);
  });

  /**
   * What a tool says at run time is not in `tools/list`: a refusal, or the
   * forecast's reason a row cannot be projected, which once said "It moves money
   * between two currencies". Every string a service can hand an agent is read
   * here, as written. `billing.ts` is left out because billing is reachable from
   * a session and never from a token (`AGENTS.md`), and payments are its subject.
   */
  it("holds every string a service can hand an agent to the same words", () => {
    const directory = new URL("../src/server/services/", import.meta.url);
    const found = readdirSync(directory)
      .filter((file) => file.endsWith(".ts") && file !== "billing.ts")
      .flatMap((file) =>
        readFileSync(new URL(file, directory), "utf8")
          .split("\n")
          .map((line, index) => ({ line, at: `${file}:${index + 1}` }))
          .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .flatMap(({ line, at }) =>
            [...line.matchAll(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].flatMap((literal) =>
              offences(at, literal[0]),
            ),
          ),
      );
    expect(found).toEqual([]);
  });

  it("says so where a write could read otherwise", () => {
    for (const name of ["create_transaction", "archive_account", "commit_staged_transactions"]) {
      const tool = tools.find((one) => one.name === name) as { description?: string };
      expect(tool.description, name).toMatch(/move(?:s)? no real money/);
    }
  });

  it("holds the money guides' tool steps to the same words", () => {
    const found = Object.entries(IN_SIMPLE_BALANCE).flatMap(([slug, steps]) =>
      steps.flatMap((step) => offences(`${slug} / ${step.step}`, step.how)),
    );
    expect(found).toEqual([]);
  });
});
