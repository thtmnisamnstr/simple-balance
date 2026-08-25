import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
  withMcpAuth,
} from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Actor } from "../shared/domain.js";
import {
  bulkDeleteStageSchema,
  bulkTransactionDeleteSchema,
  bulkTransactionEditSchema,
  bulkTransactionFilterSelectionRequestSchema,
  categoryMergeSchema,
  commitStageSchema,
  dateRangeSchema,
  directTransactionCreateSchema,
  payeeMergeSchema,
  queryBooleanSchema,
  reportNameSchema,
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
import { getConfig, isEmailAllowed, isRegistrationClosed } from "./config.js";
import { LOCAL_BOOTSTRAP_LOCK } from "./db/advisory-locks.js";
import { getAuthBootstrapLockPool, getDb } from "./db/client.js";
import { oauthApplication, verification } from "./db/schema.js";
import {
  boundRequestBody,
  countableClientAddress,
  createAttemptLimiter,
  hardenAuthCookies,
  protectAuthMutation,
  protectBrowserMutation,
  rejectRequestBody,
  requestBodyLimit,
  securityHeaderOptions,
  withCountableClientAddress,
} from "./http-security.js";
import { handleMcpRequest } from "./mcp.js";
import { runAsBootstrapClaim } from "./registration-context.js";
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
  listCategorySummaries,
  listDuplicateCategories,
  mergeCategories,
  setCategoryArchived,
  updateCategory,
} from "./services/categories.js";
import {
  bulkDeleteTransactionTemplates,
  bulkEditTransactionTemplates,
  createTransactionTemplate,
  deleteTransactionTemplate,
  getTransactionTemplate,
  listTransactionTemplates,
  updateTransactionTemplate,
} from "./services/transaction-templates.js";
import {
  createRecurrence,
  deleteRecurrence,
  getRecurrence,
  listRecurrences,
  updateRecurrence,
} from "./services/recurrences.js";
import {
  createBudgetPlan,
  deleteBudgetEntry,
  deleteBudgetPlan,
  getBudgetPlan,
  getBudgetReport,
  listBudgetEntries,
  listBudgetPlans,
  setBudgetEntry,
  updateBudgetPlan,
} from "./services/budgets.js";
import { AppError } from "./services/errors.js";
import {
  exportTransactionsCsv,
  getCsvPreview,
  listActiveImportBatches,
  stageCsv,
} from "./services/import-export.js";
import { deleteOwnAccount, summarizeOwnData } from "./services/account-deletion.js";
import {
  listConnectedApps,
  pruneAbandonedClients,
  revokeAllConnectedApps,
  revokeConnectedApp,
} from "./services/connected-apps.js";
import { CSV_MEDIA_TYPE } from "../shared/csv.js";
import { todayIn } from "../shared/recurrence-dates.js";
import { getPreferences, setPreferences } from "./services/preferences.js";
import {
  listDuplicatePayees,
  listPayees,
  listPayeeSuggestions,
  mergePayees,
} from "./services/payees.js";
import {
  bulkEditStages,
  commitStages,
  previewBulkStageSelection,
  createStage,
  deleteStages,
  getStage,
  listStages,
  getStagedDuplicateReview,
  updateStage,
} from "./services/staging.js";
import { getAccountRegister, getReport } from "./services/reports.js";
import { getSummary } from "./services/summary.js";
import {
  bulkDeleteTransactions,
  bulkEditTransactions,
  createTransaction,
  getBulkTransactionSelection,
  getTransaction,
  listTransactions,
  setTransactionDeleted,
  updateTransaction,
} from "./services/transactions.js";
import { isOwnerSetupTokenValid } from "./setup-token.js";

const uuidPathSchema = z.string().uuid("Not a valid identifier");

type Variables = {
  actor: Actor;
  authUser: { id: string; name: string; email: string; image?: string | null };
  sessionCreatedAt: Date;
};

const app = new Hono<{ Variables: Variables }>();

app.use("*", secureHeaders(securityHeaderOptions(getConfig().isProduction)));

const globalBodyLimit = boundRequestBody({
  maxBytes: (context) => requestBodyLimit(context.req.path),
});
app.use("*", async (context, next) => {
  if (
    context.req.path === "/mcp" ||
    context.req.path === "/mcp/" ||
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
  // Not the error object. Drizzle builds its message out of the failing SQL and
  // its bound parameters, and one of those parameters is the OAuth access token
  // the MCP token endpoint looks a grant up by, so logging it whole would write
  // a live credential into the log on any database hiccup. The statement is
  // what an operator needs; the values are not.
  const query = (error as { query?: unknown }).query;
  if (typeof query === "string") {
    console.error(`Query failed: ${query}`, (error as { cause?: unknown }).cause ?? error.name);
  } else {
    console.error(error);
  }
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
    500,
  );
});

app.get("/health/live", (c) => c.json({ status: "ok" }));
// Deliberately one statement against the database, and nothing else.
//
// It does not check configuration, the migrations or the scheduler, and adding
// any of those would take a working server out of rotation for a condition that
// cannot change while it runs. The migration guarantee is ordering rather than
// a probe: `runMigrations()` is awaited before the server listens, so a process
// answering this route at all is a process that got past them.
app.get("/health/ready", async (c) => {
  try {
    await getDb().execute(sql`select 1`);
    return c.json({ status: "ready" });
  } catch {
    return c.json({ status: "not_ready" }, 503);
  }
});

app.use("/api/auth/*", async (c, next) => {
  // These answer with a cookie for authorisation and hand back session tokens,
  // IP addresses and user agents, which is exactly what a shared cache or a
  // browser's back-forward store will hold on to by default.
  //
  // Set on the way out, not on the way in: most of this prefix is served by
  // Better Auth's own handler, which returns a Response of its own and takes
  // everything set beforehand with it. Only where nothing has already said
  // otherwise, so the JWKS route keeps the public caching every MCP client
  // depends on.
  await next();
  if (!c.res.headers.has("Cache-Control")) {
    c.res.headers.set("Cache-Control", "no-store");
  }
});
app.use("/api/auth/*", protectAuthMutation(getConfig().baseUrl));
app.use("/api/auth/*", hardenAuthCookies(getConfig().baseUrl));

// Everything below hands its request to Better Auth through this, so the
// rate limiter always counts against an address the caller cannot choose.
const authRequest = (c: Context, request: Request = c.req.raw) =>
  withCountableClientAddress(request, c, getConfig().trustProxy);

app.get("/api/auth/methods", async (c) => c.json(await getPublicAuthOptions()));

const FRESH_SESSION_MS = 15 * 60 * 1000;

const setupCodeAttempts = createAttemptLimiter({
  max: 5,
  windowMs: 15 * 60 * 1000,
});

let localBootstrapBusy = false;
app.post("/api/auth/sign-up/email", async (c) => {
  if (!getConfig().localAuthEnabled) {
    return c.json(
      { code: "LOCAL_AUTH_DISABLED", message: "Local authentication is disabled" },
      403,
    );
  }
  const contentType = c.req.header("content-type") ?? "";
  const payload = contentType.includes("application/x-www-form-urlencoded")
    ? Object.fromEntries(await c.req.raw.clone().formData())
    : await c.req.raw
        .clone()
        .json()
        .catch(() => ({}));
  const field = (name: string) =>
    payload && typeof payload === "object" ? (payload as Record<string, unknown>)[name] : undefined;

  const email = field("email");

  // Anyone the registration rule admits signs up directly. The setup code is
  // for the other case: a deployment nobody has claimed yet, where the rule
  // admits nobody and the code printed in the log is the only way in. Holding
  // the code proves you can read the server's output, which is a good enough
  // stand-in for owning it.
  if (typeof email === "string" && isEmailAllowed(email)) {
    return await getAuth().handler(authRequest(c));
  }

  if (!(await isLocalBootstrapOpen())) {
    return c.json(
      {
        code: "REGISTRATION_CLOSED",
        message: isRegistrationClosed()
          ? "This instance is not accepting new accounts."
          : "That email address is not allowed to register here.",
      },
      403,
    );
  }

  // Every path that reaches here has already been turned away by the
  // registration rule, so the code is the only thing standing between a caller
  // and the deployment. Better Auth's limiter never sees these attempts, since
  // a wrong code is refused above without its handler being called.
  const setupCaller = countableClientAddress(c.req.raw, c, getConfig().trustProxy);
  if (!(await setupCodeAttempts.take(setupCaller))) {
    return c.json(
      {
        code: "TOO_MANY_SETUP_ATTEMPTS",
        message: "Too many setup attempts. Wait a few minutes and try again.",
      },
      429,
    );
  }
  if (!(await isOwnerSetupTokenValid(field("setupToken")))) {
    return c.json(
      {
        code: "INVALID_SETUP_TOKEN",
        message: "The setup code is missing or invalid.",
      },
      403,
    );
  }
  await setupCodeAttempts.clear(setupCaller);
  // Only the claim races, and it happens once in a deployment's life. Sign-ups
  // that the rule already admits returned above without coming near this lock.
  if (localBootstrapBusy) {
    return c.json(
      {
        code: "REGISTRATION_BUSY",
        message: "Setup is already in progress. Try again.",
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
      [LOCAL_BOOTSTRAP_LOCK],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) {
      return c.json(
        {
          code: "REGISTRATION_BUSY",
          message: "Setup is already in progress on another instance. Try again.",
        },
        409,
      );
    }
    // Re-read under the lock: two people may have raced to claim this, and the
    // loser's code no longer buys anything the rule would not have given them.
    if (!(await isLocalBootstrapOpen())) {
      return c.json(
        {
          code: "REGISTRATION_CLOSED",
          message: isRegistrationClosed()
            ? "This instance is not accepting new accounts."
            : "That email address is not allowed to register here.",
        },
        403,
      );
    }
    return await runAsBootstrapClaim(() => getAuth().handler(authRequest(c)));
  } finally {
    try {
      if (client && acquired) {
        await client.query("select pg_advisory_unlock($1)", [LOCAL_BOOTSTRAP_LOCK]);
      }
    } finally {
      client?.release();
      localBootstrapBusy = false;
    }
  }
});

// Changing a password from Settings is the same recovery as resetting one, and
// Better Auth's onPasswordReset hook does not fire for it. An agent's grant
// outliving the credential it was authorized under is the thing being fixed,
// so both doors close the same way.
app.post("/api/auth/change-password", async (c) => {
  const identity = await getWebIdentity(c.req.raw.headers);
  const response = await getAuth().handler(authRequest(c));
  if (identity && response.ok) {
    await revokeAllConnectedApps(identity.user.id);
  }
  return response;
});

app.on(["GET", "POST"], "/api/auth/callback/google", async (c) => {
  if (!getConfig().googleAuthEnabled) {
    return c.json(
      { code: "GOOGLE_AUTH_DISABLED", message: "Google authentication is disabled" },
      404,
    );
  }
  return getAuth().handler(authRequest(c));
});

/**
 * Dynamic client registration, bounded.
 *
 * RFC 7591 registration is open and unauthenticated by design, and Better Auth
 * stored whatever arrived. Two things followed. `client_name` is optional in
 * the spec, but the column it lands in is not null, so a client within its
 * rights to omit it got a 500 with nothing to act on. And every free-text field
 * was unbounded, so a caller could park close to the whole 64 KiB request body
 * in a permanent row and repeat at the rate limiter's pace.
 *
 * So the text is clamped to lengths a real client has no trouble with, an
 * unnamed one gets the placeholder the consent screen can show, and each
 * registration sweeps away the anonymous ones nobody ever completed.
 */
const REGISTRATION_TEXT_LIMITS: Record<string, number> = {
  client_name: 200,
  client_uri: 2_000,
  logo_uri: 2_000,
  tos_uri: 2_000,
  policy_uri: 2_000,
  software_id: 200,
  software_version: 100,
  software_statement: 8_000,
  contacts: 500,
  scope: 2_000,
  // The one field with no shape at all, and the one Better Auth stores
  // verbatim. Bounding everything else and leaving this open would have moved
  // the problem rather than fixed it.
  metadata: 4_000,
};

function boundedRegistration(body: Record<string, unknown>) {
  const bounded: Record<string, unknown> = { ...body };
  for (const [field, limit] of Object.entries(REGISTRATION_TEXT_LIMITS)) {
    const value = bounded[field];
    if (typeof value === "string" && value.length > limit) {
      bounded[field] = value.slice(0, limit);
    }
    if (Array.isArray(value)) {
      bounded[field] = value
        .slice(0, 20)
        .map((entry) => (typeof entry === "string" ? entry.slice(0, limit) : entry));
    }
  }
  // Each redirect is a URL a browser has to be able to reach, and twenty is
  // already more than any real client registers.
  const redirects = bounded.redirect_uris;
  if (Array.isArray(redirects)) {
    bounded.redirect_uris = redirects
      .slice(0, 20)
      .map((entry) => (typeof entry === "string" ? entry.slice(0, 2_000) : entry));
  }
  if (
    bounded.metadata !== undefined &&
    typeof bounded.metadata === "object" &&
    bounded.metadata !== null
  ) {
    const encoded = JSON.stringify(bounded.metadata);
    if (encoded.length > REGISTRATION_TEXT_LIMITS.metadata) delete bounded.metadata;
  }
  if (!bounded.client_name) bounded.client_name = "Unnamed MCP client";
  // Registration here is unauthenticated, so a secret would be handed to
  // whoever asked for one and authenticate nothing. Better Auth's own MCP
  // register treats a missing token_endpoint_auth_method as `client_secret_basic`
  // and writes the generated secret to the row in cleartext, which the
  // `storeClientSecret: "hashed"` setting does not reach: that one is read by
  // the OIDC provider's register endpoint, and discovery advertises this one.
  // Every client is public instead. PKCE is already required and plain
  // challenges are refused, which is what actually binds a code to its caller.
  bounded.token_endpoint_auth_method = "none";
  return bounded;
}

// Registration is unauthenticated, so one sweep per request would let a caller
// drive a table-wide delete at the rate limiter's pace. Once every ten minutes
// is plenty for rows that are only eligible after a day.
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
let lastPruneAt = 0;

app.post("/api/auth/mcp/register", async (c) => {
  // A failed sweep must never fail a registration, and the clock moves before
  // the work starts so concurrent requests cannot all decide to sweep.
  const now = Date.now();
  if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = now;
    void pruneAbandonedClients().catch((error) => {
      console.error("Could not prune abandoned OAuth clients", error);
    });
  }
  const body = await c.req.raw
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return getAuth().handler(authRequest(c));
  }
  const bounded = boundedRegistration(body as Record<string, unknown>);
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  return getAuth().handler(
    authRequest(
      c,
      new Request(c.req.raw.url, {
        method: "POST",
        headers,
        body: JSON.stringify(bounded),
      }),
    ),
  );
});

app.post("/api/auth/mcp/token", async (c) => {
  const response = await getAuth().handler(authRequest(c));
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
  return getAuth().handler(authRequest(c, new Request(authorizationUrl, c.req.raw)));
});
// Better Auth publishes this, and it answers to the bare opaque token rather
// than to the audience-bound JWT the /mcp route insists on. What it returns is
// the whole stored grant, refresh token included. Since the access token
// carries the opaque token as a readable claim, leaving this reachable would
// let anything that ever saw one access token — a proxy, a log — trade it for
// seven days of access. Nothing here calls it.
app.on(["GET", "POST"], "/api/auth/mcp/get-session", (c) =>
  c.json({ code: "NOT_FOUND", message: "No such endpoint" }, 404),
);

function consentCodeFromCookie(c: Context) {
  const cookie = getCookie(c, "oidc_consent_prompt");
  // The cookie is signed as `value.signature`; only the value names the record.
  if (!cookie) return null;
  const value = cookie.split(".", 1)[0]!;
  try {
    return decodeURIComponent(value);
  } catch {
    // A broken percent escape threw out of here and became a 500 with a stack
    // trace, for a cookie the caller controls. The raw value is the right
    // fallback rather than null: a code that was never encoded still names its
    // record, and one that names nothing fails the lookup a few lines later,
    // which is where a bad code is supposed to be turned away.
    return value;
  }
}

/**
 * The consent code this request is answering, from the body or the cookie
 * Better Auth falls back to, in that order, exactly as the handler does.
 */
async function pendingConsentCode(c: Context) {
  const body = await c.req.raw
    .clone()
    .json()
    .catch(() => null);
  const fromBody =
    body && typeof body === "object"
      ? (body as { consent_code?: unknown }).consent_code
      : undefined;
  if (typeof fromBody === "string" && fromBody) return fromBody;
  return consentCodeFromCookie(c);
}

/** The authorize request a consent code stands for, as Better Auth stored it. */
async function pendingConsent(consentCode: string) {
  const [pending] = await getDb()
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, consentCode))
    .limit(1);
  if (!pending) return null;
  let parsed: {
    userId?: unknown;
    clientId?: unknown;
    scope?: unknown;
    requireConsent?: unknown;
  };
  try {
    parsed = JSON.parse(pending.value);
  } catch {
    return null;
  }
  return {
    userId: typeof parsed.userId === "string" ? parsed.userId : null,
    clientId: typeof parsed.clientId === "string" ? parsed.clientId : null,
    scopes: Array.isArray(parsed.scope)
      ? parsed.scope.filter((scope): scope is string => typeof scope === "string")
      : [],
    requireConsent: parsed.requireConsent === true,
    expiresAt: pending.expiresAt,
  };
}

/**
 * What the consent screen is being asked to approve.
 *
 * The client name and scopes come from the stored authorize request rather
 * than from the query string, because the query string is whatever the link
 * said: one naming a familiar client and `ledger:read` would display exactly
 * that while the record it approves grants something else. Only the record the
 * consent code names says what is really being granted.
 */
app.get("/api/auth/oauth2/consent-request", async (c) => {
  const identity = await getWebIdentity(c.req.raw.headers);
  if (!identity) {
    return c.json({ code: "UNAUTHORIZED", message: "Sign in is required" }, 401);
  }
  const consentCode = c.req.query("consent_code") || consentCodeFromCookie(c);
  const pending = consentCode ? await pendingConsent(consentCode) : null;
  if (!pending || !pending.requireConsent || pending.expiresAt < new Date()) {
    return c.json(
      {
        code: "CONSENT_NOT_PENDING",
        message: "That authorization request has expired or was already answered.",
      },
      404,
    );
  }
  if (pending.userId && pending.userId !== identity.user.id) {
    return c.json(
      {
        code: "CONSENT_NOT_YOURS",
        message: "That authorization request was started by a different account.",
      },
      403,
    );
  }
  const [application] = pending.clientId
    ? await getDb()
        .select({ name: oauthApplication.name })
        .from(oauthApplication)
        .where(eq(oauthApplication.clientId, pending.clientId))
        .limit(1)
    : [];
  return c.json({
    clientId: pending.clientId,
    clientName: application?.name ?? "An unnamed MCP client",
    scopes: pending.scopes,
  });
});

// Approving an authorization has to be done by the person it belongs to.
//
// Better Auth requires a session on this route but never compares it to the
// pending record it is approving: the user and client come from the stored
// authorize request, and the signed-in account is not consulted. Since consent
// is forced on for every client here, this screen is the only gate, and without
// this check one account could answer for a request made by another. PKCE keeps
// the resulting code from being redeemed by anybody but the client that started
// the flow, so the harm was consent nobody gave and a stalled authorization for
// the person who did start it, rather than a usable token.
app.post("/api/auth/oauth2/consent", async (c) => {
  const identity = await getWebIdentity(c.req.raw.headers);
  if (!identity) {
    return c.json({ code: "UNAUTHORIZED", message: "Sign in is required" }, 401);
  }
  const consentCode = await pendingConsentCode(c);
  if (consentCode) {
    const owner = (await pendingConsent(consentCode))?.userId;
    if (owner && owner !== identity.user.id) {
      return c.json(
        {
          code: "CONSENT_NOT_YOURS",
          message: "That authorization request was started by a different account.",
        },
        403,
      );
    }
  }
  return getAuth().handler(authRequest(c));
});

// Better Auth publishes a protected-resource document of its own under the auth
// base path, built from `oidcConfig.metadata.scopes_supported`, and that is the
// one a client reads first: `withMcpAuth`'s 401 challenge names
// `<baseUrl>/api/auth/.well-known/oauth-protected-resource` as its
// `resource_metadata`. Narrowing only the RFC 9728 paths below would have left
// the advertisement everybody follows at seven scopes and corrected the one
// nobody reads. Registered above the catch-all because Hono runs matching
// handlers in registration order and the catch-all answers; and through an
// arrow, because `protectedResourceMetadata` is declared further down and a
// bare reference here would be read before its initialiser has run.
app.get("/api/auth/.well-known/oauth-protected-resource", (c) => protectedResourceMetadata(c));
app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth().handler(authRequest(c)));
/**
 * What each discovery document says this deployment supports.
 *
 * They answer two different questions and so give two different answers. RFC
 * 8414's `scopes_supported` is what the authorization server accepts, and
 * Better Auth's accept-list at `/authorize` really is the union of its four
 * defaults with our three, so naming all seven there is true.
 *
 * RFC 9728's is the one a client builds its scope request from — the MCP SDK
 * joins `scopes_supported` verbatim and prefers it to the client's own
 * configured scope — so publishing every tier there is the mistake the security
 * document names by hand: every fresh connection would ask for write access it
 * has no use for. It advertises the default grant plus `offline_access`, which
 * a long-lived client cannot work without because Better Auth issues a refresh
 * token only when it was asked for.
 *
 * The two wider tiers stay accepted at `/authorize`, stay named on the consent
 * screen, and stay reachable from the `insufficient_scope` challenge an
 * under-scoped tool call answers with, which is what makes this narrowing a
 * smaller first ask rather than a ceiling.
 */
const authorizationServerScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "ledger:read",
  "ledger:stage",
  "ledger:write",
];
const resourceScopes = ["openid", "profile", "email", "offline_access", "ledger:read"];
const discoveryHeaders = (c: Context) => {
  // Discovery is read by clients that are not browsers and have no origin to
  // speak of, which is why the library marks it public. Re-wrapping the body
  // below would otherwise drop that.
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=300");
};

const authorizationServerMetadata = async (c: Context) => {
  discoveryHeaders(c);
  const response = await oAuthDiscoveryMetadata(getAuth())(c.req.raw);
  const metadata = (await response.json()) as Record<string, unknown>;
  return c.json({ ...metadata, scopes_supported: authorizationServerScopes });
};

const protectedResourceMetadata = async (c: Context) => {
  discoveryHeaders(c);
  const response = await oAuthProtectedResourceMetadata(getAuth())(c.req.raw);
  const metadata = (await response.json()) as Record<string, unknown>;
  return c.json({ ...metadata, scopes_supported: resourceScopes });
};

app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);

// RFC 9728 puts the resource's own path after the well-known segment, so a
// client told the resource is <origin>/mcp looks here first. It is the same
// document; answering only at the root left the single-page app returning its
// HTML with a 200, which a client cannot parse and will not retry.
app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
app.get("/.well-known/oauth-authorization-server/mcp", authorizationServerMetadata);
// And with the slash, for the same reason the transport accepts one.
app.get("/.well-known/oauth-protected-resource/mcp/", protectedResourceMetadata);
app.get("/.well-known/oauth-authorization-server/mcp/", authorizationServerMetadata);

// This deployment issues id tokens and answers userinfo, so a client that
// discovers the OpenID way rather than the OAuth way is asking a fair question
// and gets the same answer.
app.get("/.well-known/openid-configuration", authorizationServerMetadata);
app.get("/.well-known/openid-configuration/mcp", authorizationServerMetadata);
app.get("/.well-known/openid-configuration/mcp/", authorizationServerMetadata);

// Anything else under /.well-known belongs to a protocol nobody here speaks.
// Say so, rather than letting the catch-all hand back an HTML page that a
// client will try to parse as JSON.
app.all("/.well-known/*", (c) =>
  c.json({ error: "not_found", error_description: "No metadata is published here" }, 404),
);

const authenticatedMcpBodyLimit = boundRequestBody({
  maxBytes: (context) => requestBodyLimit(context.req.path),
});
/**
 * The endpoint answers on `/mcp` and on `/mcp/`.
 *
 * They are different paths to a router, and only the first was registered, so a
 * client configured with the trailing slash got a bare 404 from the catch-all
 * after completing OAuth perfectly well. The grant appeared in Settings, the
 * token was valid, and every call failed on a route that did not exist. A
 * trailing slash is the most ordinary thing in the world to paste, so it is
 * accepted rather than corrected.
 *
 * `/mcp` stays the canonical form: it is what discovery advertises and what the
 * audience on every token is bound to, neither of which depends on the path a
 * request happened to arrive on.
 */
app.all("/mcp/", (c) => mcpTransport(c));
app.all("/mcp", (c) => mcpTransport(c));

async function mcpTransport(c: Context<{ Variables: Variables }>) {
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
      handled = await handleMcpRequest(c.req.raw, identity.actor, identity.scopes);
    });
    return limited ?? handled ?? new Response(null, { status: 500 });
  });
  // Every credential reaching the handler below is one this rewrote, so the
  // audience-bound JWT is the only thing that gets in.
  //
  // Testing for a "Bearer " prefix and otherwise passing the header through
  // left a way round it: the library reads the token by stripping that exact
  // prefix, so a header carrying the bare opaque token and no scheme at all
  // arrived unchanged and was accepted. That is precisely the token the JWT
  // wrapper exists to stop being used directly. Anything that is not a JWT
  // this deployment signed for this resource is now replaced with a value that
  // cannot match, whatever shape it arrived in.
  const authorization = c.req.raw.headers.get("authorization");
  let authenticatedRequest = c.req.raw;
  if (authorization !== null) {
    const scheme = /^bearer +/i.exec(authorization);
    const presented = scheme ? authorization.slice(scheme[0].length) : null;
    const opaqueToken = presented ? await unwrapMcpAccessToken(presented) : null;
    const headers = new Headers(c.req.raw.headers);
    headers.set("authorization", `Bearer ${opaqueToken ?? "invalid-audience-bound-jwt"}`);
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
}

app.use(
  "/api/v1/*",
  protectBrowserMutation({
    allowedOrigin: getConfig().baseUrl,
    allowedContentTypes: new Set(["application/json"]),
    requireContentType: true,
  }),
);
app.use("/api/v1/*", async (c, next) => {
  // Everything below this line is somebody's ledger, and it is reached with a
  // cookie rather than an Authorization header, so nothing stops a shared cache
  // or a browser's back-forward store holding on to it by default. Said once
  // here rather than remembered on each of thirty routes.
  c.header("Cache-Control", "no-store");
  const identity = await getWebIdentity(c.req.raw.headers);
  if (!identity) {
    await rejectRequestBody(c);
    return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } }, 401);
  }
  c.set("authUser", identity.user);
  c.set("sessionCreatedAt", new Date(identity.session.createdAt));
  c.set("actor", { userId: identity.user.id, source: "web" });
  await next();
});
app.use(
  "/api/v1/*",
  boundRequestBody({ maxBytes: (context) => requestBodyLimit(context.req.path) }),
);
const body = async (c: Context<{ Variables: Variables }>) => {
  try {
    return await c.req.json<unknown>();
  } catch {
    // Every mutation reads its body through here, so a truncated or absent one
    // threw past all of them and arrived as a 500 with a stack trace in the log
    // — for what is only ever a malformed request. The same reasoning as
    // `pathId` below.
    throw new AppError("VALIDATION_ERROR", "Request body must be JSON", 400);
  }
};

/**
 * The id out of the path, checked before it reaches a query.
 *
 * Without this an id that is not a uuid travels all the way to PostgreSQL and
 * comes back as a failed cast, which the caller sees as an unexplained 500 and
 * the operator as a stack trace in the log, for what was only ever a mistyped
 * URL. The same reasoning as the date parse in listAccounts.
 */
const pathId = (c: Context<{ Variables: Variables }>, name = "id") =>
  uuidPathSchema.parse(c.req.param(name));
const pathReport = (c: Context<{ Variables: Variables }>) =>
  reportNameSchema.parse(c.req.param("report"));
const query = (c: Context<{ Variables: Variables }>) => c.req.query();
/**
 * The query string with the named parameters read as booleans.
 *
 * A query string carries "true", never true, and a Zod boolean will not read
 * one as the other, so a flag declared as a boolean for MCP - where the input
 * really is JSON - refuses every value the browser can send. The reports route
 * converts one flag by hand for exactly this reason; this is that conversion
 * with a name, so the next route to grow a flag does not have to rediscover it.
 */
/**
 * `?includeArchived=` read through the shared schema rather than by hand.
 *
 * Five routes compared the raw string with `"true"`, so anything else — `yes`,
 * `1`, `TRUE` — quietly meant false. The schema refuses those instead, which
 * turns a silently wrong answer into one the caller can correct.
 */
const includeArchivedFlag = (c: Context) =>
  queryBooleanSchema.parse(c.req.query("includeArchived") ?? false);

const queryWithFlags = (c: Context<{ Variables: Variables }>, ...flags: string[]) => {
  const values: Record<string, unknown> = { ...c.req.query() };
  for (const flag of flags) {
    if (values[flag] !== undefined) values[flag] = values[flag] === "true";
  }
  return values;
};

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
  // A password added here is a second, permanent way into the account, and an
  // account that has only ever signed in with Google has no existing password
  // to confirm against. A recently created session is the re-authentication
  // that is available to every account: whoever is asking has just proved they
  // hold the credential the account already has, rather than only a cookie
  // that has been sitting in a browser since last month.
  if (Date.now() - c.get("sessionCreatedAt").getTime() > FRESH_SESSION_MS) {
    throw new AppError(
      "REAUTHENTICATION_REQUIRED",
      "Sign in again before adding a password, so that a session on its own cannot add one.",
      403,
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

// What deleting this account would destroy, and then destroying it. Both are
// reachable only with a session cookie, because that is what every /api/v1 route
// resolves: an MCP token cannot get here, and an agent must never be able to
// delete the person whose ledger it was given a corner of.
app.get("/api/v1/me/data", async (c) => c.json(await summarizeOwnData(c.get("actor"))));

app.delete("/api/v1/me", async (c) =>
  c.json(await deleteOwnAccount(c.get("actor"), await body(c))),
);

// Taking back an agent's access. The same thing is reachable over MCP, where
// listing needs ledger:read and revoking needs ledger:write, so a stolen
// read-only token cannot spend its last minutes locking out the agents it was
// stolen from. Every revocation is written to the audit log either way.
app.get("/api/v1/connected-apps", async (c) => c.json(await listConnectedApps(c.get("actor"))));

app.delete("/api/v1/connected-apps/:clientId", async (c) =>
  c.json(await revokeConnectedApp(c.get("actor"), c.req.param("clientId"))),
);

app.get("/api/v1/accounts", async (c) =>
  c.json(await listAccounts(c.get("actor"), c.req.query("end"), includeArchivedFlag(c))),
);
app.get("/api/v1/accounts/:id/balances", async (c) =>
  c.json(
    await getAccountBalances(
      c.get("actor"),
      pathId(c),
      dateRangeSchema.parse({
        start: c.req.query("start"),
        end: c.req.query("end"),
      }),
    ),
  ),
);
app.get("/api/v1/accounts/:id", async (c) => c.json(await getAccount(c.get("actor"), pathId(c))));
app.post("/api/v1/accounts", async (c) =>
  c.json(await createAccount(c.get("actor"), await body(c)), 201),
);
app.put("/api/v1/accounts/:id", async (c) =>
  c.json(await updateAccount(c.get("actor"), pathId(c), await body(c))),
);
app.post("/api/v1/accounts/:id/archived", async (c) => {
  const parsed = versionedMutationSchema.extend({ archived: z.boolean() }).parse(await body(c));
  return c.json(
    await setAccountArchived(c.get("actor"), pathId(c), parsed.expectedVersion, parsed.archived),
  );
});
app.delete("/api/v1/accounts/:id", async (c) => {
  const parsed = versionedMutationSchema.parse(await body(c));
  return c.json(await deleteAccount(c.get("actor"), pathId(c), parsed.expectedVersion));
});

app.get("/api/v1/categories", async (c) =>
  c.json(await listCategories(c.get("actor"), includeArchivedFlag(c))),
);
app.get("/api/v1/categories/duplicates", async (c) =>
  c.json(await listDuplicateCategories(c.get("actor"))),
);
app.get("/api/v1/categories/summaries", async (c) =>
  c.json(await listCategorySummaries(c.get("actor"), includeArchivedFlag(c))),
);
app.get("/api/v1/categories/:id", async (c) =>
  c.json(await getCategory(c.get("actor"), pathId(c))),
);
app.get("/api/v1/recurrences", async (c) => c.json(await listRecurrences(c.get("actor"))));
app.get("/api/v1/recurrences/:id", async (c) =>
  c.json(await getRecurrence(c.get("actor"), pathId(c))),
);
app.post("/api/v1/recurrences", async (c) =>
  c.json(await createRecurrence(c.get("actor"), await body(c)), 201),
);
app.put("/api/v1/recurrences/:id", async (c) =>
  c.json(await updateRecurrence(c.get("actor"), pathId(c), await body(c))),
);
app.delete("/api/v1/recurrences/:id", async (c) => {
  const parsed = versionedMutationSchema.parse(await body(c));
  return c.json(await deleteRecurrence(c.get("actor"), pathId(c), parsed.expectedVersion));
});
app.get("/api/v1/budget-plans", async (c) => c.json(await listBudgetPlans(c.get("actor"))));
app.get("/api/v1/budget-plans/:id", async (c) =>
  c.json(await getBudgetPlan(c.get("actor"), pathId(c))),
);
app.post("/api/v1/budget-plans", async (c) =>
  c.json(await createBudgetPlan(c.get("actor"), await body(c)), 201),
);
app.put("/api/v1/budget-plans/:id", async (c) =>
  c.json(await updateBudgetPlan(c.get("actor"), pathId(c), await body(c))),
);
app.delete("/api/v1/budget-plans/:id", async (c) => {
  const parsed = versionedMutationSchema.parse(await body(c));
  return c.json(await deleteBudgetPlan(c.get("actor"), pathId(c), parsed.expectedVersion));
});
app.get("/api/v1/budget-entries", async (c) => c.json(await listBudgetEntries(c.get("actor"))));
app.put("/api/v1/budget-entries", async (c) =>
  c.json(await setBudgetEntry(c.get("actor"), await body(c))),
);
app.delete("/api/v1/budget-entries/:id", async (c) => {
  const parsed = versionedMutationSchema.parse(await body(c));
  return c.json(await deleteBudgetEntry(c.get("actor"), pathId(c), parsed.expectedVersion));
});
app.get("/api/v1/budget-report", async (c) =>
  c.json(
    await getBudgetReport(
      c.get("actor"),
      queryWithFlags(c, "includeArchived", "includeUnbudgeted"),
    ),
  ),
);
app.get("/api/v1/transaction-templates", async (c) =>
  c.json(await listTransactionTemplates(c.get("actor"))),
);
app.get("/api/v1/transaction-templates/:id", async (c) =>
  c.json(await getTransactionTemplate(c.get("actor"), pathId(c))),
);
app.post("/api/v1/transaction-templates", async (c) =>
  c.json(await createTransactionTemplate(c.get("actor"), await body(c)), 201),
);
app.put("/api/v1/transaction-templates/:id", async (c) =>
  c.json(await updateTransactionTemplate(c.get("actor"), pathId(c), await body(c))),
);
app.post("/api/v1/transaction-templates/bulk-edit", async (c) =>
  c.json(await bulkEditTransactionTemplates(c.get("actor"), await body(c))),
);
app.post("/api/v1/transaction-templates/bulk-delete", async (c) =>
  c.json(await bulkDeleteTransactionTemplates(c.get("actor"), await body(c))),
);
app.delete("/api/v1/transaction-templates/:id", async (c) => {
  const parsed = versionedMutationSchema.parse(await body(c));
  return c.json(await deleteTransactionTemplate(c.get("actor"), pathId(c), parsed.expectedVersion));
});
app.post("/api/v1/categories/merge", async (c) =>
  c.json(await mergeCategories(c.get("actor"), categoryMergeSchema.parse(await body(c)))),
);
app.get("/api/v1/payees/suggestions", async (c) =>
  c.json(await listPayeeSuggestions(c.get("actor"), c.req.query("search"))),
);
app.get("/api/v1/payees/duplicates", async (c) =>
  c.json(await listDuplicatePayees(c.get("actor"))),
);
app.post("/api/v1/payees/merge", async (c) =>
  c.json(await mergePayees(c.get("actor"), payeeMergeSchema.parse(await body(c)))),
);
app.get("/api/v1/payees", async (c) =>
  c.json(await listPayees(c.get("actor"), { search: c.req.query("search") })),
);
app.post("/api/v1/categories", async (c) =>
  c.json(await createCategory(c.get("actor"), await body(c)), 201),
);
app.put("/api/v1/categories/:id", async (c) =>
  c.json(await updateCategory(c.get("actor"), pathId(c), await body(c))),
);
app.post("/api/v1/categories/:id/archived", async (c) => {
  const parsed = versionedMutationSchema.extend({ archived: z.boolean() }).parse(await body(c));
  return c.json(
    await setCategoryArchived(c.get("actor"), pathId(c), parsed.expectedVersion, parsed.archived),
  );
});
app.delete("/api/v1/categories/:id", async (c) => {
  const parsed = versionedMutationSchema.parse(await body(c));
  return c.json(await deleteCategory(c.get("actor"), pathId(c), parsed.expectedVersion));
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
    await bulkEditTransactions(c.get("actor"), bulkTransactionEditSchema.parse(await body(c))),
  ),
);
app.post("/api/v1/transactions/bulk-delete", async (c) =>
  c.json(
    await bulkDeleteTransactions(c.get("actor"), bulkTransactionDeleteSchema.parse(await body(c))),
  ),
);
app.get("/api/v1/transactions/:id", async (c) =>
  c.json(await getTransaction(c.get("actor"), pathId(c))),
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
  c.json(await updateTransaction(c.get("actor"), pathId(c), await body(c))),
);
app.post("/api/v1/transactions/:id/deleted", async (c) => {
  const parsed = transactionDeletedMutationSchema.parse(await body(c));
  return c.json(
    await setTransactionDeleted(
      c.get("actor"),
      pathId(c),
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
  c.json(await getStage(c.get("actor"), pathId(c))),
);
app.post("/api/v1/staged-transactions", async (c) =>
  c.json(await createStage(c.get("actor"), await body(c)), 201),
);
app.put("/api/v1/staged-transactions/:id", async (c) =>
  c.json(await updateStage(c.get("actor"), pathId(c), await body(c))),
);
// The same two shapes the committed routes take: resolve a filter selection
// into a count and a fingerprint first, then send that back with the edit.
app.post("/api/v1/staged-transactions/bulk-selection", async (c) =>
  c.json(await previewBulkStageSelection(c.get("actor"), await body(c))),
);

app.post("/api/v1/staged-transactions/bulk-edit", async (c) =>
  c.json(await bulkEditStages(c.get("actor"), await body(c))),
);

app.post("/api/v1/staged-transactions/bulk-delete", async (c) =>
  c.json(await deleteStages(c.get("actor"), bulkDeleteStageSchema.parse(await body(c)))),
);
app.post("/api/v1/staged-transactions/commit", async (c) =>
  c.json(await commitStages(c.get("actor"), commitStageSchema.parse(await body(c)))),
);

app.post("/api/v1/csv/preview", async (c) => {
  const parsed = z.object({ csv: z.string().min(1) }).parse(await body(c));
  return c.json(getCsvPreview(parsed.csv));
});
app.post("/api/v1/csv/stage", async (c) => c.json(await stageCsv(c.get("actor"), await body(c))));
app.get("/api/v1/import-batches", async (c) =>
  c.json(await listActiveImportBatches(c.get("actor"), query(c))),
);
app.get("/api/v1/csv/export", async (c) => {
  const actor = c.get("actor");
  const result = await exportTransactionsCsv(actor, query(c));
  c.header("Content-Type", CSV_MEDIA_TYPE);
  // Dated in the person's own timezone, not the server's. `common.md` puts
  // every "today" in this product through `todayIn`, and this was the one that
  // went through the server clock instead: somebody at UTC+13 downloading at
  // 09:00 got yesterday's date on the file, which is the one thing a dated
  // filename exists to get right.
  const { timezone } = await getPreferences(actor);
  c.header("Content-Disposition", `attachment; filename="transactions-${todayIn(timezone)}.csv"`);
  return c.body(result.csv);
});

app.get("/api/v1/summary", async (c) =>
  c.json(await getSummary(c.get("actor"), query(c), includeArchivedFlag(c))),
);
app.get("/api/v1/staged-transactions/:id/duplicate", async (c) =>
  c.json(await getStagedDuplicateReview(c.get("actor"), pathId(c))),
);
app.get("/api/v1/reports/:report", async (c) =>
  c.json(
    await getReport(
      c.get("actor"),
      { ...c.req.query(), report: pathReport(c) },
      includeArchivedFlag(c),
    ),
  ),
);
app.get("/api/v1/accounts/:id/register", async (c) =>
  c.json(
    await getAccountRegister(c.get("actor"), pathId(c), {
      start: c.req.query("start"),
      end: c.req.query("end"),
    }),
  ),
);
app.get("/api/v1/audit-events", async (c) =>
  c.json(
    await listAuditEvents(c.get("actor"), {
      cursor: c.req.query("cursor"),
      limit: Number(c.req.query("limit") ?? 50),
    }),
  ),
);

// Below every route this prefix owns and above the single-page fallback. A
// mistyped path, and any path with a trailing slash, otherwise reached the shell
// and came back as 200 text/html — an API client parsing that gets a syntax
// error rather than the 404 it asked for, and a person debugging a URL sees a
// working page. The same path with a non-GET method already answered 404, so the
// prefix disagreed with itself.
app.all("/api/v1/*", (c) =>
  c.json({ error: { code: "NOT_FOUND", message: "No such endpoint" } }, 404),
);

// Only when there is a bundle to serve. The decomposed deployment builds an
// API image with no client in it and puts nginx in front, and serveStatic warns
// on every request about a root it cannot find - which is right when the bundle
// should be there and pure noise when it deliberately is not.
if (getConfig().isProduction && existsSync("./dist/client")) {
  // Set after the file is served: the static handler answers with a response of
  // its own, so a header put on the context beforehand does not survive.
  //
  // Vite puts a content hash in every asset filename, so an asset at a given
  // name never changes and can be kept indefinitely. The shell is the opposite:
  // its name never changes and its contents do, and it is what names the hashed
  // assets. Served with no directive at all, a browser is free to guess how
  // long it stays fresh, and a guess that outlives an upgrade leaves somebody
  // holding a page that asks for assets which are no longer there.
  app.use("/assets/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  });
  app.use("/assets/*", serveStatic({ root: "./dist/client" }));
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) {
      c.res.headers.set("Cache-Control", "no-cache");
    }
  });
  // Anything the build actually produced at the root of the client bundle:
  // the icon, and whatever is added beside it later. Without this the only
  // static route was /assets/*, so a request for /favicon.svg fell through to
  // the catch-all below and was answered with index.html under a
  // text/html content type. The file was in the image the whole time; nothing
  // routed to it, and a browser handed HTML for an image shows no icon.
  //
  // serveStatic calls next() when there is no such file, so a real page path
  // still reaches the single-page shell underneath.
  app.use("*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
}

export default app;
