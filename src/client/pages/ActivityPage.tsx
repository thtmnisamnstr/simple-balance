import { useQuery } from "@tanstack/react-query";
import { Bot, CalendarClock, History, Monitor } from "lucide-react";
import type { ActorSource } from "../../shared/domain.js";
import { api, type AuditEvent, type Page } from "../api.js";
import { Alert, Badge, EmptyState, PageHeader, Skeleton } from "../components.js";
import { useTimezone } from "../timezone.js";
import { formatTimestamp } from "../money.js";

/**
 * Switched on the value rather than tested against one, so a source this build
 * does not know about is not silently drawn as a person at a screen. The log is
 * the record of who did what, and a wrong attribution in it is worse than an
 * unstyled one.
 */
function actorPresentation(source: ActorSource | string) {
  if (source === "mcp") return { Icon: Bot, tone: "blue" as const, label: "Agent" };
  if (source === "schedule") {
    return { Icon: CalendarClock, tone: "amber" as const, label: "Scheduled" };
  }
  if (source === "web") {
    return { Icon: Monitor, tone: "neutral" as const, label: "Web" };
  }
  return { Icon: History, tone: "neutral" as const, label: source };
}

/**
 * What each stored operation did, in words, as the end of a sentence.
 *
 * The stored operation is history and stays exactly as it was written — the
 * MCP returns it, and a log that rewrote its own entries would not be one — so
 * the words are made here, on the way to the screen. Splitting the identifier
 * into words was the old answer and it read as code: "create from stage
 * transaction", "payee merge transaction". An operation this table does not
 * know still falls back to that, so a newer server never shows a blank line.
 */
const operationWords: Record<string, string> = {
  create: "created",
  update: "edited",
  delete: "deleted",
  restore: "restored",
  archive: "archived",
  unarchive: "restored from the archive",
  revoke: "disconnected",
  merge: "merged",
  merge_into: "merged into another",
  category_merge: "moved to another category by a merge",
  payee_merge: "moved to another payee by a merge",
  bulk_edit: "edited with others at once",
  bulk_update: "edited with others at once",
  bulk_delete: "deleted with others at once",
  create_from_csv: "imported from a CSV file",
  update_from_csv: "changed by a CSV import",
  create_from_transaction: "created by a transaction that named it",
  update_from_transaction: "changed by a transaction that named it",
  create_from_recurrence: "proposed by a recurring transaction",
  create_from_stage: "committed from the staged queue",
  commit: "committed",
  moveOnMerge: "moved by a category merge",
  activate: "marked in use",
};

/** What each kind of record is called on screen, which is not always its table. */
const entityWords: Record<string, string> = {
  account: "account",
  budget_entry: "budget entry",
  budget_plan: "budget plan",
  category: "category",
  category_group: "category group",
  connected_app: "agent connection",
  import_batch: "import",
  payee: "payee",
  recurrence: "recurring transaction",
  staged_transaction: "staged row",
  transaction: "transaction",
  transaction_template: "template",
  user_preferences: "preferences",
};

/**
 * The record's own name, read out of what the entry recorded about it.
 *
 * "Edited transaction" said what kind of thing changed and not which one, on a
 * page whose whole job is telling somebody what happened to their books. The
 * snapshot is the record as it was stored, so this is its name as written, and
 * a record deleted since still has one.
 */
function recordName(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const record = snapshot as Record<string, unknown>;
  const draft =
    record.draft && typeof record.draft === "object"
      ? (record.draft as Record<string, unknown>)
      : {};
  const name = [record.name, record.payee, draft.payee, record.fileName, record.clientName].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (!name) return null;
  const trimmed = name.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

/**
 * An audit event as the line somebody reads: "transaction “Grocer” edited".
 *
 * Built lowercase on purpose: the stylesheet uppercases the first letter and
 * nothing else, so the record's name keeps the spelling it was given. The
 * entity prefix a dotted operation carries (`budgetPlan.create`) only names
 * the kind the line already starts with, so it is dropped.
 *
 * Exported for `tests/activity-sentence.test.ts`.
 */
export function activitySentence(
  event: Pick<AuditEvent, "operation" | "entityType"> &
    Partial<Pick<AuditEvent, "before" | "after">>,
) {
  const operation = event.operation.slice(event.operation.lastIndexOf(".") + 1);
  const verb =
    operationWords[operation] ??
    operation
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replaceAll("_", " ")
      .toLowerCase();
  const noun = entityWords[event.entityType] ?? event.entityType.replaceAll("_", " ");
  const name = recordName(event.after) ?? recordName(event.before);
  return `${noun}${name ? ` “${name}”` : ""} ${verb}`;
}

export default function ActivityPage() {
  const timezone = useTimezone();
  const events = useQuery({
    queryKey: ["audit-events"],
    queryFn: () => api<Page<AuditEvent>>("/api/v1/audit-events?limit=100"),
  });
  return (
    <>
      <PageHeader
        eyebrow="Security"
        title="Activity history"
        description="Changes made here and by agents, kept in order and never rewritten. The hundred most recent are shown."
      />
      {events.error ? <Alert>{events.error.message}</Alert> : null}
      {events.data?.items.length ? (
        <section className="panel activity-list">
          {events.data.items.map((event) => {
            const { Icon, tone, label } = actorPresentation(event.actorSource);
            return (
              <div className="activity-row" key={event.id}>
                <span className={`activity-icon ${event.actorSource}`}>
                  <Icon size={17} />
                </span>
                <div>
                  <strong>{activitySentence(event)}</strong>
                  <small>
                    {/* In the account's stored timezone, not the browser's:
                        an audit trail read while traveling must agree with
                        the dates on the entries it audits. */}
                    {formatTimestamp(event.createdAt, timezone)}
                  </small>
                </div>
                <Badge tone={tone}>{label}</Badge>
              </div>
            );
          })}
        </section>
      ) : events.isPending ? (
        <Skeleton height={120} label="Loading activity…" />
      ) : events.error ? null : (
        <EmptyState
          icon={History}
          title="No activity yet"
          body="Account, category, transaction, import, and agent actions show up here."
        />
      )}
    </>
  );
}
