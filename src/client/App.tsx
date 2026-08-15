import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CircleDollarSign,
  FileUp,
  History,
  Landmark,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Menu,
  ReceiptText,
  ChartColumn,
  Repeat,
  Settings,
  Sparkles,
  Tags,
  UserRound,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "./router.js";
import {
  api,
  ApiClientError,
  json,
  type AuthPublicOptions,
  type Session,
} from "./api.js";
import { authClient } from "./auth-client.js";
import { Alert, Button, Field, Input } from "./components.js";
import AccountsPage from "./pages/AccountsPage.js";
import AccountDetailPage from "./pages/AccountDetailPage.js";
import ActivityPage from "./pages/ActivityPage.js";
import CategoriesPage from "./pages/CategoriesPage.js";
import CategoryDetailPage from "./pages/CategoryDetailPage.js";
import PayeeDetailPage from "./pages/PayeeDetailPage.js";
import PayeesPage from "./pages/PayeesPage.js";
import DashboardPage from "./pages/DashboardPage.js";
import ReportsPage from "./pages/ReportsPage.js";
import ImportPage from "./pages/ImportPage.js";
import TemplateDetailPage from "./pages/TemplateDetailPage.js";
import RecurrencesPage from "./pages/RecurrencesPage.js";
import TemplatesPage from "./pages/TemplatesPage.js";
import SettingsPage from "./pages/SettingsPage.js";
import StagingPage from "./pages/StagingPage.js";
import TransactionsPage from "./pages/TransactionsPage.js";
import { detectedCurrency, detectedTimezone } from "./locale.js";
import { TimezoneProvider } from "./timezone.js";

const nav = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/accounts", label: "Accounts", icon: Landmark },
  { to: "/transactions", label: "Transactions", icon: ReceiptText },
  { to: "/reports", label: "Reports", icon: ChartColumn },
  { to: "/staged", label: "Staged", icon: Sparkles },
  { to: "/categories", label: "Categories", icon: Tags },
  { to: "/payees", label: "Payees", icon: UserRound },
  { to: "/templates", label: "Templates", icon: LayoutTemplate },
  { to: "/recurrences", label: "Recurring", icon: Repeat },
  { to: "/import", label: "Import CSV", icon: FileUp },
  { to: "/activity", label: "Activity", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
];

/**
 * A path the browser will read as a path on this site.
 *
 * `location.pathname` is whatever was typed, and `//elsewhere.example` is a
 * legal path that `window.location.assign` treats as a protocol-relative URL
 * to another origin. A backslash in that position is folded to a slash too.
 * Signing in must land back on this site, so anything else goes to the
 * overview instead.
 */
export function samePagePath(path: string) {
  return /^\/[^/\\]/.test(path) ? path : "/";
}

function SignIn({ error }: { error?: Error }) {
  const location = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const confirmationInput = useRef<HTMLInputElement>(null);
  const [localFormError, setLocalFormError] = useState("");
  // Null until somebody picks, so the screen can open on whichever form is
  // the likely one once the server says which deployment this is.
  const [registering, setRegistering] = useState<boolean | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [resetRequested, setResetRequested] = useState(false);
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const options = useQuery({
    queryKey: ["auth-methods"],
    queryFn: () => api<AuthPublicOptions>("/api/auth/methods"),
    retry: false,
  });
  const oauthParams = new URLSearchParams(location.search);
  const isMcpAuthorization =
    location.pathname === "/sign-in" &&
    oauthParams.has("client_id") &&
    oauthParams.has("redirect_uri");
  const pageReturnTo =
    location.pathname === "/sign-in"
      ? "/"
      : samePagePath(`${location.pathname}${location.search}${location.hash}`);
  const returnTo =
    isMcpAuthorization
      ? `/api/auth/mcp/authorize${location.search}`
      : pageReturnTo;
  const canRegister = options.data?.localRegistrationOpen ?? false;
  const setup =
    canRegister && (registering ?? (options.data?.awaitingFirstAccount ?? false));
  const localAuth = useMutation({
    mutationFn: async () => {
      if (!options.data) throw new Error("Authentication options are unavailable");
      if (setup) {
        if (password !== confirmation) throw new Error("Passwords do not match");
        const response = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, password, setupToken }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.message ?? "Account setup failed");
        }
        // With verification on there is no session yet, and sending somebody to
        // a ledger they cannot open would only bounce them back here.
        if (options.data.emailVerificationRequired) {
          setAwaitingVerification(true);
          return;
        }
      } else {
        const result = await authClient.signIn.email({
          email,
          password,
          rememberMe: true,
        });
        if (result.error) {
          // The password was right; the address has just never been confirmed.
          // Saying so, on the same panel as after signing up, is more use than
          // repeating the refusal. Another link is already on its way.
          if (
            result.error.code === "EMAIL_NOT_VERIFIED" ||
            result.error.message === "Email not verified"
          ) {
            setAwaitingVerification(true);
            return;
          }
          throw new Error(result.error.message ?? "Sign in failed");
        }
      }
      window.location.assign(returnTo);
    },
  });
  const requestReset = useMutation({
    mutationFn: async () => {
      // The answer is the same whether or not the address is known here, so
      // that asking is not a way to find out who has an account.
      await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });
      setResetRequested(true);
    },
  });
  const submitReset = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalFormError("");
    requestReset.mutate();
  };
  const submitLocal = (event: FormEvent<HTMLFormElement>) => {
    if (setup && password !== confirmation) {
      event.preventDefault();
      setLocalFormError("Passwords do not match");
      return;
    }
    event.preventDefault();
    setLocalFormError("");
    localAuth.mutate();
  };
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand-mark large"><CircleDollarSign size={31} /></div>
        <span className="eyebrow">Private by design</span>
        <h1>Personal accounting with safe AI automation.</h1>
        <p>
          Track accounts and transactions, import statements with a review
          step, and give AI agents only the access you choose.
        </p>
        {error && !(error instanceof ApiClientError && error.code === "UNAUTHORIZED") ? (
          <Alert>{error.message}</Alert>
        ) : null}
        {options.isPending ? <p>Loading sign-in options…</p> : null}
        {options.error ? <Alert>{options.error.message}</Alert> : null}
        {oauthParams.has("auth_error") ? (
          <Alert>Google sign-in did not complete. Try again, or sign in with your email and password.</Alert>
        ) : null}
        {awaitingVerification ? (
          <div className="local-auth-form">
            <h2>Confirm your email address</h2>
            <p className="settings-note">
              A message is on its way to {email}. Open the link in it to confirm
              the address. Until that is done the account cannot be signed in
              to. The link lasts an hour, and trying to sign in again sends a
              fresh one.
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setAwaitingVerification(false);
                setRegistering(false);
                setPassword("");
                setConfirmation("");
              }}
            >
              Back to sign in
            </Button>
          </div>
        ) : recovering ? (
          <form className="local-auth-form" onSubmit={submitReset}>
            <h2>Reset your password</h2>
            {resetRequested ? (
              <>
                <p className="settings-note">
                  If {email} has an account here, a link to choose a new
                  password is on its way. It works once and expires in an hour.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setRecovering(false);
                    setResetRequested(false);
                  }}
                >
                  Back to sign in
                </Button>
              </>
            ) : (
              <>
                <p className="settings-note">
                  Tell us the address on the account and we will send a link to
                  choose a new password.
                </p>
                <Field label="Email address">
                  <Input
                    required
                    name="email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
                {requestReset.error ? (
                  <Alert>{requestReset.error.message}</Alert>
                ) : null}
                <Button type="submit" loading={requestReset.isPending}>
                  Send the link
                </Button>
                <p className="auth-switch">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setRecovering(false)}
                  >
                    Back to sign in
                  </button>
                </p>
              </>
            )}
          </form>
        ) : options.data?.localEnabled ? (
          <form
            className="local-auth-form"
            method="post"
            action={
              setup
                ? "/api/auth/sign-up/email"
                : "/api/auth/sign-in/email"
            }
            // Submitted here rather than natively, even mid-authorization. A
            // native post hands the browser whatever the endpoint returns, and
            // a refused password or a closed registration returns JSON, which
            // leaves somebody staring at a raw error object on an API URL with
            // no way back into the flow. Signing in and then navigating to the
            // authorization endpoint reaches the same consent screen and keeps
            // failures on this page, where they can be read and retried.
            onSubmit={submitLocal}
          >
            <h2>{setup ? "Create your account" : "Sign in with your email"}</h2>
            {setup ? (
              <Field label="Your name">
                <Input
                  required
                  name="name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Email address">
              <Input
                required
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field
              label="Password"
              hint={
                setup
                  ? `At least ${options.data.minimumPasswordLength} characters`
                  : undefined
              }
            >
              <Input
                required
                name="password"
                type="password"
                minLength={options.data.minimumPasswordLength}
                maxLength={128}
                autoComplete={setup ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => {
                  const nextPassword = event.target.value;
                  setPassword(nextPassword);
                  if (confirmationInput.current) {
                    confirmationInput.current.setCustomValidity(
                      confirmationInput.current.value === nextPassword
                        ? ""
                        : "Passwords do not match",
                    );
                  }
                }}
              />
            </Field>
            {setup ? (
              <Field label="Confirm password">
                <Input
                required
                ref={confirmationInput}
                type="password"
                minLength={options.data.minimumPasswordLength}
                maxLength={128}
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  event.currentTarget.setCustomValidity(
                    event.target.value === password ? "" : "Passwords do not match",
                  );
                }}
                />
              </Field>
            ) : null}
            {setup && options.data.setupTokenRequired ? (
              <Field
                label="Setup code"
                hint="Copy this one-time code from the server startup logs"
              >
                <Input
                  required
                  name="setupToken"
                  autoComplete="one-time-code"
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                />
              </Field>
            ) : null}
            {localFormError ? <Alert>{localFormError}</Alert> : null}
            {localAuth.error ? <Alert>{localAuth.error.message}</Alert> : null}
            <Button type="submit" loading={localAuth.isPending}>
              {setup ? "Create account" : "Sign in"}
            </Button>
            {/* Only offered when there is a mail server to send the link. */}
            {!setup && options.data.passwordResetAvailable ? (
              <p className="auth-switch">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setRecovering(true);
                    setLocalFormError("");
                    localAuth.reset();
                  }}
                >
                  Forgot your password?
                </button>
              </p>
            ) : null}
            {/* Nothing to switch to until somebody has claimed the deployment,
                and nothing to switch to when registration is closed. */}
            {canRegister && !options.data.awaitingFirstAccount ? (
              <p className="auth-switch">
                {setup ? "Already have an account?" : "New here?"}{" "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setRegistering(!setup);
                    setLocalFormError("");
                    localAuth.reset();
                  }}
                >
                  {setup ? "Sign in" : "Create an account"}
                </button>
              </p>
            ) : null}
          </form>
        ) : null}
        {options.data?.googleEnabled ? (
          <>
            {options.data.localEnabled ? (
              <div className="auth-divider"><span>or</span></div>
            ) : null}
            <Button
              className="google-button"
              onClick={() =>
                authClient.signIn.social({
                  provider: "google",
                  callbackURL: returnTo,
                  // Carries the authorization parameters back, so a failed
                  // attempt returns to a page that can still finish the flow
                  // rather than to a bare sign-in screen.
                  errorCallbackURL: `/sign-in${
                    isMcpAuthorization
                      ? `${location.search}&auth_error=google`
                      : "?auth_error=google"
                  }`,
                })
              }
            >
              <svg aria-hidden viewBox="0 0 24 24">
                <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.3h5.4a4.6 4.6 0 0 1-2 3v2.8h3.5c2-1.9 3.2-4.6 3.2-7.9Z" />
                <path fill="#34A853" d="M12 22c2.9 0 5.3-1 7-2.6l-3.5-2.8c-1 .7-2.1 1-3.5 1a6.1 6.1 0 0 1-5.7-4.2H2.7v2.9A10 10 0 0 0 12 22Z" />
                <path fill="#FBBC05" d="M6.3 13.4A6 6 0 0 1 6 12c0-.5.1-1 .3-1.4V7.7H2.7A10 10 0 0 0 2 12c0 1.5.3 3 .9 4.3l3.4-2.9Z" />
                <path fill="#EA4335" d="M12 6.3c1.6 0 3 .5 4.1 1.6l3.1-3A10 10 0 0 0 2.7 7.7l3.6 2.9A6.1 6.1 0 0 1 12 6.3Z" />
              </svg>
              Continue with Google
            </Button>
            <small>
              Who may register with Google is set by the server. If you already
              have an account with a password, connect Google once in Settings
              before using this button.
            </small>
          </>
        ) : null}
      </section>
      <aside className="auth-art" aria-hidden>
        <div className="auth-orbit orbit-one" />
        <div className="auth-orbit orbit-two" />
        <div className="auth-ledger-card">
          <span>July cash flow</span>
          <strong>+$1,248.20</strong>
          <div><i /><i /><i /><i /><i /><i /><i /></div>
        </div>
      </aside>
    </main>
  );
}

const scopeDescriptions: Record<string, string> = {
  "ledger:read": "Read your accounts, transactions, and reports",
  "ledger:stage": "Propose transactions into your review queue",
  "ledger:write": "Create, edit, and delete transactions and accounts",
  offline_access: "Keep working without asking you again",
  openid: "Confirm who you are",
  profile: "See your name",
  email: "See your email address",
};

type ConsentRequest = {
  clientId: string | null;
  clientName: string;
  scopes: string[];
};

/**
 * Nothing on this screen is read from the URL except the consent code, which
 * only names a record. What the client is called and what it is asking for
 * come back from the server, so a crafted link cannot show one grant while
 * approving another.
 */
export function OAuthConsent() {
  const [params] = useSearchParams();
  const consentCode = params.get("consent_code") ?? "";
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const request = useQuery<ConsentRequest>({
    queryKey: ["consent-request", consentCode],
    enabled: Boolean(consentCode),
    retry: false,
    queryFn: () =>
      api<ConsentRequest>(
        `/api/auth/oauth2/consent-request?consent_code=${encodeURIComponent(consentCode)}`,
      ),
  });
  const decide = async (accept: boolean) => {
    setPending(true);
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, consent_code: consentCode }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "Consent failed");
      window.location.assign(payload.redirectURI);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Consent failed");
      setPending(false);
    }
  };
  const unavailable =
    !consentCode || request.isError
      ? request.error instanceof Error && consentCode
        ? request.error.message
        : "This authorization link is not one this server issued."
      : "";
  return (
    <main className="auth-shell consent-shell">
      <section className="auth-card">
        <div className="brand-mark large"><Bot size={29} /></div>
        <span className="eyebrow">Agent authorization</span>
        <h1>Allow this MCP client?</h1>
        {unavailable ? (
          <Alert>{unavailable}</Alert>
        ) : !request.data ? (
          <p>Checking what this client is asking for…</p>
        ) : (
          <>
            <p>
              <strong>{request.data.clientName}</strong> is requesting access to
              your private ledger.
            </p>
            <ul className="scope-list">
              {request.data.scopes.map((scope) => (
                <li key={scope}>
                  <strong>{scope}</strong>
                  {scopeDescriptions[scope] ? ` — ${scopeDescriptions[scope]}` : null}
                </li>
              ))}
            </ul>
            {error ? <Alert>{error}</Alert> : null}
            <div className="form-actions">
              <Button disabled={pending} variant="secondary" onClick={() => decide(false)}>
                Deny
              </Button>
              <Button loading={pending} onClick={() => decide(true)}>Allow access</Button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

/**
 * Start a new account on the timezone and currency the browser already implies.
 *
 * Every account used to begin at UTC and USD, which for most of the world is
 * wrong, and wrong in a way that misdates entries rather than merely looking
 * odd: something recorded on a California evening falls on tomorrow in UTC.
 *
 * Runs once, and only when nobody has chosen yet, so it cannot overwrite a
 * setting somebody picked on purpose, including a deliberate UTC. That is what
 * `chosen` is for. It covers whichever way the account was created, because it
 * keys off the preferences rather than off a sign-up route.
 *
 * The `chosen` check here only saves a pointless request. `ifUnchosen` is what
 * makes the rule true: this page holds the session it loaded with, and somebody
 * choosing a timezone in Settings on another tab or another device while it is
 * open would otherwise have that choice overwritten by this guess.
 */
function useAdoptBrowserRegion(session: Session) {
  const queryClient = useQueryClient();
  const asked = useRef(false);
  useEffect(() => {
    if (session.preferences.chosen || asked.current) return;
    asked.current = true;
    const timezone = detectedTimezone();
    const defaultCurrency = detectedCurrency();
    if (timezone === session.preferences.timezone &&
        defaultCurrency === session.preferences.defaultCurrency) {
      return;
    }
    void api("/api/v1/preferences", {
      ...json({ timezone, defaultCurrency, ifUnchosen: true }),
      method: "PUT",
    })
      .then(() => queryClient.invalidateQueries({ queryKey: ["session"] }))
      // Nothing here is worth interrupting somebody for: the defaults still
      // work, and Settings can change them.
      .catch(() => undefined);
  }, [queryClient, session.preferences]);
}

function Shell({ session }: { session: Session }) {
  const [mobileNav, setMobileNav] = useState(false);
  const location = useLocation();
  useAdoptBrowserRegion(session);
  const initials = session.user.name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-mark"><CircleDollarSign size={23} /></span>
          <div><strong>Simple Balance</strong><small>Personal accounting</small></div>
          <button
            className="mobile-close"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <X size={19} />
          </button>
        </div>
        <nav aria-label="Main navigation">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={{ pathname: to, search: location.search }}
              end={end}
              onClick={() => setMobileNav(false)}
            >
              <Icon size={18} /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-chip">
            {session.user.image ? (
              <img src={session.user.image} alt="" />
            ) : (
              <span>{initials}</span>
            )}
            <div><strong>{session.user.name}</strong><small>{session.user.email}</small></div>
          </div>
          <button
            className="sign-out"
            aria-label="Sign out"
            onClick={() => authClient.signOut({ fetchOptions: { onSuccess: () => window.location.reload() } })}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      {mobileNav ? <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} /> : null}
      <div className="main-column">
        <header className="mobile-header">
          <button onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={21} /></button>
          <div className="brand"><span className="brand-mark"><CircleDollarSign size={21} /></span><strong>Simple Balance</strong></div>
        </header>
        <main className="content">
          <TimezoneProvider timezone={session.preferences.timezone}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/accounts" element={<AccountsPage session={session} />} />
              <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/:report" element={<ReportsPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/staged" element={<StagingPage />} />
              <Route path="/categories" element={<CategoriesPage />} />
              <Route path="/categories/:categoryId" element={<CategoryDetailPage />} />
              <Route path="/payees" element={<PayeesPage />} />
              <Route path="/payees/transactions" element={<PayeeDetailPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route
                path="/templates/:templateId"
                element={<TemplateDetailPage />}
              />
              <Route path="/recurrences" element={<RecurrencesPage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/activity" element={<ActivityPage />} />
              <Route path="/settings" element={<SettingsPage session={session} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </TimezoneProvider>
        </main>
      </div>
    </div>
  );
}

/**
 * Where the link in a reset email lands.
 *
 * Better Auth checks the token before it redirects here, so arriving with one
 * means it was real and unexpired at that moment. It is still spent on the
 * request below rather than trusted a second time.
 */
function ResetPassword() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  const rejected = params.get("error");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [formError, setFormError] = useState("");
  const [done, setDone] = useState(false);
  const submit = useMutation({
    mutationFn: async () => {
      const result = await authClient.resetPassword({
        token,
        newPassword: password,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "That link could not be used");
      }
      setDone(true);
    },
  });
  const unusable = Boolean(rejected) || !token;
  return (
    <main className="auth-shell consent-shell">
      <section className="auth-card">
        <div className="brand-mark large"><CircleDollarSign size={31} /></div>
        <span className="eyebrow">Simple Balance</span>
        {unusable ? (
          <>
            <h1>That link has expired.</h1>
            <p>
              Reset links work once and last an hour. Ask for a new one and it
              will arrive in a moment.
            </p>
            <Button type="button" onClick={() => window.location.assign("/sign-in")}>
              Back to sign in
            </Button>
          </>
        ) : done ? (
          <>
            <h1>Your password is changed.</h1>
            <p>Sign in with the new one.</p>
            <Button type="button" onClick={() => window.location.assign("/sign-in")}>
              Sign in
            </Button>
          </>
        ) : (
          <>
            <h1>Choose a new password.</h1>
            <form
              className="local-auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                setFormError("");
                if (password !== confirmation) {
                  setFormError("Passwords do not match");
                  return;
                }
                submit.mutate();
              }}
            >
              <Field label="New password" hint="At least 12 characters">
                <Input
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <Field label="Confirm new password">
                <Input
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </Field>
              {formError ? <Alert>{formError}</Alert> : null}
              {submit.error ? <Alert>{submit.error.message}</Alert> : null}
              <Button type="submit" loading={submit.isPending}>
                Change password
              </Button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

export default function App() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api<Session>("/api/v1/session"),
    retry: false,
  });
  // Answered before anything is decided about the session, because somebody
  // resetting a password is by definition unable to sign in. The query above
  // stays unconditional so the hooks do not change shape under a navigation.
  if (window.location.pathname === "/reset-password") return <ResetPassword />;
  if (session.isPending) {
    return (
      <div className="loading-screen">
        <span className="brand-mark large"><CircleDollarSign size={29} /></span>
        <p>Opening your ledger…</p>
      </div>
    );
  }
  if (
    session.error &&
    !(session.error instanceof ApiClientError && session.error.code === "UNAUTHORIZED")
  ) {
    return (
      <main className="auth-shell consent-shell">
        <section className="auth-card">
          <div className="brand-mark large"><CircleDollarSign size={29} /></div>
          <span className="eyebrow">Connection problem</span>
          <h1>Your ledger could not be opened.</h1>
          <Alert>{session.error.message}</Alert>
          <Button type="button" onClick={() => session.refetch()}>
            Try again
          </Button>
        </section>
      </main>
    );
  }
  if (!session.data) return <SignIn error={session.error} />;
  if (window.location.pathname === "/oauth/consent") return <OAuthConsent />;
  return <Shell session={session.data} />;
}
