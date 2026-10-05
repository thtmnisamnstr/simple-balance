import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addressCarriesLedgerText,
  payeeDetailSearch,
  withoutLedgerText,
} from "../src/client/router.js";

/**
 * Text from somebody's ledger stays out of the address of any page that
 * carries an ad.
 *
 * An ad request sends Google the page's own address and the one it was opened
 * from. The payee view is addressed by the payee's name —
 * `/payees/transactions?name=ZELLE%20TO%20JANE%20DOE` — and every link on it,
 * the sidebar included, forwarded the query string so the date range would
 * travel. One click to the overview put a person's name and who they pay into
 * an ad request, which is a leak and a breach of the program's policy at once.
 *
 * The two functions are tested for what they do. That the shell and the links
 * leaving the payee view actually use them is read from the source, because
 * the shell needs a session, a router and four queries to render, and none of
 * them is what this is about.
 */
const ORIGIN = "https://books.example.org";

describe("an address that carries a payee's name", () => {
  it("is this page's own, when the payee view's name is in it", () => {
    const search = `?${payeeDetailSearch("preset=this-month", "ZELLE TO JANE DOE")}`;
    expect(addressCarriesLedgerText(search, "", ORIGIN)).toBe(true);
  });

  it("is the page that opened this one, when it came from the payee view here", () => {
    const referrer = `${ORIGIN}/payees/transactions?name=DR%20SMITH`;
    expect(addressCarriesLedgerText("?preset=this-month", referrer, ORIGIN)).toBe(true);
  });

  it("is not a page opened from somewhere else, whatever that address held", () => {
    expect(addressCarriesLedgerText("", "https://elsewhere.example/?name=x", ORIGIN)).toBe(false);
  });

  it("is not a date range, a preset or an id", () => {
    expect(
      addressCarriesLedgerText("?preset=custom&start=2026-09-01&end=2026-09-22", "", ORIGIN),
    ).toBe(false);
    expect(addressCarriesLedgerText("", `${ORIGIN}/accounts/3f1c`, ORIGIN)).toBe(false);
    expect(addressCarriesLedgerText("", "not a url", ORIGIN)).toBe(false);
  });
});

describe("a link leaving the payee view", () => {
  it("keeps the date range and drops the name", () => {
    const from = payeeDetailSearch("preset=custom&start=2026-09-01", "ZELLE TO JANE DOE");
    expect(withoutLedgerText(from)).toBe("preset=custom&start=2026-09-01");
  });

  it("is built that way by the sidebar and by the category links in the list", () => {
    const shell = readFileSync("src/client/App.tsx", "utf8");
    expect(shell).toContain("search: withoutLedgerText(location.search)");
    expect(shell).not.toMatch(/to=\{\{ pathname: to, search: location\.search \}\}/);

    const list = readFileSync("src/client/TransactionBrowser.tsx", "utf8");
    // The list is what the payee view renders, so no link in it may forward
    // the query string as it stands.
    expect(list).not.toMatch(/search: location\.search,/);
  });
});

describe("the shell", () => {
  it("mounts no ad while the address, or the one it came from, carries a payee's name", () => {
    const shell = readFileSync("src/client/App.tsx", "utf8");
    const gate = /const ads =([\s\S]*?);/.exec(shell)?.[1] ?? "";
    expect(gate).toContain("isPlanSurfacePath(location.pathname)");
    expect(gate).toContain("addressCarriesLedgerText(location.search, document.referrer");
    expect(gate).toMatch(/\?\s*null\s*:\s*session\.ads/);
  });
});
