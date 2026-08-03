import { and, eq, isNotNull } from "drizzle-orm";
import { getConfig, isEmailAllowed, isRegistrationClosed } from "./config.js";
import { mailEnabled } from "./mail.js";
import { getDb } from "./db/client.js";
import { account as authAccount, user } from "./db/schema.js";
import { isBootstrapClaim } from "./registration-context.js";

export type UserAuthState = {
  mode: "local" | "google" | "both";
  localEnabled: boolean;
  googleEnabled: boolean;
  localPasswordConfigured: boolean;
  googleLinked: boolean;
};

export type LinkedAuthAccount = {
  providerId: string;
  password?: string | null;
};

function hasCredentialAccount(accounts: LinkedAuthAccount[]) {
  return accounts.some(
    (linked) => linked.providerId === "credential" && Boolean(linked.password),
  );
}

function hasLinkedGoogleAccount(accounts: LinkedAuthAccount[]) {
  return accounts.some((linked) => linked.providerId === "google");
}

/**
 * Whether an existing account may still be used at all.
 *
 * ALLOWED_EMAILS decides who may *open* an account here; it deliberately has no
 * say from then on. It is optional, so treating it as a sign-in gate would shut
 * everyone out of a deployment that never set one, and narrowing it from
 * `pinecone.io` to a shorter list would silently take people's own books away
 * from them mid-session. Removing someone is deleting their account, which is
 * an explicit act with an obvious consequence.
 */
function isLinkedIdentityAuthorized(accounts: LinkedAuthAccount[]) {
  const config = getConfig();
  return (
    (config.localAuthEnabled && hasCredentialAccount(accounts)) ||
    (config.googleAuthEnabled && hasLinkedGoogleAccount(accounts))
  );
}

/**
 * True while nobody has an account yet, so the deployment is unclaimed.
 *
 * A deployment that names nobody in ALLOWED_EMAILS admits nobody, which would
 * leave a fresh install with no way in at all. The setup code printed at
 * startup covers exactly that gap, and only until somebody takes it.
 */
export async function isLocalBootstrapOpen() {
  const [existingUser] = await getDb()
    .select({ id: user.id })
    .from(user)
    .limit(1);
  return !existingUser;
}

export async function getUserAuthState(userId: string): Promise<UserAuthState> {
  const config = getConfig();
  const linkedAccounts = await getDb()
    .select({
      providerId: authAccount.providerId,
      password: authAccount.password,
    })
    .from(authAccount)
    .where(eq(authAccount.userId, userId));
  return {
    mode: config.authMode,
    localEnabled: config.localAuthEnabled,
    googleEnabled: config.googleAuthEnabled,
    localPasswordConfigured: hasCredentialAccount(linkedAccounts),
    googleLinked: hasLinkedGoogleAccount(linkedAccounts),
  };
}

export async function hasLocalPassword(userId: string) {
  const [credential] = await getDb()
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(
      and(
        eq(authAccount.userId, userId),
        eq(authAccount.providerId, "credential"),
        isNotNull(authAccount.password),
      ),
    )
    .limit(1);
  return Boolean(credential);
}

export async function isLedgerUserAuthorized(userId: string) {
  const linkedAccounts = await getDb()
    .select({
      providerId: authAccount.providerId,
      password: authAccount.password,
    })
    .from(authAccount)
    .where(eq(authAccount.userId, userId));
  return isLinkedIdentityAuthorized(linkedAccounts);
}

/**
 * The one place a new tenant is admitted, whichever door they came through.
 *
 * This runs inside Better Auth's sign-up transaction, so it answers from the
 * configuration and the request rather than from a query. See
 * registration-context.ts for why that matters.
 */
export function mayCreateAuthUser(
  email: string,
  path?: string | null,
  emailVerified?: boolean,
) {
  const config = getConfig();
  if (path === "/callback/google") {
    if (!config.googleAuthEnabled) return false;
    // A domain entry trusts Google's word that the address belongs to the
    // person signing in. Google says so in email_verified, and an unverified
    // claim to someone@pinecone.io is worth nothing.
    if (emailVerified === false) return false;
    return isEmailAllowed(email);
  }
  if (path === "/sign-up/email") {
    if (!config.localAuthEnabled) return false;
    // Or the setup code, which the route validated under the bootstrap lock
    // before handing over.
    return isEmailAllowed(email) || isBootstrapClaim();
  }
  return false;
}

/**
 * Adding a second way to sign in to an account somebody already holds.
 *
 * Better Auth is configured to link only an identical, explicitly confirmed
 * address (`allowDifferentEmails: false`, `disableImplicitLinking: true`), so
 * this is the same person reaching their own ledger by another route rather
 * than a new tenant arriving.
 */
export function mayCreateProviderAccount(providerId: string) {
  const config = getConfig();
  if (providerId === "credential") return config.localAuthEnabled;
  return providerId === "google" && config.googleAuthEnabled;
}

/**
 * Signing in has to prove the method is switched on and that this account
 * actually has an identity of that kind. It deliberately says nothing about
 * ALLOWED_EMAILS; see isLinkedIdentityAuthorized for why.
 */
export async function mayCreateSession(
  userId: string,
  path?: string | null,
  transactionAccounts?: LinkedAuthAccount[],
) {
  const config = getConfig();
  const linkedAccounts =
    transactionAccounts ??
    (await getDb()
      .select({
        providerId: authAccount.providerId,
        password: authAccount.password,
      })
      .from(authAccount)
      .where(eq(authAccount.userId, userId)));
  if (path === "/sign-in/email" || path === "/sign-up/email") {
    return config.localAuthEnabled && hasCredentialAccount(linkedAccounts);
  }
  if (path === "/callback/google") {
    return config.googleAuthEnabled && hasLinkedGoogleAccount(linkedAccounts);
  }
  return isLinkedIdentityAuthorized(linkedAccounts);
}

export async function getPublicAuthOptions() {
  const config = getConfig();
  // An unclaimed deployment shows the form even when the rule admits nobody,
  // because the setup code is the way in and there is nothing else to offer.
  const unclaimed = await isLocalBootstrapOpen();
  return {
    mode: config.authMode,
    localEnabled: config.localAuthEnabled,
    googleEnabled: config.googleAuthEnabled,
    localRegistrationOpen:
      config.localAuthEnabled && (unclaimed || !isRegistrationClosed()),
    // Nobody has an account yet, so there is nobody to sign in as and the
    // screen should open on the create-account form.
    awaitingFirstAccount: unclaimed,
    // Only when the rule admits nobody, which is the one case the code exists
    // for. Asking for it whenever a deployment is unclaimed would demand a
    // server log from people ALLOWED_EMAILS already lets in, and the sign-up
    // route would not have checked it anyway.
    setupTokenRequired:
      config.isProduction && unclaimed && isRegistrationClosed(),
    // Both need a mail server. Without one there is no link to send, so the
    // screen must not offer a reset it cannot perform, and a new account is
    // usable straight away rather than waiting on a message that never comes.
    passwordResetAvailable: config.localAuthEnabled && mailEnabled(),
    emailVerificationRequired: config.localAuthEnabled && mailEnabled(),
    minimumPasswordLength: 12,
  };
}
