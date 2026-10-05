import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `web.md` 13.3: a control whose own success removes or disables the control
 * puts focus on the sentence saying what happened, or back on the control.
 *
 * The population is derived from the product rather than listed, because
 * listing is how this rule failed twice. It was first written as three pages;
 * four more of the shape shipped. It was then rewritten as a shape, and
 * `tests/shell-focus.tsx` derives two of them — a `<SelectionBar>`, and a panel
 * gated on two or more selected rows. Three more defects landed outside both:
 * the account chooser, the duplicate queue and the sign-in screen, each a
 * button that `loading` disables, answered by a sentence the button is not in.
 * Removing `takeFocus` from any of the three still passes that check today.
 *
 * So this derives the third shape from the answer rather than from the trigger:
 * every `<Alert kind="success">` in the browser. A success alert exists to
 * report a finished action, which is the moment 13.3 is about, and every one of
 * the seven defects showed up as one. Each either takes focus or is named
 * below.
 *
 * **What is unsettled, said here rather than left implied.** `Button` renders
 * `disabled={loading || props.disabled}`, and a browser blurs an element it
 * disables, so after any pending submit focus is on `<body>` whether or not the
 * control comes back. The four entries below argue from reading order — the
 * sentence is the next thing after the control that produced it, inside the
 * same form — and that is a judgment 13.3 leaves open rather than a rule it
 * states. It is worth somebody settling; the register is here so the question
 * is visible rather than absent.
 */
describe("every sentence that reports a finished action", () => {
  /**
   * Named by the file and by the words, rather than by a line, which drifts.
   *
   * The words are the alert's children collapsed to one line, which is what a
   * reader recognizes it by, and a rewrite of the sentence is a change worth
   * looking at again.
   */
  const LEAVES_FOCUS_ALONE: Record<string, string> = {
    "src/client/forms.tsx#{repeatNotice}":
      "Rendered inside the entry form, directly above the actions that produced it, and the form stays open for the next entry. The control comes back and the sentence is the next thing in reading order, so moving focus would take somebody out of a form they are still filling in.",
    "src/client/pages/SettingsPage.tsx#Preferences saved.":
      "The same shape: the alert is inside the preferences form, one element above its own submit, and the form is still there to be submitted again. Nothing was removed, so there is nothing for focus to have lost.",
    "src/client/pages/SettingsPage.tsx#Password updated. Any connected agents have been disconnected.":
      "The same again, in the password form. The sentence matters enough that it carries the consequence rather than only the outcome, and it sits where the person who pressed the button is already reading.",
    "src/client/pages/BudgetsPage.tsx#{notice}":
      "Reports the standing budget that was just created, immediately above the form that created it. The form clears and stays open because the next budget is the next thing somebody does, so the control is neither gone nor still disabled.",
  };

  /**
   * Every `<Alert kind="success" …>…</Alert>`, with its attributes and its
   * words.
   *
   * Brace-counted rather than cut at the first `>`: `kind={…}` and a nested
   * element both carry characters that end the element early, which is the way
   * every scan over this repository's JSX has gone wrong at least once.
   */
  const alerts = sourceFiles("src/client").flatMap((file) =>
    file.path.endsWith(".tsx")
      ? [...file.code.matchAll(/<Alert\b/g)].flatMap((hit) => {
          let depth = 0;
          let index = hit.index;
          let opened = -1;
          while (index < file.code.length) {
            const character = file.code[index]!;
            if (character === '"') index = file.code.indexOf('"', index + 1);
            else if (character === "{") depth += 1;
            else if (character === "}") depth -= 1;
            else if (character === ">" && depth === 0) {
              opened = index;
              break;
            }
            if (index < 0) break;
            index += 1;
          }
          if (opened < 0) return [];
          const props = file.code.slice(hit.index, opened + 1);
          if (!props.includes('kind="success"')) return [];
          const closed = file.code.indexOf("</Alert>", opened);
          const words = file.code
            .slice(opened + 1, closed < 0 ? opened + 1 : closed)
            .replaceAll(/\s+/g, " ")
            .trim();
          return [{ key: `${file.path}#${words}`, takesFocus: /\btakeFocus\b/.test(props) }];
        })
      : [],
  );

  it("is found, and more than a handful of them", () => {
    // A scan that stopped matching would report nothing wrong because it read
    // nothing at all, which is how three checks in this repository passed
    // forever.
    expect(alerts.length, "no success alert was read").toBeGreaterThan(8);
    expect(alerts.filter((alert) => alert.takesFocus).length).toBeGreaterThan(4);
    expect(alerts.map((alert) => alert.key)).toContain(
      "src/client/pages/SettingsPage.tsx#Preferences saved.",
    );
  });

  it("takes focus, or is named with the reason it does not", () => {
    const silent = alerts
      .filter((alert) => !alert.takesFocus && !(alert.key in LEAVES_FOCUS_ALONE))
      .map((alert) => alert.key);
    expect(
      silent,
      "give the alert takeFocus, or name it above with why focus belongs where it is",
    ).toEqual([]);
    // A register as long as the population would excuse everything.
    expect(alerts.length - Object.keys(LEAVES_FOCUS_ALONE).length).toBeGreaterThan(4);
  });

  it("excuses nothing that is no longer there", () => {
    const keys = new Set(alerts.map((alert) => alert.key));
    expect(Object.keys(LEAVES_FOCUS_ALONE).filter((key) => !keys.has(key))).toEqual([]);
    const focusing = new Set(alerts.filter((alert) => alert.takesFocus).map((alert) => alert.key));
    expect(Object.keys(LEAVES_FOCUS_ALONE).filter((key) => focusing.has(key))).toEqual([]);
  });

  it("gives every one of them a reason somebody had to write", () => {
    for (const [key, reason] of Object.entries(LEAVES_FOCUS_ALONE)) {
      expect(reason.length, key).toBeGreaterThan(40);
    }
  });
});
