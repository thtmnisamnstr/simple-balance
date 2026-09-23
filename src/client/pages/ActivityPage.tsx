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
 * An audit event as the line somebody reads: "create budget plan", which the
 * stylesheet capitalizes to "Create Budget Plan".
 *
 * The stored operation is history and stays exactly as it was written — the
 * MCP returns it, and a log that rewrote its own entries would not be one — so
 * the words are made here, on the way to the screen. Most operations are a
 * bare snake_case verb ("payee_merge"), but the budget and category-group
 * services record theirs as `entity.camelCaseVerb`, and printing that whole
 * opened the page with "BudgetPlan.Create Budget Plan": the entity twice, once
 * as a code identifier. The prefix only names the entity the line already
 * ends with, so everything up to the last dot is dropped and the camelCase
 * verb is split into words.
 *
 * Exported for `tests/activity-sentence.test.ts`.
 */
export function activitySentence(event: Pick<AuditEvent, "operation" | "entityType">) {
  const verb = event.operation
    .slice(event.operation.lastIndexOf(".") + 1)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase();
  return `${verb} ${event.entityType.replaceAll("_", " ")}`;
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
          icon={<History size={25} />}
          title="No activity yet"
          body="Account, category, transaction, import, and agent actions show up here."
        />
      )}
    </>
  );
}
