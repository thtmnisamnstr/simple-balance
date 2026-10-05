import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bulkStageFilterSchema,
  bulkTransactionFilterSelectionRequestSchema,
  listQuerySchema,
  stageListQuerySchema,
} from "../src/shared/domain.js";

/**
 * A list route and the bulk selection made from it take the same parameters.
 *
 * `http.md` §Requests calls this "a live gap" and ranks the check first in its
 * own list: `listQuerySchema` accepts anything, so `?sortt=date` returns page
 * one in the default order with a 200, while the bulk filter schema derived
 * from it **is** `.strict()`. The two therefore disagree about the same
 * parameter set.
 *
 * This is the half of that which can ship today. Making `listQuerySchema`
 * strict would refuse a request a deployment on the previous release has been
 * sending and getting a 200 for, which is the upgrade guarantee, so the
 * enforcement half is a later release's job and is recorded as such. The key
 * comparison needs none of it: it catches the next divergence — a filter added
 * to a list and not to the selection made from it, or the other way about —
 * without narrowing anything a client may currently do.
 *
 * The divergence it is really about is not cosmetic. A filtered bulk selection
 * resolves twice, once for the count and fingerprint a preview hands back and
 * once for the write, and both resolve from the *filter* schema. A parameter
 * the list honors and the filter drops means the rows somebody saw and the rows
 * a mass edit touches are two different sets, and nothing on the way through
 * says so.
 */

/**
 * What describes a view rather than scopes it.
 *
 * The same five `bulkStageFilterSchema` omits, and the same five
 * `tests/mcp-parity.test.ts` names for the same reason. Order and paging are
 * presentation: leaving them in would scope a fingerprinted selection to
 * whichever page happened to be open, and make two requests that select exactly
 * the same rows look like different selections to the fingerprint.
 *
 * Written out rather than read off the `.omit` call, because reading the omit
 * back out of the source would make this test agree with the derivation by
 * construction and assert nothing. Spelled here, a key moved between the two
 * groups has to be moved here too, which is the decision being asked for.
 */
const PRESENTATION = ["cursor", "page", "limit", "sort", "direction"] as const;

/** A list route, the selection built from it, and where the selection resolves. */
type Pair = {
  readonly what: string;
  /** Everything the list route parses, presentation included. */
  readonly list: readonly string[];
  /** Everything a filtered bulk selection carries. */
  readonly filter: readonly string[];
  /** The service function that turns the filter into SQL. */
  readonly resolver: { readonly file: string; readonly name: string };
};

const PAIRS: readonly Pair[] = [
  {
    what: "the transactions list and a bulk transaction selection",
    list: Object.keys(listQuerySchema.shape),
    // Through the request schema rather than the unexported
    // `bulkTransactionFilterSchema`, because this is the shape that reaches the
    // wire: a filter the route accepts and this does not see would be a gap in
    // the check rather than in the product.
    filter: Object.keys(bulkTransactionFilterSelectionRequestSchema.shape.filter.shape),
    resolver: { file: "src/server/services/transactions.ts", name: "transactionFilterConditions" },
  },
  {
    what: "the staged queue and a bulk staged selection",
    list: Object.keys(stageListQuerySchema.shape),
    filter: Object.keys(bulkStageFilterSchema.shape),
    resolver: { file: "src/server/services/staging.ts", name: "stageFilterConditions" },
  },
];

describe("a list route and the bulk selection made from it", () => {
  it.each(PAIRS)("accept the same parameter names: $what", ({ list, filter }) => {
    // A schema this can no longer see into — given another name, exported as
    // something else, wrapped in an effect that hides `.shape` — would
    // otherwise pass here by comparing two empty sets.
    expect(list.length, "the list schema resolved").toBeGreaterThan(10);
    expect(filter.length, "the filter schema resolved").toBeGreaterThan(8);

    const presentation = new Set<string>(PRESENTATION);
    const scoping = list.filter((key) => !presentation.has(key));
    expect([...filter].sort(), "one parameter set, two schemas").toEqual([...scoping].sort());
  });

  it.each(PAIRS)("keep presentation out of the selection: $what", ({ list, filter }) => {
    // Both directions, because the two failures are opposite and only one of
    // them is caught by the comparison above. A presentation key that reached
    // the filter would put the open page into the fingerprint; a presentation
    // key dropped from the list would be a list that can no longer be ordered
    // or paged, with the comparison still perfectly green.
    expect(
      PRESENTATION.filter((key) => !list.includes(key)),
      "the list offers all five",
    ).toEqual([]);
    expect(
      PRESENTATION.filter((key) => filter.includes(key)),
      "a selection describes rows, not a view",
    ).toEqual([]);
  });
});

/**
 * And the resolver applies every one of them.
 *
 * The comparison above holds the two schemas together; this holds the schema to
 * the SQL. `staging.ts` states the stake directly — "A second copy of these
 * predicates is a second definition of 'the rows you are looking at', and the
 * day they drift is the day a mass edit touches something that was never on
 * screen" — and a filter key the builder never reads is that drift without the
 * second copy: the request carries it, `.strict()` accepts it because it is a
 * declared key, and the rows come back unfiltered.
 */
describe("the filter a bulk selection carries", () => {
  it.each(PAIRS)("is applied in full by its resolver: $what", ({ filter, resolver }) => {
    const source = readFileSync(resolver.file, "utf8");
    const opener = source.indexOf(`function ${resolver.name}(`);
    expect(opener, `${resolver.file} declares ${resolver.name}`).toBeGreaterThan(-1);
    // To the end of the declaration, by brace depth from the opening brace of
    // the body. A fixed window would truncate: `transactionFilterConditions`
    // runs eighty lines and the keys are spread across all of them.
    let depth = 0;
    let end = source.indexOf("{", opener);
    const start = end;
    do {
      const character = source[end]!;
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      end += 1;
    } while (depth > 0 && end < source.length);
    const body = source.slice(start, end);
    expect(body.length, "the function body was found").toBeGreaterThan(400);

    const unapplied = filter.filter((key) => !new RegExp(`\\bquery\\.${key}\\b`).test(body));
    expect(unapplied, "every filter the schema accepts narrows the rows").toEqual([]);
  });
});
