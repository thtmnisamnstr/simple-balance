import { describe, expect, it } from "vitest";
import { sourceFiles, type SourceFile } from "./support/source.js";

/**
 * Whether a password manager can fill the forms that take a credential.
 *
 * `web.md` 8.6 is **Binding twice over**. SC 1.3.5 Identify Input Purpose
 * (AA) wants `autocomplete` tokens on the sign-in, sign-up and settings fields,
 * because those collect information about the user — and the same section
 * argues the exclusion of ledger fields as a *scope* argument rather than a
 * missing-token one, since WCAG §7 does define `transaction-amount`. SC 3.3.8
 * Accessible Authentication (AA) is narrower and harder: never block paste in a
 * password field, never disable autofill, and always set `current-password` or
 * `new-password`. Note 2 of that criterion names password-manager support and
 * copy-and-paste as the two qualifying mechanisms, so a password field without
 * a token is not untidy — it is the criterion failing.
 *
 * The guide filed this as *Not checked mechanically*, with "a grep for
 * `autocomplete` on the auth forms would cover the first half". Nothing in the
 * suite mentioned the word at all: seven password controls and eleven tokens
 * shipped correct and entirely unwatched, and the next field to arrive would
 * have shipped however it was written.
 *
 * **The population is derived from the product, never from the presence of a
 * token** (`web.md` 17.2's opening rule). Two populations, each a different
 * question:
 *
 * - Every control that is `type="password"`, anywhere in the client. That is
 *   SC 3.3.8's own population, and it needs no roster: a new password field
 *   declares itself by its type.
 * - Every control inside an auth form, found by the form's own class. That is
 *   SC 1.3.5's: an email box on the sign-in screen is about the person whether
 *   or not it is a password.
 *
 * Read from the source rather than rendered, because these forms branch on
 * server state — `setup`, `localEnabled`, `setupTokenRequired`, whether a
 * password is already configured — and a rendered pass would have to reach
 * every branch or quietly check the ones it happened to reach. That is the
 * failure shape 17.2 lists: a check whose population is whatever it bumped
 * into.
 */

/** A JSX opening tag, from `<Name` to the `>` that closes that same tag. */
type Element = {
  readonly file: string;
  readonly line: number;
  readonly tag: string;
  readonly attributes: string;
};

/**
 * Scan an opening tag to its real end.
 *
 * Not a width, and not the first `/>`: an attribute value is an arbitrary
 * expression, and the ones here hold object literals, arrow functions with
 * their own JSX inside, template strings and regular division. A window of n
 * characters truncates a tag whose props run long — which reads as "the
 * attribute is absent" and passes — and stopping at the first slash ends the
 * tag inside a closing `</span>` or a `//` in a URL. So brace depth and quote
 * state are tracked, and the tag ends at the first `>` outside both.
 */
function openingTag(source: string, from: number): string {
  let depth = 0;
  let quote = "";
  for (let index = from; index < source.length; index++) {
    const character = source[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === ">" && depth === 0) return source.slice(from, index + 1);
  }
  return source.slice(from);
}

/** Every `<Input>`, `<input>`, `<Select>` and `<select>` in one file. */
function controls(file: SourceFile): Element[] {
  const found: Element[] = [];
  for (const match of file.code.matchAll(/<(Input|input|Select|select)\b/g)) {
    found.push({
      file: file.path,
      line: file.text.slice(0, match.index).split("\n").length,
      tag: match[1]!,
      attributes: openingTag(file.code, match.index),
    });
  }
  return found;
}

const client = sourceFiles("src/client");
const every = client.flatMap(controls);

/** The value of a string-literal attribute, or `undefined` when it is absent. */
const literal = (element: Element, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(element.attributes)?.[1];

/** Whether an attribute is present at all, string or expression. */
const present = (element: Element, name: string): boolean =>
  new RegExp(`\\b${name}[=\\s]`).test(element.attributes);

const where = (element: Element) => `${element.file}:${element.line} <${element.tag}>`;

describe("the scanner that finds the fields", () => {
  /**
   * Every assertion below is a search for something missing, and a scanner that
   * had stopped matching would report every one of them satisfied. So the
   * reading is proved first, against the shapes that break the naive versions:
   * a tag whose props run over a dozen lines, and one whose `onChange` holds
   * braces, a comparison and a nested call.
   */
  it("finds the controls and reads attributes off them whole", () => {
    expect(every.length).toBeGreaterThan(40);
    const passwords = every.filter((element) => literal(element, "type") === "password");
    expect(passwords.length).toBeGreaterThanOrEqual(7);

    // The sign-up password field: `minLength` comes from a server value, the
    // `onChange` body spans eleven lines and sets custom validity on a ref, and
    // `autoComplete` is a ternary. Every one of those is after the point a
    // fixed-width window would have cut.
    const signUp = passwords.find(
      (element) =>
        element.file === "src/client/App.tsx" && /setup \? "new-password"/.test(element.attributes),
    );
    expect(signUp, "App.tsx's sign-in password field was not read whole").toBeDefined();
    expect(signUp!.attributes).toContain("setCustomValidity");
    expect(signUp!.attributes.split("\n").length).toBeGreaterThan(10);
  });
});

describe("password fields", () => {
  const passwords = every.filter((element) => literal(element, "type") === "password");

  /**
   * SC 3.3.8's whole mechanism. A token that is not one of these two tells the
   * manager nothing it can act on, and `off` tells it to stay away — which the
   * criterion's Note 2 names as the support being absent.
   */
  it("say which password they want, in the two words a manager reads", () => {
    const wrong: string[] = [];
    for (const element of passwords) {
      const token = literal(element, "autoComplete");
      // A ternary between the two tokens is correct and is how the one form
      // serving both sign-in and sign-up is written, so an expression is
      // accepted on the condition that both arms are.
      if (token === undefined) {
        const expression = /\bautoComplete=\{([\s\S]*?)\}/.exec(element.attributes)?.[1];
        if (expression === undefined) {
          wrong.push(`${where(element)} carries no autoComplete`);
          continue;
        }
        const quoted = [...expression.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
        const bad = quoted.filter(
          (value) => value !== "current-password" && value !== "new-password",
        );
        if (quoted.length === 0 || bad.length > 0) {
          wrong.push(`${where(element)} computes autoComplete as ${expression.trim()}`);
        }
        continue;
      }
      if (token !== "current-password" && token !== "new-password") {
        wrong.push(`${where(element)} sets autoComplete="${token}"`);
      }
    }
    expect(wrong, "SC 3.3.8 asks for current-password or new-password").toEqual([]);
  });

  /**
   * The other half of Note 2, and the half that is written as an *absence*:
   * there is no attribute for "paste works", so what is checked is that nothing
   * has been added to stop it. `onPaste` is the handler somebody reaches for,
   * and `readOnly` plus the managers' own opt-out attributes are the other
   * three ways the field gets taken away from the manager.
   */
  it("let a manager and a clipboard reach them", () => {
    const blocked: string[] = [];
    for (const element of passwords) {
      for (const attribute of [
        "onPaste",
        "onCopy",
        "readOnly",
        "data-lpignore",
        "data-1p-ignore",
      ]) {
        if (present(element, attribute)) blocked.push(`${where(element)} sets ${attribute}`);
      }
    }
    expect(blocked, "SC 3.3.8 Note 2 names paste and password managers").toEqual([]);
  });
});

describe("the auth forms", () => {
  /**
   * The forms themselves are the population. `local-auth-form` is the class the
   * three of them share — sign in, ask for a reset link, choose a new password
   * — and it is a class the stylesheet needs anyway, so it is not a marker this
   * test asked for and can lose.
   */
  const forms = client.flatMap((file) =>
    [...file.code.matchAll(/<form\b[^>]*className="local-auth-form"/g)].map((match) => {
      const close = file.code.indexOf("</form>", match.index);
      return {
        file: file.path,
        line: file.text.slice(0, match.index).split("\n").length,
        body: file.code.slice(match.index, close === -1 ? file.code.length : close),
      };
    }),
  );

  it("are all three found", () => {
    // The guard. Three forms, all in App.tsx; a selector that stopped matching
    // would leave the assertion below iterating nothing.
    expect(forms.map((form) => form.file)).toEqual([
      "src/client/App.tsx",
      "src/client/App.tsx",
      "src/client/App.tsx",
    ]);
  });

  it("give every field a purpose a browser can read", () => {
    const silent: string[] = [];
    for (const form of forms) {
      for (const match of form.body.matchAll(/<(Input|input)\b/g)) {
        const attributes = openingTag(form.body, match.index);
        if (/\bautoComplete[=\s]/.test(attributes)) continue;
        // The `name`, when there is one, and otherwise the opening of the tag
        // folded onto one line: two of these fields are bound by ref and carry
        // no name, and a failure that printed eleven lines of `onChange` would
        // say less than nothing.
        const label =
          /\bname="([^"]*)"/.exec(attributes)?.[1] ??
          attributes.replaceAll(/\s+/g, " ").slice(0, 60);
        const line = form.line + form.body.slice(0, match.index).split("\n").length - 1;
        silent.push(`${form.file}:${line} — ${label} carries no autoComplete`);
      }
    }
    expect(silent, "SC 1.3.5: these fields collect information about the person").toEqual([]);
  });
});
