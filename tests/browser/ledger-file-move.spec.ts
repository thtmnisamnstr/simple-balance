import { expect, test, type Page } from "@playwright/test";
import { serializeLedgerFile, splitLedgerFile } from "../../src/shared/ledger-file.js";
import { LEDGER_FILE_MOVE_BLOCKED } from "../../src/shared/ledger-file-import.js";
import { origin, wholeLedger } from "../support/ledger-file.js";
import { accountLike, factsOf, parsedLedger } from "../support/ledger-file-facts.js";
import { moveResultFor, qualifying, typedInto } from "../support/ledger-file-move-facts.js";
import {
  answerLedgerFileImport,
  chooseByKeyboard,
  liveStream,
  streamed,
} from "./support/ledger-file-import.js";

/**
 * Moving a Simple Balance file into a ledger that may take one, from the
 * keyboard alone, against the routes' answers.
 *
 * jsdom holds the request bodies and every state of the section. What it
 * cannot hold is the browser's share: a real file chosen through the drop
 * zone's input, the arrow keys and Space inside the way-in radio group, a
 * disabled radio the arrows pass over, a reply read as frames, and a file
 * large enough to be cut into two parts by the splitter's real limits, sent
 * one after the other to the move's own route with focus ending on what was
 * done.
 */

const person = {
  email: `ledger-move-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "Ledger Move",
};

/** The same sign-up the other browser specs do, and for the reason they give. */
async function signUp(page: Page) {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Create an account" });
  const heading = page.getByRole("heading", { name: "Create your account" });
  await expect(heading.or(toggle)).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await expect(heading).toBeVisible();
  await page.getByLabel("Your name").fill(person.name);
  await page.getByLabel("Email address").fill(person.email);
  await page.getByLabel(/^Password/).fill(person.password);
  await page.getByLabel(/^Confirm password/).fill(person.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

/** `wholeLedger` with `count` more withdrawals, which is how a file comes to need a second part. */
function largeLedger(count: number) {
  const file = wholeLedger();
  const more = Array.from({ length: count }, (_, at) => ({
    id: origin(300_000 + at),
    type: "withdrawal",
    date: `2025-${String((at % 12) + 1).padStart(2, "0")}-${String((at % 28) + 1).padStart(2, "0")}`,
    from: "Checking",
    amount: "1.25",
    payee: `Kiosk ${at}`,
  }));
  return { ...file, entries: [...(file.entries as unknown[]), ...more] };
}

test.describe.configure({ mode: "serial" });

test.describe("moving a Simple Balance file", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signUp(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("is chosen, moved in two parts and summed up, from the keyboard", async () => {
    test.setTimeout(120_000);
    const facts = qualifying(factsOf());
    // The first part answered a frame at a time, so the bar can be read
    // between two of them; the second held, so "Part 2 of 2" can.
    const live = await liveStream();
    let release: () => void = () => {};
    const routes = await answerLedgerFileImport(page, {
      facts,
      answerMove: async (body, call) => {
        if (call === 1) return live.answer;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return streamed([{ type: "result", value: moveResultFor(body, facts) }]);
      },
    });
    const file = largeLedger(10_000);
    await page.goto("/import");
    const section = page.getByRole("region", { name: "Import a Simple Balance file" });
    await chooseByKeyboard(page, section, file);
    const action = section.getByRole("button", { name: "Import this file" });
    await expect(action).toBeDisabled();
    await expect(action).toHaveAccessibleDescription("Choose how the file comes in.");

    // From the file input into the way-in group: neither is chosen, so Tab
    // lands on the first, and Space chooses it.
    const move = section.getByRole("radio", { name: "Move it into this ledger" });
    const add = section.getByRole("radio", { name: "Add it to this ledger" });
    await page.keyboard.press("Tab");
    await expect(move).toBeFocused();
    await expect(move).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(move).toBeChecked();
    // The arrows move between the two and choose as they go, and back.
    await page.keyboard.press("ArrowDown");
    await expect(add).toBeChecked();
    await expect(section.getByRole("button", { name: "Add to this ledger" })).toBeEnabled();
    await page.keyboard.press("ArrowUp");
    await expect(move).toBeChecked();

    // Planned as one file, both parts together.
    await expect(
      section.getByText("10,005 transactions go straight into the books, with nothing to review."),
    ).toBeVisible();
    await expect(
      section.getByText(
        "The balances of 2 accounts are checked against the file once the last part is in, and that part is not written if one comes out different.",
      ),
    ).toBeVisible();

    const moveButton = section.getByRole("button", { name: "Move into this ledger" });
    await moveButton.focus();
    await page.keyboard.press("Enter");
    await live.open;
    await expect(section.getByText("Part 1 of 2")).toBeVisible();
    // No bar before a count is real (web.md 12.6), then one from the frame,
    // in the move's own word for posting.
    await expect(section.getByRole("progressbar")).toHaveCount(0);
    live.push({ type: "progress", event: { phase: "posting", done: 4_120, total: 10_000 } });
    const bar = section.getByRole("progressbar", { name: "4,120 of 10,000 written" });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveJSProperty("value", 0.412);
    live.push({ type: "result", value: moveResultFor(routes.moves[0]!.body, facts) });
    live.end();
    await expect(section.getByText("Part 2 of 2")).toBeVisible();
    await expect(section.getByRole("progressbar")).toHaveCount(0);
    // The way in cannot change under a move in flight.
    await expect(move).toBeDisabled();
    release();

    const done = section.getByRole("status").filter({ hasText: /^Moved "/ });
    await expect(done).toHaveText(
      'Moved "simple-balance-2026-10-25.json" into this ledger. 10,005 transactions went straight into the books, and 1 deleted transaction came in deleted, as it was where the file came from.',
    );
    await expect(done).toBeFocused();
    await expect(
      section.getByText(
        "Every balance came out as the file says: 2 accounts checked. 1 account archived where the file came from was not compared, holding nothing there to compare with.",
      ),
    ).toBeVisible();
    await expect(section.getByRole("link", { name: "Open Accounts" })).toBeVisible();

    // Cut by the splitter's own limits, sent in order to the move's route,
    // one key per part from one per attempt, asking for frames each time.
    const split = splitLedgerFile(parsedLedger(file));
    if (!split.ok) throw new Error(split.message);
    const parts = split.parts.map(serializeLedgerFile);
    expect(parts).toHaveLength(2);
    expect(routes.adds).toEqual([]);
    expect(routes.moves.map(({ body }) => body.ledgerFile)).toEqual(parts);
    expect(routes.moves.map(({ body }) => body.part)).toEqual([
      { index: 1, count: 2 },
      { index: 2, count: 2 },
    ]);
    expect(routes.moves.map(({ accept }) => accept)).toEqual([
      "text/event-stream",
      "text/event-stream",
    ]);
    const [first, second] = routes.moves.map(({ body }) => body.idempotencyKey);
    expect(first!.slice(0, -2)).toBe(second!.slice(0, -2));
    expect([first!.slice(-2), second!.slice(-2)]).toEqual(["-1", "-2"]);
    await routes.remove();
    await live.close();
  });

  test("ends on the button when Enter in a name field sends it and the part stops", async () => {
    // The one here opens differently, so a move can only bring the file's in
    // under another name, and the name field is the last thing somebody types
    // in. Enter there submits through the default button while the field is
    // disabled under it, which a browser answers by blurring the field.
    const routes = await answerLedgerFileImport(page, {
      facts: qualifying(factsOf({ accounts: [accountLike("Checking", { openingBalance: "1" })] })),
      answerMove: () =>
        streamed([
          {
            type: "error",
            error: {
              error: {
                code: "CONFLICT",
                message:
                  "Another import wrote this file's transactions a moment ago. Check the file again.",
              },
            },
          },
        ]),
    });
    await page.goto("/import");
    const section = page.getByRole("region", { name: "Import a Simple Balance file" });
    await chooseByKeyboard(page, section, wholeLedger());
    await section.getByRole("radio", { name: "Move it into this ledger" }).check();
    await section.getByRole("checkbox", { name: /Bring it in as$/ }).check();
    const name = section.getByRole("textbox", { name: 'New name for "Checking"' });
    await name.focus();
    await page.keyboard.press("Enter");
    const retry = section.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await expect(name).toBeDisabled();
    // Where a pressed button ends, so the next Tab carries on from here.
    await expect(retry).toBeFocused();
    expect(routes.moves).toHaveLength(1);
    await routes.remove();
  });

  test("is refused beside adding once the ledger holds a transaction typed into it", async () => {
    const routes = await answerLedgerFileImport(page, { facts: typedInto(factsOf()) });
    await page.goto("/import");
    const section = page.getByRole("region", { name: "Import a Simple Balance file" });
    await chooseByKeyboard(page, section, wholeLedger());
    const move = section.getByRole("radio", { name: "Move it into this ledger" });
    const add = section.getByRole("radio", { name: "Add it to this ledger" });
    await expect(move).toBeDisabled();
    await expect(move).toHaveAccessibleDescription(LEDGER_FILE_MOVE_BLOCKED);
    await expect(section.getByText(LEDGER_FILE_MOVE_BLOCKED)).toBeVisible();
    await expect(add).toBeChecked();
    // Tab reaches the chosen radio, and the arrows have nowhere else to go:
    // the refused one is passed over.
    await page.keyboard.press("Tab");
    await expect(add).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(add).toBeChecked();
    await expect(move).not.toBeChecked();

    const addButton = section.getByRole("button", { name: "Add to this ledger" });
    await addButton.focus();
    await page.keyboard.press("Enter");
    await expect(section.getByText(/^Added "/)).toBeVisible();
    expect(routes.moves).toEqual([]);
    expect(routes.adds).toHaveLength(1);
    await routes.remove();
  });
});
