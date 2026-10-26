import { expect, type Locator, type Page } from "@playwright/test";
import {
  ledgerFileAddInputSchema,
  ledgerFilePreviewInputSchema,
  type LedgerFileAddInput,
  type LedgerFileFacts,
} from "../../../src/shared/ledger-file-import.js";
import { encodeProgressFrame, type ProgressFrame } from "../../../src/shared/progress.js";
import { chosenAccounts, wholeLedger } from "../../support/ledger-file.js";
import { factsOf, ownAccount, previewFor, resultFor } from "../../support/ledger-file-facts.js";

/**
 * The two ledger-file import routes, answered in the browser tier the way
 * `plan-buttons.spec.ts` answers the billing status: the question is what the
 * page sends and what it does with the answer, and what the server does with
 * a file is the integration tier's to check. The answers come from the shared
 * planner the server runs, and every body is parsed with the route's own
 * schema, so a request the server would refuse fails the spec where it is
 * made.
 */

export type AddCall = {
  readonly body: LedgerFileAddInput;
  readonly raw: Record<string, unknown>;
  readonly accept: string | null;
};

type Answer = { status: number; headers: Record<string, string>; body: string };

/** A reply in frames, the way the route streams one when asked. */
export const streamed = (frames: readonly ProgressFrame[]): Answer => ({
  status: 200,
  headers: { "Content-Type": "text/event-stream" },
  body: frames.map(encodeProgressFrame).join(""),
});

/** A refusal, the way the route sends one before it has streamed anything. */
export const refused = (status: number, code: string, message: string): Answer => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error: { code, message } }),
});

export async function answerLedgerFileImport(
  page: Page,
  {
    facts,
    here = new Set<string>(),
    answer,
    holdPreview,
  }: {
    facts: LedgerFileFacts;
    here?: ReadonlySet<string>;
    answer?: (body: LedgerFileAddInput, call: number) => Answer | Promise<Answer>;
    /** Keeps a part's preview waiting, so what the page says meanwhile can be read. */
    holdPreview?: (call: number) => Promise<void> | undefined;
  },
) {
  const previews: string[] = [];
  const adds: AddCall[] = [];
  const isPreview = (url: URL) => url.pathname === "/api/v1/ledger-file:preview";
  const isAdd = (url: URL) => url.pathname === "/api/v1/ledger-file:add";
  await page.route(isPreview, async (route) => {
    const { ledgerFile } = ledgerFilePreviewInputSchema.parse(route.request().postDataJSON());
    previews.push(ledgerFile);
    await holdPreview?.(previews.length);
    await route.fulfill({ json: previewFor(ledgerFile, facts, here) });
  });
  await page.route(isAdd, async (route) => {
    const raw = route.request().postDataJSON() as Record<string, unknown>;
    const body = ledgerFileAddInputSchema.parse(raw);
    adds.push({ body, raw, accept: (await route.request().allHeaders())["accept"] ?? null });
    const reply = answer
      ? await answer(body, adds.length)
      : streamed([{ type: "result", value: resultFor(body, facts, here) }]);
    await route.fulfill(reply);
  });
  return {
    previews,
    adds,
    remove: async () => {
      await page.unroute(isPreview);
      await page.unroute(isAdd);
    },
  };
}

/**
 * An account name with nothing to break it at, which is the record list, a
 * question's heading and a checkbox's words at their widest.
 */
export const LONG = "JointHouseholdEverydayCheckingAccountAtTheCooperativeBank";

/** `wholeLedger`, with the long name standing for Checking everywhere the file names it. */
export const longLedger = () =>
  JSON.parse(JSON.stringify(wholeLedger()).replaceAll('"Checking"', `"${LONG}"`)) as Record<
    string,
    unknown
  >;

/**
 * A ledger that makes the preview ask everything it can: the long account is
 * here already and differs, the plan keeps three places with two in use, and
 * this copy chose settings of its own that the file's differ from.
 */
export const askingEverything = () =>
  factsOf(
    { accounts: [ownAccount(LONG), ownAccount("Wallet")] },
    {
      limit: 3,
      preferences: { chosen: true, timezone: "UTC", defaultCurrency: "USD", theme: "light" },
    },
  );

/** Choose a file through the drop zone's own input, from the keyboard. */
export async function chooseByKeyboard(
  page: Page,
  section: Locator,
  file: Record<string, unknown> | string,
  name = "simple-balance-2026-10-25.json",
) {
  const input = section.locator('input[type="file"]');
  await input.focus();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Space"),
  ]);
  await chooser.setFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(typeof file === "string" ? file : JSON.stringify(file)),
  });
}

/**
 * The import section in every state it can take, each handed to `measure`
 * once it is on screen: what a width check or a target check is asked about.
 */
export async function visitImportStates(page: Page, measure: (state: string) => Promise<void>) {
  const section = page.getByRole("region", { name: "Import a Simple Balance file" });

  // A file the browser refuses, with its list of problems and their places.
  await page.goto("/import");
  const broken = longLedger();
  const entries = broken.entries as Record<string, unknown>[];
  entries[0] = { ...entries[0], amount: 54.23 };
  entries[2] = { ...entries[2], amount: 80 };
  await chooseByKeyboard(page, section, broken);
  await expect(section.getByRole("alert")).toContainText("This file cannot be added as it is.");
  await measure("a file refused in the browser");

  // Everything asked at once, a copy's name being typed, and every record shown.
  const asking = await answerLedgerFileImport(page, {
    facts: askingEverything(),
    answer: (body, call) =>
      call === 1
        ? refused(
            409,
            "CONFLICT",
            "This ledger changed while the file was being read. Check the file again.",
          )
        : streamed([
            { type: "progress", event: { phase: "staging", done: 7, total: 7 } },
            { type: "result", value: resultFor(body, askingEverything()) },
          ]),
  });
  await page.goto("/import");
  await chooseByKeyboard(page, section, longLedger());
  await expect(section.getByRole("button", { name: "Add to this ledger" })).toBeVisible();
  await section.getByRole("radio", { name: "Bring it in as" }).check();
  await expect(section.getByRole("textbox", { name: `New name for "${LONG}"` })).toBeVisible();
  await section.getByRole("button", { name: /^Show all \d+ records$/ }).click();
  await expect(
    section.getByRole("table", { name: "Every record in the file, and what happens to it" }),
  ).toBeVisible();
  await expect(section.getByRole("heading", { name: "Still to decide" })).toBeVisible();
  await measure("asking about a duplicate, places and settings, with every record shown");

  // The same, answered, added, and stopped by a refusal of the first part.
  await section.getByRole("checkbox", { name: /^Brokerage/ }).check();
  await section.getByRole("radio", { name: /^Keep this copy's/ }).check();
  await section.getByRole("button", { name: "Add to this ledger" }).click();
  await expect(section.getByRole("button", { name: "Try again" })).toBeVisible();
  await measure("an add that stopped");

  // Tried again, and finished.
  await section.getByRole("button", { name: "Try again" }).click();
  await expect(section.getByText(/^Added "/)).toBeVisible();
  await measure("an add that finished");
  await asking.remove();

  // A record the file only names, matched to one here in its currency.
  const naming = await answerLedgerFileImport(page, {
    facts: factsOf({ accounts: [ownAccount(`${LONG}Investments`, "USD")] }),
  });
  await page.goto("/import");
  await chooseByKeyboard(page, section, chosenAccounts());
  await section.getByRole("radio", { name: "Use another here" }).check();
  await expect(
    section.getByRole("combobox", { name: 'Account here to use for "Brokerage"' }),
  ).toBeVisible();
  await measure("a reference being matched to an account here");
  await naming.remove();
}
