import { and, eq, isNotNull } from "drizzle-orm";
import { getConfig, isEmailAllowed } from "./config.js";
import { getDb } from "./db/client.js";
import { account as authAccount, user } from "./db/schema.js";

export type UserAuthState = {
  mode: "local" | "google" | "both";
  localEnabled: boolean;
  googleEnabled: boolean;
  localPasswordConfigured: boolean;
  googleLinked: boolean;
  googleEligible: boolean;
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

function isLinkedIdentityAuthorized(
  email: string,
  accounts: LinkedAuthAccount[],
) {
  const config = getConfig();
  return (
    (config.localAuthEnabled && hasCredentialAccount(accounts)) ||
    (config.googleAuthEnabled &&
      isEmailAllowed(email) &&
      hasLinkedGoogleAccount(accounts))
  );
}

export async function isLocalBootstrapOpen() {
  const [existingUser] = await getDb()
    .select({ id: user.id })
    .from(user)
    .limit(1);
  return !existingUser;
}

export async function getUserAuthState(userId: string): Promise<UserAuthState> {
  const config = getConfig();
  const [linkedAccounts, [authUser]] = await Promise.all([
    getDb()
      .select({
        providerId: authAccount.providerId,
        password: authAccount.password,
      })
      .from(authAccount)
      .where(eq(authAccount.userId, userId)),
    getDb()
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
  ]);
  return {
    mode: config.authMode,
    localEnabled: config.localAuthEnabled,
    googleEnabled: config.googleAuthEnabled,
    localPasswordConfigured: hasCredentialAccount(linkedAccounts),
    googleLinked: hasLinkedGoogleAccount(linkedAccounts),
    googleEligible:
      config.googleAuthEnabled &&
      Boolean(authUser && isEmailAllowed(authUser.email)),
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

export async function hasGoogleAccount(userId: string) {
  const [google] = await getDb()
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(
      and(
        eq(authAccount.userId, userId),
        eq(authAccount.providerId, "google"),
      ),
    )
    .limit(1);
  return Boolean(google);
}

export async function isLedgerUserAuthorized(userId: string, email: string) {
  const linkedAccounts = await getDb()
    .select({
      providerId: authAccount.providerId,
      password: authAccount.password,
    })
    .from(authAccount)
    .where(eq(authAccount.userId, userId));
  return isLinkedIdentityAuthorized(email, linkedAccounts);
}

export async function mayCreateAuthUser(email: string, path?: string | null) {
  const config = getConfig();
  if (path === "/sign-up/email") {
    return (
      config.localAuthEnabled &&
      (config.authMode !== "both" || isEmailAllowed(email))
    );
  }
  if (path === "/callback/google") {
    return config.googleAuthEnabled && isEmailAllowed(email);
  }
  return false;
}

export async function mayCreateProviderAccount(
  providerId: string,
  userId: string,
  path?: string | null,
  userEmail?: string | null,
) {
  const config = getConfig();
  if (providerId === "credential") return config.localAuthEnabled;
  if (providerId !== "google" || !config.googleAuthEnabled) return false;
  if (userEmail) return isEmailAllowed(userEmail);
  const [authUser] = await getDb()
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (authUser) return isEmailAllowed(authUser.email);
  // A new Google user's row may still be inside Better Auth's transaction.
  // Its email was already checked by mayCreateAuthUser in the same callback.
  return path === "/callback/google";
}

export async function mayCreateSession(
  userId: string,
  email: string,
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
    return (
      config.googleAuthEnabled &&
      isEmailAllowed(email) &&
      hasLinkedGoogleAccount(linkedAccounts)
    );
  }
  return isLinkedIdentityAuthorized(email, linkedAccounts);
}

export async function getPublicAuthOptions() {
  const config = getConfig();
  return {
    mode: config.authMode,
    localEnabled: config.localAuthEnabled,
    googleEnabled: config.googleAuthEnabled,
    localRegistrationOpen:
      config.localAuthEnabled && (await isLocalBootstrapOpen()),
    setupTokenRequired: config.isProduction,
    minimumPasswordLength: 12,
  };
}
