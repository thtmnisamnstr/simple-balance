import { BulkEditToggle, Input, Textarea } from "./components.js";

/**
 * The parts of a mass-edit panel that are the same on both screens.
 *
 * The two panels are not interchangeable: a committed row and a staged one
 * offer different accounts and refuse for different reasons, which is why the
 * category, account, and type controls stay where they are. Everything above
 * that line is identical, and two copies of it had already drifted apart in
 * five places.
 */
export const bulkEditFields = [
  "date",
  "payee",
  "categoryId",
  "accountId",
  "description",
  "notes",
  "type",
] as const;

export type BulkEditField = (typeof bulkEditFields)[number];

export type BulkEditValues = {
  date: string;
  payee: string;
  categoryId: string;
  accountId: string;
  description: string;
  notes: string;
  type: "deposit" | "withdrawal";
};

export const emptyBulkEditEnabled = (): Record<BulkEditField, boolean> => ({
  date: false,
  payee: false,
  categoryId: false,
  accountId: false,
  description: false,
  notes: false,
  type: false,
});

export const emptyBulkEditValues = (accountId = ""): BulkEditValues => ({
  date: "",
  payee: "",
  categoryId: "",
  accountId,
  description: "",
  notes: "",
  type: "withdrawal",
});

type FieldProps = {
  values: BulkEditValues;
  enabled: Record<BulkEditField, boolean>;
  onEnabled: (field: BulkEditField, on: boolean) => void;
  onValue: (patch: Partial<BulkEditValues>) => void;
};

export function BulkEditDateField({ values, enabled, onEnabled, onValue }: FieldProps) {
  return (
    <BulkEditToggle
      label="Change date"
      enabled={enabled.date}
      onToggle={(on) => onEnabled("date", on)}
    >
      <Input
        aria-label="New date"
        type="date"
        value={values.date}
        disabled={!enabled.date}
        required={enabled.date}
        onChange={(event) => onValue({ date: event.target.value })}
      />
    </BulkEditToggle>
  );
}

export function BulkEditPayeeField({
  values,
  enabled,
  onEnabled,
  onValue,
  listId,
  suggestions,
}: FieldProps & { listId: string; suggestions: readonly string[] }) {
  return (
    <BulkEditToggle
      label="Change payee"
      enabled={enabled.payee}
      onToggle={(on) => onEnabled("payee", on)}
    >
      <Input
        aria-label="New payee"
        list={listId}
        value={values.payee}
        disabled={!enabled.payee}
        required={enabled.payee}
        placeholder="Start typing a payee"
        onChange={(event) => onValue({ payee: event.target.value })}
      />
      <datalist id={listId}>
        {suggestions.map((payee) => (
          <option key={payee} value={payee} />
        ))}
      </datalist>
    </BulkEditToggle>
  );
}

export function BulkEditDescriptionField({ values, enabled, onEnabled, onValue }: FieldProps) {
  return (
    <BulkEditToggle
      label="Change description"
      enabled={enabled.description}
      onToggle={(on) => onEnabled("description", on)}
    >
      <Input
        aria-label="New description"
        value={values.description}
        disabled={!enabled.description}
        placeholder="Leave blank to clear"
        onChange={(event) => onValue({ description: event.target.value })}
      />
      {enabled.description ? <small>Leave blank to clear.</small> : null}
    </BulkEditToggle>
  );
}

export function BulkEditNotesField({ values, enabled, onEnabled, onValue }: FieldProps) {
  return (
    <BulkEditToggle
      label="Change notes"
      enabled={enabled.notes}
      onToggle={(on) => onEnabled("notes", on)}
    >
      <Textarea
        aria-label="New notes"
        rows={3}
        value={values.notes}
        disabled={!enabled.notes}
        placeholder="Leave blank to clear"
        onChange={(event) => onValue({ notes: event.target.value })}
      />
      {enabled.notes ? <small>Leave blank to clear.</small> : null}
    </BulkEditToggle>
  );
}
