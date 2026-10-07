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

/**
 * The trigger half, which the answer half above cannot see.
 *
 * Deriving the population from the success alerts finds every finished action
 * that HAS a sentence, so an action with none is invisible to it — and six
 * deletes were exactly that: a template, a recurrence, a standing budget, a
 * category group, a connected agent and the other row on the duplicate review
 * each removed the row and the button that removed it, left focus on
 * `<body>`, and said nothing. So this starts from the trigger: every mutation
 * that sends a `DELETE` has to set, on success, a piece of state that some
 * focus-taking `Alert` in the same file renders.
 */
describe("every delete a row confirms", () => {
  /** The text from `open` to the brace or paren that closes it. */
  const balanced = (code: string, open: number) => {
    const opener = code[open]!;
    const closer = opener === "{" ? "}" : ")";
    let depth = 0;
    for (let index = open; index < code.length; index += 1) {
      if (code[index] === opener) depth += 1;
      else if (code[index] === closer && --depth === 0) return code.slice(open, index + 1);
    }
    return code.slice(open);
  };

  /**
   * Named with the reason a sentence is not the answer. Deleting the account
   * ends the session and leaves the app, so there is no page left to put one
   * on.
   */
  const NO_PAGE_LEFT: Record<string, string> = {
    "src/client/pages/SettingsPage.tsx#/api/v1/me":
      "Deleting the account signs the person out and leaves the app; the sentence it would need has nowhere to render.",
  };

  const deletes = sourceFiles("src/client").flatMap((file) =>
    [...file.code.matchAll(/useMutation\b[^(]*\(/g)].flatMap((hit) => {
      const body = balanced(file.code, hit.index + hit[0].length - 1);
      if (!body.includes('method: "DELETE"')) return [];
      const path = /api(?:<[^>]*>)?\(\s*[`"]([^`"$]+)/.exec(body)?.[1] ?? "?";
      const onSuccess = /onSuccess\s*:\s*(?:async\s*)?\(/.exec(body);
      const handler = onSuccess ? body.slice(onSuccess.index) : "";
      const setters = [...handler.matchAll(/\bset([A-Z]\w*)\(/g)].map(
        (setter) => setter[1]!.charAt(0).toLowerCase() + setter[1]!.slice(1),
      );
      return [{ key: `${file.path}#${path}`, file, setters }];
    }),
  );

  /** Every identifier a focus-taking `Alert` in this file reads in its words. */
  const focusedWords = (code: string) =>
    new Set(
      [...code.matchAll(/<Alert\b[^>]*\btakeFocus\b[^>]*>([\s\S]*?)<\/Alert>/g)].flatMap((alert) =>
        [...alert[1]!.matchAll(/[A-Za-z_$][\w$]*/g)].map((word) => word[0]),
      ),
    );

  it("finds them", () => {
    expect(deletes.length).toBeGreaterThanOrEqual(8);
  });

  it("says, where focus lands, that the row has gone", () => {
    const silent = deletes
      .filter((one) => !(one.key in NO_PAGE_LEFT))
      .filter((one) => {
        const words = focusedWords(one.file.code);
        return !one.setters.some((state) => words.has(state));
      })
      .map((one) => one.key);
    expect(silent, "set a notice an Alert with takeFocus renders").toEqual([]);
    const keys = new Set(deletes.map((one) => one.key));
    expect(Object.keys(NO_PAGE_LEFT).filter((key) => !keys.has(key))).toEqual([]);
  });
});

/**
 * A notice is about the last press, so the next press clears it.
 *
 * An alert already on screen announces nothing when its words are set to the
 * same words again, and takes no focus, so a second "Amazon committed." in a run
 * of one payee's imported rows, or a second "Deleted “Coffee”, Oct 1.", was
 * silent and left focus on `<body>`. And a notice left up sat beside the next
 * press's refusal, so the page reported on one record twice. Accounts and
 * Categories already cleared theirs as each press started; three pages that
 * gained notices in 0.2.1 did not, and neither did the staged queue's row
 * actions before them.
 *
 * Derived from every `useMutation` in the client whose `onSuccess` sets a
 * notice or an outcome: the same setter is called with nothing in `onMutate`,
 * directly or through a helper it names, or at the top of `mutationFn`.
 */
describe("every notice a press leaves", () => {
  /** Cleared before the mutation is called rather than inside it. */
  const CLEARED_BEFORE: Record<string, string> = {
    "src/client/pages/BudgetsPage.tsx#createPlan#setNotice":
      "The form's submit handler calls `startAttempt`, which clears the notice and the error, before every `createPlan.mutate`.",
    "src/client/pages/StagingPage.tsx#bulkEditMutation#setBulkEditNotice":
      "Only the bulk editor submits it, and `openBulkEditor` clears the notice as the editor opens, which it has to before every edit because a successful one closes it.",
  };

  const presses = sourceFiles("src/client").flatMap((file) => {
    const found: { key: string; cleared: boolean }[] = [];
    for (const match of file.code.matchAll(/const (\w+) = useMutation\b[^(]*\(\{/g)) {
      let depth = 0;
      let end = match.index + match[0].length - 1;
      for (; end < file.code.length; end += 1) {
        if (file.code[end] === "{") depth += 1;
        else if (file.code[end] === "}" && --depth === 0) break;
      }
      const body = file.code.slice(match.index + match[0].length - 1, end + 1);
      const part = (name: string) =>
        body.slice(body.indexOf(`${name}:`), body.indexOf(`${name}:`) === -1 ? 0 : undefined);
      const onSuccess = part("onSuccess").split(/\n    on(?:Error|Settled|Mutate):/)[0]!;
      const setters = new Set(
        [...onSuccess.matchAll(/\b(set\w*(?:Notice|Outcome))\(\s*(?!null\b|""|undefined\b)/g)].map(
          (setter) => setter[1]!,
        ),
      );
      const onMutate = part("onMutate").split(/\n    on(?:Error|Settled|Success):/)[0]!;
      const helper = /^onMutate:\s*(\w+),/.exec(onMutate)?.[1];
      const helperBody = helper
        ? (new RegExp(`const ${helper} = [^;]*;`).exec(file.code)?.[0] ?? "")
        : "";
      const mutationFn = part("mutationFn").slice(0, 300);
      for (const setter of setters) {
        const clears = new RegExp(`${setter}\\(\\s*(?:null|""|undefined)\\s*\\)`);
        found.push({
          key: `${file.path}#${match[1]}#${setter}`,
          cleared: [onMutate, helperBody, mutationFn].some((text) => clears.test(text)),
        });
      }
    }
    return found;
  });

  it("finds the presses that leave one", () => {
    expect(presses.length).toBeGreaterThan(8);
  });

  it("clears it as the next press starts, or says where it is cleared instead", () => {
    expect(
      presses
        .filter((press) => !press.cleared && !(press.key in CLEARED_BEFORE))
        .map((press) => press.key),
      "clear the notice in onMutate",
    ).toEqual([]);
    expect(
      Object.keys(CLEARED_BEFORE).filter(
        (key) => !presses.some((press) => press.key === key && !press.cleared),
      ),
      "these are cleared in the mutation now, or gone — take them out",
    ).toEqual([]);
  });
});

/**
 * A bulk edit's refusal sits at the top of its dialog and takes focus.
 *
 * 0.2.1 moved all three to the top, where 8.3 puts a summary, and left them
 * without focus. The dialog scrolls with its footer, so on a phone or at zoom
 * somebody pressed Apply at the bottom and saw nothing happen: focus stayed on
 * Apply and the sentence was scrolled out of sight. Derived from every mutation
 * that posts to a `bulk-edit` path.
 */
describe("every bulk edit's refusal", () => {
  const refusals = sourceFiles("src/client").flatMap((file) =>
    [...file.code.matchAll(/const (\w+) = useMutation\b[\s\S]{0,400}?bulk-edit"/g)].map((match) => {
      const name = match[1]!;
      const alert = new RegExp(`\\{${name}\\.error \\? \\(?\\s*<Alert([^>]*)>`).exec(file.code);
      return { where: `${file.path}#${name}`, attributes: alert?.[1] };
    }),
  );

  it("finds all three", () => {
    expect(refusals.map((refusal) => refusal.where).sort()).toEqual([
      "src/client/TransactionBrowser.tsx#bulkMutation",
      "src/client/pages/StagingPage.tsx#bulkEditMutation",
      "src/client/pages/TemplatesPage.tsx#bulkEdit",
    ]);
  });

  it("takes focus", () => {
    for (const refusal of refusals) {
      expect(refusal.attributes, refusal.where).toContain("takeFocus");
    }
  });
});
