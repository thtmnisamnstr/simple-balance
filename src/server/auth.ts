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
import {
  mailEnabled,
  passwordResetMessage,
  sendMail,
  verificationMessage,
} from "./mail.js";
import { isBootstrapClaim } from "./registration-context.js";
import { revokeAllConnectedApps } from "./services/connected-apps.js";
import { getDb } from "./db/client.js";
import * as schema from "./db/schema.js";
import { user } from "./db/schema.js";

function createAuthInstance() {
  const config = getConfig();
  // Both features act on password accounts. In google mode there are none, and
  // offering a reset there would mint a credential the account policy refuses.
  const canSendMail = config.localAuthEnabled && mailEnabled();
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
      // Better Auth otherwise awaits sendVerificationEmail and
      // sendResetPassword inline. That puts a slow relay in front of a person
      // waiting on a sign-up button, and makes the response time differ
      // depending on whether the address was already taken, which is a way to
      // ask the server who has an account. Handing the promise off makes every
      // branch answer at the same speed.
      backgroundTasks: {
        handler: (promise: Promise<unknown>) => {
          void promise.catch((error) => {
            console.error("A background auth task failed", error);
          });
        },
      },
      // Rate limiting counts per client address, read from x-forwarded-for.
      // That header is only worth believing because every request reaching this
      // handler has passed through withCountableClientAddress, which replaces
      // it with the peer address of the connection unless a proxy is trusted.
    },
    emailAndPassword: {
      enabled: config.localAuthEnabled,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      // Both of these need somewhere to send a link. A deployment with no mail
      // server keeps the behaviour it has always had: no reset, and an address
      // nobody is asked to prove. Configure SMTP_HOST and MAIL_FROM and the two
      // switch on together, because requiring an address to be confirmed
      // without being able to send the confirmation would lock everybody out.
      requireEmailVerification: canSendMail,
      // Somebody resetting a password is often doing it because somebody else
      // has it. Leaving that person's session open would defeat the point, so
      // a reset signs everybody out and the new password is what gets back in.
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user: resetUser }) => {
        await revokeAllConnectedApps(resetUser.id);
      },
      ...(canSendMail
        ? {
            sendResetPassword: async ({ user, url }) => {
              await sendMail({
                to: user.email,
                ...passwordResetMessage(url, config.baseUrl),
              });
            },
          }
        : {}),
    },
    ...(canSendMail
      ? {
          emailVerification: {
            sendVerificationEmail: async ({ user, url }) => {
              await sendMail({
                to: user.email,
                ...verificationMessage(url, config.baseUrl),
              });
            },
            sendOnSignUp: true,
            // Somebody who lost the first message can ask for another by
            // trying to sign in, which is what they will do anyway.
            sendOnSignIn: true,
            // Deliberately not autoSignInAfterVerification. The token is a
            // stateless JWT that stays valid for its hour, so anyone who came
            // by the link afterwards would be signed in as its owner. Opening
            // it confirms the address; signing in still takes the password.
            expiresIn: 3600,
          },
        }
      : {}),
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
          before: async (newUser, context) => {
            if (
              !mayCreateAuthUser(
                newUser.email,
                context?.path,
                newUser.emailVerified,
              )
            ) {
              return false;
            }
            // Two local sign-ups are settled here rather than left to wait on
            // a message.
            //
            // The first is the account claimed with the code printed to the
            // server's own log, which proves control of this deployment better
            // than an inbox does. Asking for the round-trip as well would mean
            // a mail server configured slightly wrong locks the operator out of
            // the instance they just created, with the setup code spent.
            //
            // The second is any account made while no mail server is set. Such
            // a deployment never asked, so it must not withhold anything later:
            // otherwise the day somebody sets SMTP_HOST is the day everyone who
            // signed up before it stops being able to sign in.
            if (
              context?.path === "/sign-up/email" &&
              (isBootstrapClaim() || !canSendMail)
            ) {
              return { data: { ...newUser, emailVerified: true } };
            }
            return true;
          },
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
