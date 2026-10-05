import { describe, expect, it } from "vitest";
import { mutationNames } from "./support/mutations.js";
import { sourceFiles, topLevelDeclarations } from "./support/source.js";

/**
 * `services.md` 2.5: every write to somebody's books is audited.
 *
 * The guide marks one word in that sentence unchecked, and names it: *every*.
 * "Nothing enumerates the mutations in this directory the way
 * `tests/service-transactions.test.ts` enumerates their parameter lists, so a
 * new write that audits nothing passes." The integration suite asserts that
 * audit rows exist, are scoped to one person, and parse as the shape the MCP
 * tool declares — all of which a new unaudited mutation leaves true.
 *
 * So the population is derived: every exported declaration in
 * `src/server/services` that writes a row, itself or through something in the
 * directory that does. Each one reaches `writeAudit`, `writeAuditMany` or
 * `auditedTransaction` the same way, or is named below with the argument for
 * why it does not.
 *
 * This has never caught anything. The hand enumeration that preceded it came
 * back clean, which is the point: the register below is a transcription of an
 * argument that already existed in prose, and what it buys is that the next
 * unaudited write has to come here and join it.
 */
describe("every exported service write", () => {
  /**
   * One module rather than one declaration, because the guide exempts it as a
   * module and says why at length.
   *
   * `billing.ts` has ten write statements and does not contain the word
   * *audit*. The audit log is somebody's history of their own books, read back
   * through `listAuditEvents` scoped to their `userId`; a billing row is not
   * their bookkeeping, and eight of the ten writes run from a Stripe webhook or
   * the reconciliation sweep where there is no `Actor` to attribute a row to.
   * Kept as a module entry so a new write there is still read against the
   * guide's test — would a person read this row back as something they did —
   * rather than being exempt for living in the right file.
   */
  const UNAUDITED_MODULES: Record<string, string> = {
    "src/server/services/billing.ts":
      "A billing row is this deployment's bookkeeping with a payment processor rather than somebody's own history of their books, and most of these writes run from a webhook or a sweep with no Actor to attribute a row to. services.md 2.5 argues it in full and keeps the test for a new write: would a person read this row back as something they did?",
  };

  /**
   * The declarations that write without auditing, each with its reason.
   *
   * Keyed by name rather than by file and line: a name is what the reader
   * recognizes, these names are unique across the directory, and a line drifts
   * the moment anything above it changes.
   */
  const UNAUDITED: Record<string, string> = {
    deleteOwnAccount:
      "Deletes the person and cascades every row they own, the audit history included. A row written to record the deletion would be deleted by the same statement, so the only honest place for this event is the server log, which is where it goes.",
    ensureSystemAccount:
      "The counter-accounts are the server's own, one per kind and currency, and never appear in a list or a picker. Nobody did this and nobody can undo it, so an audit row would say a person created an account they cannot see.",
    reconcileArchivedAccountClosings:
      "A startup repair that re-closes accounts archived under the old single-entry rule. It appends only the difference per account and date, so over an account that is already right it writes nothing at all — auditing it would file a row under somebody's name for an upgrade they did not ask for.",
    postClosingBalance:
      "A helper that posts an account's balance out to equity. The entity being changed is the account, and the archive and restore that call this write the audit row for it; a second row here would record the same event twice under a name nobody uses.",
    repostTransaction:
      "The same shape one table along: it works out the delta per account, currency and date and appends it. Its callers — the edit, the delete, the restore — each audit the transaction, which is the entity a person reads back.",
    prepareTransaction:
      "Resolves a draft into the rows a transaction needs, including creating a category somebody named. It is reached only from a create or an edit, and both audit the transaction and the category creation inside it with the operation that says how it happened.",
    runDueNotifications:
      "A sweep with no Actor. What it writes is a watermark recording what was sent, which is the mail system's own bookkeeping rather than a change to anybody's books — and it writes nothing at all when there is no mail server.",
    pruneAbandonedClients:
      "Deletes dynamic registrations that nobody consented to and that were never issued a token. The rows are anonymous by construction, so there is no person whose history this belongs in; a registration tied to an account is left alone.",
    setIdempotent:
      "The idempotency record, which is how a retry gets the first answer back rather than a second write. It is infrastructure for the mutation beside it, and that mutation audits what it did.",
    pruneIdempotencyRecords:
      "The retention sweep over those same records, run with no Actor. Auditing the expiry of a retry receipt would put a row in somebody's history for a thing they never saw.",
  };

  const declarations = sourceFiles("src/server/services").flatMap((file) =>
    topLevelDeclarations(file).map((declaration) => ({ ...declaration, file: file.path })),
  );

  /**
   * Reaching an audit, followed through the directory the same way
   * `mutationNames` follows a write.
   *
   * The three spellings are the three the guide counts, and `writeAuditMany` is
   * why this cannot read `writeAudit` alone: it writes the audit table itself
   * without going through the singular call, so a reader looking for one name
   * called every bulk delete in the product unaudited.
   */
  const audits = () => {
    const writesAudit = /\b(?:writeAudit|writeAuditMany|auditedTransaction)\s*\(/;
    const reached = new Set(
      declarations.filter((it) => writesAudit.test(it.body)).map((it) => it.name),
    );
    const calls = new Map(
      declarations.map((declaration) => [
        declaration.name,
        new Set(
          [...declaration.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]!),
        ),
      ]),
    );
    for (let settled = false; !settled;) {
      settled = true;
      for (const declaration of declarations) {
        if (reached.has(declaration.name)) continue;
        for (const called of calls.get(declaration.name) ?? []) {
          if (called === declaration.name || !reached.has(called)) continue;
          reached.add(declaration.name);
          settled = false;
          break;
        }
      }
    }
    return reached;
  };

  const writers = () => {
    const mutations = mutationNames(declarations);
    return declarations.filter((it) => it.exported && mutations.has(it.name));
  };

  it("is read off a population the reader can still find", () => {
    // Each of these stopped being true once in this repository's history, and
    // in every case the check went on passing.
    expect(declarations.length, "no service declarations read").toBeGreaterThan(200);
    expect(writers().length, "no service writers found").toBeGreaterThan(40);
    const reaching = audits();
    expect(
      writers().filter((it) => reaching.has(it.name)).length,
      "nothing reaches an audit, so the walk stopped walking",
    ).toBeGreaterThan(30);
  });

  it("writes an audit entry, or is named with the reason it does not", () => {
    const reaching = audits();
    const silent = writers()
      .filter((it) => !reaching.has(it.name))
      .filter((it) => !(it.file in UNAUDITED_MODULES) && !(it.name in UNAUDITED))
      .map((it) => `${it.file}:${it.line} ${it.name}`);
    expect(
      silent,
      "write an audit entry, or name it above with the argument for why this write is not somebody's history",
    ).toEqual([]);
    // A register as long as the population would excuse the directory.
    expect(writers().length - Object.keys(UNAUDITED).length).toBeGreaterThan(20);
  });

  it("excuses nothing that has gone, or that now audits", () => {
    const reaching = audits();
    const present = new Map(writers().map((it) => [it.name, it.file]));
    const stale = Object.keys(UNAUDITED).filter(
      (name) =>
        !present.has(name) || reaching.has(name) || (present.get(name) ?? "") in UNAUDITED_MODULES,
    );
    expect(stale, "this no longer writes without auditing, so the entry is spent").toEqual([]);
    const modules = new Set(declarations.map((it) => it.file));
    expect(Object.keys(UNAUDITED_MODULES).filter((path) => !modules.has(path))).toEqual([]);
  });

  it("gives every exception an argument somebody had to make", () => {
    for (const [name, reason] of Object.entries({ ...UNAUDITED_MODULES, ...UNAUDITED })) {
      expect(reason.length, name).toBeGreaterThan(40);
    }
  });
});
