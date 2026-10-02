import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./source.js";

/**
 * `--<role>[-<property>][-<modifier>]`, read out of the guide that defines it.
 *
 * `web.md` 1.4 names the two closed lists in one paragraph, and `17.2` item 2
 * asks for exactly this: a parse of the grammar, so the `TEXT` and `FILL` sets
 * `tests/theme-tokens.test.ts` kept by hand become something derived. A hand
 * list is what let `--art-glow-b` go missing from 1.4's own exemptions for a
 * release — the same failure one level up.
 *
 * The lists are read from `docs/standards/web.md` rather than copied here. A
 * copy is a third place a role can be added, and the one that would not be
 * updated: the guide is where somebody argues for a new role, so the guide is
 * what this reads.
 */

const guide = readFileSync(path.join(repoRoot, "docs/standards/web.md"), "utf8");

/** Every `` `word` `` in a run of them, which is how 1.4 writes both lists. */
function backticked(after: RegExp): string[] {
  const start = after.exec(guide);
  if (!start) throw new Error(`web.md 1.4 no longer says ${after}`);
  const tail = guide.slice(start.index + start[0].length);
  const stop = tail.indexOf(".");
  return [...tail.slice(0, stop === -1 ? tail.length : stop).matchAll(/`([^`]+)`/g)].map(
    (match) => match[1]!,
  );
}

/** `ground`, `surface`, `field`, … — with `series-N` and `on-*` as patterns. */
export const TOKEN_ROLES: readonly string[] = backticked(/with the role from a closed\s+list:/);

/** `soft`, `wash`, `subtle`, … */
export const TOKEN_MODIFIERS: readonly string[] = backticked(/The modifier comes from/);

export type ParsedToken = {
  /** The role, as the closed list spells it (`series-N`, `on-*`). */
  readonly role: string;
  /** The one open segment, when there is one: `glow`, `ring`, `hairline`. */
  readonly property?: string;
  /** Trailing segments, every one from the closed list. */
  readonly modifiers: readonly string[];
};

/**
 * Split a declared token into the three parts the grammar names, or say why
 * it does not split.
 *
 * Longest role first, because `fill` is both a role and a modifier and
 * `--fill-subtle` is the role: a shortest-match parse would read `--field-line`
 * as the role `fi`… there is no such role, but `--green-line-strong` would
 * become role `green`, property `line`, modifier `strong` under one reading and
 * role `green`, two modifiers under another. Modifiers are peeled off the end
 * first, so what is left over is unambiguously the property.
 */
export function parseToken(token: string): ParsedToken | string {
  const name = token.replace(/^--/, "");
  const role = [...TOKEN_ROLES]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => {
      // `series-N` and `on-*` are patterns rather than literals, and the list
      // writes them that way rather than enumerating ten series and three
      // surfaces. `on-*` consumes one segment: `--on-art-muted` is the muted
      // ink for the art surface, not a role called `on`.
      if (candidate === "series-N") return /^series-\d+$/.test(name);
      if (candidate === "on-*") return /^on-[a-z]+/.test(name);
      return name === candidate || name.startsWith(`${candidate}-`);
    });
  if (role === undefined) return `${token}: no role from 1.4's closed list opens it`;

  const consumed =
    role === "series-N"
      ? name.length
      : role === "on-*"
        ? /^on-[a-z]+/.exec(name)![0].length
        : role.length;
  const rest = name.slice(consumed).replace(/^-/, "");
  const segments = rest === "" ? [] : rest.split("-");

  const modifiers: string[] = [];
  while (segments.length > 0 && TOKEN_MODIFIERS.includes(segments.at(-1)!)) {
    modifiers.unshift(segments.pop()!);
  }
  if (segments.length > 1) {
    return `${token}: ${segments.join("-")} is more than one property segment`;
  }
  return { role, property: segments[0], modifiers };
}

/**
 * What a token paints: words, an area, or neither.
 *
 * The role answers it, and three segments override the role. This is the
 * derivation 17.2 item 2 asks for, and it is written as rules rather than as
 * two lists of names:
 *
 * - `ink` and `muted` are words; `ground`, `surface`, `field`, `fill` and
 *   `track` are areas. Nothing after the role changes that.
 * - A `line` segment — property or modifier — is an edge, which is neither.
 *   `--field-line` and `--green-line-strong` are borders.
 * - `green`, `red`, `amber` and `blue` are hues rather than roles, so the
 *   segment after decides: `fill`, `soft` or `wash` makes the hue an area,
 *   and anything else leaves it the hue at text contrast — `--green` and
 *   `--green-dark` are figures in a register, `--green-soft` is the tint
 *   behind one.
 * - Every other role — `line`, `focus`, `shadow`, `accent`, `brand`, `art`,
 *   `chrome`, `scrim`, `ambient`, `series-N`, `on-*` — names a thing in the
 *   product rather than a kind of color, so its name cannot say. 1.4 exempts
 *   six of these by name for exactly that reason; the grammar reaches the same
 *   verdict for all of them.
 */
export type TokenKind = "text" | "fill" | "neither";

const WORDS = ["ink", "muted"];
const AREAS = ["ground", "surface", "field", "fill", "track"];
const HUES = ["green", "red", "amber", "blue"];
const HUE_AS_AREA = ["fill", "soft", "wash"];

export function tokenKind(token: string): TokenKind | string {
  const parsed = parseToken(token);
  if (typeof parsed === "string") return parsed;
  const segments = [parsed.property, ...parsed.modifiers].filter((part) => part !== undefined);
  if (segments.includes("line")) return "neither";
  if (WORDS.includes(parsed.role)) return "text";
  if (AREAS.includes(parsed.role)) return "fill";
  if (HUES.includes(parsed.role)) {
    return segments.some((part) => HUE_AS_AREA.includes(part)) ? "fill" : "text";
  }
  return "neither";
}

/** The names the grammar reads as words, out of whatever is declared. */
export const textTokens = (declared: Iterable<string>): Set<string> =>
  new Set([...declared].filter((token) => tokenKind(token) === "text"));

/** The names the grammar reads as areas. */
export const fillTokens = (declared: Iterable<string>): Set<string> =>
  new Set([...declared].filter((token) => tokenKind(token) === "fill"));
