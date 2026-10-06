import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `operations.md` §Types: an on/off switch accepts true and false and says
 * something about anything else. The frontend image's three switches reached
 * nginx's `map` unread and were matched against the literal "true", so "yes",
 * "1" and "TRUE" all meant off with nothing in the log, while the server reads
 * the same SB_CSP_REPORT_ONLY case-insensitively and refuses "yes".
 *
 * Sourced the way the entrypoint sources it, under `set -eu`, with what a child
 * process then receives read back — the same harness
 * `tests/frontend-real-ip.test.ts` uses for its sibling.
 */
const root = new URL("../", import.meta.url).pathname;
const script = path.join(root, "deploy/docker/nginx-switches.envsh");
const NAMES = ["SB_BILLING_CONFIGURED", "SB_ADS_CONFIGURED", "SB_CSP_REPORT_ONLY"] as const;

function source(env: Record<string, string>) {
  const probe = [
    "set -eu",
    `. "${script}"`,
    ...NAMES.map((name) => `printf '%s\\0' "$(sh -c 'printf "%s" "$${name}"')"`),
    `printf '%s\\0' "$( (set; command -v sb_switch) 2>/dev/null | grep '^sb_switch' || true)"`,
  ].join("\n");
  const result = spawnSync("sh", ["-c", probe], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  const [billing = "", ads = "", reportOnly = "", leftovers = ""] = result.stdout.split("\0");
  return { status: result.status, stderr: result.stderr, billing, ads, reportOnly, leftovers };
}

describe("the frontend's on/off switches", () => {
  it("passes true and false through, and reads unset and empty as off, quietly", () => {
    const set = source({
      SB_BILLING_CONFIGURED: "true",
      SB_ADS_CONFIGURED: "false",
      SB_CSP_REPORT_ONLY: "",
    });
    expect(set).toMatchObject({ status: 0, billing: "true", ads: "false", reportOnly: "false" });
    expect(set.stderr).toBe("");
    expect(source({})).toMatchObject({ status: 0, billing: "false", stderr: "" });
  });

  it.each(["yes", "1", "on", "TRUE"])(
    "keeps %s off, as 0.2.0 served it, and says so by name",
    (value) => {
      const result = source({ SB_ADS_CONFIGURED: value });
      expect(result.status).toBe(0);
      expect(result.ads).toBe("false");
      expect(result.stderr).toContain(`SB_ADS_CONFIGURED is "${value}"`);
      expect(result.stderr).toContain("reads as false");
    },
  );

  it("tells somebody who wrote TRUE what to change", () => {
    expect(source({ SB_CSP_REPORT_ONLY: "TRUE" }).stderr).toContain("lowercase");
  });

  it("leaves nothing of its own in the shell that sourced it", () => {
    expect(source({ SB_BILLING_CONFIGURED: "maybe" }).leftovers).toBe("");
  });

  it("is installed ahead of the template render, executable", () => {
    const dockerfile = readFileSync(path.join(root, "deploy/docker/frontend.Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY --chmod=0755 deploy/docker/nginx-switches.envsh /docker-entrypoint.d/17-sb-switches.envsh",
    );
    // And these are the switches the template matches, so a fourth `map` on a
    // new switch is a name this has to learn.
    const template = readFileSync(path.join(root, "deploy/docker/nginx.conf.template"), "utf8");
    const mapped = new Set(
      [...template.matchAll(/^map "[^"]*\$\{(SB_[A-Z_]+)\}/gm)].map((match) => match[1]!),
    );
    for (const name of [...template.matchAll(/^map "([^"]*)"/gm)].flatMap((match) =>
      [...match[1]!.matchAll(/\$\{(SB_[A-Z_]+)\}/g)].map((inner) => inner[1]!),
    ))
      mapped.add(name);
    expect([...mapped].sort()).toEqual([...NAMES].sort());
  });
});
