import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Whose word the frontend's nginx takes for a visitor's address.
 *
 * The API counts sign-in attempts per client address and reads it from the
 * X-Forwarded-For the frontend sends, which is the frontend's own
 * `$remote_addr` after the real_ip module. So these two settings decide whether
 * one stranger can spend the sign-in allowance of everybody behind the same
 * load balancer — and a mistake in them is silent, because every request still
 * succeeds.
 *
 * The script is run rather than read. It is sourced by the image's entrypoint,
 * so the checks here source it the same way, under the `set -eu` the stock
 * 15-local-resolvers.envsh leaves behind, and read what a child process sees
 * afterward, which is what 20-envsubst-on-templates.sh sees. The container
 * itself was proved against the pinned base image; these hold the behavior
 * still on every commit.
 */
const root = new URL("../", import.meta.url).pathname;
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const script = path.join(root, "deploy/docker/nginx-real-ip.envsh");
const template = read("deploy/docker/nginx.conf.template");

const scratch = mkdtempSync(path.join(tmpdir(), "sb-real-ip-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Sourced = {
  status: number | null;
  stderr: string;
  /** SB_TRUSTED_PROXY_CIDR as a child process receives it. */
  trusted: string;
  /** SB_REAL_IP_RECURSIVE as a child process receives it. */
  recursive: string;
  /** Anything of the script's own left in the shell that sourced it. */
  leftovers: string;
  /** The entrypoint's loop variable, which a sourced script shares. */
  loopVariable: string;
};

/**
 * Sources the script with exactly `env` and nothing inherited, so a developer's
 * own SB_ variables cannot make a case pass. `f` stands in for the entrypoint's
 * `while read -r f` loop variable, which a sourced script that used the name
 * would silently redirect.
 */
function source(env: Record<string, string>, cwd = scratch): Sourced {
  const probe = [
    "set -eu",
    "f=/docker-entrypoint.d/18-sb-real-ip.envsh",
    `. "${script}"`,
    `printf '%s\\0' "$(sh -c 'printf "%s" "$SB_TRUSTED_PROXY_CIDR"')"`,
    `printf '%s\\0' "$(sh -c 'printf "%s" "$SB_REAL_IP_RECURSIVE"')"`,
    `printf '%s\\0' "$( (set; command -v sb_real_ip_refuse) 2>/dev/null | grep '^sb_real_ip' || true)"`,
    `printf '%s\\0' "$f"`,
  ].join("\n");
  const result = spawnSync("sh", ["-c", probe], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NGINX_ENTRYPOINT_QUIET_LOGS: "1", ...env },
  });
  const [trusted = "", recursive = "", leftovers = "", loopVariable = ""] =
    result.stdout.split("\0");
  return {
    status: result.status,
    stderr: result.stderr,
    trusted,
    recursive,
    leftovers,
    loopVariable,
  };
}

/** The template's two real_ip lines as envsubst would render them. */
function rendered(sourced: Sourced) {
  const lines = template
    .split("\n")
    .filter((line) => /^(set_real_ip_from|real_ip_recursive) /.test(line));
  expect(lines, "the template's set_real_ip_from and real_ip_recursive lines").toEqual([
    "set_real_ip_from ${SB_TRUSTED_PROXY_CIDR};",
    "real_ip_recursive ${SB_REAL_IP_RECURSIVE};",
  ]);
  return lines
    .join("\n")
    .replace("${SB_TRUSTED_PROXY_CIDR}", sourced.trusted)
    .replace("${SB_REAL_IP_RECURSIVE}", sourced.recursive);
}

describe("the entrypoint script that turns the settings into directives", () => {
  it("renders the image defaults exactly as the template did before lists", () => {
    const sourced = source({ SB_TRUSTED_PROXY_CIDR: "127.0.0.1", SB_REAL_IP_RECURSIVE: "off" });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(rendered(sourced)).toBe("set_real_ip_from 127.0.0.1;\nreal_ip_recursive off;");
  });

  it("passes one CIDR through byte for byte", () => {
    const sourced = source({ SB_TRUSTED_PROXY_CIDR: "10.4.0.0/14" });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(sourced.trusted).toBe("10.4.0.0/14");
    // Unset is off: the image always sets it, and a shell that did not must
    // still land on the safe side.
    expect(sourced.recursive).toBe("off");
  });

  it("turns a list into one directive per entry, whatever separates them", () => {
    const sourced = source({
      SB_TRUSTED_PROXY_CIDR: " 130.211.0.0/22,35.191.0.0/16 ,, 34.8.9.10\tfd00::/8\n",
      SB_REAL_IP_RECURSIVE: "on",
    });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(rendered(sourced)).toBe(
      [
        "set_real_ip_from 130.211.0.0/22;",
        "set_real_ip_from 35.191.0.0/16;",
        "set_real_ip_from 34.8.9.10;",
        "set_real_ip_from fd00::/8;",
        "real_ip_recursive on;",
      ].join("\n"),
    );
  });

  it.each([
    ["true", "on"],
    ["TRUE", "on"],
    ["On", "on"],
    ["false", "off"],
    ["OFF", "off"],
    ["", "off"],
  ])("reads SB_REAL_IP_RECURSIVE=%j as nginx's %s", (value, expected) => {
    const sourced = source({ SB_TRUSTED_PROXY_CIDR: "10.0.0.0/8", SB_REAL_IP_RECURSIVE: value });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(sourced.recursive).toBe(expected);
  });

  it("refuses a recursion setting it would have to guess at", () => {
    for (const value of ["yes", "1", "enabled"]) {
      const sourced = source({ SB_TRUSTED_PROXY_CIDR: "10.0.0.0/8", SB_REAL_IP_RECURSIVE: value });
      expect(sourced.status, value).toBe(1);
      expect(sourced.stderr).toContain(`SB_REAL_IP_RECURSIVE is "${value}"`);
    }
  });

  /**
   * The reason the script refuses at all. nginx's `set_real_ip_from` resolves
   * anything it cannot parse, at startup, and trusts the answer: `localhost`
   * trusts loopback and musl reads `10.0.0` as 10.0.0.0 and `10.1` as
   * 10.0.0.1. Each of these starts a stock container without a word.
   */
  it.each([
    "localhost",
    "ingress-nginx.ingress-nginx.svc",
    "10.0.0",
    "10.1",
    "10.0.0.0/33",
    "256.0.0.1",
    "010.0.0.1",
    "fd00::/129",
    "10.0.0.0/8;",
  ])("refuses %j before nginx can trust whatever it resolves to", (entry) => {
    const sourced = source({ SB_TRUSTED_PROXY_CIDR: `10.0.0.0/16, ${entry}` });
    expect(sourced.status).toBe(1);
    expect(sourced.stderr).toContain(`SB_TRUSTED_PROXY_CIDR holds "${entry}"`);
  });

  it("refuses a list that comes out empty rather than reading it as off", () => {
    for (const value of ["", " , ", "\n"]) {
      const sourced = source({ SB_TRUSTED_PROXY_CIDR: value });
      expect(sourced.status, JSON.stringify(value)).toBe(1);
      expect(sourced.stderr).toContain("SB_TRUSTED_PROXY_CIDR is empty");
    }
  });

  it("refuses a range holding every address only when recursion would walk it", () => {
    for (const everything of ["0.0.0.0/0", "::/0"]) {
      const on = source({ SB_TRUSTED_PROXY_CIDR: everything, SB_REAL_IP_RECURSIVE: "on" });
      expect(on.status, everything).toBe(1);
      expect(on.stderr).toContain("believes whatever address a caller writes first");
      // Accepted before recursion existed, so still accepted without it.
      const off = source({ SB_TRUSTED_PROXY_CIDR: everything, SB_REAL_IP_RECURSIVE: "off" });
      expect(off.status, off.stderr).toBe(0);
      expect(off.trusted).toBe(everything);
    }
  });

  it("never lets the shell expand an entry against the files beside it", () => {
    // Without `set -f` this is the dangerous direction, not merely a wrong
    // message: a working directory holding a file called 10.0.0.1 turns the
    // pattern into an address the script then accepts.
    const directory = mkdtempSync(path.join(scratch, "glob-"));
    writeFileSync(path.join(directory, "10.0.0.1"), "");
    const sourced = source({ SB_TRUSTED_PROXY_CIDR: "10.0.0.*" }, directory);
    expect(sourced.status).toBe(1);
    expect(sourced.stderr).toContain('holds "10.0.0.*"');
  });

  it("exports what envsubst reads and leaves nothing of its own behind", () => {
    const sourced = source({ SB_TRUSTED_PROXY_CIDR: "10.0.0.0/8 10.1.0.0/16" });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(sourced.trusted).toBe("10.0.0.0/8;\nset_real_ip_from 10.1.0.0/16");
    expect(sourced.leftovers).toBe("");
    expect(sourced.loopVariable).toBe("/docker-entrypoint.d/18-sb-real-ip.envsh");
  });
});

/**
 * The chart refuses at render what the image refuses at startup, and accepts
 * what it accepts. A value the schema let through and the script refused would
 * install cleanly and never become ready; one the script took and the schema
 * refused would be a setting the image offers and the chart withholds.
 */
describe("the chart's schema and the image's script", () => {
  const schema = JSON.parse(read("deploy/helm/simple-balance/values.schema.json")) as {
    properties: {
      frontend: {
        properties: Record<
          string,
          {
            type?: string;
            anyOf?: { type: string; pattern?: string; items?: { pattern: string } }[];
          }
        >;
      };
    };
  };
  const frontend = schema.properties.frontend.properties;
  const forms = frontend.trustedProxyCidr!.anyOf!;
  const stringForm = forms.find((form) => form.type === "string")!.pattern!;
  const itemForm = forms.find((form) => form.type === "array")!.items!.pattern;
  const scriptEntry = /^sb_real_ip_entry='([^']*)'$/m.exec(
    read("deploy/docker/nginx-real-ip.envsh"),
  )?.[1];

  it("uses one expression for an entry, character for character", () => {
    expect(scriptEntry, "sb_real_ip_entry in nginx-real-ip.envsh").toBeDefined();
    expect(itemForm).toBe(scriptEntry);
    // And the list form is that same entry, separated the way the script
    // splits: commas and the three characters default word splitting uses.
    // `\s` would admit a carriage return or a non-breaking space the script
    // then refuses.
    const inner = scriptEntry!.slice(2, -2);
    const separator = "[ \\t\\n,]";
    expect(stringForm).toBe(`^${separator}*(${inner})(${separator}+(${inner}))*${separator}*$`);
  });

  it.each([
    "127.0.0.1",
    "10.4.0.0/14",
    "0.0.0.0/0",
    "10.0.0.1/8",
    "::1",
    "fd00::/8",
    "unix:",
    "130.211.0.0/22, 35.191.0.0/16 34.8.9.10",
    "localhost",
    "10.0.0",
    "10.0.0.0/33",
    "256.1.1.1",
    "a.b.c.d",
    "10.0.0.0/8\r",
    "",
    " , ",
  ])("agrees with the script about %j", (value) => {
    const script = source({ SB_TRUSTED_PROXY_CIDR: value });
    expect(new RegExp(stringForm).test(value), `schema vs. script: ${script.stderr}`).toBe(
      script.status === 0,
    );
  });

  /**
   * The three things the chart decides that no schema can see. Each is checked
   * against the image rather than against a spelling: a list is joined with a
   * separator the script is then asked to split, the off position is read out
   * of every file that writes it down, and the render-time refusal splits and
   * tests with expressions read out of the template and put to the same values
   * as the script. Rendering the chart needs helm, which this tier does not
   * have, so this is the template's logic taken apart rather than a render;
   * the renders themselves, the NOTES warning and the refusals are in the
   * deploy job of .github/workflows/verify.yml, and the image's reading of a
   * list with recursion on is in its images job.
   */
  const helpers = read("deploy/helm/simple-balance/templates/_helpers.tpl");
  const helper = /define "simple-balance\.trustedProxies" -\}\}\n([\s\S]*?)\n\{\{- end \}\}/.exec(
    helpers,
  )?.[1];

  it("joins a YAML list with a separator the image splits back into the same entries", () => {
    expect(helper, 'the "simple-balance.trustedProxies" helper in _helpers.tpl').toBeDefined();
    // A Go string literal, whose escapes are JSON's for anything a separator
    // could sensibly hold.
    const literal = /\{\{ join "((?:[^"\\]|\\.)*)" \$trusted \}\}/.exec(helper!)?.[1];
    expect(literal, "the join that turns a YAML list into one string").toBeDefined();
    const separator = JSON.parse(`"${literal}"`) as string;
    // Joined with nothing, or with anything the script does not split on, a
    // list arrives as one entry the script refuses, and every pod crashloops
    // on a values file the schema accepted.
    const entries = ["130.211.0.0/22", "35.191.0.0/16", "34.8.9.10"];
    const sourced = source({ SB_TRUSTED_PROXY_CIDR: entries.join(separator) });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(sourced.trusted).toBe(entries.join(";\nset_real_ip_from "));
  });

  it("names one off position everywhere the chart and the image write it down", () => {
    const image = /^ENV SB_TRUSTED_PROXY_CIDR=(\S+)$/m.exec(
      read("deploy/docker/frontend.Dockerfile"),
    )?.[1];
    const values = /^ {2}trustedProxyCidr: (\S+)$/m.exec(
      read("deploy/helm/simple-balance/values.yaml"),
    )?.[1];
    // What a key removed with `--set frontend.trustedProxyCidr=null` renders.
    // Without the default it is an empty value, which the image refuses, so a
    // pod that never starts.
    const removed = /\$trusted := \.Values\.frontend\.trustedProxyCidr \| default "([^"]*)"/.exec(
      helper ?? "",
    )?.[1];
    // And what NOTES.txt compares against to warn that nothing is trusted. It
    // has to read the helper's output rather than the raw value, or a list
    // holding only the off position, or the string with spaces around it,
    // installs without the warning.
    const warned = /eq \(include "simple-balance\.trustedProxies" \.\) "([^"]*)"/.exec(
      read("deploy/helm/simple-balance/templates/NOTES.txt"),
    )?.[1];
    expect(image, "the image's ENV default").toBe("127.0.0.1");
    expect({ values, removed, warned }).toEqual({
      values: image,
      removed: image,
      warned: image,
    });
  });

  it("takes recursion as a boolean, which the chart renders as nginx's on and off", () => {
    expect(frontend.realIpRecursive).toEqual({ type: "boolean" });
    const deployment = read("deploy/helm/simple-balance/templates/frontend-deployment.yaml");
    expect(deployment).toContain(
      'value: {{ ternary "on" "off" (.Values.frontend.realIpRecursive | default false) | quote }}',
    );
    expect(deployment).toContain('value: {{ include "simple-balance.trustedProxies" . | quote }}');
  });

  // The one refusal that spans two values, so the schema cannot hold it and
  // it lives in simple-balance.validate. Split on commas alone, it would let
  // a whitespace-separated list render into a pod that exits at startup.
  const guard =
    /\{\{- if \.Values\.frontend\.realIpRecursive \}\}\n\{\{- range regexSplit "((?:[^"\\]|\\.)*)" \(include "simple-balance\.trustedProxies" \.\) -1 \}\}\n\{\{- if hasSuffix "([^"]*)" \. \}\}\n\{\{- fail \(printf "([^"]*)" \.\) \}\}/.exec(
      helpers,
    );

  it.each([
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/8, 0.0.0.0/0",
    "::/0,10.0.0.0/8",
    "0.0.0.0/0 10.0.0.0/8",
    "0.0.0.0/0\t10.0.0.0/8",
    "::/0\n10.0.0.0/8",
    "10.0.0.0/8",
    "10.0.0.0/20, 10.0.0.10",
    "130.211.0.0/22, 35.191.0.0/16, 34.8.9.10",
  ])("treats %j with recursion on at render as the image does at startup", (value) => {
    expect(guard, "the range-with-recursion guard in _helpers.tpl").not.toBeNull();
    const [, split, suffix, message] = guard!;
    // A Go string literal holding an RE2 class, which JavaScript reads alike
    // for the ASCII separators the schema admits.
    const entries = value.split(new RegExp(JSON.parse(`"${split}"`) as string));
    const script = source({ SB_TRUSTED_PROXY_CIDR: value, SB_REAL_IP_RECURSIVE: "on" });
    const refusal = "which believes whatever address a caller writes first in X-Forwarded-For";
    expect(message).toContain(refusal);
    expect(
      entries.some((entry) => entry.endsWith(suffix!)),
      `chart vs. script: ${script.stderr}`,
    ).toBe(script.stderr.includes(refusal));
    expect(script.status === 0).toBe(!script.stderr.includes(refusal));
  });
});

describe("the image that runs the script", () => {
  const dockerfile = read("deploy/docker/frontend.Dockerfile");

  it("installs it where the entrypoint sources it, before the template renders", () => {
    const copy =
      /^COPY (--chmod=(\d+) )?deploy\/docker\/nginx-real-ip\.envsh \/docker-entrypoint\.d\/(\d+)-[\w-]+\.envsh$/m.exec(
        dockerfile,
      );
    expect(copy, "a COPY of nginx-real-ip.envsh into /docker-entrypoint.d").not.toBeNull();
    // Executable, or the entrypoint logs "Ignoring ... not executable" and a
    // list reaches nginx as `set_real_ip_from a, b;`, which refuses to start.
    expect(copy![2], "the mode the COPY sets").toBe("0755");
    // `sort -V` order: after the stock 15-local-resolvers.envsh, whose
    // `set -eu` this is written to survive, and before
    // 20-envsubst-on-templates.sh, which must see what this exports.
    const order = Number(copy![3]);
    expect(order).toBeGreaterThan(15);
    expect(order).toBeLessThan(20);
  });

  it("is linted on every pull request, in the workflow CodeQL leaves alone", () => {
    // deployment-profile.yml rather than verify.yml, for the CodeQL reason at
    // the top of that file; the systemd scripts' lint there is held to
    // deploy/systemd exactly by tests/systemd-scripts.test.ts, so this one is a
    // command of its own.
    const commands = read(".github/workflows/deployment-profile.yml")
      .split("\n")
      .flatMap((line) => /^\s*shellcheck\s+(\S[^\\]*)$/.exec(line)?.[1]?.trim().split(/\s+/) ?? []);
    expect(commands).toContain("deploy/docker/nginx-real-ip.envsh");
  });
});
