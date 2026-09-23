import { readFileSync } from "node:fs";
import { repoFiles } from "./support/source.js";
import { describe, expect, it } from "vitest";

/**
 * The two files an operator actually copies from.
 *
 * This proves the four record names and the two pointers are present, and that
 * the run command carries the flags it is supposed to. It cannot prove the
 * section is useful: whether it answers the question somebody has at two in the
 * morning stays a person's job, and the guide's "review only" list says so.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Prose, matched however it is wrapped: every space may be a line break. */
const phrase = (text: string) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s+"));

describe("what an operator is told about getting mail delivered", () => {
  it("names the four records an operator has to publish", () => {
    const deployment = read("docs/deployment.md");
    const missing = ["SPF", "DKIM", "DMARC", "PTR"].filter((name) => !deployment.includes(name));

    expect(deployment).toContain("### Getting mail delivered");
    expect(missing).toEqual([]);
  });

  it("points at that section from the two files an operator meets first", () => {
    for (const path of ["README.md", ".env.example"]) {
      expect(read(path), path).toContain("SPF");
      expect(read(path), path).toContain("docs/deployment.md");
    }
  });

  it("keeps the RFC numbers in the standards guide", () => {
    // An operator needs the record and the registrar. A citation they cannot
    // check is worse than none, and the argument for each number lives in
    // docs/standards/operations.md where somebody is reading for the argument.
    expect(read("docs/deployment.md")).not.toMatch(/\bRFC \d+/);
  });
});

/** The fenced block holding the run command this project tells people to use. */
const documentedRunCommand = (path: string) => {
  const fenced = read(path).split("```");
  const block = fenced.find(
    (part) => part.includes("docker run") && part.includes("--env-file .env"),
  );
  expect(block, `${path} must document a docker run with --env-file`).toBeDefined();
  return block!;
};

describe("the run command people copy", () => {
  it("hands out a container that cannot write to itself or gain a privilege", () => {
    for (const path of ["README.md", "docs/deployment.md"]) {
      const command = documentedRunCommand(path);
      for (const flag of [
        "--read-only",
        "--tmpfs /tmp:rw,noexec,nosuid,size=16m",
        "--stop-timeout 30",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
      ]) {
        expect(command, `${path} must pass ${flag}`).toContain(flag);
      }
    }
  });
});

describe("the compose recipe", () => {
  const compose = read("deploy/compose/compose.distributed.yml");
  const [preamble, body] = [
    compose.slice(0, compose.indexOf("\nservices:\n")),
    compose.slice(compose.indexOf("\nservices:\n")).split("\nvolumes:\n")[0]!,
  ];
  const serviceNames = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]!);
  const hardeningOf = (name: string) => {
    const start = body.indexOf(`\n  ${name}:\n`);
    const next = serviceNames
      .map((other) => body.indexOf(`\n  ${other}:\n`))
      .filter((at) => at > start);
    const block = body.slice(start, next.length ? Math.min(...next) : undefined);
    // A service either says it itself or merges the anchor that says it.
    const text = block.includes("<<: *hardening") ? block + preamble : block;
    return {
      dropsCapabilities: text.includes("cap_drop: [ALL]"),
      cannotGainPrivileges: text.includes('security_opt: ["no-new-privileges:true"]'),
    };
  };

  it("hardens every Simple Balance service the same way", () => {
    for (const name of ["server", "frontend", "scheduler"]) {
      expect(hardeningOf(name), name).toEqual({
        dropsCapabilities: true,
        cannotGainPrivileges: true,
      });
    }
  });

  it("leaves the bundled database its capabilities, because its entrypoint needs them", () => {
    // postgres starts as root, chowns its data directory and drops to the
    // postgres user. Dropping CAP_CHOWN and friends breaks the one-command
    // trial the service exists for, so it gets the half that costs nothing.
    expect(hardeningOf("postgres")).toEqual({
      dropsCapabilities: false,
      cannotGainPrivileges: true,
    });
  });
});

/**
 * Every readiness check against PostgreSQL, wherever it is written.
 *
 * `docs/standards/operations.md` §Health checks has the reasoning: the official
 * image runs a temporary server while it executes its initdb scripts, and that
 * one listens on the unix socket alone. A `pg_isready` with no `-h` answers
 * against that server, reports healthy, and is replaced moments later — so
 * whatever was waiting connects to `FATAL: the database system is shutting
 * down`.
 *
 * This walks the repository rather than checking a list of files, because a list
 * is exactly what was wrong: one recipe had carried `-h 127.0.0.1` with the
 * reason beside it for a release while four other places — the dev database, the
 * `vps` profile's own compose file, ralph's sandbox and both CI service
 * containers — were still checking the socket. Nobody had copied the reasoning
 * across, and nothing could have noticed.
 */
describe("waiting for PostgreSQL", () => {
  it("goes over TCP everywhere, never over the unix socket", () => {
    const offenders: string[] = [];
    // Discovered, not listed. `tests/support/source.ts` has the argument; the
    // short version is that the first version of this check carried a list and
    // missed four of the five places that wait for PostgreSQL.
    for (const { path: file, text } of repoFiles(() => true)) {
      if (!text.includes("pg_isready")) continue;
      if (file.endsWith("deployment-docs.test.ts")) continue;
      const markdown = file.endsWith(".md");
      let fenced = false;
      for (const [index, line] of text.split("\n").entries()) {
        // In a document, prose *about* the command is not a command. What is, is
        // anything inside a fence — an operator copies those, and the upgrade
        // note's own procedure told them to wait on the socket for a release.
        if (markdown && line.trimStart().startsWith("```")) {
          fenced = !fenced;
          continue;
        }
        if (!line.includes("pg_isready")) continue;
        if (markdown && !fenced) continue;
        if (/pg_isready[^\n]*-h\s/.test(line)) continue;
        offenders.push(`${file}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Every Simple Balance container in every compose file, hardened the same way.
 *
 * The block above this one checks `compose.distributed.yml` by name, which was
 * the whole population when it was written and is now one file of ten. This
 * release added five — the `vps` profile's four and the capacity harness — and
 * nothing looked at any of them; the harness turned out to be running the
 * application image with no `cap_drop` and no `no-new-privileges` at all, which
 * makes a measurement taken against a container configured unlike the
 * deployment.
 *
 * The population is every service whose image is a Simple Balance one. That is
 * the right boundary rather than "every service": `postgres` and `caddy` are
 * somebody else's images with their own needs, and the one exception among them
 * is argued where it lives — PostgreSQL's entrypoint starts as root, chowns its
 * data directory and drops privileges, so it keeps the capabilities it needs and
 * takes the half that costs nothing.
 */
describe("hardening, across every compose file", () => {
  /** Services are the keys under `services:` and above `volumes:`/`networks:`. */
  const servicesOf = (text: string) => {
    const start = text.indexOf("\nservices:\n");
    if (start < 0) return [];
    let body = text.slice(start);
    for (const end of ["\nvolumes:\n", "\nnetworks:\n", "\nsecrets:\n"]) {
      const at = body.indexOf(end);
      if (at > 0) body = body.slice(0, at);
    }
    const names = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]!);
    return names.map((name) => {
      const at = body.indexOf(`\n  ${name}:\n`);
      const nexts = names.map((other) => body.indexOf(`\n  ${other}:\n`)).filter((x) => x > at);
      let block = body.slice(at, nexts.length ? Math.min(...nexts) : undefined);
      // A service either states it or merges an anchor that does.
      if (block.includes("<<: *hardening")) block += text.slice(0, start);
      // Comments explain hardening as often as they apply it — one compose file
      // says "No cap_drop here, and this is the exception rather than an
      // oversight" — so a check that read them would pass on the explanation.
      const code = block
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      return { name, code };
    });
  };

  const composeFiles = repoFiles((file) => /(^|\/)compose[a-z.]*\.ya?ml$/.test(file));

  it("finds every compose file in the tree", () => {
    // Without this the regex could stop matching and every assertion below would
    // pass over an empty population, which is the failure a list makes slowly.
    expect(composeFiles.length).toBeGreaterThanOrEqual(8);
    expect(composeFiles.map((file) => file.path)).toContain("deploy/compose/vps/compose.app.yml");
  });

  it("drops every capability from every Simple Balance service", () => {
    const unhardened: string[] = [];
    for (const file of composeFiles) {
      for (const service of servicesOf(file.text)) {
        if (!/image:\s*\S*simple-balance/.test(service.code)) continue;
        const dropped = service.code.includes("cap_drop: [ALL]");
        const noPrivileges = service.code.includes("no-new-privileges");
        if (!dropped || !noPrivileges) {
          unhardened.push(
            `${file.path} ${service.name}${dropped ? "" : " (cap_drop)"}${noPrivileges ? "" : " (no-new-privileges)"}`,
          );
        }
      }
    }
    expect(unhardened).toEqual([]);
  });
});

/**
 * What the single-machine programs are said to run, where an operator reads it.
 *
 * Both programs stopped bundling PostgreSQL and several pages went on saying
 * they had not: the Pulumi README said the machine ran its own database and
 * there was no URL to supply, two paragraphs above the one saying to supply it,
 * and an owner who believed it provisioned nothing and budgeted $0. These are
 * the sentences that would have to come back for that to happen again, and the
 * ones the Oracle path cannot do without.
 */
describe("the single-machine programs, as the Pulumi README describes them", () => {
  const readme = read("deploy/pulumi/README.md");
  const section = (heading: string) => {
    const start = readme.indexOf(`\n### ${heading}\n`);
    expect(start, `README has "### ${heading}"`).toBeGreaterThan(-1);
    const end = readme.indexOf("\n### ", start + 1);
    return readme.slice(start, end === -1 ? undefined : end);
  };

  it("never says the machine runs its own database", () => {
    for (const path of [
      "deploy/pulumi/README.md",
      "deploy/pulumi/oci-single/Pulumi.yaml",
      "deploy/pulumi/aws-single/Pulumi.yaml",
    ]) {
      expect(read(path), path).not.toMatch(
        /runs its own PostgreSQL|PostgreSQL and\s+Caddy|the database lives on|reserved public IP/,
      );
    }
    for (const path of [
      "deploy/pulumi/oci-single/Pulumi.yaml",
      "deploy/pulumi/aws-single/Pulumi.yaml",
    ]) {
      expect(read(path), path).toMatch(/creates no\s+database/);
    }
  });

  it("walks through a database for Oracle Cloud, and says it is not free", () => {
    const oracle = section("A database for Oracle Cloud");
    for (const needed of [
      "Always Free",
      "simple-balance:databaseSubnet true",
      "PostgreSQL 15 or later",
      "private endpoint",
      "URL-encoded",
      "sslmode=no-verify",
      "DATABASE_URL='postgresql://",
    ]) {
      expect(oracle, needed).toContain(needed);
    }
  });

  it("says a setting is an edit to env.local and a restart", () => {
    expect(readme).toMatch(
      /# A setting\.\nsudo nano \/var\/lib\/simple-balance\/env\.local\nsudo systemctl restart simple-balance\n/,
    );
    // EDITOR is unset on a fresh Ubuntu, where `sudo $EDITOR file` runs the file.
    expect(readme).not.toContain("$EDITOR");
    expect(section("`DATABASE_URL` goes on the machine")).toContain(
      "sudo /usr/local/sbin/simple-balance-firstboot",
    );
  });

  it("says which release the programs deploy, and that it is the one they pin", () => {
    // The pin is set-version's to move, and this sentence is not: it names a
    // release that has no billing, no ads and a frontend that reads no
    // SB_TRUSTED_PROXY_CIDR, which stops being true the moment the pin reaches
    // one that does. So it has to name the pin while the pin is before 0.2.0,
    // and has to be gone once it is not — whatever it lists by then.
    const pinned = /DEFAULT_IMAGE = "ghcr\.io\/thtmnisamnstr\/simple-balance:([^"]+)"/.exec(
      read("deploy/pulumi/single-common/index.ts"),
    )?.[1];
    expect(pinned, "DEFAULT_IMAGE in single-common/index.ts").toBeDefined();
    expect(
      /^appVersion: "([^"]+)"$/m.exec(read("deploy/helm/simple-balance/Chart.yaml"))?.[1],
    ).toBe(pinned);
    const [major, minor] = pinned!.split(".").map(Number);
    const claim =
      /deploys the pinned release image, which until\s+0\.2\.0 is released is (\S+) and predates\s+([^;]+);/.exec(
        readme,
      );
    if (major === 0 && minor! < 2) {
      expect(claim?.[1], "the release the README names").toBe(pinned);
      // The trusted-proxy setting is in the list because the README describes
      // `trustedProxyCidr` as working, and on the pin nothing reads it.
      expect(claim?.[2].replace(/\s+/g, " ")).toBe(
        "billing, ads and the frontend's trusted-proxy setting",
      );
    } else expect(claim, "the README still says what the pin predates").toBeNull();
    expect(readme).toMatch(/`simple-balance:imageTag` selects another\s+published\s+release/);
  });

  it("gives no instruction for building or publishing an image of a branch", () => {
    // The programs deploy published releases and nothing else. The README once
    // told people how to build and publish an image of a branch, and an image
    // like that runs migrations no release has shipped against whatever
    // database it is pointed at.
    const files = repoFiles(
      (file) =>
        /^deploy\/(pulumi|systemd)\//.test(file) ||
        file === ".github/workflows/deployment-profile.yml",
    );
    expect(files.map((file) => file.path)).toContain("deploy/pulumi/README.md");
    const offenders = files
      .filter(({ text }) =>
        /preview-images|preview-<|preview-[0-9a-f]{12}\b|\bbuildx\b|preview image|running a branch|\b002[2-4]\b/i.test(
          text,
        ),
      )
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("says what a resize and a replacement each do to the machine", () => {
    // A resize is in place on both clouds. It was once described as destroying
    // the root disk, and a promoted reserved IP as following a replacement.
    expect(readme).not.toMatch(/resizing — change `size`, deploy — destroys/);
    expect(readme).not.toMatch(/unless it has been\s+promoted to reserved/);
    expect(readme).toContain("**Resizing is not a rebuild.**");
    expect(readme).toMatch(/Two things take the volume\s+with it: `pulumi destroy`/);
    // A new machine brings back the stack's image and not the schema an
    // upgrade migrated to, which docs/upgrades.md says never to run it against.
    expect(readme).not.toMatch(/way back from an\s+upgrade/);
    expect(readme).toMatch(
      /the way back from a machine that has gone\s+wrong, not from an upgrade\. An upgrade is undone on the machine, as\s+\[docs\/upgrades\.md\]\(\.\.\/\.\.\/docs\/upgrades\.md#rolling-back\) says/,
    );
    expect(read("docs/upgrades.md")).toContain("\n## Rolling back\n");
    // The volume arrives after the new machine boots, and can arrive after
    // firstboot has stopped waiting for it.
    expect(readme).toMatch(
      /If the move takes longer, `sudo cloud-init status` there reports an error: run\s+`sudo \/usr\/local\/sbin\/simple-balance-firstboot`/,
    );
  });

  it("bills the managed database, not every database", () => {
    expect(readme).not.toMatch(
      /Always Free has no PostgreSQL|separate, billed thing wherever it runs/,
    );
    expect(section("A database for Oracle Cloud")).toMatch(
      /OCI Database with PostgreSQL is not part of Always Free/,
    );
  });

  it("takes a backup by hand through the unit, onto the data volume", () => {
    expect(readme).toContain(
      "Take a backup first either way: `sudo systemctl start simple-balance-backup`.",
    );
    expect(readme).not.toContain("Take a backup first either way: `sudo /usr/local/bin/");
  });
});

/**
 * The deployment pages' claims about the `single` profile and the cloud
 * programs, which drifted from what the programs build: a bundled PostgreSQL
 * that no longer exists, a data disk OCI would refuse, a nginx edit the image
 * no longer needs. Each is a sentence that would have to come back for the old
 * mistake to return, or one the corrected page cannot do without.
 */
describe("the deployment pages, against what the programs build", () => {
  const deployment = read("docs/deployment.md");
  const profiles = read("docs/deployment-profiles.md");
  const sizing = read("docs/deployment-sizing.md");
  const costs = read("docs/deployment-costs.md");

  it("makes the trusted proxy one setting, with recursion off", () => {
    expect(deployment).not.toMatch(phrase("real_ip_recursive on"));
    expect(deployment).not.toMatch(phrase("set_real_ip_from <your"));
    expect(deployment).toContain("frontend.trustedProxyCidr");
  });

  it("counts no list it could drift away from", () => {
    expect(deployment).not.toMatch(/\b(Six|Seven|Eight|Nine)\s+(settings|things)\b/);
  });

  it("gives billing's grace, retries and ads the conditions the server applies", () => {
    expect(deployment).toMatch(phrase("fifteen-day grace"));
    expect(deployment).not.toMatch(phrase("seven-day grace"));
    expect(deployment).toMatch(phrase("Revenue recovery"));
    expect(deployment).toMatch(phrase("shown only where a plan is for sale"));
  });

  it("says what the backups do with sslmode", () => {
    expect(deployment).toMatch(phrase("`sslmode=no-verify` becomes `sslmode=require`"));
  });

  it("runs no database on the single machine", () => {
    expect(deployment).not.toMatch(phrase("with PostgreSQL, TLS, backups"));
    expect(profiles).not.toContain("POSTGRES_PASSWORD");
    expect(profiles).not.toMatch(phrase("reaches PostgreSQL as `postgres`"));
    expect(profiles).toMatch(/^\| The host \| The database \|/m);
    expect(profiles).not.toMatch(phrase("holds the database, the backups"));
    expect(profiles).toMatch(phrase("every time the deployment starts"));
    expect(sizing).not.toMatch(/docker compose (exec -T|logs) postgres/);
    expect(sizing).not.toContain("POSTGRES_MAX_CONNECTIONS");
    expect(sizing).not.toMatch(phrase("write into `.env`"));
  });

  it("prices the database as a line of its own, and the OCI disk as what OCI accepts", () => {
    expect(costs).not.toMatch(phrase("no managed database bill"));
    expect(costs).toMatch(phrase("not part of Always Free"));
    expect(costs).toMatch(phrase("2/4 + 100 GB"));
    expect(sizing).toMatch(phrase("raises a data disk under 50 GB to 50"));
  });

  it("answers a capacity shortage with another availability domain", () => {
    expect(costs).toContain("simple-balance:availabilityDomain");
  });
});

describe("the compose READMEs, against the unit and the chart", () => {
  it("sends a hand install to the .env the unit reads", () => {
    // The unit runs from /opt/simple-balance, and its header copies .env there.
    // The copy in the repository is what `docker compose up` in that directory
    // reads, so an edit to it restarts the unit onto the settings it had.
    const unit = read("deploy/systemd/simple-balance.service");
    expect(unit).toContain("\nWorkingDirectory=/opt/simple-balance\n");
    expect(unit).toContain("/opt/simple-balance/.env  # then edit it");
    const single = read("deploy/compose/single/README.md");
    expect(single).not.toMatch(phrase("it is `.env`, the file you wrote"));
    expect(single).toMatch(
      phrase(
        "Installed by hand, it is `/opt/simple-balance/.env`, the copy the unit's header installs",
      ),
    );
  });

  it("says the chart can run the database, when asked to", () => {
    const values = read("deploy/helm/simple-balance/values.yaml");
    expect(values).toMatch(/^database:\n {2}enabled: false\n/m);
    const compose = read("deploy/compose/README.md");
    expect(compose).not.toMatch(phrase("The chart provisions no database."));
    expect(compose).toMatch(
      phrase(
        "The chart provisions no database by default. A cluster's PostgreSQL is bring your own unless `database.enabled` runs",
      ),
    );
  });
});
