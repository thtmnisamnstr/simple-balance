// @vitest-environment jsdom
import { globSync, readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, Field, Input, Select, Textarea } from "../src/client/components.js";

/**
 * The three things `Field` was wrong about, and the one it still cannot do.
 *
 * `web.md` 8.1 is **Binding** under SC 1.3.1 and SC 4.1.2 and called itself the
 * largest single piece of work in that guide. All three defects were the same
 * omission from different angles: the label, the hint and the error were on
 * screen and none of them was connected to the control, so a screen reader read
 * a box with a name and no explanation, or no name at all.
 *
 * The guide also says a test asserting every control sits inside a `Field`
 * "becomes possible" once the contract lands. It has, and it is the last case
 * here.
 */
afterEach(cleanup);

describe("a field and its control", () => {
  it("associates the label explicitly, not by wrapping", () => {
    render(
      <Field label="Payee">
        <Input defaultValue="" />
      </Field>,
    );
    const control = screen.getByLabelText("Payee", { selector: "input" });
    // W3C's forms tutorial asks for `for` matching the control's own `id`.
    // Wrapping alone is what this did, and it is what left the composite case
    // binding a label to the first of fifty controls.
    expect(control.id).not.toBe("");
    expect(document.querySelector(`label[for="${control.id}"]`)).not.toBeNull();
  });

  it("puts the hint above the control and points the control at it", () => {
    const { container } = render(
      <Field label="Amount" hint="Up to eighteen decimal places.">
        <Input defaultValue="" />
      </Field>,
    );
    const control = screen.getByLabelText("Amount", { selector: "input" });
    const hint = container.querySelector(".field-hint")!;
    expect(hint.textContent).toBe("Up to eighteen decimal places.");
    // Pointed at, which is the Binding half. The hint used to render after the
    // control with no id and nothing referring to it, so it was on screen and
    // absent from the accessible name and description both.
    expect(control.getAttribute("aria-describedby")).toBe(hint.id);
    // And above it, which is GOV.UK's order and this guide's House rule.
    expect(hint.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says a field is wrong in three places that agree", () => {
    const { container } = render(
      <Field label="Date" error="Enter a date">
        <Input defaultValue="" />
      </Field>,
    );
    const control = screen.getByLabelText("Date", { selector: "input" });
    const error = container.querySelector(".field-error")!;
    expect(error.textContent).toBe("Enter a date");
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(control.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("names both the hint and the error when there are both", () => {
    render(
      <Field label="Amount" hint="Optional" error="Amount must be greater than zero">
        <Input defaultValue="" />
      </Field>,
    );
    const control = screen.getByLabelText("Amount", { selector: "input" });
    const described = control.getAttribute("aria-describedby")!.split(" ");
    expect(described).toHaveLength(2);
    for (const id of described) expect(document.getElementById(id)).not.toBeNull();
  });

  it("wires a select and a textarea the same way", () => {
    // All three controls read the same context, so a field holding any of them
    // behaves alike. `Select` was the one that could have been missed: it wraps
    // its `<select>` in a `<span>` for the chevron, so the id has to reach
    // through the wrapper.
    render(
      <>
        <Field label="Type" hint="Pick one">
          <Select defaultValue="">
            <option value="">None</option>
          </Select>
        </Field>
        <Field label="Notes" error="Too long">
          <Textarea defaultValue="" />
        </Field>
      </>,
    );
    const select = screen.getByLabelText("Type", { selector: "select" });
    expect(select.getAttribute("aria-describedby")).not.toBeNull();
    const textarea = screen.getByLabelText("Notes", { selector: "textarea" });
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
  });

  it("lets a caller's own attributes win", () => {
    // The queue's inline cells label themselves and pass their own
    // `aria-label`; a field must not overwrite what a call site decided.
    render(
      <Field label="Payee" hint="Ignored here">
        <Input id="mine" aria-describedby="somewhere-else" defaultValue="" />
      </Field>,
    );
    const control = document.getElementById("mine")!;
    expect(control.getAttribute("aria-describedby")).toBe("somewhere-else");
  });
});

/**
 * And the composite, which a wrapping `<label>` cannot describe.
 *
 * `CategoryLegs` renders up to fifty rows of three controls. A `<label>` around
 * that binds to the first of them, so leg one borrowed the label and legs two
 * onward had no accessible name at all — while the amount and note inputs in
 * the same rows did, which is what made it look deliberate.
 */
describe("a field around a composite", () => {
  it("is a labelled group rather than a label", () => {
    render(
      <Field label="Category" as="group">
        <Input aria-label="Category for split 1" defaultValue="" />
        <Input aria-label="Category for split 2" defaultValue="" />
      </Field>,
    );
    const group = screen.getByRole("group", { name: "Category" });
    expect(group.tagName.toLowerCase()).toBe("div");
    // And it hands out no id, because there is no one control to point at: each
    // control inside names itself.
    for (const name of ["Category for split 1", "Category for split 2"]) {
      const control = screen.getByLabelText(name, { selector: "input" });
      expect(control.id).toBe("");
      expect(control.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("is what the three split fields use, and each leg is named", () => {
    const forms = readFileSync("src/client/forms.tsx", "utf8");
    // Three call sites wrap `CategoryLegs`, and all three are groups.
    expect([
      ...forms.matchAll(/<Field label="Category" hint="Optional" as="group">/g),
    ]).toHaveLength(3);
    // Both shapes of the composite name their picker: one when unsplit, one per
    // leg once split. The `ariaLabel` prop existed for a release with nothing
    // passing it, which is the state this is here to prevent returning to.
    expect(forms).toContain('ariaLabel="Category"');
    expect(forms).toContain("ariaLabel={`Category for split ${index + 1}`}");
  });
});

/**
 * The census the guide said would become possible.
 *
 * Every text control in a form belongs to a `Field`, so the label, hint and
 * error contract above is what every one of them gets. The exceptions are named
 * individually: a filter bar holds bare controls with an `aria-label` by rule
 * (7.6), and the queue's inline cells are a control standing where a table cell
 * was.
 */
/**
 * One control that is not a `Field`, named rather than pattern-matched.
 *
 * The CSV drop zone is an `<input type="file">` inside a wrapping
 * `<label className="file-drop">` whose text is the whole affordance — "Drop in
 * a file or browse" and two sentences about delimiters. The input is visually
 * hidden and the wrapper takes the focus ring (13.2), so the label *is* the
 * control as far as anybody using it is concerned. A `Field` around it would add
 * a second label above a box that already says what it is.
 *
 * Named, so a second file input has to come here and make its own case.
 */
const NOT_A_FIELD = new Set(["src/client/pages/ImportPage.tsx:318"]);

describe("every control in the client", () => {
  it("goes through the three shared components", () => {
    const raw: string[] = [];
    for (const path of globSync("src/client/**/*.tsx")) {
      // `components.tsx` is where the three are defined.
      if (path.endsWith("components.tsx")) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/<(?:input|select|textarea)\b/.test(line)) return;
        // A checkbox or a radio is labelled by the `<label>` it sits in or by
        // the `radiogroup` around it, and neither takes a `Field`. The `type`
        // is usually on the next line, so the tag's own attributes are read
        // rather than the line it opens on: a window to the closing `>`,
        // bounded so a malformed file cannot run to the end.
        const tag = lines.slice(index, index + 12).join(" ");
        if (/type="(?:checkbox|radio)"/.test(tag.slice(0, tag.indexOf(">") + 1))) return;
        if (NOT_A_FIELD.has(`${path}:${index + 1}`)) return;
        raw.push(`${path}:${index + 1}`);
      });
    }
    expect(raw, "use Input, Select or Textarea, so a Field can reach it").toEqual([]);
  });
});

/**
 * A disabled submit says why, next to itself.
 *
 * `web.md` 12.3 says so and six controls disabled on a computed predicate had
 * one sentence between them. It is the one control that can go completely
 * silent: nothing was typed wrongly, so there is no field error, and nothing was
 * submitted, so there is no summary — the button is simply grey and the person
 * has to guess which of the form's conditions is unmet.
 *
 * The guide called this "structural and has nothing to key on today". `Button`
 * takes a `disabledReason` now, which is the thing to key on.
 */
describe("a disabled button", () => {
  it("shows its reason and points at it", () => {
    render(
      <Button disabled disabledReason="Give the category a name.">
        Save category
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save category" });
    const described = button.getAttribute("aria-describedby");
    expect(described, "the reason has to be pointed at, not merely nearby").not.toBeNull();
    expect(document.getElementById(described!)?.textContent).toBe("Give the category a name.");
  });

  it("shows nothing while it is enabled", () => {
    const { container } = render(
      <Button disabledReason="Give the category a name.">Save category</Button>,
    );
    expect(container.querySelector(".button-reason")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-describedby")).toBeNull();
  });

  it("stays out of the way while it is working", () => {
    // A button that is working already says so, and a reason for that state
    // would be a second answer to a question already answered.
    const { container } = render(
      <Button disabled loading disabledReason="Give the category a name.">
        Save category
      </Button>,
    );
    expect(container.querySelector(".button-reason")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
  });

  it("keeps the same element when the reason comes and goes", () => {
    // Wrapping only when a reason exists remounts the button, which takes focus
    // off it at the moment it becomes usable — the defect 13.3 is about. The
    // wrapper is unconditional and `display: contents` until it has something
    // to lay out.
    const { rerender, container } = render(
      <Button disabled disabledReason="Give the category a name.">
        Save
      </Button>,
    );
    const before = screen.getByRole("button");
    rerender(<Button disabledReason="Give the category a name.">Save</Button>);
    expect(screen.getByRole("button")).toBe(before);
    expect(container.querySelector(".button-with-reason")).not.toBeNull();
  });

  it("is used at every submit disabled on a computed predicate", () => {
    // The six the guide names. Read from the source, because each is inside a
    // page that needs a router, a query client and a session to render — and
    // what is under test is that the prop is passed, not what it says.
    for (const path of [
      "src/client/forms.tsx",
      "src/client/pages/TemplatesPage.tsx",
      "src/client/pages/SettingsPage.tsx",
      "src/client/pages/PayeesPage.tsx",
      "src/client/pages/CategoriesPage.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      const disabled = [...source.matchAll(/<Button[^>]*?\sdisabled=\{[^}]*\}/gs)];
      expect(disabled.length, `${path} has a computed-predicate button`).toBeGreaterThan(0);
      for (const match of disabled) {
        // The tag through to its closing `>`, so the reason can sit either side
        // of `disabled`.
        const from = match.index;
        const tag = source.slice(from, source.indexOf(">", from + match[0].length) + 1);
        expect(tag, `${path}: ${match[0].slice(0, 60)}`).toContain("disabledReason");
      }
    }
  });
});
