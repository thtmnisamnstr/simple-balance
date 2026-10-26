import { expect, type Locator, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import {
  ledgerFileAddInputSchema,
  ledgerFilePreviewInputSchema,
  type LedgerFileAddInput,
  type LedgerFileFacts,
} from "../../../src/shared/ledger-file-import.js";
import {
  ledgerBalanceRefusal,
  ledgerFileMoveInputSchema,
} from "../../../src/shared/ledger-file-move.js";
import { encodeProgressFrame, type ProgressFrame } from "../../../src/shared/progress.js";
import { chosenAccounts, wholeLedger } from "../../support/ledger-file.js";
import { factsOf, ownAccount, previewFor, resultFor } from "../../support/ledger-file-facts.js";
import { moveResultFor, qualifying, typedInto } from "../../support/ledger-file-move-facts.js";

/**
 * The three ledger-file import routes, answered in the browser tier the way
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
/** A part sent on to a server of the test's own, which answers it as it goes. */
type Forwarded = { continueTo: string };

/** A reply in frames, the way the route streams one when asked. */
export const streamed = (frames: readonly ProgressFrame[]): Answer => ({
  status: 200,
  headers: { "Content-Type": "text/event-stream" },
  body: frames.map(encodeProgressFrame).join(""),
});

/**
 * A reply written a frame at a time, as the route writes one.
 *
 * `route.fulfill` hands the browser a body that is whole before it is read, so
 * a page answered that way never has a frame to show before the result is
 * there too, and a bar drawn from the first frame is gone before anything can
 * see it. A part sent on with `route.continue` to a server of the test's own
 * arrives the way the real route's does: headers first, then each frame as
 * the test writes it, so what the page shows between two frames can be read.
 */
export async function liveStream() {
  let reply: ServerResponse | null = null;
  let opened: () => void = () => {};
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
    reply = response;
    opened();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    answer: { continueTo: `http://127.0.0.1:${port}/` } satisfies Forwarded,
    /** Settles once the page's request has reached the server. */
    open,
    push: (frame: ProgressFrame) => reply!.write(encodeProgressFrame(frame)),
    end: () => reply!.end(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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
    answerMove,
    holdPreview,
  }: {
    facts: LedgerFileFacts;
    here?: ReadonlySet<string>;
    answer?: (body: LedgerFileAddInput, call: number) => Answer | Promise<Answer>;
    /** A move's part, answered; left out, every part succeeds with what it carried out. */
    answerMove?: (
      body: LedgerFileAddInput,
      call: number,
    ) => Answer | Forwarded | Promise<Answer | Forwarded>;
    /** Keeps a part's preview waiting, so what the page says meanwhile can be read. */
    holdPreview?: (call: number) => Promise<void> | undefined;
  },
) {
  const previews: string[] = [];
  const adds: AddCall[] = [];
  const moves: AddCall[] = [];
  const isPreview = (url: URL) => url.pathname === "/api/v1/ledger-file:preview";
  const isAdd = (url: URL) => url.pathname === "/api/v1/ledger-file:add";
  const isMove = (url: URL) => url.pathname === "/api/v1/ledger-file:move";
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
  await page.route(isMove, async (route) => {
    const raw = route.request().postDataJSON() as Record<string, unknown>;
    // The move route's own parser, for the reason the add's is above.
    const body = ledgerFileMoveInputSchema.parse(raw);
    moves.push({ body, raw, accept: (await route.request().allHeaders())["accept"] ?? null });
    const reply = answerMove
      ? await answerMove(body, moves.length)
      : streamed([{ type: "result", value: moveResultFor(body, facts, here) }]);
    if ("continueTo" in reply) await route.continue({ url: reply.continueTo });
    else await route.fulfill(reply);
  });
  return {
    previews,
    adds,
    moves,
    remove: async () => {
      await page.unroute(isPreview);
      await page.unroute(isAdd);
      await page.unroute(isMove);
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

  await visitMoveStates(page, section, measure);
}

/**
 * A ledger that may take a move, asking everything a move asks: the long
 * account here already and differing, so it has to be used or brought in as a
 * copy, and three places with two in use, so one account has to arrive
 * archived.
 */
export const movingEverything = () => qualifying(askingEverything());

/** The refusal a last part meets when two accounts come out different, as the route sends it. */
export const balanceRefusal = () => {
  const refusal = ledgerBalanceRefusal(
    [
      {
        field: "accounts.0.balance",
        key: LONG,
        name: LONG,
        currency: "EUR",
        expected: "1301.11",
        actual: "1311.11",
        difference: "10",
      },
      {
        field: "accounts.1.balance",
        key: "Brokerage",
        name: "Brokerage",
        currency: "USD",
        expected: "1081.4",
        actual: "81.4",
        difference: "-1000",
      },
    ],
    "2026-10-25",
    { part: { index: 1, count: 1 }, startsOn: null },
  );
  return streamed([
    {
      type: "error",
      error: { error: { code: "CONFLICT", message: refusal.message, details: refusal.details } },
    },
  ]);
};

/** The move's states, each handed to `measure`: the choice, its questions, a stop and the end. */
async function visitMoveStates(
  page: Page,
  section: Locator,
  measure: (state: string) => Promise<void>,
) {
  // A ledger somebody has typed into: moving is refused beside itself.
  const typed = await answerLedgerFileImport(page, { facts: typedInto(askingEverything()) });
  await page.goto("/import");
  await chooseByKeyboard(page, section, longLedger());
  await expect(section.getByRole("radio", { name: "Move it into this ledger" })).toBeDisabled();
  await measure("a move refused, beside adding");
  await typed.remove();

  // Both ways open and neither chosen, then a move asking everything it can.
  const moving = await answerLedgerFileImport(page, {
    facts: movingEverything(),
    answerMove: (body, call) =>
      call === 1
        ? balanceRefusal()
        : streamed([
            { type: "progress", event: { phase: "posting", done: 5, total: 6 } },
            { type: "result", value: moveResultFor(body, movingEverything()) },
          ]),
  });
  await page.goto("/import");
  await chooseByKeyboard(page, section, longLedger());
  await expect(section.getByRole("button", { name: "Import this file" })).toBeVisible();
  await measure("a file that may be moved or added, with neither chosen");
  await section.getByRole("radio", { name: "Move it into this ledger" }).check();
  // One answer, so a box to tick: the one here opens differently, and a move
  // holds every balance to the file, so it cannot be used.
  await section.getByRole("checkbox", { name: /Bring it in as$/ }).check();
  await section.getByRole("button", { name: /^Show all \d+ records$/ }).click();
  await expect(section.getByRole("heading", { name: "Still to decide" })).toBeVisible();
  await measure("a move asking about a duplicate and places, with every record shown");

  // Answered, sent, and stopped by balances that did not come out, which the
  // same request would meet again, so trying again waits on a fresh check.
  await section.getByRole("checkbox", { name: /^Brokerage/ }).check();
  await section.getByRole("radio", { name: /^Keep this copy's/ }).check();
  await section.getByRole("button", { name: "Move into this ledger" }).click();
  await expect(section.getByRole("button", { name: "Try again" })).toBeDisabled();
  await measure("a move stopped by balances that did not come out");

  // Checked again, sent again, and finished.
  await section.getByRole("button", { name: "Check the file again" }).click();
  await section.getByRole("button", { name: "Move into this ledger" }).click();
  await expect(section.getByText(/^Moved "/)).toBeVisible();
  await measure("a move that finished");
  await moving.remove();
}
