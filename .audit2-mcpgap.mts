import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client as PgClient } from "pg";
import { closeDb, getDb } from "./src/server/db/client.js";
import { runMigrations } from "./src/server/db/migrate.js";
import { user } from "./src/server/db/schema.js";
import { createMcpServer } from "./src/server/mcp.js";
import { createAccount } from "./src/server/services/accounts.js";
import { createCategory } from "./src/server/services/categories.js";
import { runDueNotifications } from "./src/server/services/notifications.js";

const connection = process.env.TEST_DATABASE_URL!;
const dbName = `sb_audit2_${process.pid}`;
const actor = { userId: "audit2", source: "mcp" as const, clientId: "audit2" };
const admin = new PgClient({ connectionString: connection });
const out: Record<string, unknown> = {};

await admin.connect();
await admin.query(`drop database if exists "${dbName}"`);
await admin.query(`create database "${dbName}"`);
const url = new URL(connection);
url.pathname = `/${dbName}`;
process.env.DATABASE_URL = url.toString();
await runMigrations();
await getDb().insert(user).values({
  id: actor.userId,
  name: "Audit",
  email: "audit@example.com",
  emailVerified: true,
});
const account = await createAccount(actor, {
  name: "Checking",
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "100",
});
const category = await createCategory(actor, { name: "Rent", kind: "expense" });

const server = createMcpServer(
  actor,
  new Set(["ledger:read", "ledger:stage", "ledger:write"]),
);
const client = new Client({ name: "audit2", version: "1.0.0" });
const [c, s] = InMemoryTransport.createLinkedPair();
await server.connect(s);
await client.connect(c);

const raw = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return res as { structuredContent?: { result?: unknown }; isError?: boolean };
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await raw(name, args);
  const result = res.structuredContent?.result;
  if (result && typeof result === "object" && "error" in (result as object)) {
    throw new Error(`${name} -> ${JSON.stringify((result as any).error)}`);
  }
  if (result === undefined) {
    throw new Error(`${name} -> NO STRUCTURED RESULT (schema drop?)`);
  }
  return result as any;
};
const softCall = async (name: string, args: Record<string, unknown> = {}) => {
  try {
    return { ok: true, value: await call(name, args) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
};

const key = (n: string) => `${n}-${Math.random().toString(16).slice(2)}`;

// ---- tool inventory by scope
const listFor = async (scopes: string[]) => {
  const srv = createMcpServer(actor, new Set(scopes));
  const cl = new Client({ name: "x", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.connect(b);
  await cl.connect(a);
  const { tools } = await cl.listTools();
  await cl.close();
  await srv.close();
  return tools.map((t) => t.name).sort();
};
const readOnly = await listFor(["ledger:read"]);
const stageOnly = await listFor(["ledger:stage"]);
const writeOnly = await listFor(["ledger:write"]);
const all = await listFor(["ledger:read", "ledger:stage", "ledger:write"]);
out.toolCounts = {
  read: readOnly.length,
  stage: stageOnly.length,
  write: writeOnly.length,
  all: all.length,
};
out.stageOnlyExtra = stageOnly.filter((t) => !readOnly.includes(t));
out.notificationNamedTools = all.filter((t) => /notif|remind|mail|email/i.test(t));

// ---- input schema introspection: which tools mention notification fields
const { tools: allTools } = await (async () => {
  const srv = createMcpServer(
    actor,
    new Set(["ledger:read", "ledger:stage", "ledger:write"]),
  );
  const cl = new Client({ name: "y", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.connect(b);
  await cl.connect(a);
  const listed = await cl.listTools();
  await cl.close();
  await srv.close();
  return listed;
})();
const mentions = (t: any, word: string) =>
  JSON.stringify(t.inputSchema ?? {}).includes(word);
out.toolsWithNotificationInput = allTools
  .filter((t) => mentions(t, "notification") || mentions(t, "notifyOnCreate"))
  .map((t) => t.name);
out.toolsWithNotificationOutput = allTools
  .filter(
    (t) =>
      JSON.stringify((t as any).outputSchema ?? {}).includes("notification") ||
      JSON.stringify((t as any).outputSchema ?? {}).includes("notifyOnCreate"),
  )
  .map((t) => t.name);
out.whoamiOutput = JSON.stringify(
  (allTools.find((t) => t.name === "whoami") as any)?.outputSchema ?? null,
);
out.getPreferencesOutput = JSON.stringify(
  (allTools.find((t) => t.name === "get_preferences") as any)?.outputSchema ??
    null,
);

// ---- 1. set a ONE-OFF reminder through MCP
const oneOff = await softCall("create_transaction_template", {
  name: "Council tax",
  draft: {
    type: "withdrawal",
    payee: "Council",
    fromAccountId: account.id,
    categoryId: category.id,
    amount: "120.00",
  },
  notification: { frequency: null, anchorDate: "2026-09-01", time: "08:30" },
  idempotencyKey: key("t1"),
});
out.createOneOffReminder = oneOff;

// ---- 2. set a REPEATING reminder through MCP
const repeating = await softCall("create_transaction_template", {
  name: "Rent",
  draft: {
    type: "withdrawal",
    payee: "Landlord",
    fromAccountId: account.id,
    categoryId: category.id,
    amount: "900.00",
  },
  notification: {
    frequency: "monthly",
    interval: 1,
    anchorDate: "2026-08-01",
    monthPolicy: "last_day",
    weekendPolicy: "previous_business_day",
    time: "09:00",
  },
  idempotencyKey: key("t2"),
});
out.createRepeatingReminder = repeating;

const repeatingId = (repeating as any).value?.id;
const oneOffId = (oneOff as any).value?.id;

// ---- 3. read it back
out.getTemplateNotification = await softCall("get_transaction_template", {
  id: repeatingId,
});
const listed = await softCall("list_transaction_templates", {});
out.listTemplateNotifications = (listed as any).value?.map?.((t: any) => ({
  name: t.name,
  notification: t.notification,
}));

// ---- 4. update NAME only: is the reminder preserved?
const afterRename = await softCall("update_transaction_template", {
  id: repeatingId,
  input: {
    name: "Rent (flat)",
    expectedVersion: (repeating as any).value?.version,
  },
  idempotencyKey: key("t3"),
});
out.renameKeepsReminder = {
  ok: afterRename.ok,
  notification: (afterRename as any).value?.notification ?? afterRename,
};

// ---- 5. change the reminder
const changed = await softCall("update_transaction_template", {
  id: repeatingId,
  input: {
    notification: {
      frequency: "monthly",
      interval: 2,
      anchorDate: "2026-08-05",
      monthPolicy: "skip",
      weekendPolicy: "next_business_day",
      time: "19:45",
    },
    expectedVersion: (afterRename as any).value?.version,
  },
  idempotencyKey: key("t4"),
});
out.changeReminder = {
  ok: changed.ok,
  notification: (changed as any).value?.notification ?? changed,
};

// ---- 6. remove the reminder with null
const removed = await softCall("update_transaction_template", {
  id: repeatingId,
  input: {
    notification: null,
    expectedVersion: (changed as any).value?.version,
  },
  idempotencyKey: key("t5"),
});
out.removeReminder = {
  ok: removed.ok,
  notification: (removed as any).value?.notification ?? removed,
};

// ---- 7. has a reminder already been sent? Overdue one-off, sweep, then read.
const before = await softCall("get_transaction_template", { id: oneOffId });
const overdue = await softCall("update_transaction_template", {
  id: oneOffId,
  input: {
    notification: { frequency: null, anchorDate: "2020-01-01", time: "00:01" },
    expectedVersion: (before as any).value?.version,
  },
  idempotencyKey: key("t6"),
});
out.overdueBeforeSweep = (overdue as any).value?.notification ?? overdue;
out.sweep = await runDueNotifications();
out.overdueAfterSweep =
  (await softCall("get_transaction_template", { id: oneOffId })).value
    ?.notification ?? null;

// ---- 8. recurrence notifyOnCreate
const recurrence = await softCall("create_recurrence", {
  name: "Salary",
  shape: {
    type: "deposit",
    payee: "Employer",
    toAccountId: account.id,
    amount: "2000.00",
  },
  schedule: { frequency: "monthly", anchorDate: "2026-08-25" },
  notifyOnCreate: true,
  idempotencyKey: key("r1"),
});
out.createRecurrenceNotify = {
  ok: recurrence.ok,
  notifyOnCreate: (recurrence as any).value?.notifyOnCreate ?? recurrence,
};
out.getRecurrenceNotify =
  (await softCall("get_recurrence", { id: (recurrence as any).value?.id }))
    .value?.notifyOnCreate ?? null;
const recList = await softCall("list_recurrences", {});
out.listRecurrenceNotify = (recList as any).value?.items?.map?.((r: any) => ({
  name: r.name,
  notifyOnCreate: r.notifyOnCreate,
}));
const flipped = await softCall("update_recurrence", {
  id: (recurrence as any).value?.id,
  input: {
    notifyOnCreate: false,
    expectedVersion: (recurrence as any).value?.version,
  },
  idempotencyKey: key("r2"),
});
out.updateRecurrenceNotify = {
  ok: flipped.ok,
  notifyOnCreate: (flipped as any).value?.notifyOnCreate ?? flipped,
};

// ---- 9. can bulk template edit touch reminders?
out.bulkTemplateReminder = await softCall("bulk_edit_transaction_templates", {
  selection: {
    mode: "ids",
    items: [{ id: oneOffId, expectedVersion: 99 }],
  },
  patch: { notification: null },
  idempotencyKey: key("b1"),
  dryRun: true,
});

// ---- 10. does any tool report whether mail is configured?
out.whoami = await softCall("whoami");
out.preferences = await softCall("get_preferences");
out.summarizeOwnData = await softCall("summarize_own_data");

// ---- 11. is a reminder change visible in the audit trail?
const audit = await softCall("list_audit_events", { limit: 50 });
out.auditTemplateEvents = (audit as any).value?.items
  ?.filter((e: any) => e.entityType === "transaction_template")
  ?.map((e: any) => ({
    operation: e.operation,
    beforeNotification: e.before?.notification ?? null,
    afterNotification: e.after?.notification ?? null,
  }));

// ---- 12. skipped-occurrence lookahead: a monthly rule on the 31st with skip
const skipper = await softCall("create_transaction_template", {
  name: "Quarter day",
  draft: { type: "withdrawal", payee: "Agent", fromAccountId: account.id },
  notification: {
    frequency: "monthly",
    interval: 1,
    anchorDate: "2026-01-31",
    monthPolicy: "skip",
    weekendPolicy: "allow",
    time: "07:00",
  },
  idempotencyKey: key("t7"),
});
out.skipperOnCreate = (skipper as any).value?.notification ?? skipper;
out.skipperSweep = await runDueNotifications();
out.skipperAfterSweep =
  (await softCall("get_transaction_template", { id: (skipper as any).value?.id }))
    .value?.notification ?? null;

// ---- 13. what a read tool returns but does not declare
const undeclared = (value: any, schema: any, path = ""): string[] => {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema.anyOf ?? schema.oneOf)) {
    const branches = (schema.anyOf ?? schema.oneOf).map((b: any) =>
      undeclared(value, b, path),
    );
    return branches.sort((a: string[], b: string[]) => a.length - b.length)[0] ?? [];
  }
  if (Array.isArray(value)) {
    return value.slice(0, 2).flatMap((item, index) =>
      undeclared(item, schema.items, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    const properties = schema.properties ?? {};
    const found: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (!(k in properties)) {
        found.push(`${path}.${k}`);
        continue;
      }
      found.push(...undeclared(v, properties[k], `${path}.${k}`));
    }
    return found;
  }
  return [];
};

const readProbes: [string, Record<string, unknown>][] = [
  ["list_accounts", {}],
  ["get_account", { id: account.id }],
  ["list_categories", {}],
  ["get_category", { id: category.id }],
  ["list_transaction_templates", {}],
  ["list_recurrences", {}],
  ["get_recurrence", { id: (recurrence as any).value?.id }],
  ["list_audit_events", { limit: 5 }],
  ["whoami", {}],
  ["get_preferences", {}],
  ["list_transactions", {}],
  ["list_staged_transactions", {}],
  ["get_financial_summary", {}],
  ["list_connected_agents", {}],
  ["summarize_own_data", {}],
];
const schemaOf = (name: string) =>
  (allTools.find((t) => t.name === name) as any)?.outputSchema;
const undeclaredByTool: Record<string, string[] | string> = {};
for (const [name, args] of readProbes) {
  const attempt = await softCall(name, args);
  if (!attempt.ok) {
    undeclaredByTool[name] = `CALL FAILED: ${attempt.error}`;
    continue;
  }
  undeclaredByTool[name] = [
    ...new Set(
      undeclared(
        { result: attempt.value },
        schemaOf(name) ?? { properties: {} },
        "",
      ).map((p) => p.replace(/\[\d+\]/g, "[]")),
    ),
  ];
}
out.undeclaredOutputFields = undeclaredByTool;

await client.close();
await server.close();
await closeDb();
await admin.query(`drop database if exists "${dbName}"`);
await admin.end();

console.log(JSON.stringify(out, null, 1));
