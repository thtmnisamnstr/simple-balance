import { expect, test, type Page } from "@playwright/test";
import {
  LEDGER_FILE_PART_MAX_BYTES,
  serializeLedgerFile,
  splitLedgerFile,
} from "../../src/shared/ledger-file.js";
import { origin, wholeLedger } from "../support/ledger-file.js";
import {
  accountLike,
  factsOf,
  ownAccount,
  parsedLedger,
  resultFor,
} from "../support/ledger-file-facts.js";
import {
  answerLedgerFileImport,
  chooseByKeyboard,
  streamed,
} from "./support/ledger-file-import.js";

/**
 * Adding a Simple Balance file, from the keyboard alone, against the routes'
 * answers.
 *
 * jsdom holds the request bodies and every state of the section; what it
 * cannot hold is the browser's own share — a real file chosen through the
 * drop zone's input from the keyboard, the arrow keys moving inside a radio
 * group, Enter in a name field submitting the form, a streamed reply read as
 * frames, focus landing on the sentence that says what was done — and a file
 * large enough to need a second part, which the page cuts with the splitter's
 * real limits rather than a test's small ones.
 */

const person = {
  email: `ledger-import-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "Ledger Import",
};

/** The same sign-up the other browser specs do, and for the reason they give. */
async function signUp(page: Page) {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Sign up" });
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

/**
 * `wholeLedger` with `count` more withdrawals, which is how a file comes to
 * need a second part: the cap is ten thousand rows, and a part is cut at it.
 */
function largeLedger(count: number) {
  const file = wholeLedger();
  const more = Array.from({ length: count }, (_, at) => ({
    id: origin(200_000 + at),
    type: "withdrawal",
    date: `2025-${String((at % 12) + 1).padStart(2, "0")}-${String((at % 28) + 1).padStart(2, "0")}`,
    from: "Checking",
    amount: "1.25",
    payee: `Kiosk ${at}`,
  }));
  return { ...file, entries: [...(file.entries as unknown[]), ...more] };
}

test.describe.configure({ mode: "serial" });

test.describe("adding a Simple Balance file", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signUp(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("is chosen, decided and added from the keyboard, and says what it did", async () => {
    const facts = factsOf(
      {
        accounts: [accountLike("Checking", { institution: "Another bank" }), ownAccount("Wallet")],
      },
      {
        limit: 3,
        preferences: { chosen: true, timezone: "UTC", defaultCurrency: "USD", theme: "light" },
      },
    );
    const routes = await answerLedgerFileImport(page, {
      facts,
      answer: (body) =>
        streamed([
          { type: "progress", event: { phase: "staging", done: 3, total: 7 } },
          { type: "result", value: resultFor(body, facts, new Set(), 1) },
        ]),
    });
    await page.goto("/import");
    const section = page.getByRole("region", { name: "Import a Simple Balance file" });
    await chooseByKeyboard(page, section, wholeLedger());
    await expect(section.getByRole("button", { name: "Add to this ledger" })).toBeDisabled();
    expect(routes.previews).toHaveLength(1);

    // The duplicate: into its group, and along it with the arrows to a copy.
    const duplicate = section.getByRole("radiogroup", { name: 'Account "Checking" (EUR)' });
    await duplicate.getByRole("radio", { name: "Use the one here" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(duplicate.getByRole("radio", { name: "Bring it in as" })).toBeChecked();
    // The copy's name is the next stop, offered and editable.
    await page.keyboard.press("Tab");
    const name = section.getByRole("textbox", { name: 'New name for "Checking"' });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("Checking (2)");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Checking at the old bank");

    // A copy takes a place, so one account has to arrive archived now.
    await expect(section.getByRole("group", { name: "Accounts to arrive archived" })).toContainText(
      "choose at least 1 to arrive archived",
    );
    await section.getByRole("checkbox", { name: "Brokerage USD" }).focus();
    await page.keyboard.press("Space");

    // And the settings, which nothing chose for anybody.
    const settings = section.getByRole("radiogroup", { name: "Regional defaults and appearance" });
    await settings.getByRole("radio", { name: /^Use the file's/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(settings.getByRole("radio", { name: /^Keep this copy's/ })).toBeChecked();

    // Enter in a single-line field submits the form, which is the add.
    await expect(section.getByRole("button", { name: "Add to this ledger" })).toBeEnabled();
    await name.focus();
    await page.keyboard.press("Enter");

    const done = section.getByRole("status").filter({ hasText: /^Added "/ });
    await expect(done).toHaveText(
      'Added "simple-balance-2026-10-25.json" to this ledger. 7 rows went to Staged for review, and 1 of them need something from you before they can be committed.',
    );
    await expect(done).toBeFocused();
    await expect(section.getByRole("link", { name: "Review 7 staged rows" })).toHaveAttribute(
      "href",
      `/staged?importBatchId=${origin(5001)}&preset=all-time`,
    );

    expect(routes.adds).toHaveLength(1);
    const [sent] = routes.adds;
    expect(sent!.accept).toBe("text/event-stream");
    const [part] = (() => {
      const split = splitLedgerFile(parsedLedger(wholeLedger()));
      if (!split.ok) throw new Error(split.message);
      return split.parts.map(serializeLedgerFile);
    })();
    expect(sent!.raw).toEqual({
      ledgerFile: part,
      fileName: "simple-balance-2026-10-25.json",
      idempotencyKey: expect.stringMatching(/-1$/),
      part: { index: 1, count: 1 },
      decisions: [
        { kind: "account", key: "Checking", action: "rename", name: "Checking at the old bank" },
      ],
      arriveArchived: ["Brokerage"],
      preferences: "keep",
    });
    await routes.remove();
  });

  test("is checked and added in parts when it is over ten thousand rows", async () => {
    test.setTimeout(120_000);
    let release: () => void = () => {};
    const facts = factsOf();
    const routes = await answerLedgerFileImport(page, {
      facts,
      holdPreview: (call) =>
        call === 2
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : undefined,
    });
    const file = largeLedger(10_000);
    await page.goto("/import");
    const section = page.getByRole("region", { name: "Import a Simple Balance file" });
    await chooseByKeyboard(page, section, file);
    await expect(section.getByText("Checking part 2 of 2 against this ledger")).toBeVisible();
    release();
    const add = section.getByRole("button", { name: "Add to this ledger" });
    await expect(add).toBeEnabled();

    // Cut by the splitter's own limits, which the server holds every part to.
    const split = splitLedgerFile(parsedLedger(file));
    if (!split.ok) throw new Error(split.message);
    const parts = split.parts.map(serializeLedgerFile);
    expect(parts).toHaveLength(2);
    expect(routes.previews).toEqual(parts);
    for (const text of parts) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LEDGER_FILE_PART_MAX_BYTES);
    }
    // Planned as one file: every live entry is counted, not one part's share.
    await expect(section.getByText(/^10,005 transactions go to Staged for review/)).toBeVisible();

    await add.focus();
    await page.keyboard.press("Enter");
    await expect(section.getByText(/^Added "/)).toBeVisible();
    expect(routes.adds.map(({ body }) => body.part)).toEqual([
      { index: 1, count: 2 },
      { index: 2, count: 2 },
    ]);
    expect(routes.adds.map(({ body }) => body.ledgerFile)).toEqual(parts);
    const [first, second] = routes.adds.map(({ body }) => body.idempotencyKey);
    expect(first!.slice(0, -2)).toBe(second!.slice(0, -2));
    expect([first!.slice(-2), second!.slice(-2)]).toEqual(["-1", "-2"]);
    // One batch per part, so one link to each.
    await expect(section.getByRole("link", { name: /^Review part 1's / })).toBeVisible();
    await expect(section.getByRole("link", { name: /^Review part 2's / })).toBeVisible();
    await routes.remove();
  });

  /**
   * The drop zone's input is refused while a file is checked, never disabled:
   * a browser blurs an element it disables, so the input that was just used
   * let go of focus and the preview arrived with it on `<body>` (web.md 13.3).
   * Only a real browser blurs; jsdom does not, which is why this is here.
   */
  test("keeps focus on the file input while the file is checked, and once it is", async () => {
    let release: () => void = () => {};
    const routes = await answerLedgerFileImport(page, {
      facts: factsOf(),
      holdPreview: (call) =>
        call === 1
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : undefined,
    });
    await page.goto("/import");
    const section = page.getByRole("region", { name: "Import a Simple Balance file" });
    const input = section.locator('input[type="file"]');
    await chooseByKeyboard(page, section, wholeLedger());
    await expect(section.getByText("Checking the file against this ledger")).toBeVisible();
    await expect(input).toHaveAttribute("aria-disabled", "true");
    await expect(input).toBeFocused();
    // Refused while it works: Space opens no chooser.
    const opened = page
      .waitForEvent("filechooser", { timeout: 750 })
      .then(() => true)
      .catch(() => false);
    await page.keyboard.press("Space");
    expect(await opened).toBe(false);
    release();
    await expect(section.getByRole("button", { name: "Add to this ledger" })).toBeVisible();
    await expect(input).not.toHaveAttribute("aria-disabled", "true");
    await expect(input).toBeFocused();
    expect(routes.previews).toHaveLength(1);
    await routes.remove();
  });
});
