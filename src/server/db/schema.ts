import {
  bigint,
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
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  accountTypes,
  budgetAmountRules,
  budgetGroupPolicies,
  budgetPeriodUnits,
  systemAccountKinds,
  actorSources,
  categoryKinds,
  MAX_RECURRENCE_INTERVAL,
  MAX_TRANSACTION_LEGS,
  recurrenceFrequencies,
  recurrenceMonthPolicies,
  recurrenceWeekendPolicies,
  themes,
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
    unique("auth_account_provider_account_unique").on(table.providerId, table.accountId),
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

/**
 * The one-time code that claims an unclaimed deployment, when the operator did
 * not choose one.
 *
 * A row rather than a module variable because the web tier can run more than one
 * replica: a code generated per process is printed by the pod that generated it
 * and rejected by every other, so the claim documented in the chart's own notes
 * failed about half the time. One row, so it is the same code whichever pod
 * answers.
 */
export const ownerSetupTokens = pgTable("auth_owner_setup_token", {
  id: text("id").primaryKey(),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Exported although nothing outside this file names them: drizzle-kit discovers
// enums by enumerating this module's exports, and un-exporting one makes it
// generate a `DROP TYPE` for a type every column of that kind still uses.
export const accountTypeEnum = pgEnum("ledger_account_type", accountTypes);
export const systemAccountKindEnum = pgEnum("system_account_kind", systemAccountKinds);
export const categoryKindEnum = pgEnum("category_kind", categoryKinds);
export const transactionTypeEnum = pgEnum("transaction_type", transactionTypes);
export const stagedStatusEnum = pgEnum("staged_status", ["staged", "committed", "deleted"]);
export const actorSourceEnum = pgEnum("actor_source", actorSources);
export const recurrenceFrequencyEnum = pgEnum("recurrence_frequency", recurrenceFrequencies);
export const recurrenceMonthPolicyEnum = pgEnum("recurrence_month_policy", recurrenceMonthPolicies);
export const recurrenceWeekendPolicyEnum = pgEnum(
  "recurrence_weekend_policy",
  recurrenceWeekendPolicies,
);
export const userThemeEnum = pgEnum("user_theme", themes);
export const budgetPeriodUnitEnum = pgEnum("budget_period_unit", budgetPeriodUnits);
export const budgetAmountRuleEnum = pgEnum("budget_amount_rule", budgetAmountRules);
export const budgetGroupPolicyEnum = pgEnum("budget_group_policy", budgetGroupPolicies);

export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    timezone: text("timezone").default("UTC").notNull(),
    defaultCurrency: text("default_currency").default("USD").notNull(),
    // Defaults to following the machine, which is also what every row that
    // existed before this column lands on. A NOT NULL add with a constant default
    // is metadata-only on PostgreSQL 11 and later, so there is no backfill to
    // write and no table rewrite to wait for.
    theme: userThemeEnum("theme").default("system").notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "user_preferences_default_currency_check",
      sql`${table.defaultCurrency} ~ '^[A-Z]{2,12}$'`,
    ),
  ],
);

/**
 * Sign-in and other auth attempts, counted where every replica can see them.
 *
 * Better Auth counts in the process by default, which bounds nothing once there
 * is more than one: each replica keeps its own tally, so the allowance is
 * multiplied by the replica count and a guesser only has to spread their
 * attempts. The model name and its three fields are Better Auth's, not ours.
 *
 * `key` is unique because two rows for one key split the count between them,
 * which reads as half the attempts having happened. A race to insert raises
 * here and Better Auth re-reads rather than failing the request.
 */
export const rateLimit = pgTable(
  "auth_rate_limit",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    // Milliseconds since the epoch, which is past what an integer holds.
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("auth_rate_limit_key_unique").on(table.key),
    index("auth_rate_limit_last_request_idx").on(table.lastRequest),
  ],
);

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
    /**
     * Whether the money here is money the budget is about.
     *
     * On by default and on for credit cards, which is the decision worth
     * writing down: a card sits outside the cash flow statement's set on
     * purpose, and leaving it out here too would mean spending on a card
     * empties an envelope while no cash leaves the perimeter — so the page
     * would say there is more money to assign than there is.
     */
    inBudget: boolean("in_budget").default(true).notNull(),
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
    // Names are unique among the accounts a person keeps. The server's own
    // counter-accounts are excluded, because naming an account "Expenses (USD)"
    // would otherwise collide with one and leave the ledger unable to open it.
    uniqueIndex("ledger_account_user_name_unique")
      .on(table.userId, table.name)
      .where(sql`${table.systemKind} is null`),
    // Also the index every "this person's accounts" read uses. A bare
    // user_id index would be a second copy of this one's leading column.
    unique("ledger_account_user_id_id_unique").on(table.userId, table.id),
    // Lets postings and transactions carry a foreign key that includes the
    // currency, so no row can name an amount in a currency its account does
    // not hold.
    unique("ledger_account_user_id_currency_unique").on(table.userId, table.id, table.currency),
    uniqueIndex("ledger_account_system_kind_unique")
      .on(table.userId, table.systemKind, table.currency)
      .where(sql`${table.systemKind} is not null`),
    check("ledger_account_currency_check", sql`${table.currency} ~ '^[A-Z]{2,12}$'`),
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
    /**
     * At most one group, and never a group of groups.
     *
     * A single-column reference, unlike every other cross-table link here,
     * which pair the tenant with the id. `on delete set null` sets *every*
     * column of the constraint, so the composite form would null the tenant as
     * well and fail against `user_id not null` — PostgreSQL 15 can name the
     * column to clear and Drizzle cannot emit that. What the composite key
     * bought was a cross-tenant assignment being impossible in the database;
     * that is checked in `resolveCategoryGroup` instead, on the one path that
     * writes this column, and `tests/integration/tenant-isolation...` holds it.
     */
    groupId: uuid("group_id").references(() => categoryGroups.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    // Leads with the tenant, so it is also the index a read of one person's
    // categories uses. A bare user_id index would duplicate its first column.
    unique("category_user_name_unique").on(table.userId, table.name),
    unique("category_user_id_id_unique").on(table.userId, table.id),
    // Deleting a group leaves its categories where they are, ungrouped. The
    // group was a way of reading them, and removing it is not a reason to lose
    // what it was reading.
    index("category_group_idx").on(table.userId, table.groupId),
    check("category_version_check", sql`${table.version} >= 1`),
  ],
);

/**
 * One level of grouping over categories, and one level only.
 *
 * Arbitrary depth is refused rather than unimplemented. hledger shows what it
 * costs: spending in an unbudgeted grandchild rolls up to the nearest budgeted
 * ancestor, and the totals stop agreeing with themselves. One level has no
 * grandchild, so there is nothing to misattribute.
 */
export const categoryGroups = pgTable(
  "category_group",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * The name with case and spacing taken out, which is what uniqueness is
     * about. The same normalisation categories and payees already use, so
     * "Fixed Costs" and "fixed costs" are one group here as they would be one
     * category there.
     */
    normalizedName: text("normalized_name").notNull(),
    policy: budgetGroupPolicyEnum("policy").notNull(),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    unique("category_group_user_normalized_unique").on(table.userId, table.normalizedName),
    unique("category_group_user_id_id_unique").on(table.userId, table.id),
    check("category_group_version_check", sql`${table.version} >= 1`),
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
    index("import_batch_user_created_idx").on(table.userId, table.createdAt, table.id),
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
    // How many legs this is split across, read by nothing but the check below.
    // Every "is this a split" question elsewhere counts leg rows instead, so if
    // this ever drifted it would weaken the check rather than answer anything
    // incorrectly.
    legCount: smallint("leg_count").default(0).notNull(),
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
    // The normalised payee, indexed as the expression that reads it. Resolving a
    // payee to the spelling the ledger already keeps runs on every single
    // transaction write, and matching on
    // `lower(regexp_replace(trim(normalize(payee, NFKC)), ...))` is an expression
    // no plain column index serves — so each save sequentially scanned the
    // tenant's own rows. Measured on five thousand transactions: 6.3ms and 205
    // buffers became 0.02ms and 3.
    //
    // Every function in it is immutable, which is what lets it be indexed at all.
    // The spelling has to stay identical to the one in
    // services/payees.ts, and a test compares the two rather than trusting them.
    index("transaction_user_payee_normalized_idx").on(
      table.userId,
      sql`lower(regexp_replace(trim(normalize(${table.payee}, NFKC)), '\\s+', ' ', 'g'))`,
    ),
    index("transaction_user_date_idx").on(table.userId, table.date, table.id),
    index("transaction_user_source_account_idx").on(table.userId, table.sourceAccountId),
    index("transaction_user_destination_account_idx").on(table.userId, table.destinationAccountId),
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
    // A split is a cardinality inside an existing shape, not a fourth shape: a
    // split withdrawal still names one account and one source amount, so the
    // shape check above needs no clause about it and stays frozen.
    //
    // What this does enforce is that legs and a single category can never both
    // be recorded, so no query has to decide which of two labels wins, and that
    // a split has at least two legs, making "one leg is not a split" a fact
    // about the row rather than a rule every screen has to remember.
    check(
      "ledger_transaction_split_check",
      sql`
        ${table.legCount} = 0
        or (
          ${table.legCount} between 2 and ${sql.raw(String(MAX_TRANSACTION_LEGS))}
          and ${table.categoryId} is null
          and ${table.type} <> 'transfer'
        )
      `,
    ),
  ],
);

/**
 * One category's share of a split transaction.
 *
 * A leg is not a second record of the money. It **is** the counter-account side
 * of the transaction, cut into pieces: each leg has its own postings, and those
 * postings are what make the entry balance. So "the legs add up to the total"
 * needs no rule of its own — it is the double-entry check that was already
 * there, and there is no way to write a split that satisfies one and not the
 * other.
 *
 * `amount` may be zero because a leg is never deleted. Removing a category from
 * a split posts the leg back down to nothing and leaves the row, since the
 * postings that reference it are append-only. A zeroed leg falls out of every
 * report through the existing `sum(amount) <> 0` filters, and putting the
 * category back reuses the row rather than orphaning it.
 */
export const transactionLegs = pgTable(
  "transaction_leg",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id").notNull(),
    // Null is a real answer here, not a missing one: it is the share of the
    // receipt the person chose to leave unfiled.
    categoryId: uuid("category_id"),
    // The order the legs were entered in, which is the order they are shown in.
    // Nothing sorts them by amount or by name, because reordering them is an
    // edit the person made on purpose.
    ordinal: smallint("ordinal").default(0).notNull(),
    amount: numeric("amount", { precision: 44, scale: 18 }).notNull(),
    note: text("note"),
    ...timestamps,
  },
  (table) => [
    // The target of posting_leg_owner_fk, carrying the transaction so that key
    // can pin a posting's leg, transaction and tenant together in one place.
    //
    // Currency is deliberately not a column here. A leg's postings already have
    // theirs pinned to their account by posting_account_currency_fk, and an
    // entry can be moved to an account in another currency, so a currency on
    // the leg would be a mutable copy that append-only postings could never
    // follow.
    unique("transaction_leg_posting_target_unique").on(table.userId, table.transactionId, table.id),
    foreignKey({
      columns: [table.userId, table.transactionId],
      foreignColumns: [transactions.userId, transactions.id],
      name: "transaction_leg_transaction_owner_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.categoryId],
      foreignColumns: [categories.userId, categories.id],
      name: "transaction_leg_category_owner_fk",
    }),
    index("transaction_leg_transaction_idx").on(table.userId, table.transactionId, table.ordinal),
    // Serves the category screens, which ask which transactions touched one
    // category without knowing which of them are splits.
    index("transaction_leg_user_category_idx").on(
      table.userId,
      table.categoryId,
      table.transactionId,
    ),
    check("transaction_leg_ordinal_check", sql`${table.ordinal} >= 0`),
    check("transaction_leg_amount_check", sql`${table.amount} >= 0`),
    check(
      "transaction_leg_note_check",
      sql`${table.note} is null or char_length(${table.note}) <= 240`,
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
    accountId: uuid("account_id").notNull(),
    // Which leg of a split this line belongs to, on the counter-account side of
    // a split transaction and nowhere else. Null on the account side, on
    // openings and closings, and on every transaction that is not split.
    legId: uuid("leg_id"),
    // A journal line carries its own date. Money moved on the day it moved, so
    // balances as of a date read this table alone rather than reaching through
    // to a transaction, and changing when something happened moves the posting.
    //
    // A category is deliberately still NOT here. A posting names the leg it
    // belongs to, and the leg holds the one copy of the label, so recategorising
    // is a single update that leaves the postings alone and cannot make the
    // books and the reports disagree.
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
      foreignColumns: [ledgerAccounts.userId, ledgerAccounts.id, ledgerAccounts.currency],
      name: "posting_account_currency_fk",
    }),
    // Three columns, so a posting cannot name a leg of a different transaction
    // or a different tenant. MATCH SIMPLE makes it vacuously true whenever any
    // column is null, which is how account-side lines, openings and closings
    // pass it untouched; posting_leg_origin_check closes the one hole that
    // leaves.
    //
    // Every column here is immutable. A key over anything an edit can change
    // could not hold, because these rows are append-only and cannot be brought
    // along: moving an entry to an account in another currency would fail on
    // the key rather than on anything a person could act on.
    //
    // The cascade is required rather than preferred: deleting an account is a
    // single delete of the user row with nothing enumerating tables, and both
    // sides already cascade from there. "A leg is never deleted" is upheld by
    // resyncLegs never issuing one, not by this key.
    foreignKey({
      columns: [table.userId, table.transactionId, table.legId],
      foreignColumns: [transactionLegs.userId, transactionLegs.transactionId, transactionLegs.id],
      name: "posting_leg_owner_fk",
    }).onDelete("cascade"),
    // Both halves of an opening pair name the account they open, so moving an
    // opening date moves the equity side with it.
    foreignKey({
      columns: [table.userId, table.openingAccountId],
      foreignColumns: [ledgerAccounts.userId, ledgerAccounts.id],
      name: "posting_opening_account_owner_fk",
    }),
    index("posting_opening_account_idx").on(table.userId, table.openingAccountId),
    foreignKey({
      columns: [table.userId, table.closingAccountId],
      foreignColumns: [ledgerAccounts.userId, ledgerAccounts.id],
      name: "posting_closing_account_owner_fk",
    }),
    index("posting_closing_account_idx").on(table.userId, table.closingAccountId),
    // Serves every balance-as-of query: one account, dates up to a bound.
    index("posting_user_account_date_idx").on(table.userId, table.accountId, table.date),
    // Serves the dashboard, which sums a date range across counter-accounts.
    index("posting_user_date_idx").on(table.userId, table.date),
    index("posting_transaction_idx").on(table.transactionId),
    index("posting_user_leg_idx").on(table.userId, table.legId),
    // Only a transaction line can belong to a leg. Without this, a null
    // transaction_id would leave posting_leg_owner_fk vacuously satisfied and
    // an opening posting could claim a leg that does not exist.
    check(
      "posting_leg_origin_check",
      sql`${table.legId} is null or ${table.transactionId} is not null`,
    ),
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
    validationIssues: jsonb("validation_issues")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    duplicateOfId: uuid("duplicate_of_id"),
    // What this row would collide with. `duplicateOfId` names a committed
    // transaction it repeats; `duplicateKey` is the same fingerprint the commit
    // check uses, stored so two staged rows that repeat EACH OTHER can be found
    // before the commit refuses them. Without it that kind of duplicate exists
    // only for the instant a commit is attempted.
    duplicateKey: text("duplicate_key"),
    importBatchId: uuid("import_batch_id"),
    committedTransactionId: uuid("committed_transaction_id"),
    // Which recurrence proposed this row, and which occurrence of it.
    // Provenance rather than ownership, so no foreign key: deleting a
    // recurrence must leave what it already proposed alone, which a cascade
    // would destroy and a restricting key would forbid.
    recurrenceId: uuid("recurrence_id"),
    // The instance in the schedule's own sequence, which is not always the date
    // the row carries: a weekend policy moves the date and leaves this alone.
    // This is the identity an occurrence is proposed exactly once under.
    occurrenceDate: date("occurrence_date"),
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
    index("staged_user_import_batch_idx").on(table.userId, table.importBatchId),
    // Finding the rows that share a fingerprint is a grouped lookup.
    index("staged_user_duplicate_key_idx").on(table.userId, table.duplicateKey),
    // The same expression over the draft's payee, for the same reason: the
    // resolve reads both sides.
    index("staged_user_payee_normalized_idx").on(
      table.userId,
      sql`lower(regexp_replace(trim(normalize(${table.draft} ->> 'payee', NFKC)), '\\s+', ' ', 'g'))`,
    ),
    // Deliberately not qualified by status. A row somebody threw out keeps its
    // place here, which is what stops the next tick proposing that occurrence
    // again as though it had never happened.
    uniqueIndex("staged_recurrence_occurrence_unique")
      .on(table.userId, table.recurrenceId, table.occurrenceDate)
      .where(sql`${table.recurrenceId} is not null`),
    check(
      "staged_transaction_recurrence_check",
      sql`(${table.recurrenceId} is null) = (${table.occurrenceDate} is null)`,
    ),
    // A proposed row has no bank behind it, said in the schema rather than in a
    // comment somebody has to go and find.
    check(
      "staged_transaction_recurrence_import_check",
      sql`${table.recurrenceId} is null or ${table.importBatchId} is null`,
    ),
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
    check("idempotency_record_request_hash_check", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
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
    index("audit_user_created_idx").on(table.userId, table.createdAt, table.id),
    index("audit_user_entity_idx").on(table.userId, table.entityType, table.entityId),
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
    // Leads with the tenant, so it serves a read of one person's templates
    // too. A bare user_id index would duplicate its first column.
    unique("transaction_template_user_name_unique").on(table.userId, table.name),
    check(
      "transaction_template_name_check",
      sql`char_length(btrim(${table.name})) between 1 and 120`,
    ),
    check("transaction_template_version_check", sql`${table.version} >= 1`),
  ],
);

/**
 * A reminder to make a transaction from a template, at most one per template.
 *
 * Its own table rather than columns on the template. A template with no reminder
 * is the common case and would carry eight null columns describing a schedule it
 * does not have, and the scheduler needs an index leading with the due date,
 * which on the template table would be an index over mostly nulls.
 *
 * The schedule is a recurrence's, and deliberately the same shape so the same
 * date arithmetic serves both. What a recurrence has no need for is the two
 * things below: a time of day, and a null frequency.
 */
export const templateNotifications = pgTable(
  "template_notification",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // One reminder per template, and it goes when the template does.
    templateId: uuid("template_id")
      .notNull()
      .unique()
      .references(() => transactionTemplates.id, { onDelete: "cascade" }),

    // Null is a reminder that happens once, on the anchor date. A template is
    // filled in by hand and half the reason to be reminded of one is a payment
    // that only ever happens once, so "once" is a first-class answer here rather
    // than a yearly rule nobody means.
    frequency: recurrenceFrequencyEnum("frequency"),
    interval: smallint("interval").default(1).notNull(),
    anchorDate: date("anchor_date").notNull(),
    monthPolicy: recurrenceMonthPolicyEnum("month_policy").default("last_day").notNull(),
    weekendPolicy: recurrenceWeekendPolicyEnum("weekend_policy").default("allow").notNull(),
    positionOrdinal: smallint("position_ordinal"),
    positionWeekday: smallint("position_weekday"),

    // The wall-clock time in the person's own timezone, not an instant. The zone
    // is a preference they can change, and a reminder set for half past eight
    // means half past eight after they move as well as before.
    notifyAt: text("notify_at").notNull(),

    // The last occurrence this has sent for, and the next it will. Null next is
    // "nothing further", which is where a one-off ends up and is what stops the
    // scheduler looking at it again. Same watermark discipline as a recurrence:
    // whether to send is decided from the rule and the person's own clock, never
    // from these, and they only ever move forwards.
    lastNotifiedDate: date("last_notified_date"),
    nextNotificationDate: date("next_notification_date"),

    // No `version` here, unlike every other table. A reminder is replaced whole
    // rather than patched, and the template it belongs to carries the version an
    // edit is checked against, so there is nothing for a second one to guard.
    ...timestamps,
  },
  (table) => [
    index("template_notification_user_idx").on(table.userId),
    // The scheduler's due query, which like the recurrence one has to find work
    // across every ledger before it can know whose it is.
    index("template_notification_due_idx").on(table.nextNotificationDate, table.userId, table.id),
    check(
      "template_notification_interval_check",
      sql`${table.interval} between 1 and ${sql.raw(String(MAX_RECURRENCE_INTERVAL))}`,
    ),
    check(
      "template_notification_notify_at_check",
      sql`${table.notifyAt} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    // Both or neither, and only where a month is being counted within.
    check(
      "template_notification_position_check",
      sql`(${table.positionOrdinal} is null) = (${table.positionWeekday} is null)`,
    ),
    check(
      "template_notification_position_frequency_check",
      sql`${table.positionOrdinal} is null or ${table.frequency} in ('monthly', 'yearly')`,
    ),
    // A reminder that happens once has no interval and no policies to apply, so
    // it must not be storing a repeating rule's leftovers.
    check(
      "template_notification_once_check",
      sql`${table.frequency} is not null or (${table.interval} = 1 and ${table.positionOrdinal} is null)`,
    ),
  ],
);

/**
 * A saved shape, a schedule, and what to do about the dates a calendar does not
 * have. It posts nothing and commits nothing: on its due date it puts an
 * ordinary row in the review queue and waits for somebody.
 *
 * The accounts and category it names live inside the JSON with no foreign key,
 * for the reason a template's do: a key would cascade, so tidying away an old
 * account would take the recurrence with it. What differs is what happens when
 * an id stops resolving. A template quietly drops it, because a person is
 * looking at the form. Nobody is looking when this fires, so the row is proposed
 * carrying the reason instead.
 */
export const recurrences = pgTable(
  "recurrence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    shape: jsonb("shape").notNull(),

    frequency: recurrenceFrequencyEnum("frequency").notNull(),
    // How many periods between occurrences: 1 is every month, 3 is every
    // quarter, and a weekly 2 is what other products call skipping every other
    // one. `interval` is a PostgreSQL type name, so hand-written SQL must quote
    // it; everything here goes through Drizzle, which always does.
    interval: smallint("interval").default(1).notNull(),
    // The first candidate occurrence, and the phase of every later one. Monthly
    // on the 31st is an anchor on the 31st; weekly on Tuesdays is an anchor that
    // is a Tuesday. A separate day-of-month and day-of-week beside this would be
    // two more ways to say what the anchor already says, and two more things
    // that can disagree with it.
    anchorDate: date("anchor_date").notNull(),
    monthPolicy: recurrenceMonthPolicyEnum("month_policy").default("last_day").notNull(),
    weekendPolicy: recurrenceWeekendPolicyEnum("weekend_policy").default("allow").notNull(),
    // "The second Tuesday", "the last Friday", for the monthly and yearly rules
    // that are about a weekday rather than a date. Set together or not at all,
    // and when they are set the anchor's day of the month is not read.
    positionOrdinal: smallint("position_ordinal"),
    positionWeekday: smallint("position_weekday"),

    // Nothing dated before this is ever proposed. Set to the day this was made,
    // in the person's own timezone, and never rewritten. Without it a recurrence
    // anchored in 2019 and created today would open by proposing six years of
    // back-dated rent, and moving the anchor backwards later would do it again.
    proposesFrom: date("proposes_from").notNull(),
    // The last nominal occurrence this has decided: proposed, or passed over by
    // a policy. Null is "has never run", which is the difference between a
    // scheduler that is silent and one with nothing to say. It advances past a
    // skipped occurrence too, or the month a policy passed over is reconsidered
    // on every tick, and turning that policy off a year later would propose a
    // year of back-dated rows at once.
    lastOccurrenceDate: date("last_occurrence_date"),
    // Where the scheduler's due query looks, and nowhere else. A pure function
    // of the rule, proposes_from and last_occurrence_date, written in the same
    // statement as the watermark it follows. Whether to propose is decided from
    // the rule and the person's own calendar date, never from this column, and
    // the read view recomputes it rather than reporting it, so a value that
    // drifted shows up as a recurrence overdue with nothing proposed rather than
    // as a wrong date on a row.
    nextOccurrenceDate: date("next_occurrence_date").notNull(),

    // Whether the scheduler tells this person it proposed something. Beside the
    // rule rather than in it: the rule decides what is proposed, this decides
    // whether anybody hears about it, and a tick that proposes nothing sends
    // nothing whatever this says.
    notifyOnCreate: boolean("notify_on_create").default(false).notNull(),

    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    // Leads with the tenant, so it serves a read of one person's recurrences
    // too. A bare user_id index would duplicate its first column.
    unique("recurrence_user_name_unique").on(table.userId, table.name),
    // The one index here that does not lead with the tenant, for the one query
    // that cannot: the scheduler has to find work across every ledger before it
    // can know whose it is. It reads the id and the user id and nothing else,
    // and everything after it runs through an Actor built from that user id.
    index("recurrence_due_idx").on(table.nextOccurrenceDate, table.userId, table.id),
    check("recurrence_name_check", sql`char_length(btrim(${table.name})) between 1 and 120`),
    check(
      "recurrence_interval_check",
      sql`${table.interval} between 1 and ${sql.raw(String(MAX_RECURRENCE_INTERVAL))}`,
    ),
    check("recurrence_version_check", sql`${table.version} >= 1`),
    // A relative day is both halves or neither, and only the ordinals that
    // exist in every month. There is no fifth Tuesday in half the year.
    check(
      "recurrence_position_check",
      sql`(${table.positionOrdinal} is null) = (${table.positionWeekday} is null)
          and (${table.positionOrdinal} is null
               or (${table.positionOrdinal} in (1, 2, 3, 4, -1)
                   and ${table.positionWeekday} between 0 and 6))`,
    ),
    // Both hold by construction, and both are here because the column they
    // guard is derived: a writer that advances the watermark and forgets the
    // cursor is a recurrence that silently stops, which is the failure this
    // whole feature exists to prevent.
    check(
      "recurrence_cursor_floor_check",
      sql`${table.nextOccurrenceDate} >= ${table.proposesFrom}`,
    ),
    check(
      "recurrence_cursor_watermark_check",
      sql`${table.lastOccurrenceDate} is null
          or ${table.nextOccurrenceDate} > ${table.lastOccurrenceDate}`,
    ),
  ],
);

/**
 * The standing instruction for one budget target.
 *
 * One row covers every period, so a budget that runs all year is one row rather
 * than twelve, and nothing has to materialise the months nobody has reached
 * yet. That is the whole reason there is no scheduler anywhere near budgeting:
 * an amount that is derived on read cannot drift from what it was derived from,
 * and there is no backlog for a stopped cron to eat.
 *
 * The window is what keeps history honest. Raising the grocery budget in July
 * closes one plan and opens another, so asking what March intended still
 * answers with what March intended. The service refuses an overlap under the
 * category namespace lock, because two plans covering one month would leave the
 * amount depending on which row was read first.
 */
export const budgetPlans = pgTable(
  "budget_plan",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * The target, which is a category or a group and never both.
     *
     * Nullable rather than two tables, because everything else about a budget
     * — the window, the carry, the rule, the priority — is identical whichever
     * it points at, and two tables would be the same columns twice with two
     * copies of the fold to read them.
     */
    categoryId: uuid("category_id"),
    groupId: uuid("group_id"),
    currency: text("currency").notNull(),
    periodUnit: budgetPeriodUnitEnum("period_unit").notNull(),
    amount: numeric("amount", { precision: 44, scale: 18 }).notNull(),
    activeFrom: date("active_from").notNull(),
    activeTo: date("active_to"),
    /**
     * Whether what a period did not spend belongs to the next one.
     *
     * Off is a limit: every period starts again at the amount, and last month
     * having gone well buys nothing. On is an envelope: the unspent carries
     * forward and so does the overspend, as a debt against the next period.
     * Nothing is stored per period either way — the carry is folded at read
     * time from the same plans, entries and postings the figures already come
     * from, so turning this on invents no rows and turning it off leaves none
     * behind.
     */
    rollover: boolean("rollover").default(false).notNull(),
    /**
     * How far a carry may run in either direction, or null for no limit.
     *
     * Symmetric on purpose. A holiday fund that nobody has drawn on for three
     * years is not a budget any more, and a category three thousand in debt to
     * itself will never come back inside its limit, so both ends of the same
     * runaway are the same setting.
     */
    rolloverCap: numeric("rollover_cap", { precision: 44, scale: 18 }),
    /** What a sinking fund is saving up for, with the date it is needed by. */
    targetAmount: numeric("target_amount", { precision: 44, scale: 18 }),
    targetDate: date("target_date"),
    /**
     * How many finished periods a trailing average looks back over.
     *
     * Bounded by a check rather than by taste: an average over four hundred
     * periods is a fold over four hundred periods, and the one thing this
     * design will not do is let a budget's arithmetic grow without a bound
     * somebody can see.
     */
    ruleLookback: integer("rule_lookback"),
    /**
     * The percentage an incremental budget adds to the last period, or the
     * share of income a percent-of-income budget takes. One column for two
     * rules, because a row is only ever one of them.
     */
    rulePercent: numeric("rule_percent", { precision: 9, scale: 4 }),
    /**
     * Which budgets are funded first when a period's income will not cover
     * them all. Lower goes first, the way `nice` does, and the default of zero
     * means a ledger that never sets one has every budget equal.
     */
    priority: integer("priority").default(0).notNull(),
    amountRule: budgetAmountRuleEnum("amount_rule").default("fixed").notNull(),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    // The composite key the category already carries, so one cascade satisfies
    // both halves of the rule: deleting a category takes its budgets with it,
    // and a budget is never a reason a category cannot be deleted.
    foreignKey({
      columns: [table.userId, table.categoryId],
      foreignColumns: [categories.userId, categories.id],
      name: "budget_plan_category_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.groupId],
      foreignColumns: [categoryGroups.userId, categoryGroups.id],
      name: "budget_plan_group_fk",
    }).onDelete("cascade"),
    // Two partial indexes rather than one constraint over both columns.
    // PostgreSQL counts NULLs as distinct in a unique constraint, so the
    // original would have let a person write the same group budget as many
    // times as they liked the moment `category_id` became nullable.
    uniqueIndex("budget_plan_category_window_unique")
      .on(table.userId, table.categoryId, table.periodUnit, table.currency, table.activeFrom)
      .where(sql`${table.categoryId} is not null`),
    uniqueIndex("budget_plan_group_window_unique")
      .on(table.userId, table.groupId, table.periodUnit, table.currency, table.activeFrom)
      .where(sql`${table.groupId} is not null`),
    check(
      "budget_plan_target_check",
      sql`(${table.categoryId} is null) <> (${table.groupId} is null)`,
    ),
    // Zero is a budget, and a useful one: it says any spending here is over.
    check("budget_plan_amount_check", sql`${table.amount} >= 0`),
    check("budget_plan_currency_check", sql`${table.currency} ~ '^[A-Z]{2,12}$'`),
    check("budget_plan_version_check", sql`${table.version} >= 1`),
    check(
      "budget_plan_window_check",
      sql`${table.activeTo} is null or ${table.activeTo} >= ${table.activeFrom}`,
    ),
    check(
      "budget_plan_rollover_cap_check",
      sql`${table.rolloverCap} is null or ${table.rolloverCap} >= 0`,
    ),
    check(
      "budget_plan_target_amount_check",
      sql`${table.targetAmount} is null or ${table.targetAmount} > 0`,
    ),
    // The rule and its parameters, held to each other in the one place both
    // transports go through. A sinking fund with no target is a fixed budget
    // wearing the wrong name, and a target with the rule left at fixed is a
    // number nothing reads.
    check(
      "budget_plan_rule_check",
      sql`(${table.amountRule} = 'sinking_fund') = (${table.targetAmount} is not null and ${table.targetDate} is not null)`,
    ),
    // A fund that does not keep what it saved saves nothing: each period would
    // start again from the target divided by the periods left, and the money
    // put aside last month would be invisible to this month's figure.
    check(
      "budget_plan_sinking_rollover_check",
      sql`${table.amountRule} <> 'sinking_fund' or ${table.rollover}`,
    ),
    // Each rule holds exactly the parameter it is named for, and the others
    // hold none. A trailing average with a percentage beside it is a row that
    // cannot say what it meant.
    // Compared as text, and this is not a style choice. `ALTER TYPE ... ADD
    // VALUE` and a constraint naming the value it added cannot share a
    // transaction — PostgreSQL refuses with `unsafe use of new value of enum
    // type`, and every migration runs in one. Casting to text means the
    // constraint never touches the new enum value, so the rules and the
    // vocabulary they are about can arrive together.
    check(
      "budget_plan_lookback_check",
      sql`(${table.amountRule}::text = 'trailing_average') = (${table.ruleLookback} is not null)`,
    ),
    check(
      "budget_plan_percent_check",
      sql`(${table.amountRule}::text in ('incremental', 'percent_of_income')) = (${table.rulePercent} is not null)`,
    ),
    check(
      "budget_plan_lookback_range_check",
      sql`${table.ruleLookback} is null or (${table.ruleLookback} >= 1 and ${table.ruleLookback} <= 24)`,
    ),
    // A taper is a real budget — "ten per cent less each month" is how somebody
    // winds spending down — so an incremental plan may carry a negative
    // percentage, floored at -100 because a period cannot budget less than
    // nothing. A share of income may not: a negative share is not a share.
    check(
      "budget_plan_percent_range_check",
      sql`${table.rulePercent} is null
        or (${table.amountRule}::text = 'incremental' and ${table.rulePercent} >= -100 and ${table.rulePercent} <= 1000)
        or (${table.amountRule}::text = 'percent_of_income' and ${table.rulePercent} >= 0 and ${table.rulePercent} <= 1000)`,
    ),
  ],
);

/**
 * One period's amount, set explicitly, overriding whatever the plan would say.
 *
 * The exception rather than the rule. Three hundred for December only is a row
 * here; two hundred a month is a plan and no rows at all. An entry with no plan
 * behind it is a budget for one period and nothing else, which is what somebody
 * setting a single month means.
 */
export const budgetEntries = pgTable(
  "budget_entry",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** A category or a group, and never both. See `budgetPlans` above. */
    categoryId: uuid("category_id"),
    groupId: uuid("group_id"),
    currency: text("currency").notNull(),
    periodUnit: budgetPeriodUnitEnum("period_unit").notNull(),
    // Always the first day of the period it names, truncated the same way the
    // report grid truncates, so a limit and its actual cannot land on different
    // grids. The service is what holds it to that; the column only stores it.
    periodStart: date("period_start").notNull(),
    amount: numeric("amount", { precision: 44, scale: 18 }).notNull(),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.categoryId],
      foreignColumns: [categories.userId, categories.id],
      name: "budget_entry_category_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.groupId],
      foreignColumns: [categoryGroups.userId, categoryGroups.id],
      name: "budget_entry_group_fk",
    }).onDelete("cascade"),
    uniqueIndex("budget_entry_category_period_unique")
      .on(table.userId, table.categoryId, table.periodUnit, table.periodStart, table.currency)
      .where(sql`${table.categoryId} is not null`),
    uniqueIndex("budget_entry_group_period_unique")
      .on(table.userId, table.groupId, table.periodUnit, table.periodStart, table.currency)
      .where(sql`${table.groupId} is not null`),
    check(
      "budget_entry_target_check",
      sql`(${table.categoryId} is null) <> (${table.groupId} is null)`,
    ),
    check("budget_entry_amount_check", sql`${table.amount} >= 0`),
    check("budget_entry_currency_check", sql`${table.currency} ~ '^[A-Z]{2,12}$'`),
    check("budget_entry_version_check", sql`${table.version} >= 1`),
  ],
);

export type CategoryRow = typeof categories.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type TransactionLegRow = typeof transactionLegs.$inferSelect;
export type StagedTransactionRow = typeof stagedTransactions.$inferSelect;
export type RecurrenceRow = typeof recurrences.$inferSelect;
export type CategoryGroupRow = typeof categoryGroups.$inferSelect;
export type BudgetPlanRow = typeof budgetPlans.$inferSelect;
export type BudgetEntryRow = typeof budgetEntries.$inferSelect;
