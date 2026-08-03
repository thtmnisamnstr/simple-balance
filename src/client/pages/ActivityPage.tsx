import { useQuery } from "@tanstack/react-query";
import { Bot, History, Monitor } from "lucide-react";
import { api, type AuditEvent, type Page } from "../api.js";
import { Badge, EmptyState, PageHeader } from "../components.js";

function sentence(event: AuditEvent) {
  const entity = event.entityType.replaceAll("_", " ");
  return `${event.operation.replaceAll("_", " ")} ${entity}`;
}

export default function ActivityPage() {
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
      {events.data?.items.length ? (
        <section className="panel activity-list">
          {events.data.items.map((event) => {
            const Icon = event.actorSource === "mcp" ? Bot : Monitor;
            return (
              <div className="activity-row" key={event.id}>
                <span className={`activity-icon ${event.actorSource}`}>
                  <Icon size={17} />
                </span>
                <div>
                  <strong>{sentence(event)}</strong>
                  <small>
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(event.createdAt))}
                  </small>
                </div>
                <Badge tone={event.actorSource === "mcp" ? "blue" : "neutral"}>
                  {event.actorSource === "mcp" ? "Agent" : "Web"}
                </Badge>
              </div>
            );
          })}
        </section>
      ) : (
        <EmptyState
          icon={<History size={25} />}
          title="No activity yet"
          body="Account, category, transaction, import, and agent actions show up here."
        />
      )}
    </>
  );
}
