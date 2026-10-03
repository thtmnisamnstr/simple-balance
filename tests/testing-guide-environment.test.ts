import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * 5.4 of `docs/standards/code/testing.md`: a file that turns a feature on turns
 * it off again.
 *
 * `unstubGlobals` in `vitest.config.ts` undoes a stubbed global between files
 * and does nothing at all for the environment, which is the half the billing
 * work made load-bearing. Every file in a tier shares one process, so a
 * `STRIPE_SECRET_KEY` left set is a vendor switched on for whatever runs next —
 * and `src/server/config.ts:224` caches the parsed configuration in a
 * module-level variable, so the next file can be answered out of this one's
 * keys even after the variables themselves are back.
 *
 * The keys below are the switches: setting one changes what the product *is*
 * rather than what one call returns. `DATABASE_URL` is deliberately not among
 * them — every integration file points it at a scratch database of its own and
 * the next one does the same, so it is never read stale.
 */
const SWITCHES =
  /^(?:STRIPE_|SB_BILLING_ENABLED|SMTP_|MAIL_|GOOGLE_CLIENT_|METRICS_|ADS_|AUTH_MODE|ALLOWED_EMAILS|SETUP_TOKEN|LOG_LEVEL|SB_CSP_REPORT_ONLY|TRUST_PROXY|PRIVACY_POLICY_URL|TERMS_OF_USE_URL)/;

/**
 * The three spellings a file sets one with, read out of the code rather than
 * the text so a key named in a comment is not mistaken for a key being set.
 *
 * The third is why this is not one pattern: a file that merges a whole object
 * into `process.env` never writes `process.env.STRIPE_SECRET_KEY` anywhere, so
 * the keys have to be read off the literal instead. Four of these files are
 * written that way and a check that knew the first two called every one of them
 * clean.
 */
const ASSIGNED = /process\.env\.([A-Z0-9_]+)\s*=\s[^=]/g;
const STUBBED = /vi\.stubEnv\(\s*["'`]([A-Z0-9_]+)/g;
const MERGED = /Object\.assign\(\s*process\.env/;
const LITERAL_KEY = /^\s*([A-Z0-9_]+):/gm;

/**
 * And the spellings that put one back: `vi.unstubAllEnvs`, a whole-object
 * snapshot restored, a per-key loop, or a `delete`. Four rather than one
 * because all four are in the tree and none is wrong.
 */
const RESTORED =
  /unstubAllEnvs|process\.env = \{|delete process\.env\.|process\.env\[[a-zA-Z]+\] =/;

/** Where a file's teardown starts, which the import of `afterAll` is not. */
const teardownAt = (code: string): number => {
  const marks = [code.indexOf("afterAll("), code.indexOf("afterEach(")].filter((at) => at >= 0);
  return marks.length === 0 ? -1 : Math.min(...marks);
};

/**
 * A merge into `process.env` is both spellings at once — it is how four files
 * turn the switches on and how three of them put the old values back — so it
 * counts as a restore only where it happens, in a teardown. Reading it as a
 * restore anywhere would make every merging file satisfy this check by the act
 * of setting the variables.
 */
const restores = (code: string): boolean => {
  if (RESTORED.test(code)) return true;
  const at = teardownAt(code);
  return at >= 0 && MERGED.test(code.slice(at));
};

const testFiles = sourceFiles("tests").filter((file) => /\.test\.tsx?$/.test(file.path));

/** Every file that flips at least one switch, and which ones. */
const flipping = testFiles
  .map((file) => {
    const keys = new Set<string>();
    for (const match of file.code.matchAll(ASSIGNED)) keys.add(match[1]!);
    for (const match of file.code.matchAll(STUBBED)) keys.add(match[1]!);
    if (MERGED.test(file.code)) {
      for (const match of file.code.matchAll(LITERAL_KEY)) keys.add(match[1]!);
    }
    return {
      path: file.path,
      code: file.code,
      keys: [...keys].filter((key) => SWITCHES.test(key)),
    };
  })
  .filter((file) => file.keys.length > 0);

describe("a file that turns a feature on", () => {
  it("is one of several, and they are found rather than listed", () => {
    // 2.6, applied to this file's own population: both patterns above are
    // guesses about how people write, and a guess that stops matching would
    // leave the claim below passing over an empty list.
    expect(flipping.length).toBeGreaterThanOrEqual(15);
    const paths = flipping.map((file) => file.path);
    // One from each spelling, so no pattern can rot unnoticed: the log-level
    // file assigns a key at a time, the mail header file stubs, and the Stripe
    // schedule file merges an object.
    expect(paths).toContain("tests/log-level.test.ts");
    expect(paths).toContain("tests/mail-headers.test.ts");
    expect(paths).toContain("tests/stripe-schedule-phases.test.ts");
  });

  it("turns it off again", () => {
    const leaking = flipping
      .filter((file) => !restores(file.code))
      .map((file) => `${file.path} sets ${file.keys.join(", ")} and never puts them back`);
    expect(leaking, "restore the environment this file changed").toEqual([]);
  });
});
