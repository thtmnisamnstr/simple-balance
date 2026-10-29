import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  foldQuotes,
  PACK_FORMAT,
  parseCopy,
  productHeadings,
  sha256,
} from "../scripts/lib/learn-sync.mjs";
import { IN_SIMPLE_BALANCE } from "../src/server/learn/in-simple-balance.js";
import { LEARN_PACK, learnPackSchema } from "../src/server/learn/pack.js";
import { createMcpServer, TOOL_SCOPES } from "../src/server/mcp.js";
import { transactionDraftSchema, transactionTemplateDraftSchema } from "../src/shared/domain.js";

/**
 * The vendored guides, and the map from their steps to this server's tools.
 *
 * Two halves, owned by two repositories. The pack is the site's words and is
 * never edited here, so what can be held offline is that it is still the
 * site's words: each copy's bytes match the hash taken when it was synced, it
 * is flattened the way the site's own copy is, and it has the shape the site's
 * content standard requires. The map is this repository's, and it is held to
 * both the pack and the tool list, because each moves without the other: the
 * site renames a step, or a tool here is renamed, and the map is what goes
 * stale. Freshness against the live site is not here — it needs the network —
 * and is `scripts/sync-learn.mjs --check` in release-prep.
 */
const raw = JSON.parse(readFileSync("src/server/learn/learn-pack.json", "utf8")) as unknown;

describe("the vendored money guides", () => {
  it("parse as a pack of the one format this reads", () => {
    const pack = learnPackSchema.parse(raw);
    expect(pack.format).toBe(PACK_FORMAT);
    expect(pack.articles.length).toBeGreaterThan(0);
    expect(pack.source.license).toMatch(/^MIT License/);
  });

  it("are the copies they were synced as, byte for byte", () => {
    // A hand edit to a guide is the failure this catches. The words are the
    // site's: a correction belongs there, and reaches here at the next sync.
    for (const article of LEARN_PACK.articles) {
      expect(sha256(article.lines.join("\n")), article.slug).toBe(article.sha256);
    }
  });

  it("each live at the address their slug names, once, and say what their own header says", () => {
    const slugs = LEARN_PACK.articles.map((article) => article.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const article of LEARN_PACK.articles) {
      expect(article.url).toBe(`${LEARN_PACK.source.site}/learn/${article.slug}/`);
      // Every fact the tools serve beside the text is the text's own header,
      // read by the sync's one reader: a description or date edited by hand
      // keeps every hash valid, and is what list_learn_articles hands out.
      const { title, description, url, updated } = article;
      expect(
        parseCopy(article.lines.join("\n"), article.slug, LEARN_PACK.source.site),
        article.slug,
      ).toEqual({ title, description, url, updated });
    }
  });

  it("are flattened the way the site flattens them", () => {
    // A component left in a copy is a tag no agent can render, and a relative
    // link is one that leads nowhere outside the site. The site's own tests
    // refuse both in what it publishes; this refuses them in what was vendored.
    for (const article of LEARN_PACK.articles) {
      let fenced = false;
      for (const line of article.lines) {
        if (/^(```|~~~)/.test(line)) fenced = !fenced;
        if (fenced) continue;
        expect(line, article.slug).not.toMatch(/<[A-Z]/);
        expect(line, article.slug).not.toMatch(/\]\(\//);
      }
    }
  });

  it("each explain, then show how, then show it here, then cite their sources", () => {
    for (const article of LEARN_PACK.articles) {
      const headings = article.lines.filter((line) => line.startsWith("## "));
      const product = headings.indexOf("## How to do it in Simple Balance");
      expect(
        headings.some((heading) => heading.startsWith("## Why")),
        article.slug,
      ).toBe(true);
      expect(
        headings.slice(0, product).some((heading) => heading.startsWith("## How")),
        article.slug,
      ).toBe(true);
      expect(product, article.slug).toBeGreaterThan(0);
      expect(headings.at(-1), article.slug).toBe("## Sources");
    }
  });

  it("record the steps their own text has", () => {
    // `steps` is what the server maps, so it has to be the text's and not a
    // stale copy of it: the one heading reader is the sync's.
    for (const article of LEARN_PACK.articles) {
      expect(article.steps, article.slug).toEqual(productHeadings(article.lines.join("\n")));
      expect(article.steps.length, article.slug).toBeGreaterThan(0);
    }
  });
});

/** Every property name and enum value a JSON Schema publishes, at any depth. */
function vocabulary(schema: unknown, into: Set<string>) {
  if (!schema || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  for (const name of Object.keys((node["properties"] as object) ?? {})) into.add(name);
  for (const value of (node["enum"] as unknown[]) ?? []) into.add(String(value));
  if ("const" in node) into.add(String(node["const"]));
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) for (const item of child) vocabulary(item, into);
    else vocabulary(child, into);
  }
}

/** Every property name a JSON Schema declares, at any depth, and no enum value. */
function propertyNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== "object") return into;
  const node = schema as Record<string, unknown>;
  for (const name of Object.keys((node["properties"] as object) ?? {})) into.add(name);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) for (const item of child) propertyNames(item, into);
    else propertyNames(child, into);
  }
  return into;
}

/** Every object schema, at any depth, whose `type` property is the one literal `type`. */
function variantsOf(schema: unknown, type: string, into: Record<string, unknown>[] = []) {
  if (!schema || typeof schema !== "object") return into;
  const node = schema as Record<string, unknown>;
  const discriminator = (node["properties"] as Record<string, Record<string, unknown>> | undefined)
    ?.type;
  if (discriminator?.const === type || (discriminator?.enum as unknown[])?.join() === type) {
    into.push(node);
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) for (const item of child) variantsOf(item, type, into);
    else variantsOf(child, type, into);
  }
  return into;
}

const backticked = (how: string) => new Set([...how.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));

describe("the map from each guide's steps to the tools that do them", () => {
  let published: Map<string, Set<string>>;
  let schemas: Map<string, { input: unknown; output: unknown }>;

  beforeAll(async () => {
    const server = createMcpServer(
      { userId: "learn-map", source: "mcp", clientId: "learn-map" },
      new Set(["ledger:read", "ledger:stage", "ledger:write"]),
    );
    const client = new Client({ name: "learn-map", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    published = new Map(
      tools.map((tool) => {
        const words = new Set<string>();
        vocabulary(tool.inputSchema, words);
        vocabulary(tool.outputSchema, words);
        return [tool.name, words];
      }),
    );
    schemas = new Map(
      tools.map((tool) => [tool.name, { input: tool.inputSchema, output: tool.outputSchema }]),
    );
  });

  it("covers every guide in the pack and no other", () => {
    expect(Object.keys(IN_SIMPLE_BALANCE).sort()).toEqual(
      LEARN_PACK.articles.map((article) => article.slug).sort(),
    );
  });

  it("maps every Simple Balance step a guide has, in its order, and nothing else", () => {
    for (const article of LEARN_PACK.articles) {
      expect(
        (IN_SIMPLE_BALANCE[article.slug] ?? []).map((one) => foldQuotes(one.step)),
        `${article.slug}: edit in-simple-balance.ts to the guide's steps`,
      ).toEqual(article.steps.map(foldQuotes));
    }
  });

  it("names only tools the server has, each where the scope map files it", () => {
    for (const [slug, steps] of Object.entries(IN_SIMPLE_BALANCE)) {
      for (const { step, tools } of steps) {
        expect(tools.length, `${slug}: ${step}`).toBeGreaterThan(0);
        for (const tool of tools) {
          expect(TOOL_SCOPES.has(tool), `${slug}: ${step} names ${tool}`).toBe(true);
          expect(published.has(tool), `${slug}: ${step} names ${tool}`).toBe(true);
        }
      }
    }
  });

  /**
   * A backticked word is an identifier an agent will send, so it has to be one
   * the step's own tools publish: a tool's name, or a field or enum value of
   * one of them. Prose stays prose — "Amount owed" is the browser's label, and
   * is left bare on purpose — and a quoted literal such as "-500" is a value,
   * not a name.
   */
  it("backticks only names the step's own tools publish", () => {
    const unknown: string[] = [];
    let checked = 0;
    for (const [slug, steps] of Object.entries(IN_SIMPLE_BALANCE)) {
      for (const { step, tools, how } of steps) {
        const allowed = new Set<string>(tools);
        for (const tool of tools) for (const word of published.get(tool) ?? []) allowed.add(word);
        for (const match of how.matchAll(/`([^`]+)`/g)) {
          checked += 1;
          if (!allowed.has(match[1]!)) unknown.push(`${slug}: ${step}: \`${match[1]}\``);
        }
      }
    }
    expect(unknown).toEqual([]);
    expect(checked).toBeGreaterThan(60);
  });

  /**
   * `update_account`'s one figure is the opening balance, which is posted on
   * the opening date: a new value there restates every balance since. Listed
   * with no field named, the field an agent reaches for to "update the value"
   * is that one, which rewrites the whole net-worth trend. So a step that lists
   * it says which field to change, and never the two that move history.
   */
  it("lists update_account only beside a field that leaves the account's history alone", () => {
    const fields = propertyNames(
      (schemas.get("update_account")!.input as { properties: { input: unknown } }).properties.input,
    );
    expect([...fields]).toEqual(expect.arrayContaining(["openingBalance", "openingDate"]));
    let listed = 0;
    for (const [slug, steps] of Object.entries(IN_SIMPLE_BALANCE)) {
      for (const { step, tools, how } of steps) {
        if (!tools.includes("update_account")) continue;
        listed += 1;
        const named = [...backticked(how)].filter((word) => fields.has(word));
        expect(named, `${slug}: ${step} names no field for update_account`).not.toEqual([]);
        expect(named, `${slug}: ${step}`).not.toContain("openingBalance");
        expect(named, `${slug}: ${step}`).not.toContain("openingDate");
      }
    }
    expect(listed).toBeGreaterThan(0);
  });

  /**
   * A template may leave the date out and an entry may not, so "copy its
   * draft" is refused at input validation unless the step says to add one. The
   * premise is checked first, so this goes quiet only if a template starts
   * carrying a date it must have, not because the schemas drifted apart.
   */
  it("names the date a template leaves out wherever a step makes an entry from one", () => {
    const account = "00000000-0000-4000-8000-000000000001";
    const template = transactionTemplateDraftSchema.parse({
      type: "withdrawal",
      fromAccountId: account,
      payee: "Cash",
    });
    const copied = { ...template, amount: "5" };
    expect(
      transactionDraftSchema.safeParse(copied).error?.issues.map((issue) => issue.path.join(".")),
    ).toEqual(["date"]);
    expect(transactionDraftSchema.safeParse({ ...copied, date: "2026-01-02" }).success).toBe(true);
    let using = 0;
    for (const [slug, steps] of Object.entries(IN_SIMPLE_BALANCE)) {
      for (const { step, tools, how } of steps) {
        const words = backticked(how);
        if (!words.has("templateId") || !tools.includes("create_transaction")) continue;
        using += 1;
        expect(words.has("date"), `${slug}: ${step}`).toBe(true);
      }
    }
    expect(using).toBeGreaterThan(0);
  });

  /**
   * A transfer's figure is `sourceAmount` on an entry and `amount` on a
   * recurrence, so a step that spells a transfer out field by field names the
   * one each of its tools takes. "A recurrence of the same shape" was refused
   * on both counts.
   */
  it("names the figure's field wherever it spells out a transfer, on each tool it sends one to", () => {
    const figure = (tool: string) => {
      const [variant, ...more] = variantsOf(schemas.get(tool)!.input, "transfer");
      expect(more, tool).toEqual([]);
      const properties = Object.keys((variant!["properties"] as object) ?? {});
      return ["sourceAmount", "amount"].filter((field) => properties.includes(field));
    };
    const fields = new Map([
      ["create_transaction", figure("create_transaction")],
      ["create_recurrence", figure("create_recurrence")],
    ]);
    expect(Object.fromEntries(fields)).toEqual({
      create_transaction: ["sourceAmount"],
      create_recurrence: ["amount"],
    });
    let spelled = 0;
    for (const [slug, steps] of Object.entries(IN_SIMPLE_BALANCE)) {
      for (const { step, tools, how } of steps) {
        if (!how.includes("`type` transfer")) continue;
        for (const tool of tools.filter((name) => fields.has(name))) {
          spelled += 1;
          expect(backticked(how).has(fields.get(tool)![0]!), `${slug}: ${step}: ${tool}`).toBe(
            true,
          );
        }
      }
    }
    expect(spelled).toBeGreaterThanOrEqual(3);
  });

  /**
   * A step that asks for something to be dropped lists the tool that drops it,
   * and a removal that takes an expected version lists a read that returns one.
   * `held` answers per listed tool, so an unlisted one is a step a staging agent
   * cannot tell it may do, and "go back to the usual amount" a session later
   * has no other way to the entry's version.
   */
  it("lists the tool for every removal it asks for, and the read that finds what it removes", () => {
    let removals = 0;
    for (const [slug, steps] of Object.entries(IN_SIMPLE_BALANCE)) {
      for (const { step, tools, how } of steps) {
        const deletes = tools.filter((tool) => tool.startsWith("delete_"));
        if (/\b(drop|delete|remove)\b/i.test(how)) {
          expect(
            deletes,
            `${slug}: ${step} asks for a removal and lists no tool for it`,
          ).not.toEqual([]);
        }
        for (const tool of deletes) {
          removals += 1;
          const takes = propertyNames(schemas.get(tool)!.input);
          if (!takes.has("expectedVersion") && !takes.has("expectedVersions")) continue;
          expect(
            tools.some(
              (read) =>
                read.startsWith("list_") && propertyNames(schemas.get(read)!.output).has("version"),
            ),
            `${slug}: ${step}: ${tool} needs a version no listed read returns`,
          ).toBe(true);
        }
      }
    }
    expect(removals).toBeGreaterThanOrEqual(2);
  });

  /**
   * The guides are the site's words and never edited here, so a page the
   * browser now calls something else keeps its old label in a guide until the
   * site is fixed and synced. Meanwhile the step's `how` says what the page is
   * called, in one fixed sentence, so an agent passing the guide on sends
   * nobody looking for a page the navigation does not have. Both ways: the
   * sentence goes when the guide stops using the old label, rather than
   * outliving it.
   */
  it("says what a page is called now wherever a guide names it by a label the navigation lost", () => {
    const navigation = new Set(
      [
        ...readFileSync("src/client/App.tsx", "utf8").matchAll(/\{ to: "[^"]*", label: "([^"]+)"/g),
      ].map((match) => match[1]!),
    );
    expect([...navigation]).toEqual(expect.arrayContaining(["Accounts", "Import and export"]));
    const note = /The page the guide calls (.+?) is (.+?) now\./g;
    let pages = 0;
    for (const article of LEARN_PACK.articles) {
      const text = new Map<string, string[]>();
      let inside = false;
      let current: string[] | undefined;
      for (const line of article.lines) {
        if (line.startsWith("## ")) inside = line === "## How to do it in Simple Balance";
        else if (inside && line.startsWith("### ")) {
          current = [];
          text.set(foldQuotes(line.slice(4).trim()), current);
        } else if (inside) current?.push(line);
      }
      for (const { step, how } of IN_SIMPLE_BALANCE[article.slug] ?? []) {
        const body = (text.get(foldQuotes(step)) ?? []).join("\n");
        const named = new Set(
          [
            ...body.matchAll(/\[\*\*([A-Z][^*]*)\*\*\]\(https:\/\/smpl\.money\/docs\//g),
            ...body.matchAll(/\b[Oo]pen \[?\*\*([A-Z][^*]*)\*\*/g),
          ].map((match) => match[1]!),
        );
        pages += named.size;
        const stale = [...named].filter((label) => !navigation.has(label)).sort();
        const notes = [...how.matchAll(note)];
        expect(
          notes.map((match) => match[1]).sort(),
          `${article.slug}: ${step}: say what each stale label is now, and only those`,
        ).toEqual(stale);
        for (const match of notes) expect(navigation.has(match[2]!), match[0]).toBe(true);
      }
    }
    expect(pages).toBeGreaterThan(20);
  });
});
