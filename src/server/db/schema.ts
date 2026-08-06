import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  accountTypes,
  systemAccountKinds,
  actorSources,
  categoryKinds,
  transactionTypes,
} from "../../shared/domain.js";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

// Better Auth core tables. Property names are intentionally the model names
// expected by the Better Auth Drizzle adapter.
export const user = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  ...timestamps,
});

export const session = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [index("auth_session_user_idx").on(table.userId)],
);

export const account = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    index("auth_account_user_idx").on(table.userId),
    unique("auth_account_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("auth_verification_identifier_idx").on(table.identifier)],
);

export const oauthApplication = pgTable(
  "auth_oauth_application",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    icon: text("icon"),
    metadata: text("metadata"),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    redirectUrls: text("redirect_urls").notNull(),
    type: text("type").notNull(),
    disabled: boolean("disabled").default(false),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [index("oauth_application_user_idx").on(table.userId)],
);

export const oauthAccessToken = pgTable(
  "auth_oauth_access_token",
  {
    id: text("id").primaryKey(),
    accessToken: text("access_token").notNull().unique(),
    refreshToken: text("refresh_token").notNull().unique(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }).notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    ...timestamps,
  },
  (table) => [
    index("oauth_access_token_client_idx").on(table.clientId),
    index("oauth_access_token_user_idx").on(table.userId),
  ],
);

export const oauthConsent = pgTable(
  "auth_oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    consentGiven: boolean("consent_given").default(false),
    ...timestamps,
  },
  (table) => [
    index("oauth_consent_client_idx").on(table.clientId),
    index("oauth_consent_user_idx").on(table.userId),
  ],
);

export const mcpSigningKeys = pgTable("auth_mcp_signing_key", {
  id: text("id").primaryKey(),
  algorithm: text("algorithm").default("RS256").notNull(),
  publicJwk: jsonb("public_jwk").notNull(),
  privateJwk: jsonb("private_jwk").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

export const accountTypeEnum = pgEnum("ledger_account_type", accountTypes);
export const systemAccountKindEnum = pgEnum(
  "system_account_kind",
  systemAccountKinds,
);
export const categoryKindEnum = pgEnum("category_kind", categoryKinds);
export const transactionTypeEnum = pgEnum("transaction_type", transactionTypes);
export const stagedStatusEnum = pgEnum("staged_status", ["staged", "committed", "deleted"]);
export const actorSourceEnum = pgEnum("actor_source", actorSources);

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  timezone: text("timezone").default("UTC").notNull(),
  defaultCurrency: text("default_currency").default("USD").notNull(),
  ...timestamps,
}, (table) => [
  check(
    "user_preferences_default_currency_check",
    sql`${table.defaultCurrency} ~ '^[A-Z]{2,12}$'`,
  ),
]);

export const ledgerAccounts = pgTable(
  "ledger_account",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: accountTypeEnum("type").notNull(),
    // Set only on the server-owned counter-accounts that balance deposits,
    // withdrawals, and cross-currency transfers. Null means a real account.
    systemKind: systemAccountKindEnum("system_kind"),
    currency: text("currency").notNull(),
    institution: text("institution"),
    notes: text("notes"),
    openingDate: date("opening_date").notNull(),
    openingBalance: numeric("opening_balance", { precision: 44, scale: 18 }).default("0").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    index("ledger_account_user_idx").on(table.userId),
    // Names are unique among the accounts a person keeps. The server's own
    // counter-accounts are excluded, because naming an account "Expenses (USD)"
    // would otherwise collide with one and leave the ledger unable to open it.
    uniqueIndex("ledger_account_user_name_unique")
      .on(table.userId, table.name)
      .where(sql`${table.systemKind} is null`),
    unique("ledger_account_user_id_id_unique").on(table.userId, table.id),
    // Lets postings and transactions carry a foreign key that includes the
    // currency, so no row can name an amount in a currency its account does
    // not hold.
    unique("ledger_account_user_id_currency_unique").on(
      table.userId,
      table.id,
      table.currency,
    ),
    uniqueIndex("ledger_account_system_kind_unique")
      .on(table.userId, table.systemKind, table.currency)
      .where(sql`${table.systemKind} is not null`),
    check(
      "ledger_account_currency_check",
      sql`${table.currency} ~ '^[A-Z]{2,12}$'`,
    ),
    check("ledger_account_version_check", sql`${table.version} >= 1`),
  ],
);

export const categories = pgTable(
  "category",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: categoryKindEnum("kind").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    index("category_user_idx").on(table.userId),
    unique("category_user_name_unique").on(table.userId, table.name),
    unique("category_user_id_id_unique").on(table.userId, table.id),
    check("category_version_check", sql`${table.version} >= 1`),
  ],
);

export const importBatches = pgTable(
  "import_batch",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    delimiter: text("delimiter").notNull(),
    mapping: jsonb("mapping").notNull(),
    rowCount: integer("row_count").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("import_batch_user_id_id_unique").on(table.userId, table.id),
    index("import_batch_user_created_idx").on(
      table.userId,
      table.createdAt,
      table.id,
    ),
    check("import_batch_row_count_check", sql`${table.rowCount} >= 0`),
  ],
);

export const transactions = pgTable(
  "ledger_transaction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: transactionTypeEnum("type").notNull(),
    date: date("date").notNull(),
    description: text("description"),
    payee: text("payee").notNull(),
    categoryId: uuid("category_id"),
    // Which template this came from, if any. Provenance rather than current
    // state, so it carries no foreign key: deleting a template is allowed and
    // leaves the transactions made from it untouched, which a restricting key
    // would forbid and a cascading one would turn into data loss.
    templateId: uuid("template_id"),
    notes: text("notes"),
    externalId: text("external_id"),
    sourceAccountId: uuid("source_account_id"),
    destinationAccountId: uuid("destination_account_id"),
    sourceAmount: numeric("source_amount", { precision: 44, scale: 18 }),
    destinationAmount: numeric("destination_amount", { precision: 44, scale: 18 }),
    sourceCurrency: text("source_currency"),
    destinationCurrency: text("destination_currency"),
    effectiveRate: numeric("effective_rate", { precision: 44, scale: 18 }),
    version: integer("version").default(1).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("ledger_transaction_user_id_id_unique").on(table.userId, table.id),
    foreignKey({
      columns: [table.userId, table.categoryId],
      foreignColumns: [categories.userId, categories.id],
      name: "ledger_transaction_category_owner_fk",
    }),
    foreignKey({
      columns: [table.userId, table.sourceAccountId],
      foreignColumns: [ledgerAccounts.userId, ledgerAccounts.id],
      name: "ledger_transaction_source_account_owner_fk",
    }),
    foreignKey({
      columns: [table.userId, table.destinationAccountId],
      foreignColumns: [ledgerAccounts.userId, ledgerAccounts.id],
      name: "ledger_transaction_destination_account_owner_fk",
    }),
    index("transaction_user_date_idx").on(table.userId, table.date, table.id),
    index("transaction_user_source_account_idx").on(
      table.userId,
      table.sourceAccountId,
    ),
    index("transaction_user_destination_account_idx").on(
      table.userId,
      table.destinationAccountId,
    ),
    index("transaction_user_category_idx").on(table.userId, table.categoryId),
    index("transaction_user_template_idx").on(table.userId, table.templateId),
    index("transaction_external_id_idx").on(table.userId, table.externalId),
    check("ledger_transaction_version_check", sql`${table.version} >= 1`),
    check(
      "ledger_transaction_payee_check",
      sql`char_length(trim(${table.payee})) between 1 and 160`,
    ),
    check(
      "ledger_transaction_description_check",
      sql`${table.description} is null or char_length(${table.description}) <= 240`,
    ),
    check(
      "ledger_transaction_shape_check",
      sql`
        (
          ${table.type} = 'deposit'
          and ${table.sourceAccountId} is null
          and ${table.sourceAmount} is null
          and ${table.sourceCurrency} is null
          and ${table.destinationAccountId} is not null
          and ${table.destinationAmount} is not null
          and ${table.destinationAmount} > 0
          and ${table.destinationCurrency} is not null
          and ${table.destinationCurrency} ~ '^[A-Z]{2,12}$'
          and ${table.effectiveRate} is null
        )
        or
        (
          ${table.type} = 'withdrawal'
          and ${table.sourceAccountId} is not null
          and ${table.sourceAmount} is not null
          and ${table.sourceAmount} > 0
          and ${table.sourceCurrency} is not null
          and ${table.sourceCurrency} ~ '^[A-Z]{2,12}$'
          and ${table.destinationAccountId} is null
          and ${table.destinationAmount} is null
          and ${table.destinationCurrency} is null
          and ${table.effectiveRate} is null
        )
        or
        (
          ${table.type} = 'transfer'
          and ${table.sourceAccountId} is not null
          and ${table.destinationAccountId} is not null
          and ${table.sourceAccountId} <> ${table.destinationAccountId}
          and ${table.sourceAmount} is not null
          and ${table.sourceAmount} > 0
          and ${table.destinationAmount} is not null
          and ${table.destinationAmount} > 0
          and ${table.sourceCurrency} is not null
          and ${table.sourceCurrency} ~ '^[A-Z]{2,12}$'
          and ${table.destinationCurrency} is not null
          and ${table.destinationCurrency} ~ '^[A-Z]{2,12}$'
          and ${table.effectiveRate} is not null
          and ${table.effectiveRate} > 0
          and (
            (
              ${table.sourceCurrency} = ${table.destinationCurrency}
              and ${table.sourceAmount} = ${table.destinationAmount}
              and ${table.effectiveRate} = 1
            )
            or ${table.sourceCurrency} <> ${table.destinationCurrency}
          )
        )
      `,
    ),
  ],
);

export const postings = pgTable(
  "posting",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // A posting records a transaction, where an account started, or where one
    // was closed. Exactly one of these is set, which the origin check below
    // enforces.
    transactionId: uuid("transaction_id"),
    openingAccountId: uuid("opening_account_id"),
    // Archiving an account posts its remaining balance out to equity so the
    // account ends at zero. Both halves name the account being closed, the same
    // way an opening pair does, so unarchiving can find and undo them.
    closingAccountId: uuid("closing_account_id"),
    accountId: uuid("account_id")
      .notNull(),
    // A journal line carries its own date. Money moved on the day it moved, so
    // balances as of a date read this table alone rather than reaching through
    // to a transaction, and changing when something happened moves the posting.
    //
    // A category is deliberately NOT here. It is a label on the transaction, and
    // keeping one copy of it means recategorising cannot leave the books and the
    // reports disagreeing.
    date: date("date").notNull(),
    amount: numeric("amount", { precision: 44, scale: 18 }).notNull(),
    currency: text("currency").notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.transactionId],
      foreignColumns: [transactions.userId, transactions.id],
      name: "posting_transaction_owner_fk",
    }).onDelete("cascade"),
    // Ties the posting to its account and pins its currency to that account's
    // in one constraint, so a balance can sum without grouping by currency.
    foreignKey({
      columns: [table.userId, table.accountId, table.currency],
      foreignColumns: [
        ledgerAccounts.userId,
        ledgerAccounts.id,
        ledgerAccounts.currency,
      ],
      name: "posting_account_currency_fk",
    }),
    // Both halves of an opening pair name the account they open, so moving an
    // opening date moves the equity side with it.
    foreignKey({
      columns: [table.userId, table.openingAccountId],
      foreignColumns: [ledgerAccounts.userId, ledgerAccounts.id],
      name: "posting_opening_account_owner_fk",
    }),
    index("posting_opening_account_idx").on(
      table.userId,
      table.openingAccountId,
    ),
    foreignKey({
      columns: [table.userId, table.closingAccountId],
      foreignColumns: [ledgerAccounts.userId, ledgerAccounts.id],
      name: "posting_closing_account_owner_fk",
    }),
    index("posting_closing_account_idx").on(
      table.userId,
      table.closingAccountId,
    ),
    // Serves every balance-as-of query: one account, dates up to a bound.
    index("posting_user_account_date_idx").on(
      table.userId,
      table.accountId,
      table.date,
    ),
    // Serves the dashboard, which sums a date range across counter-accounts.
    index("posting_user_date_idx").on(table.userId, table.date),
    index("posting_transaction_idx").on(table.transactionId),
    check(
      "posting_origin_check",
      sql`(case when ${table.transactionId} is null then 0 else 1 end)
        + (case when ${table.openingAccountId} is null then 0 else 1 end)
        + (case when ${table.closingAccountId} is null then 0 else 1 end) = 1`,
    ),
    check("posting_amount_check", sql`${table.amount} <> 0`),
    check("posting_currency_check", sql`${table.currency} ~ '^[A-Z]{2,12}$'`),
  ],
);

export const stagedTransactions = pgTable(
  "staged_transaction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: stagedStatusEnum("status").default("staged").notNull(),
    draft: jsonb("draft").notNull(),
    rawData: jsonb("raw_data"),
    validationIssues: jsonb("validation_issues").default(sql`'[]'::jsonb`).notNull(),
    duplicateOfId: uuid("duplicate_of_id"),
    // What this row would collide with. `duplicateOfId` names a committed
    // transaction it repeats; `duplicateKey` is the same fingerprint the commit
    // check uses, stored so two staged rows that repeat EACH OTHER can be found
    // before the commit refuses them. Without it that kind of duplicate exists
    // only for the instant a commit is attempted.
    duplicateKey: text("duplicate_key"),
    importBatchId: uuid("import_batch_id"),
    committedTransactionId: uuid("committed_transaction_id"),
    version: integer("version").default(1).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.duplicateOfId],
      foreignColumns: [transactions.userId, transactions.id],
      name: "staged_transaction_duplicate_owner_fk",
    }),
    foreignKey({
      columns: [table.userId, table.importBatchId],
      foreignColumns: [importBatches.userId, importBatches.id],
      name: "staged_transaction_import_batch_owner_fk",
    }),
    foreignKey({
      columns: [table.userId, table.committedTransactionId],
      foreignColumns: [transactions.userId, transactions.id],
      name: "staged_transaction_committed_owner_fk",
    }),
    index("staged_user_status_created_idx").on(
      table.userId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("staged_user_import_batch_idx").on(
      table.userId,
      table.importBatchId,
    ),
    // Finding the rows that share a fingerprint is a grouped lookup.
    index("staged_user_duplicate_key_idx").on(table.userId, table.duplicateKey),
    check("staged_transaction_version_check", sql`${table.version} >= 1`),
    check(
      "staged_transaction_status_check",
      sql`
        (
          ${table.status} = 'staged'
          and ${table.deletedAt} is null
          and ${table.committedTransactionId} is null
        )
        or
        (
          ${table.status} = 'deleted'
          and ${table.deletedAt} is not null
          and ${table.committedTransactionId} is null
        )
        or
        (
          ${table.status} = 'committed'
          and ${table.deletedAt} is null
          and ${table.committedTransactionId} is not null
        )
      `,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_record",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.operation, table.key] }),
    check(
      "idempotency_record_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    actorSource: actorSourceEnum("actor_source").notNull(),
    clientId: text("client_id"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    operation: text("operation").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_user_created_idx").on(
      table.userId,
      table.createdAt,
      table.id,
    ),
    index("audit_user_entity_idx").on(
      table.userId,
      table.entityType,
      table.entityId,
    ),
  ],
);

/**
 * A saved starting point for the transaction form. It records nothing that has
 * happened, posts nothing, and touches no balance.
 *
 * The account and category it names live inside the JSON with no foreign key,
 * deliberately. A key would cascade, so tidying up an old account would take the
 * user's saved templates with it, which is a loss they never asked for. What
 * they hold instead is an id that is looked up when the template is used and
 * quietly dropped if it no longer resolves.
 */
export const transactionTemplates = pgTable(
  "transaction_template",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // A partial draft: a field the user left blank is absent rather than empty,
    // so "not saved" and "saved as nothing" cannot be confused at the point of
    // use.
    draft: jsonb("draft").notNull(),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    index("transaction_template_user_idx").on(table.userId),
    unique("transaction_template_user_name_unique").on(table.userId, table.name),
    check(
      "transaction_template_name_check",
      sql`char_length(btrim(${table.name})) between 1 and 120`,
    ),
    check("transaction_template_version_check", sql`${table.version} >= 1`),
  ],
);

export type CategoryRow = typeof categories.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type StagedTransactionRow = typeof stagedTransactions.$inferSelect;
