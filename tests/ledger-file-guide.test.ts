import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ledgerFileSchema } from "../src/shared/ledger-file.js";
import { repoRoot } from "./support/source.js";

/**
 * The field table in `docs/standards/ledger-file.md` §3, against the schema it
 * describes.
 *
 * The table is the format as somebody outside the code reads it, and the
 * format is a published contract: a field renamed, removed or made required
 * breaks every file already written, which is the one change the guide's
 * version rule forbids under an existing token. The schema cannot say that
 * about itself, because whatever it says is right by definition. So the table
 * is written by hand and held to the schema here, and the change that would
 * break a file has to change a document a reviewer reads in the same diff.
 *
 * Not derived the other way round. A table generated from the schema would
 * agree with any edit, which is the failure `tests/product-facts.test.ts`
 * names: a check that rewrites what it is checking is not a check.
 */

type Shape = Readonly<Record<string, z.ZodType>>;

/** Through `.optional()` and `.nullable()` to the schema that holds the shape. */
function unwrapped(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrapped(schema.unwrap() as z.ZodType);
  }
  return schema;
}

const shapeOf = (schema: z.ZodType): Shape => {
  const inner = unwrapped(schema);
  if (!(inner instanceof z.ZodObject)) throw new Error("not an object schema");
  return inner.shape as Shape;
};

const elementOf = (schema: z.ZodType): z.ZodType => {
  const inner = unwrapped(schema);
  if (!(inner instanceof z.ZodArray)) throw new Error("not an array schema");
  return inner.element as z.ZodType;
};

/** One member of a discriminated union, by the value of its discriminator. */
const optionOf = (schema: z.ZodType, key: string, value: string): z.ZodType => {
  const inner = unwrapped(schema);
  if (!(inner instanceof z.ZodDiscriminatedUnion)) throw new Error("not a discriminated union");
  const found = (inner.options as z.ZodType[]).find((option) => {
    const field = shapeOf(option)[key];
    return field !== undefined && field.safeParse(value).success;
  });
  if (!found) throw new Error(`no ${key} ${value}`);
  return found;
};

/**
 * Where each row of the table lives in the schema. Named by the row's own
 * words, so a row renamed in the guide fails as a row this list does not know,
 * and a record added to the format fails as one the guide has no row for.
 */
function records(): Record<string, Shape> {
  const file = ledgerFileSchema.shape as unknown as Shape;
  const record = (section: string) => elementOf(file[section]!);
  const wholeTemplate = shapeOf(optionOf(record("templates"), "detail", "full"));
  const draft = shapeOf(wholeTemplate.draft!);
  const recurrence = shapeOf(record("recurrences"));
  const recurrenceShape = (type: string) => shapeOf(optionOf(recurrence.shape!, "type", type));
  const budgets = shapeOf(file.budgets!);
  const entry = (type: string) => shapeOf(optionOf(record("entries"), "type", type));
  const staged = shapeOf(record("staged"));
  const stagedDraft = shapeOf(staged.draft!);
  return {
    "The file": file,
    Producer: shapeOf(file.producer!),
    Scope: shapeOf(file.scope!),
    Settings: shapeOf(file.preferences!),
    "Category group": shapeOf(record("groups")),
    "Category, whole": shapeOf(optionOf(record("categories"), "detail", "full")),
    "Category, reference": shapeOf(optionOf(record("categories"), "detail", "reference")),
    "Account, whole": shapeOf(optionOf(record("accounts"), "detail", "full")),
    "Account, reference": shapeOf(optionOf(record("accounts"), "detail", "reference")),
    "Template, whole": wholeTemplate,
    "Template, reference": shapeOf(optionOf(record("templates"), "detail", "reference")),
    "Template draft": draft,
    "Template draft leg": shapeOf(elementOf(draft.legs!)),
    Reminder: shapeOf(wholeTemplate.notification!),
    "Recurring transaction": recurrence,
    "Shape of a recurring deposit": recurrenceShape("deposit"),
    "Shape of a recurring withdrawal": recurrenceShape("withdrawal"),
    "Shape of a recurring transfer": recurrenceShape("transfer"),
    "Recurring leg": shapeOf(elementOf(recurrenceShape("deposit").legs!)),
    Schedule: shapeOf(recurrence.schedule!),
    "Budget plan": shapeOf(elementOf(budgets.plans!)),
    "Budget amount": shapeOf(elementOf(budgets.entries!)),
    Deposit: entry("deposit"),
    Withdrawal: entry("withdrawal"),
    Transfer: entry("transfer"),
    "Entry leg": shapeOf(elementOf(entry("deposit").legs!)),
    "Staged row": staged,
    "Staged draft": stagedDraft,
    "Staged leg": shapeOf(elementOf(stagedDraft.legs!)),
    "History event": shapeOf(elementOf(file.history!)),
  };
}

/**
 * Whether a record parses with the field absent: an optional field, a field
 * with a default, and a staged field that takes anything all do. Asked of the
 * field rather than read off its wrapper, because three different wrappers
 * mean "may be left out" here and a reader of the file cannot tell them apart.
 */
const mayBeLeftOut = (field: z.ZodType) => field.safeParse(undefined).success;

/** The guide's table, row by row: the record's name and its fields as written. */
function guideTable(): { record: string; fields: string[] }[] {
  const guide = readFileSync(path.join(repoRoot, "docs/standards/ledger-file.md"), "utf8");
  const section = guide.slice(
    guide.indexOf("## 3. The records"),
    guide.indexOf("## 4. Money, dates and text"),
  );
  return [...section.matchAll(/^\| ([^|`]+?) \| (`.+) \|$/gm)].map((match) => ({
    record: match[1]!.trim(),
    fields: [...match[2]!.matchAll(/`([A-Za-z]+\??)`/g)].map((field) => field[1]!),
  }));
}

describe("the field table in ledger-file.md", () => {
  const table = guideTable();
  const schema = records();

  it("has a row for every record the format has, and no row for one it lacks", () => {
    // A table that stopped parsing would pass by examining nothing.
    expect(table.length).toBeGreaterThan(25);
    expect(table.map((row) => row.record).sort()).toEqual(Object.keys(schema).sort());
  });

  it.each(Object.keys(records()))("lists every field of %s, in written order", (record) => {
    const row = table.find((candidate) => candidate.record === record);
    expect(row, `no row for ${record}`).toBeDefined();
    const shape = schema[record]!;
    const expected = Object.entries(shape).map(
      ([name, field]) => `${name}${mayBeLeftOut(field) ? "?" : ""}`,
    );
    expect(row!.fields).toEqual(expected);
  });
});
