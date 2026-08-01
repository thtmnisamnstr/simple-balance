import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bot,
  CircleDollarSign,
  FileUp,
  History,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  Settings,
  Sparkles,
  Tags,
  UserRound,
  X,
} from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
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
import ImportPage from "./pages/ImportPage.js";
import SettingsPage from "./pages/SettingsPage.js";
import StagingPage from "./pages/StagingPage.js";
import TransactionsPage from "./pages/TransactionsPage.js";
import { TimezoneProvider } from "./timezone.js";

const nav = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/accounts", label: "Accounts", icon: Landmark },
  { to: "/transactions", label: "Transactions", icon: ReceiptText },
  { to: "/staged", label: "Staged", icon: Sparkles },
  { to: "/categories", label: "Categories", icon: Tags },
  { to: "/payees", label: "Payees", icon: UserRound },
  { to: "/import", label: "Import CSV", icon: FileUp },
  { to: "/activity", label: "Activity", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
];

function SignIn({ error }: { error?: Error }) {
  const location = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const confirmationInput = useRef<HTMLInputElement>(null);
  const [localFormError, setLocalFormError] = useState("");
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
      : `${location.pathname}${location.search}${location.hash}`;
  const returnTo =
    isMcpAuthorization
      ? `/api/auth/mcp/authorize${location.search}`
      : pageReturnTo;
  const localAuth = useMutation({
    mutationFn: async () => {
      if (!options.data) throw new Error("Authentication options are unavailable");
      if (options.data.localRegistrationOpen) {
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
      } else {
        const result = await authClient.signIn.email({
          email,
          password,
          rememberMe: true,
        });
        if (result.error) throw new Error(result.error.message ?? "Sign in failed");
      }
      window.location.assign(returnTo);
    },
  });
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
  const setup = options.data?.localRegistrationOpen;
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
          <Alert>Google sign-in did not complete. Try again or use your local password.</Alert>
        ) : null}
        {options.data?.localEnabled ? (
          <form
            className="local-auth-form"
            method="post"
            action={
              setup
                ? "/api/auth/sign-up/email"
                : "/api/auth/sign-in/email"
            }
            // Better Auth's MCP plugin completes the stored OAuth prompt by
            // redirecting after login. A native form keeps that redirect as a
            // top-level navigation instead of following the agent callback in
            // a background fetch.
            onSubmit={isMcpAuthorization ? undefined : submitLocal}
          >
            <h2>{setup ? "Create your owner account" : "Sign in locally"}</h2>
            {setup && options.data.mode === "both" ? (
              <small>
                Use the owner email configured in the server’s ALLOWED_EMAILS list.
              </small>
            ) : null}
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
                label="Owner setup code"
                hint="Copy this one-time code from the container startup logs"
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
                  errorCallbackURL: "/sign-in?auth_error=google",
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
              Google access is limited to allowlisted emails. If you created the
              owner locally, connect Google once in Settings before using this button.
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

function OAuthConsent() {
  const [params] = useSearchParams();
  const consentCode = params.get("consent_code") ?? "";
  const clientId = params.get("client_id") ?? "an MCP client";
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
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
  return (
    <main className="auth-shell consent-shell">
      <section className="auth-card">
        <div className="brand-mark large"><Bot size={29} /></div>
        <span className="eyebrow">Agent authorization</span>
        <h1>Allow this MCP client?</h1>
        <p><strong>{clientId}</strong> is requesting access to your private ledger.</p>
        <ul className="scope-list">
          {scopes.map((scope) => <li key={scope}>{scope}</li>)}
        </ul>
        {error ? <Alert>{error}</Alert> : null}
        <div className="form-actions">
          <Button disabled={pending} variant="secondary" onClick={() => decide(false)}>
            Deny
          </Button>
          <Button loading={pending} onClick={() => decide(true)}>Allow access</Button>
        </div>
      </section>
    </main>
  );
}

function Shell({ session }: { session: Session }) {
  const [mobileNav, setMobileNav] = useState(false);
  const location = useLocation();
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
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/staged" element={<StagingPage />} />
              <Route path="/categories" element={<CategoriesPage />} />
              <Route path="/categories/:categoryId" element={<CategoryDetailPage />} />
              <Route path="/payees" element={<PayeesPage />} />
              <Route path="/payees/transactions" element={<PayeeDetailPage />} />
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

export default function App() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api<Session>("/api/v1/session"),
    retry: false,
  });
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
