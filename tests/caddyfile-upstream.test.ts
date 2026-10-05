import { describe, expect, it } from "vitest";
import { repoFiles } from "./support/source.js";

/**
 * Every `reverse_proxy` upstream in every Caddyfile names a service that the
 * command bringing that Caddy up actually declares, on a port it listens on.
 *
 * Written because the opposite shipped, and was never noticed. The `vps`
 * profile's Caddyfile was a byte-for-byte copy of the `single` profile's,
 * header comment included, and said `reverse_proxy app:3000`. Its own overlay
 * documented `docker compose -f compose.frontend.yml -f compose.caddy.yml`,
 * which declares `frontend` and `caddy` and no `app` at all. Caddy resolves an
 * upstream lazily, so the container started, passed its admin-API health check
 * and returned 502 to every request: the documented TLS path for that profile
 * had never worked. Nothing in the repository read either Caddyfile.
 *
 * The population is the whole point. A Caddyfile is checked against the
 * *command* its overlay documents rather than against the directory it sits in,
 * because the directory is not what is brought up — `deploy/compose/single/`
 * holds two Compose projects that never run together, and a check that unioned
 * the directory would have found `app` for the `vps` copy too and passed the
 * bug. The command is also the thing an operator types, so a command that is
 * wrong is the defect, not a detail beside it.
 */

const caddyfiles = repoFiles((path) => path.endsWith("/Caddyfile"));
const composeFiles = repoFiles((path) => path.startsWith("deploy/") && /\.ya?ml$/.test(path));

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * The services one compose file declares, and the container ports each listens
 * on.
 *
 * The port is the right-hand side of a `ports:` mapping — the container side,
 * which is what an upstream on the Compose network connects to, and not the
 * published side, which is the host's. `"127.0.0.1:8080:8080"` and
 * `"${APP_BIND_ADDRESS:-127.0.0.1}:${APP_PORT:-3000}:3000"` both end in the
 * number that matters, so the last colon-separated field is it.
 *
 * Bounded to the `services:` block by the next key at the margin. Without that
 * bound the `volumes:` block at the end of a file reads as two more services
 * called `caddy-data` and `caddy-config`, which is not a failure that would
 * ever have fired — it is a check quietly agreeing about the wrong names.
 */
function servicesIn(text: string): Map<string, Set<string>> {
  const services = new Map<string, Set<string>>();
  const lines = text.split("\n");
  const start = lines.indexOf("services:");
  if (start === -1) return services;
  const after = lines.findIndex((line, at) => at > start && /^[A-Za-z]/.test(line));
  const block = lines.slice(start + 1, after === -1 ? undefined : after);
  let service = "";
  block.forEach((line, at) => {
    const name = /^ {2}([\w-]+):\s*$/.exec(line);
    if (name !== null) {
      service = name[1]!;
      if (!services.has(service)) services.set(service, new Set());
    }
    if (!/^ +ports:\s*$/.test(line) || service === "") return;
    for (const entry of block.slice(at + 1)) {
      if (entry.trim() === "" || entry.trimStart().startsWith("#")) continue;
      if (indentOf(entry) <= indentOf(line)) break;
      const mapping = /^\s*- "?([^"]*)"?\s*$/.exec(entry)?.[1];
      if (mapping === undefined) continue;
      // `443:443/udp` — the protocol is no part of the port an upstream names,
      // and a Caddy upstream is TCP in any case.
      services.get(service)!.add(mapping.split("/")[0]!.split(":").at(-1)!);
    }
  });
  return services;
}

/**
 * The compose file that mounts a given Caddyfile, and the compose files the
 * command in its header brings it up with.
 *
 * The two spellings in the tree are both accepted: repository-relative
 * (`-f deploy/compose/single/compose.yml`, which is how the `single` overlay
 * documents a command run from the checkout) and bare (`-f compose.caddy.yml`,
 * run from the directory on the machine). A path that resolves to no file in
 * the tree comes back as `undefined` and fails the assertion below, rather than
 * being skipped as a command this test could not read.
 */
function projectFor(caddyfile: string) {
  const directory = directoryOf(caddyfile);
  const mount = composeFiles.find(
    ({ path, text }) => directoryOf(path) === directory && /^\s*- \.\/Caddyfile:/m.test(text),
  );
  if (mount === undefined) return undefined;
  /*
   * `[ \t]` rather than `\s`, and that is the whole difference between linear
   * and exponential. The continuation this walks is
   *
   *   #   docker compose -f .../compose.yml \
   *   #                  -f .../compose.caddy.yml up -d
   *
   * and the first spelling closed the gap after `-f \S+` with `\s*`, which can
   * match the newline the continuation group `(?:\\\s*#\s+)?` also consumes.
   * Two quantifiers able to claim the same characters, inside a `+`, is
   * catastrophic backtracking: CodeQL reported it as high severity against a
   * string of many repetitions of `\# -f `. Horizontal space cannot match the
   * `\` that begins the continuation and cannot match the newline inside it,
   * so every character now has exactly one owner and the match is linear.
   *
   * Rewriting it as a line walk was the alternative and is worse here: the
   * shape being read is one commented command, and a regex that states that
   * shape is checkable against the file above it in a way a loop is not.
   */
  const command = /^#\s+(?:sudo )?docker compose ((?:-f \S+[ \t]*(?:\\\n#[ \t]*)?)+)up/m.exec(
    mount.text,
  );
  if (command === null) return undefined;
  const named = [...command[1]!.matchAll(/-f (\S+)/g)].map((match) => match[1]!);
  const resolved = named.map((name) =>
    composeFiles.find(({ path }) => path === name || path === `${directory}/${name}`),
  );
  return { mount: mount.path, named, resolved };
}

describe("what a Caddyfile proxies to", () => {
  it("finds the Caddyfiles it is checking", () => {
    // A floor rather than a fixed list: a Caddyfile added anywhere under
    // deploy/ is checked the day it lands, and a rename that emptied the
    // population fails here instead of turning every assertion below into a
    // check of nothing.
    expect(caddyfiles.length).toBeGreaterThanOrEqual(1);
    expect(caddyfiles.map(({ path }) => path)).toContain("deploy/compose/single/Caddyfile");
  });

  it.each(caddyfiles.map((file) => [file.path, file] as const))(
    "is brought up by a command this test can read, for %s",
    (path) => {
      const project = projectFor(path);

      expect(
        project,
        `${path}: no compose file beside it mounts it with a documented command`,
      ).toBeDefined();
      for (const [at, file] of project!.resolved.entries())
        expect(
          file,
          `${path}: its command names ${project!.named[at]}, which is not in the tree`,
        ).toBeDefined();
    },
  );

  it.each(caddyfiles.map((file) => [file.path, file] as const))(
    "names a service that command declares, on a port it listens on, for %s",
    (path, file) => {
      const project = projectFor(path)!;
      const services = new Map<string, Set<string>>();
      for (const compose of project.resolved)
        for (const [name, ports] of servicesIn(compose!.text))
          services.set(name, new Set([...(services.get(name) ?? []), ...ports]));

      const upstreams = file.text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .flatMap((line) => /^\s*reverse_proxy\s+(\S+)\s*$/.exec(line)?.[1] ?? []);

      // A Caddyfile with no upstream would otherwise pass by having nothing to
      // check, which is the shape this whole file exists to refuse.
      expect(upstreams.length, `${path} proxies to something`).toBeGreaterThan(0);
      for (const upstream of upstreams) {
        const [host, port] = upstream.split(":");
        expect(
          [...services.keys()],
          `${path}: reverse_proxy ${upstream}, but \`docker compose ${project.named
            .map((name) => `-f ${name}`)
            .join(" ")}\` declares no such service`,
        ).toContain(host);
        expect([...services.get(host!)!], `${path}: ${host} does not listen on ${port}`).toContain(
          port,
        );
      }
    },
  );
});
