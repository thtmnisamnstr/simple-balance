import { describe, expect, it } from "vitest";
import { MAX_BULK_SELECTION_ENTRIES } from "../src/shared/domain.js";
import {
  LEDGER_FILE_PART_MAX_BYTES,
  ledgerFileRecordCount,
  ledgerFileRowCount,
  parseLedgerFile,
  serializeLedgerFile,
  splitLedgerFile,
  utf8Length,
  type LedgerFile,
  type LedgerFilePartLimits,
} from "../src/shared/ledger-file.js";
import { previewLedgerFile } from "../src/server/services/ledger-file.js";
import { origin, wholeLedger } from "./support/ledger-file.js";

/**
 * `splitLedgerFile`'s invariants, each of which an import in parts depends on.
 *
 * One import is at most ten thousand rows, so a larger ledger arrives in parts,
 * each applied on its own and atomically. That only works if every part can
 * stand alone — every record in each, so any part can be applied first, and
 * after a browser closed halfway — and if the balance checks arrive with the
 * part after which they are true. Each of those is held below rather than
 * trusted, because a splitter that broke one would still hand back parts that
 * parse.
 */

function read(value: unknown): LedgerFile {
  const parsed = parseLedgerFile(value);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues, null, 2));
  return parsed.file;
}

/**
 * The whole-ledger fixture grown to `count` entries spread over many days,
 * with payees long enough, and in enough scripts, that the byte cap and the
 * UTF-8 count are exercised rather than the row cap alone.
 */
function grown(count: number, staged = 2): LedgerFile {
  const file = wholeLedger();
  const payees = ["Rewe", "Bäckerei Müller", "東京ストア", "Café 🥐 du Coin"];
  file.entries = Array.from({ length: count }, (_, n) => ({
    id: origin(10_000 + ((n * 7919) % count)),
    type: "withdrawal",
    date: `2026-${String((n % 9) + 1).padStart(2, "0")}-${String((n % 27) + 1).padStart(2, "0")}`,
    from: "Checking",
    amount: `${n + 1}.25`,
    payee: payees[n % payees.length],
    category: "Groceries",
    ...(n % 5 === 0 ? { notes: "x".repeat(200) } : {}),
  }));
  file.staged = Array.from({ length: staged }, (_, n) => ({
    id: origin(900_000 + n),
    draft: { type: "withdrawal", date: "2026-10-20", payee: `Staged ${n}`, amount: "1.00" },
    rawData: { line: String(n) },
  }));
  return read(file);
}

function split(file: LedgerFile, limits: LedgerFilePartLimits): LedgerFile[] {
  const result = splitLedgerFile(file, limits);
  if (!result.ok) throw new Error(result.message);
  return result.parts;
}

/** Everything every part carries whole, with the balance checks taken out. */
function records(file: LedgerFile) {
  return {
    format: file.format,
    exportedAt: file.exportedAt,
    throughDate: file.throughDate,
    producer: file.producer,
    scope: file.scope,
    preferences: file.preferences,
    groups: file.groups,
    categories: file.categories,
    accounts: file.accounts.map((account) => {
      if (account.detail !== "full") return account;
      const { balance: _balance, ...rest } = account;
      return rest;
    }),
    templates: file.templates,
    recurrences: file.recurrences,
    plans: file.budgets.plans,
  };
}

describe("splitting a ledger file", () => {
  const file = grown(57, 6);
  const limits = { maxRows: 10, maxBytes: LEDGER_FILE_PART_MAX_BYTES };
  const parts = split(file, limits);

  it("cuts parts of at most the row cap, and no more parts than that needs", () => {
    expect(ledgerFileRowCount(file)).toBe(57 + 6 + 1);
    expect(parts).toHaveLength(Math.ceil(64 / 10));
    for (const part of parts) expect(ledgerFileRowCount(part)).toBeLessThanOrEqual(10);
  });

  it("makes every part a file in its own right", () => {
    for (const part of parts) expect(parseLedgerFile(part).ok).toBe(true);
  });

  it("carries every record in every part", () => {
    for (const part of parts) expect(records(part)).toEqual(records(file));
  });

  it("keeps the entries in date order across the parts, each exactly once", () => {
    const entries = parts.flatMap((part) => part.entries);
    expect(entries).toEqual(file.entries);
    const dates = entries.map((entry) => entry.date);
    expect(dates).toEqual([...dates].sort());
  });

  it("puts budget amounts and staged rows after every entry", () => {
    const lastWithEntries = parts.map((part) => part.entries.length > 0).lastIndexOf(true);
    const firstWithTail = parts.findIndex(
      (part) => part.staged.length > 0 || part.budgets.entries.length > 0,
    );
    expect(firstWithTail).toBeGreaterThanOrEqual(lastWithEntries);
    expect(parts.flatMap((part) => part.staged)).toEqual(file.staged);
    expect(parts.flatMap((part) => part.budgets.entries)).toEqual(file.budgets.entries);
    expect(parts.at(-1)!.staged.length).toBeGreaterThan(0);
  });

  /**
   * A balance as of the file's last day is only true once every entry before
   * it is in, so it travels with the part that is applied last. An earlier
   * part carrying one would be refused by its own import for money the next
   * part has not brought yet.
   */
  it("carries the balance checks in the last part and only there", () => {
    const balances = (part: LedgerFile) =>
      part.accounts.flatMap((account) =>
        account.detail === "full" && account.balance !== undefined ? [account.balance] : [],
      );
    expect(balances(parts.at(-1)!)).toEqual(balances(file));
    expect(balances(file)).toHaveLength(3);
    for (const part of parts.slice(0, -1)) expect(balances(part)).toEqual([]);
  });

  it("leaves the activity history out of every part, because no import reads it", () => {
    expect(file.history).toHaveLength(1);
    for (const part of parts) expect(part.history).toBeUndefined();
  });

  it("changes nothing about the file it was given", () => {
    const before = serializeLedgerFile(file);
    split(file, limits);
    expect(serializeLedgerFile(file)).toBe(before);
  });
});

describe("the byte cap", () => {
  /**
   * Bytes on the wire, not characters: a payee in Japanese is three bytes a
   * character and an emoji four, and a server's body limit counts bytes. A
   * cap enforced in characters would pass parts the server then refuses.
   */
  it("holds every part to the limit in UTF-8 bytes as written", () => {
    const file = grown(400);
    const whole = utf8Length(serializeLedgerFile(file));
    const maxBytes = Math.floor(whole / 5);
    const parts = split(file, { maxRows: MAX_BULK_SELECTION_ENTRIES, maxBytes });
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) {
      const written = new TextEncoder().encode(serializeLedgerFile(part)).length;
      expect(written).toBeLessThanOrEqual(maxBytes);
    }
    expect(parts.flatMap((part) => part.entries)).toEqual(file.entries);
  });

  it("counts UTF-8 the way an encoder does, surrogate pairs included", () => {
    for (const text of [
      "",
      "plain",
      "Bäckerei",
      "東京ストア",
      "Café 🥐 du Coin",
      "🏦💶\u{10FFFF}",
    ]) {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  it("refuses a file whose records alone outgrow a part", () => {
    const result = splitLedgerFile(grown(3), { maxRows: 10, maxBytes: 2_000 });
    expect(result).toEqual({
      ok: false,
      message:
        "This file's accounts, categories, templates and other records are larger on their own than one part of an import may be, so it cannot be sent in parts.",
    });
  });

  /**
   * Records are bounded on their own at the row cap's number, because every
   * part carries every one of them: no row cut brings a part under it, so the
   * file is refused up front rather than cut into parts the server refuses.
   */
  it("refuses a file with more records than one part may carry", () => {
    const file = grown(3);
    expect(ledgerFileRecordCount(file)).toBe(1 + 4 + 3 + 2 + 2 + 2);
    expect(
      splitLedgerFile(file, {
        maxRows: 10,
        maxBytes: LEDGER_FILE_PART_MAX_BYTES,
        maxRecords: ledgerFileRecordCount(file),
      }).ok,
    ).toBe(true);
    expect(
      splitLedgerFile(file, {
        maxRows: 10,
        maxBytes: LEDGER_FILE_PART_MAX_BYTES,
        maxRecords: ledgerFileRecordCount(file) - 1,
      }),
    ).toEqual({
      ok: false,
      message:
        "This file holds 14 accounts, categories, groups, templates, recurring transactions and budgets, and one part of an import holds at most 13. Every part carries all of them, so it cannot be sent in parts.",
    });
  });

  it("refuses a single row larger than a part, and names it", () => {
    const file = grown(3);
    const room = utf8Length(serializeLedgerFile({ ...file, entries: [], staged: [] })) + 600;
    const huge = { ...file.entries[1]!, notes: "y".repeat(4_000) };
    const result = splitLedgerFile(
      { ...file, entries: [file.entries[0]!, huge, file.entries[2]!] },
      { maxRows: 10, maxBytes: room },
    );
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^The entry dated \d{4}-\d{2}-\d{2} with .+ is larger than/),
    });
  });
});

describe("the default limits", () => {
  it("are the bulk cap and the part byte limit", () => {
    const parts = split(grown(MAX_BULK_SELECTION_ENTRIES + 1, 0), {
      maxRows: MAX_BULK_SELECTION_ENTRIES,
      maxBytes: LEDGER_FILE_PART_MAX_BYTES,
    });
    const defaults = splitLedgerFile(grown(MAX_BULK_SELECTION_ENTRIES + 1, 0));
    expect(defaults.ok && defaults.parts.map(ledgerFileRowCount)).toEqual(
      parts.map(ledgerFileRowCount),
    );
    expect(parts.map(ledgerFileRowCount)).toEqual([MAX_BULK_SELECTION_ENTRIES, 2]);
  });

  /**
   * The browser's download allows ten times the cap, and the import page cuts
   * it before sending it. An agent handed that file has no page and, connected
   * to another copy, no way to export the source again a range at a time, so
   * the refusal is the only place it can learn how to cut it. It states the
   * rules this file holds the splitter to, one for one, so a part an agent cuts
   * by them is a part the import takes.
   */
  it("tell an agent handed a file over them how to cut it the way the splitter does", async () => {
    const whole = serializeLedgerFile(grown(MAX_BULK_SELECTION_ENTRIES + 1, 0));
    const refusal = await previewLedgerFile(
      { userId: "ledger-file-split", source: "mcp", clientId: "split" },
      { ledgerFile: whole },
    ).then(
      () => undefined,
      (error: unknown) => error as { code?: string; message?: string },
    );
    expect(refusal?.code).toBe("VALIDATION_ERROR");
    for (const rule of [
      "every part carries every record section whole",
      "the entries go across the parts in date order",
      "with budgets.entries and then staged after them",
      "history goes in no part",
      "only the last part keeps each account's balance",
      "the same decisions, its own idempotencyKey, and part saying which it is",
    ]) {
      expect(refusal?.message).toContain(rule);
    }
  });

  it("leave a ledger that fits as one part, history aside", () => {
    const file = read(wholeLedger());
    const result = splitLedgerFile(file);
    expect(result.ok && result.parts).toHaveLength(1);
    const { history: _history, ...rest } = file;
    expect(result.ok && result.parts[0]).toEqual(rest);
  });

  it("leave a file of records alone as one part with no rows", () => {
    const file = read({ ...wholeLedger(), entries: [], staged: [] });
    const result = splitLedgerFile({ ...file, budgets: { ...file.budgets, entries: [] } });
    expect(result.ok && result.parts.map(ledgerFileRowCount)).toEqual([0]);
  });
});
