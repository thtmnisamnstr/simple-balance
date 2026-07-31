import { serveStatic } from "@hono/node-server/serve-static";
import {
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
  withMcpAuth,
} from "better-auth/plugins";
import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Actor } from "../shared/domain.js";
import {
  bulkDeleteStageSchema,
  bulkTransactionEditSchema,
  bulkTransactionFilterSelectionRequestSchema,
  categoryMergeSchema,
  commitStageSchema,
  dateRangeSchema,
  directTransactionCreateSchema,
  payeeMergeSchema,
  transactionDeletedMutationSchema,
  versionedMutationSchema,
} from "../shared/domain.js";
import { actorFromMcpSession, getAuth, getWebIdentity } from "./auth.js";
import {
  getPublicAuthOptions,
  getUserAuthState,
  hasLocalPassword,
  isLocalBootstrapOpen,
} from "./auth-policy.js";
import { getConfig } from "./config.js";
import { getAuthBootstrapLockPool, getDb } from "./db/client.js";
import {
  boundRequestBody,
  protectAuthMutation,
  protectBrowserMutation,
  rejectRequestBody,
  requestBodyLimit,
} from "./http-security.js";
import { handleMcpRequest } from "./mcp.js";
import {
  getMcpJwks,
  issueMcpAccessToken,
  resignMcpIdToken,
  unwrapMcpAccessToken,
} from "./mcp-token.js";
import {
  createAccount,
  deleteAccount,
  getAccount,
  getAccountBalances,
  listAccounts,
  setAccountArchived,
  updateAccount,
} from "./services/accounts.js";
import { listAuditEvents } from "./services/audit.js";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  listDuplicateCategories,
  mergeCategories,
  setCategoryArchived,
  updateCategory,
} from "./services/categories.js";
import { AppError } from "./services/errors.js";
import {
  exportTransactionsCsv,
  getCsvPreview,
  listActiveImportBatches,
  stageCsv,
} from "./services/import-export.js";
import { getPreferences, setPreferences } from "./services/preferences.js";
import {
  listDuplicatePayees,
  listPayees,
  listPayeeSuggestions,
  mergePayees,
} from "./services/payees.js";
import {
  commitStages,
  createStage,
  deleteStages,
  getStage,
  listStages,
  updateStage,
} from "./services/staging.js";
import { getSummary } from "./services/summary.js";
import {
  bulkEditTransactions,
  createTransaction,
  getBulkTransactionSelection,
  getTransaction,
  listTransactions,
  setTransactionDeleted,
  updateTransaction,
} from "./services/transactions.js";
import { isOwnerSetupTokenValid } from "./setup-token.js";

type Variables = {
  actor: Actor;
  authUser: { id: string; name: string; email: string; image?: string | null };
};

const app = new Hono<{ Variables: Variables }>();

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
    strictTransportSecurity: getConfig().isProduction
      ? "max-age=31536000; includeSubDomains"
      : false,
  }),
);

const globalBodyLimit = boundRequestBody({
  maxBytes: (context) => requestBodyLimit(context.req.path),
});
app.use("*", async (context, next) => {
  if (
    context.req.path === "/mcp" ||
    context.req.path === "/api/v1" ||
    context.req.path.startsWith("/api/v1/")
  ) {
    await next();
    return;
  }
  return globalBodyLimit(context, next);
});

app.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      error.status as 400,
    );
  }
  if (error instanceof z.ZodError) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues,
        },
      },
      422,
    );
  }
  console.error(error);
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
    500,
  );
});

app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", async (c) => {
  try {
    await getDb().execute(sql`select 1`);
    return c.json({ status: "ready" });
  } catch {
    return c.json({ status: "not_ready" }, 503);
  }
});

app.use("/api/auth/*", protectAuthMutation(getConfig().baseUrl));

app.get("/api/auth/methods", async (c) =>
  c.json(await getPublicAuthOptions()),
);

const localBootstrapLockId = 724_202_608;
let localBootstrapBusy = false;
app.post("/api/auth/sign-up/email", async (c) => {
  if (!getConfig().localAuthEnabled) {
    return c.json(
      { code: "LOCAL_AUTH_DISABLED", message: "Local authentication is disabled" },
      403,
    );
  }
  const contentType = c.req.header("content-type") ?? "";
  const setupPayload = contentType.includes("application/x-www-form-urlencoded")
    ? Object.fromEntries(await c.req.raw.clone().formData())
    : await c.req.raw.clone().json().catch(() => ({}));
  if (
    !isOwnerSetupTokenValid(
      setupPayload && typeof setupPayload === "object"
        ? (setupPayload as Record<string, unknown>).setupToken
        : undefined,
    )
  ) {
    return c.json(
      {
        code: "INVALID_SETUP_TOKEN",
        message: "The owner setup code is missing or invalid.",
      },
      403,
    );
  }
  if (localBootstrapBusy) {
    return c.json(
      {
        code: "REGISTRATION_BUSY",
        message: "Owner setup is already in progress. Try again.",
      },
      409,
    );
  }
  localBootstrapBusy = true;
  let client: PoolClient | undefined;
  let acquired = false;
  try {
    client = await getAuthBootstrapLockPool().connect();
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1) as acquired",
      [localBootstrapLockId],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) {
      return c.json(
        {
          code: "REGISTRATION_BUSY",
          message: "Owner setup is already in progress on another instance. Try again.",
        },
        409,
      );
    }
    if (!(await isLocalBootstrapOpen())) {
      return c.json(
        {
          code: "REGISTRATION_CLOSED",
          message:
            "The local owner account is already configured. Sign in with that account.",
        },
        409,
      );
    }
    return await getAuth().handler(c.req.raw);
  } finally {
    try {
      if (client && acquired) {
        await client.query("select pg_advisory_unlock($1)", [localBootstrapLockId]);
      }
    } finally {
      client?.release();
      localBootstrapBusy = false;
    }
  }
});

app.on(["GET", "POST"], "/api/auth/callback/google", async (c) => {
  if (!getConfig().googleAuthEnabled) {
    return c.json(
      { code: "GOOGLE_AUTH_DISABLED", message: "Google authentication is disabled" },
      404,
    );
  }
  return getAuth().handler(c.req.raw);
});

app.post("/api/auth/mcp/token", async (c) => {
  const response = await getAuth().handler(c.req.raw);
  if (!response.ok) return response;
  const payload = (await response.json()) as Record<string, unknown>;
  if (typeof payload.access_token === "string") {
    payload.access_token = await issueMcpAccessToken(payload.access_token);
  }
  if (typeof payload.id_token === "string") {
    payload.id_token = await resignMcpIdToken(payload.id_token);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
app.get("/api/auth/mcp/jwks", async (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=300");
  return c.json(await getMcpJwks());
});
app.get("/api/auth/mcp/authorize", (c) => {
  // Better Auth 1.6 only marks an MCP authorization code as consent-gated
  // when the client itself sends `prompt=consent`. Dynamic clients are
  // untrusted, so make consent a server policy instead of a client choice.
  const authorizationUrl = new URL(c.req.raw.url);
  authorizationUrl.searchParams.set("prompt", "consent");
  return getAuth().handler(new Request(authorizationUrl, c.req.raw));
});
app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth().handler(c.req.raw));
const mcpScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "ledger:read",
  "ledger:stage",
  "ledger:write",
];
app.get("/.well-known/oauth-authorization-server", async (c) => {
  const response = await oAuthDiscoveryMetadata(getAuth())(c.req.raw);
  const metadata = (await response.json()) as Record<string, unknown>;
  return c.json({ ...metadata, scopes_supported: mcpScopes });
});
app.get("/.well-known/oauth-protected-resource", async (c) => {
  const response = await oAuthProtectedResourceMetadata(getAuth())(c.req.raw);
  const metadata = (await response.json()) as Record<string, unknown>;
  return c.json({ ...metadata, scopes_supported: mcpScopes });
});

const authenticatedMcpBodyLimit = boundRequestBody({
  maxBytes: (context) => requestBodyLimit(context.req.path),
});
app.all("/mcp", async (c) => {
  const protectedMcp = withMcpAuth(getAuth(), async (request, session) => {
    const identity = await actorFromMcpSession(session);
    if (!identity) {
      await rejectRequestBody(c);
      return new Response("Forbidden", {
        status: 403,
        headers: { Connection: "close" },
      });
    }

    c.req.raw = request;
    let handled: Response | undefined;
    const limited = await authenticatedMcpBodyLimit(c, async () => {
      handled = await handleMcpRequest(
        c.req.raw,
        identity.actor,
        identity.scopes,
      );
    });
    return limited ?? handled ?? new Response(null, { status: 500 });
  });
  const authorization = c.req.raw.headers.get("authorization");
  let authenticatedRequest = c.req.raw;
  if (authorization?.startsWith("Bearer ")) {
    const opaqueToken = await unwrapMcpAccessToken(authorization.slice(7));
    const headers = new Headers(c.req.raw.headers);
    headers.set(
      "authorization",
      `Bearer ${opaqueToken ?? "invalid-audience-bound-jwt"}`,
    );
    authenticatedRequest = new Request(c.req.raw, { headers });
  }
  const response = await protectedMcp(authenticatedRequest);
  if (response.status !== 401) return response;

  await rejectRequestBody(c);
  const headers = new Headers(response.headers);
  headers.set("Connection", "close");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});

app.use(
  "/api/v1/*",
  protectBrowserMutation({
    allowedOrigin: getConfig().baseUrl,
    allowedContentTypes: new Set(["application/json"]),
    requireContentType: true,
  }),
);
app.use("/api/v1/*", async (c, next) => {
  const identity = await getWebIdentity(c.req.raw.headers);
  if (!identity) {
    await rejectRequestBody(c);
    return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } }, 401);
  }
  c.set("authUser", identity.user);
  c.set("actor", { userId: identity.user.id, source: "web" });
  await next();
});
app.use(
  "/api/v1/*",
  boundRequestBody({ maxBytes: (context) => requestBodyLimit(context.req.path) }),
);
const body = async (c: Context<{ Variables: Variables }>) => c.req.json<unknown>();
const query = (c: Context<{ Variables: Variables }>) => c.req.query();

app.get("/api/v1/session", async (c) =>
  c.json({
    user: c.get("authUser"),
    preferences: await getPreferences(c.get("actor")),
    auth: await getUserAuthState(c.get("authUser").id),
  }),
);
app.post("/api/v1/auth/local-password", async (c) => {
  if (!getConfig().localAuthEnabled) {
    throw new AppError("FORBIDDEN", "Local authentication is disabled", 403);
  }
  const parsed = z
    .object({
      newPassword: z.string().min(12).max(128),
    })
    .parse(await body(c));
  const userId = c.get("authUser").id;
  if (await hasLocalPassword(userId)) {
    throw new AppError(
      "CONFLICT",
      "A local password is already configured. Use the password change action.",
      409,
    );
  }
  try {
    await getAuth().api.setPassword({
      headers: c.req.raw.headers,
      body: { newPassword: parsed.newPassword },
    });
  } catch (error) {
    throw new AppError(
      "VALIDATION_ERROR",
      error instanceof Error ? error.message : "Password could not be updated",
      422,
    );
  }
  return c.json(await getUserAuthState(userId));
});
app.put("/api/v1/preferences", async (c) =>
  c.json(await setPreferences(c.get("actor"), await body(c))),
);

app.get("/api/v1/accounts", async (c) =>
  c.json(
    await listAccounts(
      c.get("actor"),
      c.req.query("end"),
      c.req.query("includeArchived") === "true",
    ),
  ),
);
app.get("/api/v1/accounts/:id/balances", async (c) =>
  c.json(
    await getAccountBalances(
      c.get("actor"),
      c.req.param("id"),
      dateRangeSchema.parse({
        start: c.req.query("start"),
        end: c.req.query("end"),
      }),
    ),
  ),
);
app.get("/api/v1/accounts/:id", async (c) =>
  c.json(await getAccount(c.get("actor"), c.req.param("id"))),
);
app.post("/api/v1/accounts", async (c) =>
  c.json(await createAccount(c.get("actor"), await body(c)), 201),
);
app.put("/api/v1/accounts/:id", async (c) =>
  c.json(await updateAccount(c.get("actor"), c.req.param("id"), await body(c))),
);
app.post("/api/v1/accounts/:id/archive", async (c) => {
  const parsed = versionedMutationSchema
    .extend({ archived: z.boolean() })
    .parse(await body(c));
  return c.json(
    await setAccountArchived(
      c.get("actor"),
      c.req.param("id"),
      parsed.expectedVersion,
      parsed.archived,
    ),
  );
});
app.delete("/api/v1/accounts/:id", async (c) => {
  const parsed = versionedMutationSchema.parse(await body(c));
  return c.json(
    await deleteAccount(c.get("actor"), c.req.param("id"), parsed.expectedVersion),
  );
});

app.get("/api/v1/categories", async (c) =>
  c.json(
    await listCategories(c.get("actor"), c.req.query("includeArchived") === "true"),
  ),
);
app.get("/api/v1/categories/duplicates", async (c) =>
  c.json(await listDuplicateCategories(c.get("actor"))),
);
app.get("/api/v1/categories/:id", async (c) =>
  c.json(await getCategory(c.get("actor"), c.req.param("id"))),
);
app.post("/api/v1/categories/merge", async (c) =>
  c.json(
    await mergeCategories(
      c.get("actor"),
      categoryMergeSchema.parse(await body(c)),
    ),
  ),
);
app.get("/api/v1/payees/suggestions", async (c) =>
  c.json(await listPayeeSuggestions(c.get("actor"), c.req.query("search"))),
);
app.get("/api/v1/payees/duplicates", async (c) =>
  c.json(await listDuplicatePayees(c.get("actor"))),
);
app.post("/api/v1/payees/merge", async (c) =>
  c.json(
    await mergePayees(
      c.get("actor"),
      payeeMergeSchema.parse(await body(c)),
    ),
  ),
);
app.get("/api/v1/payees", async (c) =>
  c.json(
    await listPayees(c.get("actor"), { search: c.req.query("search") }),
  ),
);
app.post("/api/v1/categories", async (c) =>
  c.json(await createCategory(c.get("actor"), await body(c)), 201),
);
app.put("/api/v1/categories/:id", async (c) =>
  c.json(await updateCategory(c.get("actor"), c.req.param("id"), await body(c))),
);
app.post("/api/v1/categories/:id/archive", async (c) => {
  const parsed = versionedMutationSchema
    .extend({ archived: z.boolean() })
    .parse(await body(c));
  return c.json(
    await setCategoryArchived(
      c.get("actor"),
      c.req.param("id"),
      parsed.expectedVersion,
      parsed.archived,
    ),
  );
});
app.delete("/api/v1/categories/:id", async (c) => {
  const parsed = versionedMutationSchema.parse(await body(c));
  return c.json(
    await deleteCategory(c.get("actor"), c.req.param("id"), parsed.expectedVersion),
  );
});

app.get("/api/v1/transactions", async (c) =>
  c.json(await listTransactions(c.get("actor"), query(c))),
);
app.post("/api/v1/transactions/bulk-selection", async (c) =>
  c.json(
    await getBulkTransactionSelection(
      c.get("actor"),
      bulkTransactionFilterSelectionRequestSchema.parse(await body(c)),
    ),
  ),
);
app.post("/api/v1/transactions/bulk-edit", async (c) =>
  c.json(
    await bulkEditTransactions(
      c.get("actor"),
      bulkTransactionEditSchema.parse(await body(c)),
    ),
  ),
);
app.get("/api/v1/transactions/:id", async (c) =>
  c.json(await getTransaction(c.get("actor"), c.req.param("id"))),
);
app.post("/api/v1/transactions", async (c) => {
  const parsed = directTransactionCreateSchema.parse(await body(c));
  return c.json(
    await createTransaction(
      c.get("actor"),
      parsed.draft,
      parsed.idempotencyKey,
      parsed.allowDuplicate,
    ),
    201,
  );
});
app.put("/api/v1/transactions/:id", async (c) =>
  c.json(await updateTransaction(c.get("actor"), c.req.param("id"), await body(c))),
);
app.post("/api/v1/transactions/:id/deleted", async (c) => {
  const parsed = transactionDeletedMutationSchema.parse(await body(c));
  return c.json(
    await setTransactionDeleted(
      c.get("actor"),
      c.req.param("id"),
      parsed.expectedVersion,
      parsed.deleted,
      parsed.allowDuplicate,
    ),
  );
});

app.get("/api/v1/staged-transactions", async (c) =>
  c.json(await listStages(c.get("actor"), query(c))),
);
app.get("/api/v1/staged-transactions/:id", async (c) =>
  c.json(await getStage(c.get("actor"), c.req.param("id"))),
);
app.post("/api/v1/staged-transactions", async (c) =>
  c.json(await createStage(c.get("actor"), await body(c)), 201),
);
app.put("/api/v1/staged-transactions/:id", async (c) =>
  c.json(await updateStage(c.get("actor"), c.req.param("id"), await body(c))),
);
app.post("/api/v1/staged-transactions/delete", async (c) =>
  c.json(await deleteStages(c.get("actor"), bulkDeleteStageSchema.parse(await body(c)))),
);
app.post("/api/v1/staged-transactions/commit", async (c) =>
  c.json(await commitStages(c.get("actor"), commitStageSchema.parse(await body(c)))),
);

app.post("/api/v1/csv/preview", async (c) => {
  const parsed = z.object({ csv: z.string().min(1) }).parse(await body(c));
  return c.json(getCsvPreview(parsed.csv));
});
app.post("/api/v1/csv/stage", async (c) =>
  c.json(await stageCsv(c.get("actor"), await body(c))),
);
app.get("/api/v1/import-batches", async (c) =>
  c.json(await listActiveImportBatches(c.get("actor"), query(c))),
);
app.get("/api/v1/csv/export", async (c) => {
  const result = await exportTransactionsCsv(c.get("actor"), query(c));
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  return c.body(result.csv);
});

app.get("/api/v1/summary", async (c) =>
  c.json(await getSummary(c.get("actor"), query(c))),
);
app.get("/api/v1/audit-events", async (c) =>
  c.json(
    await listAuditEvents(c.get("actor"), {
      cursor: c.req.query("cursor"),
      limit: Number(c.req.query("limit") ?? 50),
    }),
  ),
);

if (process.env.NODE_ENV === "production") {
  app.use("/assets/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
}

export default app;
