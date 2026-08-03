import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { mcp } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { Actor } from "../shared/domain.js";
import {
  isLedgerUserAuthorized,
  mayCreateProviderAccount,
  mayCreateAuthUser,
  mayCreateSession,
} from "./auth-policy.js";
import { getConfig } from "./config.js";
import { getDb } from "./db/client.js";
import * as schema from "./db/schema.js";
import { user } from "./db/schema.js";

function createAuthInstance() {
  const config = getConfig();
  const supportedScopes = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "ledger:read",
    "ledger:stage",
    "ledger:write",
  ];
  return betterAuth({
    appName: "Simple Balance",
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [config.baseUrl],
    logger: {
      level: config.logLevel,
      disableColors: config.isProduction,
    },
    advanced: {
      trustedProxyHeaders: config.trustProxy,
      // Rate limiting counts per client address, read from x-forwarded-for.
      // That header is only worth believing because every request reaching this
      // handler has passed through withCountableClientAddress, which replaces
      // it with the peer address of the connection unless a proxy is trusted.
    },
    emailAndPassword: {
      enabled: config.localAuthEnabled,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema,
      usePlural: false,
      transaction: true,
    }),
    socialProviders: config.googleAuthEnabled
      ? {
          google: {
            clientId: config.googleClientId!,
            clientSecret: config.googleClientSecret!,
            scope: ["openid", "email", "profile"],
            prompt: "select_account",
          },
        }
      : {},
    databaseHooks: {
      user: {
        create: {
          before: async (newUser, context) =>
            mayCreateAuthUser(
              newUser.email,
              context?.path,
              newUser.emailVerified,
            ),
        },
      },
      session: {
        create: {
          before: async (newSession, context) => {
            const transactionAdapter = context?.context.internalAdapter;
            const linkedAccounts = transactionAdapter
              ? await transactionAdapter.findAccounts(newSession.userId)
              : undefined;
            return mayCreateSession(
              newSession.userId,
              context?.path,
              linkedAccounts,
            );
          },
        },
      },
      account: {
        create: {
          before: async (newAccount) =>
            mayCreateProviderAccount(newAccount.providerId),
        },
      },
    },
    plugins: [
      mcp({
        loginPage: "/sign-in",
        resource: `${config.baseUrl}/mcp`,
        oidcConfig: {
          loginPage: "/sign-in",
          consentPage: "/oauth/consent",
          allowDynamicClientRegistration: true,
          requirePKCE: true,
          allowPlainCodeChallengeMethod: false,
          scopes: supportedScopes,
          defaultScope: "openid profile email ledger:read",
          storeClientSecret: "hashed",
          metadata: {
            scopes_supported: supportedScopes,
          },
        },
      }),
    ],
  });
}

type ConcreteAuth = ReturnType<typeof createAuthInstance>;
let authInstance: ConcreteAuth | undefined;

export function getAuth(): ConcreteAuth {
  if (authInstance) return authInstance;
  const created = createAuthInstance();
  authInstance = created;
  return created;
}

export type AuthInstance = ReturnType<typeof getAuth>;

export async function getWebIdentity(headers: Headers) {
  const session = await getAuth().api.getSession({ headers });
  if (!session || !(await isLedgerUserAuthorized(session.user.id))) {
    return null;
  }
  return session;
}

export async function actorFromMcpSession(session: {
  userId: string;
  clientId: string;
  scopes: string;
}): Promise<{ actor: Actor; scopes: Set<string> } | null> {
  const [authUser] = await getDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, session.userId))
    .limit(1);
  if (!authUser || !(await isLedgerUserAuthorized(authUser.id))) {
    return null;
  }
  return {
    actor: {
      userId: authUser.id,
      source: "mcp",
      clientId: session.clientId,
    },
    scopes: new Set(session.scopes.split(/\s+/).filter(Boolean)),
  };
}
