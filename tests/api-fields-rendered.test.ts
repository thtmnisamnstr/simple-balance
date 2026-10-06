import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";
import {
  bulkStageEditResultSchema,
  bulkTransactionEditResultSchema,
  bulkTransactionSelectionSnapshotSchema,
  payeeDuplicateGroupSchema,
  payeeMergeResultSchema,
  payeeSummarySchema,
} from "../src/shared/domain.js";
import { sourceFiles, type SourceFile } from "./support/source.js";

/**
 * `web.md` 11.9: a field the API sends is rendered, or its absence is argued.
 *
 * The rule is Binding and it was held by nothing. Three fields were being
 * dropped silently when it was last asked by hand, two of them on one path:
 * both merge results carry `mergedSource*` and the two updated counts, and
 * neither page's `onSuccess` took an argument — so merging nine spellings of a
 * payee reported nothing at all about what had moved.
 *
 * What this cannot do is decide whether a field is RENDERED; that needs a
 * reading of the page. What it can decide is whether the field is anywhere at
 * all. So the bar is the one the rule itself sets: a field the browser never
 * mentions is either a defect or a drop somebody argued, and the argument is a
 * comment naming the field. A comment is the register here, kept beside the
 * declaration rather than in a list — the same shape as a named exception, with
 * the entry where the next reader meets it.
 */
/**
 * Every field name any result publishes, at any depth.
 *
 * The two populations below are what `api.ts` declares and six shared shapes'
 * top-level keys, and both are the client's own account of what arrives. A
 * field the client never declared was therefore never asked about, and neither
 * was anything nested: a staged row's `committedTransactionId`, a bulk result's
 * per-row `previousVersion`, a commit's `committed[].stagedId`. So the
 * published result schemas are walked too. The two transports return the same
 * service objects — `mcp-output-schemas.ts` is their published shape — so this
 * is what the server says it sends, not what the browser expected to get.
 */
let published = new Map<string, string>();

beforeAll(async () => {
  const server = createMcpServer(
    { userId: "fields", source: "mcp", clientId: "fields" },
    new Set(["ledger:read", "ledger:stage", "ledger:write"]),
  );
  const client = new Client({ name: "fields", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  const found = new Map<string, string>();
  const walk = (node: unknown, tool: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((member) => walk(member, tool));
    const schema = node as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, unknown> | undefined;
    for (const [name, value] of Object.entries(properties ?? {})) {
      if (!found.has(name)) found.set(name, tool);
      walk(value, tool);
    }
    for (const key of ["items", "anyOf", "oneOf", "allOf", "additionalProperties"]) {
      walk(schema[key], tool);
    }
  };
  for (const tool of tools) walk(tool.outputSchema, tool.name);
  published = found;
});

describe("every field the API sends", () => {
  const files = sourceFiles("src/client");
  const api = files.find((file) => file.path === "src/client/api.ts");
  if (!api) throw new Error("src/client/api.ts has moved");

  /**
   * The body of every `type X = { … }` in `api.ts`, and the same text blanked
   * out of the file.
   *
   * Blanked because a declaration is not a use: leaving the bodies in would
   * make every field "mentioned in src/client" by virtue of being declared
   * there, which is the whole question. Replaced by spaces rather than cut, so
   * the two halves stay index-aligned with `text` and the comment scan below
   * reads the right characters.
   */
  const declaringTypes = () => {
    const declared = new Map<string, string>();
    let elsewhere = api.code;
    for (const hit of api.code.matchAll(/\btype\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g)) {
      const start = hit.index + hit[0].length;
      let depth = 1;
      let end = start;
      while (end < api.code.length && depth > 0) {
        const character = api.code[end]!;
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        end += 1;
      }
      const body = api.code.slice(start, end - 1);
      // A field is a name at the start of a line inside the body, which is what
      // the formatter guarantees: `oxfmt` puts one member per line, so a `:`
      // somewhere in the middle of a line belongs to a type expression rather
      // than to a member of this object.
      for (const field of body.matchAll(/(?:^|\n)\s*([A-Za-z_$][\w$]*)\??\s*:/g)) {
        if (!declared.has(field[1]!)) declared.set(field[1]!, hit[1]!);
      }
      elsewhere =
        elsewhere.slice(0, start) + " ".repeat(end - 1 - start) + elsewhere.slice(end - 1);
    }
    return { declared, elsewhere };
  };

  /**
   * The shapes `api.ts` re-exports rather than restates.
   *
   * These were outside the question entirely until this was written, and that
   * is where the payee half of the merge defect lived: `PayeeMergeResult` is
   * declared in `src/shared/domain.ts` and re-exported here, so a scan of
   * `api.ts` alone saw a line of `export type { … }` and no fields at all.
   * Read off the Zod shape rather than off the text, because the text is a
   * `z.infer` and says nothing.
   */
  const RE_EXPORTED: Record<string, { shape: Record<string, unknown> }> = {
    PayeeSummary: payeeSummarySchema,
    PayeeDuplicateGroup: payeeDuplicateGroupSchema,
    PayeeMergeResult: payeeMergeResultSchema,
    TransactionBulkSelectionPreview: bulkTransactionSelectionSnapshotSchema,
    TransactionBulkEditResult: bulkTransactionEditResultSchema,
    StagedBulkEditResult: bulkStageEditResultSchema,
  };

  /** Every comment in a file, as one string, with the code blanked out. */
  const commentsOf = (file: SourceFile) => {
    let out = "";
    for (let index = 0; index < file.text.length; index += 1) {
      // A comment is already blanked to spaces in `code` and left alone in
      // `text`, so a position where the two disagree is inside one.
      out += file.code[index] === " " && file.text[index] !== " " ? file.text[index] : " ";
    }
    return out;
  };

  const everything = () => {
    const { declared, elsewhere } = declaringTypes();
    for (const [name, schema] of Object.entries(RE_EXPORTED)) {
      for (const key of Object.keys(schema.shape)) if (!declared.has(key)) declared.set(key, name);
    }
    for (const [name, tool] of published) if (!declared.has(name)) declared.set(name, tool);

    const mentioned = new Set<string>();
    const argued = new Set<string>();
    for (const file of files) {
      const code = file.path === api.path ? elsewhere : file.code;
      for (const word of code.matchAll(/[A-Za-z_$][\w$]*/g)) mentioned.add(word[0]);
      for (const word of commentsOf(file).matchAll(/[A-Za-z_$][\w$]*/g)) argued.add(word[0]);
    }
    return { declared, mentioned, argued };
  };

  it("is read off a population that is really there", () => {
    const { declared, mentioned } = everything();
    // A reader that stopped matching would declare nothing and pass on
    // everything, which is how three checks in this repository passed forever.
    expect(declared.size).toBeGreaterThan(200);
    expect([...declared.keys()]).toContain("mergedSourcePayees");
    expect([...declared.keys()]).toContain("clientSecret");
    // Nested, and declared nowhere in the client: the published half reached it.
    expect(published.size).toBeGreaterThan(200);
    expect([...declared.keys()]).toContain("committedTransactionId");
    expect([...declared.keys()]).toContain("stagedId");
    expect(mentioned.size).toBeGreaterThan(1000);
    // And the blanking really blanked: a name that exists only as a field of an
    // `api.ts` type must not count as mentioned by its own declaration.
    expect(mentioned.has("passwordResetAvailable")).toBe(true);
  });

  it("is rendered somewhere, or named in a comment saying why not", () => {
    const { declared, mentioned, argued } = everything();
    const dropped = [...declared]
      .filter(([name]) => !mentioned.has(name) && !argued.has(name))
      .map(([name, type]) => `${type}.${name}`);
    expect(
      dropped,
      "render it, or write a comment naming the field and saying why the browser drops it",
    ).toEqual([]);
  });
});
