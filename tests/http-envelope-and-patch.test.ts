import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bulkStageEditSchema, bulkTransactionEditSchema } from "../src/shared/domain.js";

/**
 * Two rules `docs/standards/http.md` lists under *What is checked* as not
 * being, and the half of each a program can decide.
 */

/**
 * A single resource is the object itself, with no envelope.
 *
 * http.md §Responses states it and then records, at length, that **eleven
 * listings predate it** and return a bare array: turning `[…]` into
 * `{items: […]}` changes the type of the whole response, which breaks every
 * client reading `response[0]`, and `AGENTS.md` forbids a release from doing
 * that. So the deviation is a decision with a deprecation cycle behind it, and
 * a check written against the whole sentence would report eleven failures on
 * code the guide has already argued about. `tests/mcp-output.test.ts` holds
 * the collection half with those twelve in a register.
 *
 * What is left unheld is the other half, and it has no exceptions at all: the
 * single-resource routes. Every one of them hands `c.json` the service result
 * and nothing else, which is a property of the route registration and readable
 * without running anything. The value is the next route: wrapping one record
 * in `{data: …}` because some client wanted a place to hang a field is how an
 * API acquires a third shape, and it is additive enough to pass review.
 *
 * *What this cannot see:* whether the service itself returns an envelope. That
 * is `tests/mcp-output.test.ts`'s ground, over the published output schemas,
 * and nothing here duplicates it.
 */
describe("a single resource carries no envelope", () => {
  const api = readFileSync("src/server/api.ts", "utf8");

  type Route = {
    readonly method: string;
    readonly path: string;
    readonly handler: string;
  };

  /**
   * Every `/api/v1` registration, with its handler read to the parenthesis that
   * closes the registration rather than to a fixed width — a handler that runs
   * long is exactly the one with room to hide a wrapper in.
   */
  const routes: Route[] = [
    ...api.matchAll(/app\.(get|post|put|delete)\("(\/api\/v1\/[^"]*)",/g),
  ].map((match) => {
    const open = api.indexOf("(", match.index);
    let depth = 0;
    let end = api.length;
    for (let index = open; index < api.length; index++) {
      if (api[index] === "(") depth += 1;
      else if (api[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    return {
      method: match[1]!.toUpperCase(),
      path: match[2]!,
      handler: api.slice(match.index, end),
    };
  });

  /** A path whose last segment is a parameter addresses one row. */
  const singles = routes.filter((route) => route.path.split("/").at(-1)!.startsWith(":"));

  it("finds the routes, and reads their handlers whole", () => {
    // The guard. Everything below is a search for a shape that is absent, and a
    // matcher that found no routes would report the API clean.
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(singles.length).toBeGreaterThanOrEqual(20);
    expect(singles.map((route) => `${route.method} ${route.path}`)).toContain(
      "GET /api/v1/accounts/:id",
    );
    // A multi-statement handler, read past its first line: the versioned
    // deletes parse a body before answering.
    const deletion = singles.find(
      (route) => route.method === "DELETE" && route.path.endsWith("accounts/:id"),
    );
    expect(deletion!.handler).toContain("versionedMutationSchema");
  });

  it("hands c.json the resource and not a wrapper around it", () => {
    const wrapped: string[] = [];
    for (const route of singles) {
      for (const call of route.handler.matchAll(/\bc\.json\(\s*([\s\S]{0,40})/g)) {
        // An object literal opening the argument is the envelope. A call, an
        // identifier or an `await` is the resource.
        if (call[1]!.trim().startsWith("{")) {
          wrapped.push(`${route.method} ${route.path} answers ${call[1]!.trim().slice(0, 40)}`);
        }
      }
    }
    expect(
      wrapped,
      "http.md §Responses: a single resource is returned as the object itself, with no envelope.",
    ).toEqual([]);
  });
});

/**
 * The two bulk patch schemas answer the same way as each other.
 *
 * http.md:678 records that three patch schemas answer the absent/null/empty
 * question and that the transaction and staged ones carry an identical
 * `transform` on `description` and `notes` while the template one refuses the
 * empty string. It closes: *Not checked mechanically: that a new nullable field
 * follows the three-way rule, or that the two patch schemas agree with each
 * other.* The second of those is decidable; the first is a judgement about a
 * field that does not exist yet and stays review.
 *
 * Agreement is the one that bites. A staged row and a committed row are the
 * same record either side of a commit, and the two mass edits are written as
 * two schemas side by side — "So fixing only the transaction path leaves the
 * same defect on the staged one" is the guide's own sentence, and it is just as
 * true of a field added to one and not the other.
 *
 * Checked by **asking both schemas** rather than by comparing their source. A
 * `.transform` is invisible to a reading of `.shape`, and the transform is the
 * whole subject. The battery is parsed field by field, and the two answers must
 * match exactly — value for value and refusal for refusal.
 */
describe("the transaction and staged bulk patches", () => {
  const transaction = bulkTransactionEditSchema.shape.patch;
  const staged = bulkStageEditSchema.shape.patch;

  const fields = (schema: typeof transaction) =>
    Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);

  /**
   * Values chosen to straddle every edge the three-way rule is about, plus a
   * few a field might read differently: absent is the fourth case and is tested
   * by leaving the key out, which no value can express.
   */
  const BATTERY: readonly unknown[] = [
    null,
    "",
    "   ",
    "text",
    "2024-01-02",
    "11111111-1111-4111-8111-111111111111",
    "deposit",
    0,
    false,
  ];

  /** What a schema does with one key set to one value, as a comparable string. */
  const answer = (schema: typeof transaction, field: string, value: unknown): string => {
    const parsed = schema.safeParse({ [field]: value });
    if (parsed.success) return `ok ${JSON.stringify(parsed.data)}`;
    return `refused ${parsed.error.issues
      .map((issue) => issue.code)
      .sort()
      .join(",")}`;
  };

  it("carry the same fields", () => {
    expect(fields(transaction).sort()).toEqual(fields(staged).sort());
    // The guard: a reader that found no fields would make every comparison
    // below vacuous.
    expect(fields(transaction)).toContain("description");
    expect(fields(transaction).length).toBeGreaterThanOrEqual(7);
  });

  it("answer absent, null, empty and a value the same way as each other", () => {
    const disagreements: string[] = [];
    for (const field of fields(transaction)) {
      for (const value of BATTERY) {
        const left = answer(transaction, field, value);
        const right = answer(staged, field, value);
        if (left !== right) {
          disagreements.push(
            `${field} with ${JSON.stringify(value)}: transaction ${left}, staged ${right}`,
          );
        }
      }
    }
    expect(
      disagreements,
      "http.md:678 — a staged row and a committed row are the same record either side of a commit.",
    ).toEqual([]);
  });

  it("keep absent and null apart on every nullable field", () => {
    // The half of the three-way rule a program can decide without knowing what
    // a new field means: a key left out has to leave the field alone, so it
    // cannot come back as the same thing an explicit null does.
    let nullable = 0;
    for (const schema of [transaction, staged]) {
      for (const field of fields(schema)) {
        if (!schema.safeParse({ [field]: null }).success) continue;
        nullable += 1;
        const cleared = schema.safeParse({ [field]: null });
        expect(cleared.success && Object.hasOwn(cleared.data as object, field)).toBe(true);
        // An empty patch is refused outright — "Choose at least one field to
        // update" — so absence is checked against a second field being present
        // rather than against an empty object.
        const other = fields(schema).find((name) => name !== field)!;
        const absent = schema.safeParse({ [other]: "x" });
        if (absent.success) {
          expect(
            Object.hasOwn(absent.data as object, field),
            `${field} appears in a patch that never named it`,
          ).toBe(false);
        }
      }
    }
    expect(nullable).toBeGreaterThanOrEqual(4);
  });

  /**
   * And the battery discriminates. Every assertion above reports an empty list
   * when the two schemas agree, which is also what it reports if `answer` had
   * stopped distinguishing anything.
   */
  it("would notice a difference if there were one", () => {
    const widened = bulkTransactionEditSchema.shape.patch;
    expect(answer(widened, "description", "")).not.toBe(answer(widened, "description", "text"));
    expect(answer(widened, "categoryId", "")).toContain("refused");
    expect(answer(widened, "description", "")).toContain("ok");
  });
});
