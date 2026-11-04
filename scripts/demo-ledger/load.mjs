/**
 * Put the demo ledger into a running copy of this application.
 *
 * Signs the demo person up — or in, when an earlier run already made them —
 * and moves `demo-ledger.json` into their books, rebased so its last month is
 * this one. Everything it writes goes through the routes the browser uses, so
 * what loads is what a person moving their own file would get.
 *
 *   npx tsx scripts/demo-ledger/load.mjs [--url http://localhost:3000] [--months-back 1]
 *
 * `--url` is the application, not Vite: the API answers there, and the
 * request has to come from the origin the server was told is its own, which
 * is the one `APP_BASE_URL` names. `--months-back 1` is for keeping the file
 * up to date, and the README beside this says why. Run under `tsx`, because
 * "what day is it" is answered by `calendarDayIn` and nowhere else.
 *
 * A fresh database each time. A second run on a later day passes over every
 * entry the first one wrote, leaving them on their old dates.
 */
import { calendarDayIn } from "../../src/shared/recurrence-dates.js";
import { DEMO_PERSON, demoLedgerMove } from "./rebase.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const url = option("--url", process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const origin = option("--origin", process.env.APP_BASE_URL ?? url).replace(/\/$/, "");
const monthsBack = Number(option("--months-back", "0"));
// The zone the ledger will be read in. The browser that later opens it offers
// this machine's zone to an account that never chose one, so the two agree.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const today = calendarDayIn(new Date(), zone);

let cookie = "";
async function call(path, body) {
  const response = await fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const set = response.headers.getSetCookie();
  if (set.length > 0) cookie = set.map((line) => line.split(";")[0]).join("; ");
  return { status: response.status, text: await response.text() };
}

const signUp = await call("/api/auth/sign-up/email", DEMO_PERSON);
if (signUp.status >= 400) {
  const signIn = await call("/api/auth/sign-in/email", {
    email: DEMO_PERSON.email,
    password: DEMO_PERSON.password,
  });
  if (signIn.status >= 400) {
    throw new Error(
      `Neither signing up nor signing in worked.\nsign-up: ${signUp.status} ${signUp.text}\nsign-in: ${signIn.status} ${signIn.text}`,
    );
  }
}

const moved = await call("/api/v1/ledger-file:move", demoLedgerMove({ today, monthsBack }));
if (moved.status >= 400) {
  // The usual one on a deployment that sells a plan: four accounts and a free
  // plan that keeps three. The product-kit skill says what to do about it.
  console.error(`The move was refused (${moved.status}):\n${moved.text}`);
  process.exit(1);
}
const result = JSON.parse(moved.text);
console.log(
  `${DEMO_PERSON.email} / ${DEMO_PERSON.password}: ${result.written.entries} transactions written, ` +
    `${result.written.deleted} deleted, ${result.skipped.entries} already there, ` +
    `${result.staged} staged, ${result.balances.checked} balances checked, as of ${today} (${zone})`,
);
