import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The worked-sentence table, read in the direction nothing was reading it.
 *
 * `tests/ui-copy.test.ts` asks whether each row of `common.md`'s table appears
 * in `src`, which holds the table to the product. It cannot see the failure the
 * table exists to prevent: a **second** sentence written for a situation a row
 * already settles. The table's whole purpose is "so the voice is not reinvented
 * per site", and a sixteenth message for a situation that has one is the voice
 * being reinvented — with the forward check perfectly green, because the row it
 * duplicates is still quoted somewhere.
 *
 * So every sentence in `src` that is *about* one of the fifteen situations has
 * to be one of the fifteen messages, or be named below with the argument for
 * it. The register is the whole cost of the check, and it is the point: adding
 * an entry is a decision somebody has to defend, where writing a new sentence
 * is not.
 */

/**
 * Where a sentence a person reads comes from, minus the agent surface.
 *
 * `src/server/mcp.ts` and `src/server/mcp-output-schemas.ts` are descriptions
 * rather than messages — what a tool is for, what a field means — and they are
 * a genre `mcp.md` governs on its own terms, at length and in paragraphs. They
 * mention cursors, fingerprints and date shapes constantly and refuse nothing,
 * so every probe below would fire on them and every hit would be noise.
 */
const SOURCES = [
  ...globSync("src/client/**/*.{ts,tsx}"),
  ...globSync("src/shared/**/*.ts"),
  ...globSync("src/server/**/*.ts"),
].filter((path) => !/mcp\.ts$|mcp-output-schemas\.ts$/.test(path));

/**
 * The same genre distinction inside a file that holds both.
 *
 * `src/shared/domain.ts` carries the Zod messages *and* a `.describe()` on
 * nearly every field, and the descriptions are paragraphs addressed to an
 * agent. Blanked to spaces rather than cut, so a line number still points at
 * the line somebody has to open, and by brace depth from the opening paren
 * rather than to the end of the line: thirteen of them run across several
 * lines, and a line-at-a-time filter sees only the first.
 */
function withoutDescriptions(text: string): string {
  let out = text;
  for (;;) {
    const at = out.indexOf(".describe(");
    if (at < 0) return out;
    let depth = 0;
    let end = at + ".describe(".length - 1;
    do {
      const character = out[end];
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      end += 1;
    } while (depth > 0 && end < out.length);
    out = out.slice(0, at) + out.slice(at, end).replace(/[^\n]/g, " ") + out.slice(end);
  }
}

/** Every double-quoted sentence on a line that is not a comment. */
function sentences(path: string): { text: string; where: string }[] {
  const found: { text: string; where: string }[] = [];
  withoutDescriptions(readFileSync(path, "utf8"))
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
      for (const match of line.matchAll(/"([^"\\]{10,})"/g)) {
        // A sentence starts with a capital and has a space in it. Everything
        // else a literal holds — a wire value, an import path, a column name, a
        // CSS class — is machinery, and a probe that read those would be
        // answered by renaming things rather than by fixing them.
        const text = match[1]!;
        if (!/^[A-Z]/.test(text) || !text.includes(" ")) continue;
        found.push({ text, where: `${path}:${index + 1}` });
      }
    });
  return found;
}

/**
 * What counts as "about this situation", one per row of the table.
 *
 * Keyed by the Situation column verbatim, and the key set is asserted equal to
 * the table's rows: a row added to `common.md` with no probe here would be a
 * row this check silently ignores, which is how a one-way check stays one-way.
 *
 * Two pairs of rows share a probe, because the situation is one and the table
 * splits it by which surface is being answered — a version conflict in the
 * browser and the same conflict reported to an agent. That costs nothing: a hit
 * is allowed against *any* of the fifteen messages rather than only its own
 * row's, so the two never read as each other's duplicate.
 */
const PROBES: Readonly<Record<string, RegExp>> = {
  "Amount empty":
    /\b(enter|provide|give|type)\b[^.]{0,30}\bamount\b|\bamount\b[^.]{0,30}\brequired\b/i,
  "Amount not a decimal, in a CSV cell": /\bamount\b[^.]{0,40}\b(number|decimal|separator)/i,
  "Amount zero or negative where it may not be":
    /\bamount\b[^.]{0,40}\b(greater than|more than|positive|above zero)\b/i,
  "Budget amount negative": /\bbudget\b[^.]{0,30}\bnegative\b|\bnegative\b[^.]{0,30}\bbudget\b/i,
  "Date is not a calendar date":
    /\bdate\b[^.]{0,30}\b(does not exist|doesn't exist|is not real|no such)/i,
  "Date in the wrong shape": /YYYY-MM-DD/,
  "Version conflict, browser": /\bchanged while you were\b/i,
  "Version conflict, agent, where the refusal carries the version":
    /\bchanged since you read it\b/i,
  "Version conflict, agent, where it carries no version": /\bchanged since you read it\b/i,
  "Stale bulk fingerprint, browser": /\bpreview the selection again\b/i,
  "Stale bulk fingerprint, agent": /\bpreview the selection again\b/i,
  "Cursor under a changed ordering": /\bcursor\b[^.]{0,40}\b(sort order|ordering|different)\b/i,
  "Cursor that cannot be read at all": /\b(page marker|cursor)\b[^.]{0,30}\bcannot be read\b/i,
  "A staged row that is not ready to commit":
    /\b(every|all)\b[^.]{0,30}\brows?\b[^.]{0,40}\b(complete|ready)\b/i,
  "A path id that is not an id this API issues":
    /\bid\b[^.]{0,40}\b(returned by a list|list or a create)\b/i,
};

/**
 * Sentences a probe reaches that are not the table's, and why each one stays.
 *
 * Keyed by the sentence itself rather than by a file and a line, which drifts
 * the moment a file moves and nothing watches it. Four entries, and the test
 * fails on a fifth — and equally on an entry that stops matching anything, so a
 * sentence deleted or rewritten takes its licence with it instead of leaving a
 * permission behind for whatever is written next.
 */
const NEAR_MISS: Readonly<Record<string, string>> = {
  "Enter an amount for the transaction and for each category.":
    "The split editor's remainder readout, reading alongside 'The split adds up.' and 'N left to assign.' in the same `<small>`. It is a running status rather than a refusal of a field, and it answers a question the table's row does not have: a split needs an amount on the entry *and* on every leg. Worth knowing when this is read: it is also the only site containing the row's own 'Enter an amount', so the forward check in `tests/ui-copy.test.ts` anchors that row on a substring of this sentence. The row has no message of its own in the product.",
  "Destination amount is required when transfer currencies differ":
    "A different field and a conditional one. `destinationAmount` is absent by design on a same-currency transfer and required the moment the two sides differ, so this says which of the two amounts is missing and when — 'Enter an amount' on a form with two of them would name neither.",
  "Give the date as YYYY-MM-DD.":
    "A disabled-submit blocked reason, not a field error, and `web.md` 12.3 wants the first blocked reason rather than all of them. It sits in one conditional chain with 'Select at least one row.', 'Change at least one field above.' and 'Give the payee a name.', and is written in their grammar; dropping the table's bare 'Use YYYY-MM-DD' in here would read as a label beside four instructions.",
  "This cursor was issued for a different set of filters. Start again from the first page.":
    "A different situation, split out deliberately and argued where it is thrown: the caller changed a filter rather than the ordering, and the move that works is the same either way, but a message naming the sort when the sort is unchanged sends somebody looking in the wrong place. It is a candidate for a sixteenth row rather than a duplicate of the thirteenth.",
};

/** The table, as `common.md` publishes it. */
function workedSentences(): { situation: string; message: string }[] {
  const guide = readFileSync("docs/standards/common.md", "utf8");
  const table = guide.slice(guide.indexOf("| Situation | Message |"));
  return (
    [...table.matchAll(/^\| ([^|]+?) \| ([^|]+?) \|$/gm)]
      .map((match) => ({ situation: match[1]!.trim(), message: match[2]!.trim() }))
      // The header and the separator are matched by the same row pattern. The
      // forward check leaves the header in and asks whether `src` contains the
      // word "Message", which it does; here it would be a sixteenth situation
      // with no probe, so it goes.
      .filter(({ situation }) => situation !== "---" && situation !== "Situation")
  );
}

describe("the worked sentences, in reverse", () => {
  it("have a probe for every row of the table", () => {
    const rows = workedSentences();
    // A table that stopped parsing would otherwise pass by examining nothing,
    // which is the failure this whole file exists to make visible.
    expect(rows.length, "the table parsed").toBeGreaterThan(8);
    expect(
      rows.map((row) => row.situation).sort(),
      "a row with no probe is a row nobody checks",
    ).toEqual(Object.keys(PROBES).sort());
  });

  it("are the only sentences the product has for those situations", () => {
    const rows = workedSentences();
    const published = new Set(rows.map((row) => row.message));
    const found: { probe: string; text: string; where: string }[] = [];
    for (const path of SOURCES) {
      for (const { text, where } of sentences(path)) {
        for (const [situation, probe] of Object.entries(PROBES)) {
          if (probe.test(text)) found.push({ probe: situation, text, where });
        }
      }
    }
    // A reader that stopped reading — a glob that matches nothing, a blanking
    // pass that blanked the file — would report a clean surface. The table's
    // own messages are in `src`, so the probes always have something to find.
    expect(found.length, "the probes reached the source").toBeGreaterThan(15);

    const unexplained = found
      .filter(({ text }) => !published.has(text) && !(text in NEAR_MISS))
      .map(({ probe, text, where }) => `${where} (${probe}): "${text}"`);
    expect(unexplained, "one situation, one sentence").toEqual([]);

    const stale = Object.keys(NEAR_MISS).filter((text) => !found.some((hit) => hit.text === text));
    expect(stale, "a licence outlives the sentence it was written for").toEqual([]);
  });
});
