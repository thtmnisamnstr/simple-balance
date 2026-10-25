import { describe, expect, it } from "vitest";
import {
  COLLECTOR_DEFAULTS,
  COLLECTOR_SECRET_SETTINGS,
  COLLECTOR_SETTINGS,
  METRICS_EXPORT_PROTOCOLS,
} from "../deploy/pulumi/common/app-settings.js";
import { repoFiles } from "./support/source.js";

/**
 * The metrics collector and node-exporter: the two services every metrics
 * profile adds, their configuration, and the settings a stack may give them.
 *
 * Everything here is read as text. No YAML parser is among this repository's
 * dependencies — the decision `tests/env-example.test.ts` records — so the
 * collector configurations are held to the small subset of YAML the reader
 * below understands, and a line outside it fails by name rather than reading
 * as something it is not. What this cannot do is run the collector: the
 * configurations were validated against the pinned binary with
 * `otelcol validate`, and that is the check to repeat when either changes.
 */

type Yaml = string | Yaml[] | { [key: string]: Yaml };
type Mapping = { [key: string]: Yaml };

const indentOf = (line: string) => line.length - line.trimStart().length;

/** One scalar: double-quoted, a flow list of scalars, `{}`, or plain. */
function scalar(text: string, where: string): Yaml {
  const value = text.trim();
  if (value.startsWith('"')) return JSON.parse(value) as string;
  if (value === "{}") return {};
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => scalar(item, where) as string);
  }
  if (/\s#/.test(value)) throw new Error(`${where}: a trailing comment this reader refuses`);
  if (/^[[{]/.test(value)) throw new Error(`${where}: a flow collection this reader cannot read`);
  return value;
}

/**
 * The subset of YAML the collector configurations are written in: block
 * mappings, block sequences whose items are scalars or mappings, and the
 * scalars above. Whole-line comments and blank lines are skipped.
 */
function parseYaml(text: string, path: string): Mapping {
  const lines = text
    .split("\n")
    .map((raw, index) => ({ raw: raw.replace(/\s+$/, ""), where: `${path}:${index + 1}` }))
    .filter(({ raw }) => raw.trim() !== "" && !raw.trimStart().startsWith("#"));
  let at = 0;

  const node = (indent: number): Yaml => {
    const line = lines[at]!;
    return line.raw.slice(indent).startsWith("- ") ? sequence(indent) : mapping(indent);
  };

  const sequence = (indent: number): Yaml[] => {
    const items: Yaml[] = [];
    while (at < lines.length && indentOf(lines[at]!.raw) === indent) {
      const line = lines[at]!;
      if (!line.raw.slice(indent).startsWith("- ")) break;
      const rest = line.raw.slice(indent + 2);
      if (/^[A-Za-z0-9_./-]+:(?: |$)/.test(rest)) {
        // A mapping that starts on the item's own line: read it as though the
        // dash were two spaces, which is what YAML means by it.
        lines[at] = { ...line, raw: " ".repeat(indent + 2) + rest };
        items.push(mapping(indent + 2));
      } else {
        items.push(scalar(rest, line.where));
        at += 1;
      }
    }
    return items;
  };

  const mapping = (indent: number): Mapping => {
    const out: Mapping = {};
    while (at < lines.length && indentOf(lines[at]!.raw) === indent) {
      const line = lines[at]!;
      const match = /^([A-Za-z0-9_./-]+):(?: (.*))?$/.exec(line.raw.slice(indent));
      if (!match) throw new Error(`${line.where}: a line this reader cannot read: ${line.raw}`);
      const [, key, value] = match;
      if (key! in out) throw new Error(`${line.where}: ${key} twice`);
      at += 1;
      if (value !== undefined && value.trim() !== "") {
        out[key!] = scalar(value, line.where);
      } else {
        const next = lines[at];
        if (next === undefined || indentOf(next.raw) <= indent) {
          throw new Error(`${line.where}: ${key} has no value`);
        }
        out[key!] = node(indentOf(next.raw));
      }
    }
    if (at < lines.length && indentOf(lines[at]!.raw) > indent) {
      throw new Error(`${lines[at]!.where}: indented further than anything it belongs to`);
    }
    return out;
  };

  const document = mapping(0);
  if (at !== lines.length) throw new Error(`${lines[at]!.where}: left unread`);
  return document;
}

const get = (value: Yaml | undefined, ...keys: string[]): Yaml | undefined =>
  keys.reduce<Yaml | undefined>(
    (current, key) =>
      current !== undefined && typeof current === "object" && !Array.isArray(current)
        ? current[key]
        : undefined,
    value,
  );
const asMapping = (value: Yaml | undefined): Mapping =>
  value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};

/** Every collector configuration under deploy/compose, discovered. */
const configs = repoFiles(
  (path) => path.startsWith("deploy/compose/") && /(^|\/)collector[\w.-]*\.yaml$/.test(path),
).map((file) => ({ ...file, yaml: parseYaml(file.text, file.path) }));

/**
 * The `${env:NAME...}` names a collector configuration reads, comments left
 * out: the header explains the expansion rules with an example, and an example
 * is not a name anything sets.
 */
const envReads = (text: string) =>
  new Set(
    [
      ...text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n")
        .matchAll(/\$\{env:([A-Z][A-Z0-9_]*)/g),
    ].map((match) => match[1]!),
  );

/** `${env:NAME:-default}` read out of a value, or undefined when it has none. */
const envDefault = (value: Yaml | undefined, name: string) =>
  typeof value === "string"
    ? new RegExp(`\\$\\{env:${name}:-([^}]*)\\}`).exec(value)?.[1]
    : undefined;

/** A Prometheus duration in seconds, for the handful of shapes a default takes. */
const seconds = (text: string) => {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!match || text === "") throw new Error(`not a duration this test reads: ${text}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
};

describe("the collector's configuration", () => {
  it("finds both compose shapes' configurations, and reads every line of each", () => {
    expect(configs.map((config) => config.path)).toEqual([
      "deploy/compose/collector.distributed.yaml",
      "deploy/compose/single/collector.yaml",
    ]);
    for (const { path, yaml } of configs) {
      for (const section of ["receivers", "processors", "exporters", "connectors", "service"]) {
        expect(get(yaml, section), `${path} ${section}`).toBeDefined();
      }
    }
  });

  /**
   * The block every copy shares, as text, comments and all.
   *
   * Every file under deploy/ that carries the opening line is held to it, the
   * Helm chart's ConfigMap included, so a copy that drifts fails here by path
   * rather than shipping a pipeline that behaves differently in one profile.
   * Text rather than parsed values so that the reasoning beside each number
   * cannot drift either; the indentation a template adds is taken off first.
   */
  const OPEN = "# ---- the export pipeline, shared ";
  const CLOSE = "# ---- end of the export pipeline ";
  const shared = repoFiles((path) => path.startsWith("deploy/"))
    .filter(({ text }) => text.includes(OPEN))
    .map(({ path, text }) => {
      const lines = text.split("\n");
      const start = lines.findIndex((line) => line.trimStart().startsWith(OPEN));
      const end = lines.findIndex((line, at) => at > start && line.trimStart().startsWith(CLOSE));
      const block = lines.slice(start, end + 1);
      const margin = indentOf(block[0]!);
      return {
        path,
        closed: end > start,
        block: block.map((line) => line.slice(Math.min(margin, indentOf(line)))).join("\n"),
      };
    });

  it("shares one export pipeline, word for word, in every copy", () => {
    expect(shared.map(({ path }) => path)).toEqual(
      expect.arrayContaining(configs.map(({ path }) => path)),
    );
    for (const copy of shared) {
      expect(copy.closed, `${copy.path} closes the shared block`).toBe(true);
      expect(copy.block, copy.path).toBe(shared[0]!.block);
    }
    // And parsed, so the claim is about behavior and not only about text.
    const [first, ...rest] = configs;
    for (const config of rest) {
      for (const section of ["processors", "exporters", "connectors", "service"]) {
        expect(get(config.yaml, section), `${config.path} ${section}`).toEqual(
          get(first!.yaml, section),
        );
      }
      expect(get(config.yaml, "receivers", "nop"), config.path).toEqual({});
    }
  });

  it("names only components it defines, in every pipeline, whichever protocol is chosen", () => {
    for (const { path, yaml } of configs) {
      const defined = (kind: string) => Object.keys(asMapping(get(yaml, kind)));
      for (const protocol of METRICS_EXPORT_PROTOCOLS) {
        for (const [name, pipeline] of Object.entries(
          asMapping(get(yaml, "service", "pipelines")),
        )) {
          const names = (key: string) =>
            ((get(pipeline, key) ?? []) as string[]).map((entry) =>
              entry.replace(/\$\{env:SB_METRICS_EXPORT_PROTOCOL:-[^}]*\}/, protocol),
            );
          const connectors = defined("connectors");
          for (const receiver of names("receivers"))
            expect([...defined("receivers"), ...connectors], `${path} ${name}`).toContain(receiver);
          for (const processor of names("processors"))
            expect(defined("processors"), `${path} ${name}`).toContain(processor);
          for (const exporter of names("exporters"))
            expect([...defined("exporters"), ...connectors], `${path} ${name}`).toContain(exporter);
        }
      }
    }
  });

  it("sends to exactly one exporter for each protocol a stack may name, and otlp by default", () => {
    for (const { path, yaml } of configs) {
      const pipelines = asMapping(get(yaml, "service", "pipelines"));
      const chosen = get(pipelines, "metrics", "exporters") as string[];
      expect(chosen, path).toEqual(["forward/${env:SB_METRICS_EXPORT_PROTOCOL:-otlp}"]);
      expect(envDefault(chosen[0], "SB_METRICS_EXPORT_PROTOCOL"), path).toBe(
        COLLECTOR_DEFAULTS.SB_METRICS_EXPORT_PROTOCOL,
      );
      for (const protocol of METRICS_EXPORT_PROTOCOLS) {
        const fed = Object.values(pipelines).filter((pipeline) =>
          ((get(pipeline, "receivers") ?? []) as string[]).includes(`forward/${protocol}`),
        );
        // The pipeline that carries data, and the idle one that keeps every
        // connector valid; only the first reaches a real exporter.
        const exporting = fed.filter(
          (pipeline) => !((get(pipeline, "receivers") ?? []) as string[]).includes("nop"),
        );
        expect(exporting.length, `${path} forward/${protocol}`).toBe(1);
        expect((get(exporting[0], "exporters") as string[]).length, protocol).toBe(1);
      }
      // The idle pipeline is fed by nothing that ever produces a point.
      expect(get(pipelines, "metrics/unchosen", "receivers"), path).toEqual(["nop"]);
    }
  });

  it("puts the memory limiter first, so a backlog is refused before it is held", () => {
    for (const { path, yaml } of configs) {
      expect(get(yaml, "service", "pipelines", "metrics", "processors"), path).toEqual([
        "memory_limiter",
        "resource",
        "batch",
      ]);
    }
  });

  it("scrapes under five minutes by default, which is when New Relic forgets a counter", () => {
    for (const { path, yaml } of configs) {
      const interval = get(yaml, "receivers", "prometheus", "config", "global", "scrape_interval");
      const fallback = envDefault(interval, "SB_METRICS_SCRAPE_INTERVAL");
      expect(fallback, path).toBe(COLLECTOR_DEFAULTS.SB_METRICS_SCRAPE_INTERVAL);
      expect(seconds(fallback!), path).toBeLessThan(300);
      // No job may set a slower one of its own.
      for (const job of (get(yaml, "receivers", "prometheus", "config", "scrape_configs") ??
        []) as Yaml[]) {
        expect(get(job, "scrape_interval"), `${path} ${get(job, "job_name") as string}`).toBe(
          undefined,
        );
      }
    }
  });

  it("listens on loopback alone, for its health check and its own figures", () => {
    for (const { path, yaml } of configs) {
      expect(get(yaml, "extensions", "health_check", "endpoint"), path).toMatch(/^127\.0\.0\.1:/);
      const reader = (get(yaml, "service", "telemetry", "metrics", "readers") as Yaml[])[0];
      expect(get(reader, "pull", "exporter", "prometheus", "host"), path).toBe("127.0.0.1");
    }
  });

  it("drops an empty database target rather than scraping an address that is not there", () => {
    const single = configs.find(
      (config) => config.path === "deploy/compose/single/collector.yaml",
    )!;
    const jobs = get(single.yaml, "receivers", "prometheus", "config", "scrape_configs") as Yaml[];
    const database = jobs.find((job) => get(job, "job_name") === "node-database");
    expect(get(database, "scheme")).toBe("https");
    expect(get(database, "tls_config", "ca_file")).toBe("${env:SB_METRICS_DATABASE_CA_FILE:-}");
    expect(get((get(database, "static_configs") as Yaml[])[0], "targets")).toEqual([
      "${env:SB_METRICS_DATABASE_TARGET:-}",
    ]);
    expect(get(database, "relabel_configs")).toEqual([
      { source_labels: ["__address__"], regex: "", action: "drop" },
    ]);
  });
});

/**
 * The compose services, wherever they appear: every compose file under
 * deploy/compose, so a profile that adds a collector or a node-exporter of its
 * own — the database machine's — is held the day it lands.
 */
const composeFiles = repoFiles(
  (path) => path.startsWith("deploy/compose/") && /\.ya?ml$/.test(path) && !/collector/.test(path),
);

/** Every service in a compose file, as its own lines with comments taken out. */
function servicesOf(text: string) {
  const lines = text.split("\n");
  const start = lines.indexOf("services:");
  if (start === -1) return [];
  const end = lines.findIndex((line, at) => at > start && /^[A-Za-z]/.test(line));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => !line.trimStart().startsWith("#"));
  const out: { name: string; code: string }[] = [];
  for (const [at, line] of body.entries()) {
    const name = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (name === undefined) continue;
    const rest = body.slice(at + 1);
    const next = rest.findIndex((entry) => /^ {2}[\w-]+:\s*$/.test(entry));
    out.push({ name, code: rest.slice(0, next === -1 ? undefined : next).join("\n") });
  }
  return out;
}

const IMAGES = ["otel/opentelemetry-collector", "prom/node-exporter"];
const services = composeFiles.flatMap(({ path, text }) =>
  servicesOf(text).map((service) => ({ ...service, path, text })),
);
const watchers = services.filter(({ code }) =>
  IMAGES.some((image) => code.includes(`image: ${image}`)),
);

describe("the services that run them", () => {
  it("finds a collector and a node-exporter in both compose shapes", () => {
    for (const path of [
      "deploy/compose/compose.distributed.yml",
      "deploy/compose/single/compose.yml",
    ]) {
      expect(
        watchers.filter((service) => service.path === path).map((service) => service.name),
        path,
      ).toEqual(expect.arrayContaining(["collector", "node-exporter"]));
    }
  });

  it("pins every image by tag and digest, and every copy of one to the same pair", () => {
    // A tag alone can be pushed again; the digest is what makes the image a
    // machine pulls the one that was measured and validated.
    const pins = new Map<string, Set<string>>();
    for (const { path, name, code } of watchers) {
      const image = /^\s+image: (\S+)$/m.exec(code)?.[1] ?? "";
      expect(image, `${path} ${name}`).toMatch(
        /^[a-z0-9./-]+:v?\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
      );
      const repository = image.slice(0, image.indexOf(":"));
      pins.set(repository, new Set([...(pins.get(repository) ?? []), image]));
    }
    for (const [repository, images] of pins) expect([...images], repository).toHaveLength(1);
    expect([...pins.keys()].sort()).toEqual([...IMAGES].sort());
  });

  /**
   * Every entry for a collector or a node-exporter, overlays included: an
   * overlay that adds one without the profile would start it on a deployment
   * that never asked, which is the one thing a release may not do.
   */
  it("starts nothing unless the metrics profile is on", () => {
    const entries = services.filter(({ name }) => ["collector", "node-exporter"].includes(name));
    expect(entries.length).toBeGreaterThanOrEqual(watchers.length);
    for (const { path, name, code } of entries) {
      expect(code, `${path} ${name}`).toMatch(/^ {4}profiles: \["metrics"\]$/m);
    }
  });

  it("hardens each one: read-only, no capabilities, no new privileges, not root", () => {
    for (const { path, name, code, text } of watchers) {
      const at = `${path} ${name}`;
      expect(code, at).toMatch(/^ {4}read_only: true$/m);
      const merged = code.includes("<<: *hardening")
        ? `${code}\n${text.slice(0, text.indexOf("\nservices:\n"))}`
        : code;
      expect(merged, at).toContain("cap_drop: [ALL]");
      expect(merged, at).toContain('security_opt: ["no-new-privileges:true"]');
      const user = /^ {4}user: "(\d+):(\d+)"$/m.exec(code);
      expect(user, `${at} names its user`).not.toBeNull();
      expect(Number(user![1]), at).toBeGreaterThan(0);
    }
  });

  it("gives each one a memory ceiling, and the Go runtime one below it", () => {
    const mebibytes = (text: string) => {
      const match = /^(\d+)(m|MiB)$/.exec(text);
      if (!match) throw new Error(`not a size this test reads: ${text}`);
      return Number(match[1]);
    };
    for (const { path, name, code } of watchers) {
      const at = `${path} ${name}`;
      const limit = /^ {4}mem_limit: (\S+)$/m.exec(code)?.[1];
      const runtime = /^ {6}GOMEMLIMIT: (\S+)$/m.exec(code)?.[1];
      expect(limit, at).toBeDefined();
      expect(runtime, at).toBeDefined();
      expect(mebibytes(runtime!), at).toBeLessThan(mebibytes(limit!));
    }
  });

  it("rotates each one's log, the way every other service on the machine does", () => {
    for (const { path, name, code, text } of watchers) {
      const at = `${path} ${name}`;
      const logging = /^ {4}logging:(?: (?:\*|&)([\w-]+))?$/m.exec(code);
      expect(logging, `${at} sets logging`).not.toBeNull();
      // Written out under the key, or an anchor defined anywhere in the file.
      const block = logging![1]
        ? (new RegExp(`logging: &${logging![1]}\\n((?: {6,}.*\\n)+)`).exec(text)?.[1] ?? "")
        : (/^ {4}logging:\n((?: {6,}.*\n?)+)/m.exec(code)?.[1] ?? "");
      expect(block, at).toContain("driver: json-file");
      expect(block, at).toMatch(/max-size: "\d+m"/);
      expect(block, at).toMatch(/max-file: "\d+"/);
    }
  });

  it("publishes nothing, and on the host's network listens on loopback or a private address over TLS", () => {
    for (const { path, name, code } of watchers) {
      const at = `${path} ${name}`;
      expect(code, at).not.toMatch(/^ {4}ports:/m);
      if (!/^ {4}network_mode: host$/m.test(code)) continue;
      if (name === "collector") continue; // its listeners are in its configuration, held above
      // To the end of the line rather than the first space, because the
      // database machine's address carries a `:?` message with spaces in it.
      const listen = /--web\.listen-address=(.+)$/m.exec(code)?.[1] ?? "";
      const loopback = /^127\.0\.0\.1:\d+$/.test(listen);
      const privateTls =
        /^\$\{SB_[A-Z0-9_]+:\?[^}]*\}:\d+$/.test(listen) && code.includes("--web.config.file=");
      expect(loopback || privateTls, `${at} listens on ${listen || "every address"}`).toBe(true);
    }
  });

  it("chooses node-exporter's collectors rather than taking its forty defaults", () => {
    for (const { path, name, code } of watchers.filter(
      (service) => service.name === "node-exporter",
    )) {
      expect(code, `${path} ${name}`).toContain("--collector.disable-defaults");
      // A network collector in a namespace of its own reports that namespace's
      // one interface as the machine's, so it runs only on the host's network.
      if (code.includes("--collector.netdev")) {
        expect(code, `${path} ${name}`).toMatch(/^ {4}network_mode: host$/m);
      }
    }
  });

  it("mounts each collector's configuration read-only, from a file beside it that exists", () => {
    for (const { path, name, code } of watchers.filter((service) => service.name === "collector")) {
      const source =
        /source: \.\/(collector[\w.-]*\.yaml)\n\s+target: \/etc\/otelcol\/config\.yaml\n\s+read_only: true\n\s+bind:\n\s+create_host_path: false/.exec(
          code,
        )?.[1];
      expect(source, `${path} ${name}`).toBeDefined();
      const beside = `${path.slice(0, path.lastIndexOf("/"))}/${source}`;
      expect(
        configs.map((config) => config.path),
        path,
      ).toContain(beside);
    }
  });
});

describe("the settings a stack may give it", () => {
  /** Every `${NAME` a compose file interpolates from .env, comments left out. */
  const interpolated = new Set(
    composeFiles.flatMap(({ text }) =>
      [
        ...text
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n")
          .matchAll(/\$\{(SB_METRICS_[A-Z0-9_]+)/g),
      ].map((match) => match[1]!),
    ),
  );

  it("is exactly the SB_METRICS_ names the compose files read from .env", () => {
    // The allow-list readAppSettings accepts, derived rather than trusted: a
    // name the collector gains would otherwise be refused by every stack, and
    // one it loses accepted and ignored.
    expect([...COLLECTOR_SETTINGS].sort()).toEqual([...interpolated].sort());
    for (const name of COLLECTOR_SECRET_SETTINGS) expect(COLLECTOR_SETTINGS).toContain(name);
  });

  it("passes each collector exactly what its configuration reads", () => {
    for (const config of configs) {
      const directory = config.path.slice(0, config.path.lastIndexOf("/"));
      // The service and every overlay in the same directory that adds to it.
      const passed = new Set(
        services
          .filter(
            (service) =>
              service.name === "collector" &&
              service.path.slice(0, service.path.lastIndexOf("/")) === directory,
          )
          .flatMap(({ code }) => [...code.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!)),
      );
      // GOMEMLIMIT is read by the Go runtime rather than by the configuration.
      passed.delete("GOMEMLIMIT");
      expect([...envReads(config.text)].sort(), config.path).toEqual([...passed].sort());
    }
  });

  it("defaults each one the same way in every compose file and in the deploy programs", () => {
    for (const [name, value] of Object.entries(COLLECTOR_DEFAULTS)) {
      const spelled = composeFiles.flatMap(({ text }) =>
        [...text.matchAll(new RegExp(`\\$\\{${name}:-([^}]*)\\}`, "g"))].map((match) => match[1]),
      );
      expect(spelled.length, name).toBeGreaterThan(0);
      expect(new Set(spelled), name).toEqual(new Set([value]));
      for (const config of configs) {
        const inConfig = [
          ...config.text.matchAll(new RegExp(`\\$\\{env:${name}:-([^}]*)\\}`, "g")),
        ];
        expect(inConfig.length, `${config.path} ${name}`).toBeGreaterThan(0);
        for (const match of inConfig) expect(match[1], `${config.path} ${name}`).toBe(value);
      }
    }
    expect(seconds(COLLECTOR_DEFAULTS.SB_METRICS_SCRAPE_INTERVAL)).toBeLessThan(300);
  });

  it("derives the database CA rather than taking it from .env", () => {
    // Named only when there is a database machine to check against it, so a
    // machine with nothing to scrape never reads a file that may not exist.
    const overlay = composeFiles.find(
      ({ path }) => path === "deploy/compose/single/compose.db-tls.yml",
    )!;
    expect(overlay.text).toContain(
      "SB_METRICS_DATABASE_CA_FILE: ${SB_METRICS_DATABASE_TARGET:+/var/lib/simple-balance/tls/db-ca.pem}",
    );
    expect(interpolated).not.toContain("SB_METRICS_DATABASE_CA_FILE");
  });
});
