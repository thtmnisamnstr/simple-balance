// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, Category } from "../src/client/api.js";
import { RecurrenceForm, TemplateForm, TransactionForm } from "../src/client/forms.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import "./support/dialog.js";

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
const categories: Category[] = [
  { id: "cat-1", name: "Food", kind: "expense", version: 1 },
];

function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">{node}</TimezoneProvider>
    </QueryClientProvider>,
  );
}

/** Every radio, with the group it claims to belong to. */
function radioGroups(container: HTMLElement) {
  return [...container.querySelectorAll('[role="radiogroup"]')].map((group) => ({
    label: group.getAttribute("aria-label") ?? "(unlabelled)",
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
  for (const box of container.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  )) {
    if (!box.checked && !box.disabled) fireEvent.click(box);
  }
}

afterEach(cleanup);

describe("radio groups", () => {
  const forms = [
    ["a template", <TemplateForm accounts={accounts} categories={categories} onDone={() => {}} />],
    ["a recurring transaction", <RecurrenceForm accounts={accounts} categories={categories} onDone={() => {}} />],
    ["a transaction", <TransactionForm accounts={accounts} categories={categories} onDone={() => {}} />],
  ] as const;

  for (const [what, form] of forms) {
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
      // Every native radio anywhere, not only the ones inside a labelled group:
      // a set of radios outside one is the same defect with less signposting.
      for (const radio of container.querySelectorAll<HTMLInputElement>(
        'input[type="radio"]',
      )) {
        expect(radio.getAttribute("name"), radio.outerHTML.slice(0, 90)).toBeTruthy();
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
    const names = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ].map((radio) => radio.getAttribute("name"));
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
