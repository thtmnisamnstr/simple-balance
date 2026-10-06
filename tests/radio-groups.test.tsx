// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, Session } from "../src/client/api.js";
import { RecurrenceForm, TemplateForm, TransactionForm } from "../src/client/forms.js";
import SettingsPage from "../src/client/pages/SettingsPage.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import "./support/dialog.js";
import { sourceFiles, type SourceFile } from "./support/source.js";

/**
 * A set of radios is only a group to the browser when they share a `name`.
 * Without one the arrows do nothing and every option is its own tab stop, so a
 * keyboard reaches the fourth field by pressing Tab six times. React still
 * enforces one-of-many through `checked`, which is exactly why this went
 * unnoticed: it looks and clicks correctly and only the keyboard is wrong.
 */
const account = (id: string, name: string, type: Account["type"]): Account => ({
  id,
  name,
  type,
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  version: 1,
  balance: "0",
  balancePresentation: { label: "Balance", amount: "0" },
});
const accounts: Account[] = [
  account("acc-1", "Checking", "checking"),
  account("acc-2", "Savings", "savings"),
];
const categories: Category[] = [{ id: "cat-1", name: "Food", kind: "expense", version: 1 }];
const session = {
  user: { id: "u1", name: "Ada", email: "ada@example.com" },
  preferences: {
    userId: "u1",
    timezone: "UTC",
    defaultCurrency: "USD",
    chosen: true,
    theme: "system",
  },
  auth: {
    localEnabled: true,
    googleEnabled: false,
    localPasswordConfigured: true,
    googleLinked: false,
  },
} as unknown as Session;

function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <TimezoneProvider timezone="UTC">{node}</TimezoneProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

/** A group's name, from `aria-label` or the visible words `aria-labelledby` names. */
function groupName(group: Element) {
  const labelledBy = group.getAttribute("aria-labelledby");
  const named = labelledBy
    ? labelledBy
        .split(" ")
        .map((id) => group.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
        .join(" ")
        .trim()
    : "";
  return group.getAttribute("aria-label")?.trim() || named;
}

/** Every radio, with the group it claims to belong to. */
function radioGroups(container: HTMLElement) {
  return [...container.querySelectorAll('[role="radiogroup"]')].map((group) => ({
    label: groupName(group) || "(unlabeled)",
    named: Boolean(groupName(group)),
    native: [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[],
    aria: [...group.querySelectorAll('[role="radio"]')] as HTMLElement[],
  }));
}

/**
 * Ticks every checkbox, which is how the conditional halves of these forms —
 * a reminder, a notification, a repeat — get rendered at all. A radio inside a
 * section nobody opened is a radio this file would otherwise never see.
 */
function revealOptionalSections(container: HTMLElement) {
  for (const box of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (!box.checked && !box.disabled) fireEvent.click(box);
  }
}

afterEach(cleanup);

/**
 * Every radio and radio group the client's source writes, found by reading it.
 *
 * The rendered checks further down started from a list of three forms, and the
 * Settings page's Appearance choice — three radios, the one group outside
 * `forms.tsx` — was on none of them, so it was held to nothing. A list of
 * places to look is a claim about where radios are, made by somebody who could
 * not see the next one; `testing.md` §2.6. So the population is the source: a
 * native radio is an `<input type="radio">`, an ARIA one is anything given
 * `role: "radio"` in either spelling, and a group is anything whose `role` can
 * be `"radiogroup"` — including the transaction-type picker's, which is an
 * expression — or a `<fieldset>` holding radios.
 *
 * Source text can say what the rendered checks say about structure, and not
 * whether a generated name comes out non-empty or an `aria-labelledby` points
 * at words. Those stay rendered, below, and the two halves are tied: every
 * exported component that writes a radio has to be rendered there.
 */
const client = sourceFiles("src/client").filter((file) => file.path.endsWith(".tsx"));

/** Where the opening tag that begins at `from` ends: its `>` at brace depth 0. */
function tagEnd(code: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < code.length; index += 1) {
    const character = code[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    // At depth zero only: a radio's `onChange` is an arrow, and its `>` is not
    // the end of the tag.
    else if (character === ">" && depth === 0) return index;
  }
  return -1;
}

/**
 * What one attribute was given: the expression inside its `{...}`, or its
 * quoted string with the quotes kept, so `type="radio"` and `type={"radio"}`
 * read alike. Matched whole, or `label` would be found in `aria-label`.
 */
function attribute(element: string, name: string): string | null {
  const match = new RegExp(`(?<![\\w-])${name}=`).exec(element);
  if (!match) return null;
  const start = match.index + match[0].length;
  const opener = element[start];
  if (opener === '"' || opener === "'") {
    const close = element.indexOf(opener, start + 1);
    return close === -1 ? null : element.slice(start, close + 1);
  }
  if (opener !== "{") return null;
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < element.length; index += 1) {
    const character = element[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && (depth -= 1) === 0) return element.slice(start + 1, index).trim();
  }
  return null;
}

type Tag = {
  path: string;
  line: number;
  start: number;
  /** Where the element closes: its `</name>`, or its own `/>`. */
  close: number;
  name: string;
  text: string;
  /** The top-level declaration it is written in, which is where a `useId` lives. */
  component: string;
  exported: boolean;
};

/** The top-level function or const an index sits in: the last one declared at column 0 before it. */
function declarationAt(code: string, index: number) {
  const last = [
    ...code
      .slice(0, index)
      .matchAll(/^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const)\s+(\w+)/gm),
  ].at(-1);
  return { component: last?.[2] ?? "(module)", exported: Boolean(last?.[1]) };
}

/** Where the element opening at `start` closes, counting nested elements of its own name. */
function closeOf(code: string, start: number, end: number, name: string): number {
  if (code.slice(start, end + 1).endsWith("/>")) return end;
  const escaped = name.replaceAll(".", "\\.");
  const pattern = new RegExp(`<${escaped}(?=[\\s/>])|</${escaped}>`, "g");
  pattern.lastIndex = end + 1;
  let depth = 1;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    if (match[0].startsWith("</")) depth -= 1;
    else if (!code.slice(match.index, tagEnd(code, match.index) + 1).endsWith("/>")) depth += 1;
    if (depth === 0) return match.index;
  }
  return code.length;
}

function tagsOf(file: SourceFile): Tag[] {
  const tags: Tag[] = [];
  for (const match of file.code.matchAll(/<([A-Za-z][\w.]*)(?=[\s/>])/g)) {
    const end = tagEnd(file.code, match.index);
    if (end === -1) continue;
    tags.push({
      path: file.path,
      line: file.code.slice(0, match.index).split("\n").length,
      start: match.index,
      close: closeOf(file.code, match.index, end, match[1]!),
      name: match[1]!,
      text: file.code.slice(match.index, end + 1),
      ...declarationAt(file.code, match.index),
    });
  }
  return tags;
}

/** `role: "radio"` in a spread, or `role="radio"` written out; never `"radiogroup"`. */
const ARIA_RADIO = /(?<![\w-])role(?:=\{?\s*|\s*:\s*)["']radio["']/;

type Radio = Tag & { native: boolean; group: Group | undefined };
type Group = Tag & { kind: "radiogroup" | "fieldset"; label: string | null; radios: Radio[] };

const { radios, groups } = (() => {
  const radios: Radio[] = [];
  const groups: Group[] = [];
  for (const file of client) {
    const tags = tagsOf(file);
    const found = tags
      .filter(
        (tag) =>
          (/^(input|Input)$/.test(tag.name) && attribute(tag.text, "type") === '"radio"') ||
          ARIA_RADIO.test(tag.text),
      )
      .map((tag): Radio => ({ ...tag, native: !ARIA_RADIO.test(tag.text), group: undefined }));
    const candidates = tags
      .filter(
        (tag) =>
          /["']radiogroup["']/.test(attribute(tag.text, "role") ?? "") || tag.name === "fieldset",
      )
      .map((tag): Group => ({
        ...tag,
        kind: tag.name === "fieldset" ? "fieldset" : "radiogroup",
        label:
          attribute(tag.text, "aria-label") ??
          attribute(tag.text, "aria-labelledby") ??
          (tag.name === "fieldset" && /<legend[\s>]/.test(file.code.slice(tag.start, tag.close))
            ? "its legend"
            : null),
        radios: [],
      }));
    for (const radio of found) {
      // The innermost group around it, which is the one the browser and a
      // screen reader both use.
      radio.group = candidates
        .filter((group) => group.start < radio.start && radio.start < group.close)
        .at(-1);
      radio.group?.radios.push(radio);
    }
    radios.push(...found);
    // A fieldset with no radio in it is a form section, not a group of choices.
    groups.push(...candidates.filter((group) => group.radios.length > 0));
  }
  return { radios, groups };
})();

const at = (tag: Tag) => `${tag.path}:${tag.line}`;
const nameOf = (radio: Radio) => attribute(radio.text, "name");

describe("every radio group in the client source", () => {
  /**
   * Discovery, before anything is asserted about it: an empty population
   * passes every claim made over it. The named members are the ones a
   * narrower reading would lose — the group outside `forms.tsx` the old list
   * missed, the group that is a `<fieldset>` rather than a `role`, and the one
   * whose `role` is an expression.
   */
  it("finds the radio groups that are there", () => {
    expect(groups.length).toBeGreaterThanOrEqual(8);
    expect(radios.filter((radio) => radio.native).length).toBeGreaterThanOrEqual(13);
    expect(radios.filter((radio) => !radio.native).length).toBeGreaterThanOrEqual(1);
    expect(
      groups.some(
        (group) =>
          group.path === "src/client/pages/SettingsPage.tsx" && group.label === '"Appearance"',
      ),
      "the Settings page's Appearance group",
    ).toBe(true);
    expect(groups.some((group) => group.kind === "fieldset")).toBe(true);
    expect(groups.some((group) => group.component === "TransactionTypeChoice")).toBe(true);
  });

  it("gives every radio a group to belong to", () => {
    const nameless = radios
      .filter((radio) => radio.native)
      .filter((radio) => {
        const name = nameOf(radio);
        return name === null || name === '""' || name === "";
      })
      .map(at);
    expect(nameless, "a native radio with no name is in no group").toEqual([]);
    // Every radio, native or ARIA: one outside a group is the same defect with
    // less signposting, and has nothing to be named by.
    expect(radios.filter((radio) => !radio.group).map(at)).toEqual([]);
  });

  it("names every radio group", () => {
    expect(groups.filter((group) => !group.label).map(at)).toEqual([]);
  });

  /**
   * Two groups sharing a name is the same bug from the other side: choosing in
   * one silently clears the other. Read from the source this is two claims.
   * Inside a group, one name. Across groups, no name expression twice in one
   * component — two components may both say `monthDayGroup`, because each has
   * its own `useId` — and no literal name twice anywhere, because a literal is
   * the same string in every component that writes it.
   */
  it("keeps every radio in exactly one group", () => {
    const offenders: string[] = [];
    for (const group of groups) {
      const names = new Set(
        group.radios.filter((radio) => radio.native).map((radio) => nameOf(radio)),
      );
      if (names.size > 1) offenders.push(`${at(group)} uses ${[...names].join(" and ")}`);
    }
    const owners = new Map<string, Group[]>();
    for (const group of groups) {
      for (const name of new Set(group.radios.map(nameOf).filter((name) => name !== null))) {
        const key = /^["']/.test(name) ? name : `${group.path}#${group.component}#${name}`;
        owners.set(key, [...(owners.get(key) ?? []), group]);
      }
    }
    for (const [name, sharing] of owners) {
      if (sharing.length > 1) offenders.push(`${name} spans ${sharing.map(at).join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("radio groups", () => {
  // Nothing here is about what the server says, and the Settings page asks it
  // several things on mount; a request that never answers keeps every one of
  // them pending rather than failing into a state the radios do not depend on.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
  });

  /**
   * The components rendered whole, named by the declaration that writes their
   * radios so the list can be held to the source below. A list of renderers is
   * not a population — it cannot be, since each needs its own props — so the
   * test after the loop is what stops it falling behind.
   */
  const forms = [
    [
      "TemplateForm",
      "a template",
      <TemplateForm
        key="TemplateForm"
        accounts={accounts}
        categories={categories}
        onDone={() => {}}
      />,
    ],
    [
      "RecurrenceForm",
      "a recurring transaction",
      <RecurrenceForm
        key="RecurrenceForm"
        accounts={accounts}
        categories={categories}
        onDone={() => {}}
      />,
    ],
    [
      "TransactionForm",
      "a transaction",
      <TransactionForm
        key="TransactionForm"
        accounts={accounts}
        categories={categories}
        onDone={() => {}}
      />,
    ],
    ["SettingsPage", "the settings page", <SettingsPage key="SettingsPage" session={session} />],
  ] as const;

  /**
   * The old list held three forms and the Settings page wrote a radio group
   * none of them rendered. This compares the list with the exported
   * components the source says write a native radio, so the next one fails
   * here until it is rendered. A radio in an unexported helper is rendered by
   * whichever export uses it, and the source sweep above holds it either way.
   */
  it("renders every exported component that writes a radio", () => {
    const writers = new Set(
      radios.filter((radio) => radio.native && radio.exported).map((radio) => radio.component),
    );
    expect([...writers].sort()).toEqual(forms.map(([name]) => name).sort());
  });

  for (const [, what, form] of forms) {
    it(`gives every radio on ${what} a group to belong to`, () => {
      const { container } = mount(form);
      // Several radio groups only exist once an optional section is switched on
      // — the reminder, the notification — so every checkbox is ticked first.
      // Without this the assertion runs over a form with no radios in it and
      // passes by having nothing to check.
      revealOptionalSections(container);
      const groups = radioGroups(container);
      expect(
        container.querySelectorAll('input[type="radio"]').length,
        "there are radios to check",
      ).toBeGreaterThan(0);
      for (const group of groups) {
        for (const radio of group.native) {
          expect(
            radio.getAttribute("name"),
            `a radio in "${group.label}" has no name, so it is not in a group`,
          ).toBeTruthy();
        }
      }
      // Every native radio anywhere, not only the ones inside a labeled group:
      // a set of radios outside one is the same defect with less signposting.
      for (const radio of container.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
        expect(radio.getAttribute("name"), radio.outerHTML.slice(0, 90)).toBeTruthy();
      }
    });

    it(`names every radio group on ${what}`, () => {
      const { container } = mount(form);
      revealOptionalSections(container);
      const groups = radioGroups(container);
      expect(groups.length, "there are groups to check").toBeGreaterThan(0);
      for (const group of groups) {
        expect(
          group.named,
          `a group holding "${group.native[0]?.value ?? group.aria[0]?.textContent}" has no name`,
        ).toBe(true);
      }
    });

    it(`keeps every radio on ${what} in exactly one group`, () => {
      const { container } = mount(form);
      revealOptionalSections(container);
      // Two groups sharing a name is the same bug from the other side: choosing
      // in one silently clears the other.
      const byName = new Map<string, Set<Element>>();
      for (const radio of container.querySelectorAll('input[type="radio"]')) {
        const name = radio.getAttribute("name")!;
        const group = radio.closest('[role="radiogroup"], fieldset') ?? container;
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name)!.add(group);
      }
      for (const [name, groups] of byName) {
        expect(groups.size, `name ${name} spans ${groups.size} groups`).toBe(1);
      }
    });
  }

  it("keeps two forms on one page in separate groups", () => {
    // The duplicate comparison screen puts two transaction forms side by side.
    // A constant name would make the two sets of radios one group, so choosing
    // in the left form would clear the right.
    const { container } = mount(
      <>
        <TemplateForm accounts={accounts} categories={categories} onDone={() => {}} />
        <TemplateForm accounts={accounts} categories={categories} onDone={() => {}} />
      </>,
    );
    // The reminder radios only exist once a reminder is asked for, so both forms
    // have to be switched on before there is anything to compare.
    for (const box of screen.getAllByLabelText("Email me to make this transaction")) {
      fireEvent.click(box);
    }
    const names = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
      (radio) => radio.getAttribute("name"),
    );
    const groups = [...new Set(names)];
    // Two instances, so twice as many distinct groups as one instance has.
    expect(groups.length).toBeGreaterThan(1);
    const half = groups.length / 2;
    expect(Number.isInteger(half), `${groups.length} groups across two forms`).toBe(true);
  });
});

describe("the transaction type choice", () => {
  it("is one tab stop with the arrows moving inside it", () => {
    const { container } = mount(
      <TransactionForm accounts={accounts} categories={categories} onDone={() => {}} />,
    );
    const group = container.querySelector('[role="radiogroup"][aria-label="Transaction type"]')!;
    const options = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(options.length).toBeGreaterThan(2);

    // Exactly one reachable by Tab; the rest are reached with the arrows.
    const tabbable = options.filter((option) => option.tabIndex === 0);
    expect(tabbable, "one tab stop for the group").toHaveLength(1);
    expect(tabbable[0]!.getAttribute("aria-checked")).toBe("true");

    const before = options.findIndex((o) => o.getAttribute("aria-checked") === "true");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    const after = [...group.querySelectorAll('[role="radio"]')].findIndex(
      (o) => o.getAttribute("aria-checked") === "true",
    );
    expect(after, "ArrowRight moves the choice").not.toBe(before);
  });

  it("wraps at both ends rather than stopping", () => {
    const { container } = mount(
      <TransactionForm accounts={accounts} categories={categories} onDone={() => {}} />,
    );
    const group = container.querySelector('[role="radiogroup"][aria-label="Transaction type"]')!;
    const count = group.querySelectorAll('[role="radio"]').length;
    const chosen = () =>
      [...group.querySelectorAll('[role="radio"]')].findIndex(
        (o) => o.getAttribute("aria-checked") === "true",
      );
    fireEvent.keyDown(group, { key: "Home" });
    expect(chosen()).toBe(0);
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(chosen(), "wraps to the end").toBe(count - 1);
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(chosen(), "wraps back to the start").toBe(0);
    fireEvent.keyDown(group, { key: "End" });
    expect(chosen()).toBe(count - 1);
  });

  it("is a set of toggles on a template, where no type is a real answer", () => {
    // A radio cannot become unset, and unsetting is how a template says it has
    // no type. So this one does not claim to be a radio group.
    const { container } = mount(
      <TemplateForm accounts={accounts} categories={categories} onDone={() => {}} />,
    );
    const group = container.querySelector('[aria-label="Transaction type"]')!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(0);
    const toggles = [...group.querySelectorAll<HTMLElement>("button")];
    expect(toggles.length).toBeGreaterThan(2);
    for (const toggle of toggles) {
      expect(toggle.getAttribute("aria-pressed")).toBeTruthy();
    }
    fireEvent.click(toggles[0]!);
    expect(toggles[0]!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggles[0]!);
    expect(
      toggles[0]!.getAttribute("aria-pressed"),
      "clicking the chosen one again leaves no type",
    ).toBe("false");
  });
});
