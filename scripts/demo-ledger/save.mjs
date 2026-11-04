/**
 * Export the demo ledger from a running copy and write it over
 * `demo-ledger.json`, so a change made in the app becomes a change to the file.
 *
 *   npx tsx scripts/demo-ledger/save.mjs [--url http://localhost:3000]
 *
 * The other half of `load.mjs --months-back 1`; the README beside this has the
 * whole loop. Two things make the diff show only what changed:
 *
 * - **The months go back.** The copy being exported was loaded some months
 *   after the committed file's, so every date in it is ahead by that many. The
 *   distance is read from an entry the two files share by origin — the one
 *   identity a move keeps — and every date is moved back by it.
 * - **The committed order is kept.** A move creates a kind's records in one
 *   transaction, so the order an export lists them in, which is the order they
 *   were created, comes out differently from the file they came from. Records
 *   already in the file keep their places and new ones follow, in the export's
 *   order. Entries are not reordered: the writer sorts them by date and origin.
 *
 * Read the diff before committing it. Anything in it beyond what you changed —
 * an amount written differently, a field the format gained — is the export's
 * word on how this release writes the ledger, and is worth knowing about.
 */
import { writeFileSync } from "node:fs";
import { parseLedgerFileText, serializeLedgerFile } from "../../src/shared/ledger-file.js";
import {
  DEMO_LEDGER_PATH,
  DEMO_PERSON,
  lastEntryDate,
  monthsBetween,
  readDemoLedger,
  shiftLedgerFile,
} from "./rebase.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--url");
const url = (at === -1 ? (process.env.APP_URL ?? "http://localhost:3000") : args[at + 1]).replace(
  /\/$/,
  "",
);
const origin = (process.env.APP_BASE_URL ?? url).replace(/\/$/, "");
const committed = readDemoLedger();

const signIn = await fetch(`${url}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ email: DEMO_PERSON.email, password: DEMO_PERSON.password }),
});
if (!signIn.ok) throw new Error(`Signing in failed: ${signIn.status} ${await signIn.text()}`);
const cookie = signIn.headers
  .getSetCookie()
  .map((line) => line.split(";")[0])
  .join("; ");

// The same kinds the committed file carries, so a kind is never dropped by
// accident and adding one is a decision made here.
const kinds = committed.scope.kinds.join(",");
const exported = await fetch(`${url}/api/v1/ledger-file?kinds=${kinds}`, {
  headers: { cookie, origin },
});
if (!exported.ok) throw new Error(`Exporting failed: ${exported.status} ${await exported.text()}`);
const parsed = parseLedgerFileText(await exported.text());
if (!parsed.ok) throw new Error(`The export did not read back: ${JSON.stringify(parsed.issues)}`);

// A copy loaded at the current month has had every entry still ahead of
// today dated today, and saving it would keep those dates for good: half a
// month of entries collapsed onto one day, which is how the first try at this
// script came out. So the file's last month has to be wholly past.
if (monthsBetween(lastEntryDate(parsed.file), parsed.file.throughDate) < 1) {
  throw new Error(
    "This copy's last month is the current one, so some of its entries may have been dated today to keep them out of the future. Load it with `load.mjs --months-back 1` into a fresh database, make the change there, and save from that.",
  );
}

const before = new Map(committed.entries.map((entry) => [entry.id, entry.date]));
const shared = parsed.file.entries.find((entry) => before.has(entry.id));
// Without a shared entry there is nothing to measure against, so the months
// of the last entries are compared instead; that only happens when every
// entry in the file was replaced, and then there is no old diff to keep small.
const ahead = shared
  ? monthsBetween(before.get(shared.id), shared.date)
  : monthsBetween(lastEntryDate(committed), lastEntryDate(parsed.file));
const file = shiftLedgerFile(parsed.file, -ahead);

/** `fresh` in the order its records have in `old`, new ones after, in their own order. */
function keepOrder(fresh, old, identity) {
  const place = new Map(old.map((record, index) => [identity(record), index]));
  const rank = (record) => place.get(identity(record)) ?? Number.MAX_SAFE_INTEGER;
  return fresh
    .map((record, index) => ({ record, index }))
    .sort((a, b) => rank(a.record) - rank(b.record) || a.index - b.index)
    .map(({ record }) => record);
}
const byKey = (record) => record.key;
// A budget has no key; what makes one is its target, currency, period and start.
const plan = (row) =>
  [row.category ?? "", row.group ?? "", row.currency, row.periodUnit, row.activeFrom].join("|");
file.groups = keepOrder(file.groups, committed.groups, byKey);
file.categories = keepOrder(file.categories, committed.categories, byKey);
file.accounts = keepOrder(file.accounts, committed.accounts, byKey);
file.templates = keepOrder(file.templates, committed.templates, byKey);
file.recurrences = keepOrder(file.recurrences, committed.recurrences, byKey);
file.budgets.plans = keepOrder(file.budgets.plans, committed.budgets.plans, plan);
file.budgets.entries = keepOrder(
  file.budgets.entries,
  committed.budgets.entries,
  (row) => `${plan({ ...row, activeFrom: "" })}|${row.periodStart}`,
);
file.staged = keepOrder(file.staged, committed.staged, (row) => row.id);

writeFileSync(DEMO_LEDGER_PATH, serializeLedgerFile(file));
console.log(
  `wrote ${DEMO_LEDGER_PATH}: ${file.entries.length} entries, ${file.staged.length} staged, ` +
    `dates moved back ${ahead} month${ahead === 1 ? "" : "s"}. Read the diff before committing it.`,
);
