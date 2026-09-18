import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  COHORTS,
  POSTINGS_PER_TRANSACTION,
  TOTAL_ACCOUNTS,
  TOTAL_POSTINGS,
  TOTAL_TRANSACTIONS,
  TOTAL_USERS,
  scaled,
} from "../scripts/capacity/cohorts.mjs";
import { MIX, SCHEDULE, THRESHOLDS } from "../scripts/capacity/schedule.mjs";

const root = path.resolve(import.meta.dirname, "..");
const DOC = readFileSync(path.join(root, "docs/capacity.md"), "utf8");

/**
 * `docs/capacity.md` is the claim and `scripts/capacity/` is what produces it.
 *
 * A capacity page is read by somebody deciding whether this will hold their
 * data, and by somebody else reproducing the run. If the page says 25 requests
 * a second and the driver fires 10, one of those two people is being misled and
 * neither can tell which. There is no way to generate the page from the code —
 * the argument in it is the point — so the check is that the two agree.
 *
 * Only the numbers. The prose is a person's job.
 */

/** The cells of a markdown table row whose first cell is `label`. */
function row(label: string): string[] {
  const line = DOC.split("\n").find((candidate) => candidate.startsWith(`| ${label} |`));
  expect(line, `docs/capacity.md has no row starting "| ${label} |"`).toBeDefined();
  return line!
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/**
 * The first number in a cell.
 *
 * The cells are prose — "10 minutes, excluded from every figure", "40 of 100",
 * "85% of the container's limit" — because a table of bare numbers would need
 * the reasoning somewhere else, and the reasoning is what makes a threshold
 * worth holding. Taking the leading figure reads all of them.
 */
const number = (cell: string) => {
  const found = /-?\d[\d,]*(\.\d+)?/.exec(cell);
  expect(found, `no number in "${cell}"`).not.toBeNull();
  return Number(found![0].replaceAll(",", ""));
};

describe("the capacity proof's population", () => {
  it("is the same three cohorts in the document and in the generator", () => {
    for (const cohort of COHORTS) {
      const cells = row(`\`${cohort.name}\``);
      expect(number(cells[1]!), `${cohort.name} users`).toBe(cohort.users);
      expect(number(cells[2]!), `${cohort.name} accounts`).toBe(cohort.accounts);
      expect(number(cells[3]!), `${cohort.name} transactions each`).toBe(cohort.transactions);
      expect(number(cells[4]!), `${cohort.name} transactions`).toBe(
        cohort.users * cohort.transactions,
      );
    }
  });

  it("adds up to the totals the document leads with", () => {
    expect(TOTAL_USERS).toBe(10_000);
    expect(TOTAL_ACCOUNTS).toBe(50_000);
    expect(TOTAL_TRANSACTIONS).toBe(30_000_000);
    const collapsed = DOC.replaceAll(/\s+/g, " ");
    expect(collapsed).toContain(`**${TOTAL_USERS.toLocaleString("en-US")}**`);
    expect(collapsed).toContain(`**${TOTAL_ACCOUNTS.toLocaleString("en-US")}**`);
    expect(collapsed).toContain(`**${TOTAL_TRANSACTIONS.toLocaleString("en-US")}**`);
    expect(collapsed).toContain("Thirty million transactions across ten thousand users");
  });

  it("derives the posting count from the two rates rather than stating it", () => {
    // 2.2 per transaction is not a constant somebody chose: it falls out of one
    // entry in twenty carrying six postings and the rest carrying two. Writing
    // it here as arithmetic is what stops the document and the generator
    // drifting when either rate changes.
    expect(POSTINGS_PER_TRANSACTION).toBeCloseTo(2.2, 10);
    expect(TOTAL_POSTINGS).toBe(66_000_000);
    const collapsed = DOC.replaceAll(/\s+/g, " ");
    expect(collapsed).toContain(`**${TOTAL_POSTINGS.toLocaleString("en-US")} postings**`);
    expect(collapsed).toContain(`${POSTINGS_PER_TRANSACTION} per transaction`);
  });

  it("keeps every cohort represented at any scale", () => {
    // A cohort that rounds to nobody is a cohort the proof quietly stopped
    // covering, and the heavy one is the first to go — it is one per cent of
    // the population and the whole of the tail.
    for (const scale of [1, 10, 100, 1_000, 10_000]) {
      const small = scaled(scale);
      expect(small.length, `at 1/${scale}`).toBe(COHORTS.length);
      for (const cohort of small)
        expect(cohort.users, `${cohort.name} at 1/${scale}`).toBeGreaterThan(0);
    }
  });
});

describe("the capacity proof's schedule", () => {
  it("is the same run in the document and in the driver", () => {
    expect(number(row("Warm-up")[1]!)).toBe(SCHEDULE.warmupMinutes);
    expect(number(row("Measurement")[1]!)).toBe(SCHEDULE.measureMinutes);
    expect(number(row("Steady rate")[1]!)).toBe(SCHEDULE.rps);
    expect(number(row("Recurrences due")[1]!)).toBe(SCHEDULE.dueRecurrences);
    expect(number(row("Concurrent sessions")[1]!)).toBe(SCHEDULE.virtualUsers);

    const burst = row("Burst")[1]!;
    expect(burst).toContain(`${SCHEDULE.burstRps} requests a second`);
    expect(burst).toContain(`${SCHEDULE.burstMinutes} minutes`);
    expect(burst).toContain(`minute ${SCHEDULE.burstAtMinute}`);

    const imports = row("Imports")[1]!;
    expect(imports).toContain(`${SCHEDULE.concurrentImports} concurrent`);
    expect(imports).toContain(SCHEDULE.importRows.toLocaleString("en-US"));
    expect(imports).toContain(`minute ${SCHEDULE.importsAtMinute}`);
  });

  it("burst and imports both land inside the measured hour", () => {
    // A burst scheduled past the end of the run is a burst that never happens,
    // and the report would look unremarkable rather than wrong.
    expect(SCHEDULE.burstAtMinute + SCHEDULE.burstMinutes).toBeLessThanOrEqual(
      SCHEDULE.measureMinutes,
    );
    expect(SCHEDULE.importsAtMinute).toBeLessThan(SCHEDULE.measureMinutes);
  });

  it("is the same mix, and the mix is a whole", () => {
    expect(MIX.reduce((sum, entry) => sum + entry.percent, 0)).toBe(100);
    for (const entry of MIX) {
      const cells = row(`${entry.percent}%`);
      expect(cells[0]).toBe(`${entry.percent}%`);
    }
    // Every share in the document is one the driver actually fires, and every
    // request the driver fires is documented. A route in one and not the other
    // is a mix nobody agreed to.
    const documented = DOC.split("\n")
      .filter((line) => /^\| \d+% \|/.test(line))
      .map((line) => Number(line.split("|")[1]!.trim().replace("%", "")));
    expect(documented.sort((a, b) => a - b)).toEqual(
      MIX.map((entry) => entry.percent).sort((a, b) => a - b),
    );
  });

  it("is held to the same thresholds", () => {
    expect(number(row("p50")[1]!)).toBe(THRESHOLDS.p50Ms);
    expect(number(row("p95")[1]!)).toBe(THRESHOLDS.p95Ms);
    expect(number(row("p99")[1]!)).toBe(THRESHOLDS.p99Ms);
    expect(number(row("Error rate")[1]!)).toBe(THRESHOLDS.errorRate * 100);
    expect(number(row("Peak CPU")[1]!)).toBe(THRESHOLDS.cpuPercent);
    expect(number(row("Peak memory")[1]!)).toBe(THRESHOLDS.memoryPercent);
    expect(number(row("Connections")[1]!)).toBe(THRESHOLDS.connections);
  });
});
