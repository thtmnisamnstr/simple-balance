import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, KeyRound, Link, Settings2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "../router.js";
import { api, json, type AuthPublicOptions, type Session } from "../api.js";
import { authClient } from "../auth-client.js";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  PageHeader,
  Select,
  useConfirm,
} from "../components.js";
import {
  currencyOptionLabel,
  currencyOptions,
  timezoneOptionLabel,
  timezoneOptions,
} from "../select-options.js";

export default function SettingsPage({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  // Whether a forgotten password can be recovered is a property of the
  // deployment, not of the account, so it comes from the same place the
  // sign-in screen asks.
  const authOptions = useQuery({
    queryKey: ["auth-methods"],
    queryFn: () => api<AuthPublicOptions>("/api/auth/methods"),
    retry: false,
  });
  const [searchParams] = useSearchParams();
  const [timezone, setTimezone] = useState(session.preferences.timezone);
  const [currency, setCurrency] = useState(session.preferences.defaultCurrency);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");

  const preferencesMutation = useMutation({
    mutationFn: () =>
      api("/api/v1/preferences", {
        ...json({ timezone, defaultCurrency: currency.toUpperCase() }),
        method: "PUT",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });
  const passwordMutation = useMutation({
    mutationFn: async () => {
      if (newPassword !== passwordConfirmation) {
        throw new Error("New passwords do not match");
      }
      if (session.auth.localPasswordConfigured) {
        const result = await authClient.changePassword({
          currentPassword,
          newPassword,
          revokeOtherSessions: true,
        });
        if (result.error) {
          throw new Error(result.error.message ?? "Password could not be changed");
        }
        return result.data;
      }
      return api("/api/v1/auth/local-password", {
        ...json({ newPassword }),
      });
    },
    onSuccess: async () => {
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });
  const googleLinkMutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.linkSocial({
        provider: "google",
        callbackURL: "/settings",
        errorCallbackURL: "/settings?auth_error=google-link",
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Google could not be connected");
      }
      return result.data;
    },
  });

  return (
    <>
      <PageHeader
        eyebrow="Preferences"
        title="Settings"
        description="Choose how dates and amounts are shown, and manage how you sign in."
      />
      <div className="settings-grid">
        {/* Two columns of independent cards rather than a grid of rows. Sharing
            rows made the short panels line up with the tall one beside them,
            leaving a stretch of nothing between this card and the next one
            under it. */}
        <div className="settings-column">
        <section className="panel settings-section">
          <header className="section-title">
            <span><Settings2 size={19} /></span>
            <div>
              <h2>Regional defaults</h2>
              <p>Default dates, date ranges, and calculations use this timezone.</p>
            </div>
          </header>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              preferencesMutation.mutate();
            }}
          >
            <Field label="Timezone">
              <Select
                required
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {timezoneOptions(timezone).map((option) => (
                  <option key={option} value={option}>
                    {timezoneOptionLabel(option)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Default account currency or crypto asset">
              <Select
                required
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                {currencyOptions(currency).map((option) => (
                  <option key={option} value={option}>
                    {currencyOptionLabel(option)}
                  </option>
                ))}
              </Select>
            </Field>
            {preferencesMutation.error ? (
              <Alert>{preferencesMutation.error.message}</Alert>
            ) : null}
            {preferencesMutation.isSuccess ? (
              <Alert kind="success">Preferences saved.</Alert>
            ) : null}
            <div className="form-actions">
              <Button type="submit" loading={preferencesMutation.isPending}>
                Save preferences
              </Button>
            </div>
          </form>
        </section>

        <ConnectedApps />
        </div>

        {(session.auth.localEnabled || session.auth.googleEnabled) ? (
          <div className="settings-column">
          <section className="panel settings-section">
            <header className="section-title">
              <span><KeyRound size={19} /></span>
              <div>
                <h2>Sign-in methods</h2>
                <p>Both methods open this same private ledger when connected.</p>
              </div>
            </header>
            <div className="auth-method-status">
              {session.auth.localEnabled ? (
                <div>
                  <strong>Email and password</strong>
                  <Badge tone={session.auth.localPasswordConfigured ? "green" : undefined}>
                    {session.auth.localPasswordConfigured ? "Ready" : "Not configured"}
                  </Badge>
                </div>
              ) : null}
              {session.auth.googleEnabled ? (
                <div>
                  <strong>Google</strong>
                  <Badge tone={session.auth.googleLinked ? "green" : undefined}>
                    {session.auth.googleLinked ? "Connected" : "Not connected"}
                  </Badge>
                </div>
              ) : null}
            </div>
            {searchParams.get("auth_error") === "google-link" ? (
              <Alert>Google could not be connected. Your existing sign-in method is unchanged.</Alert>
            ) : null}
            {session.auth.localEnabled ? (
              <form
                className="form-grid"
                onSubmit={(event) => {
                  event.preventDefault();
                  passwordMutation.mutate();
                }}
              >
                {session.auth.localPasswordConfigured ? (
                  <Field label="Current password">
                    <Input
                      required
                      name="currentPassword"
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                    />
                  </Field>
                ) : null}
                <Field
                  label={
                    session.auth.localPasswordConfigured
                      ? "New password"
                      : "Set a password"
                  }
                  hint="12–128 characters"
                >
                  <Input
                    required
                    name="newPassword"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </Field>
                <Field label="Confirm new password">
                  <Input
                    required
                    name="newPasswordConfirmation"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    value={passwordConfirmation}
                    onChange={(event) => setPasswordConfirmation(event.target.value)}
                  />
                </Field>
                {passwordMutation.error ? (
                  <Alert>{passwordMutation.error.message}</Alert>
                ) : null}
                {passwordMutation.isSuccess ? (
                  <Alert kind="success">Password updated.</Alert>
                ) : null}
                <div className="form-actions">
                  <Button type="submit" loading={passwordMutation.isPending}>
                    {session.auth.localPasswordConfigured
                      ? "Change password"
                      : "Set a password"}
                  </Button>
                </div>
              </form>
            ) : null}
            {session.auth.googleEnabled && !session.auth.googleLinked ? (
              <div className="provider-action">
                <Button
                  type="button"
                  variant="secondary"
                  loading={googleLinkMutation.isPending}
                  onClick={() => googleLinkMutation.mutate()}
                >
                  <Link size={16} /> Connect Google
                </Button>
                {googleLinkMutation.error ? (
                  <Alert>{googleLinkMutation.error.message}</Alert>
                ) : null}
              </div>
            ) : null}
            {session.auth.localPasswordConfigured ? (
              <p className="settings-note">
                {authOptions.data?.passwordResetAvailable
                  ? "Forgotten this password? The sign-in screen can send a link to reset it."
                  : "This deployment has no mail server, so a forgotten password cannot be reset. Keep it in a password manager."}
              </p>
            ) : null}
          </section>
          </div>
        ) : null}
      </div>

      <DeleteAccount session={session} />
    </>
  );
}

type OwnDataSummary = {
  accounts: number;
  transactions: number;
  categories: number;
  stagedTransactions: number;
  importBatches: number;
  payees: number;
  connectedAgents: number;
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** "a, b and c", skipping the parts that do not apply to this account. */
const readableList = (parts: (string | null)[]) => {
  const present = parts.filter((part): part is string => Boolean(part));
  if (present.length <= 1) return present.join("");
  return `${present.slice(0, -1).join(", ")} and ${present[present.length - 1]}`;
};

/**
 * Leaving, and taking everything with you.
 *
 * Its own section at the foot of the page rather than a menu item, because
 * nothing here is recoverable and it should not sit next to anything somebody
 * clicks by habit. What will be destroyed is counted and shown before the
 * confirmation, and the address has to be typed: it is the one thing on the
 * screen a stray click cannot produce.
 */
function DeleteAccount({ session }: { session: Session }) {
  const [confirmEmail, setConfirmEmail] = useState("");
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const summary = useQuery({
    queryKey: ["own-data"],
    queryFn: () => api<OwnDataSummary>("/api/v1/me/data"),
    enabled: open,
  });
  const deletion = useMutation({
    mutationFn: () =>
      api("/api/v1/me", { ...json({ confirmEmail }), method: "DELETE" }),
    onSuccess: () => {
      // The session went with the account, so there is nothing to return to.
      // A full load rather than a route change, to leave no cached ledger
      // behind in memory.
      window.location.href = "/";
    },
  });

  const matches =
    confirmEmail.trim().toLowerCase() === session.user.email.trim().toLowerCase();

  return (
    <section className="panel settings-section danger-zone">
      <header className="section-title">
        <span><TriangleAlert size={19} /></span>
        <div>
          <h2>Delete this account</h2>
          <p>
            Everything in it goes: accounts, transactions, categories, payees,
            staged rows, import history, and every agent you have connected.
            This cannot be undone and there is no copy kept.
          </p>
        </div>
      </header>

      {open ? (
        <>
          {summary.isLoading ? <p className="settings-note">Counting…</p> : null}
          {summary.error ? <Alert>{summary.error.message}</Alert> : null}
          {summary.data ? (
            <p className="settings-note">
              This will delete{" "}
              {plural(summary.data.transactions, "transaction")} across{" "}
              {plural(summary.data.accounts, "account")}, along with{" "}
              {readableList([
                plural(summary.data.categories, "category", "categories"),
                plural(summary.data.payees, "payee"),
                summary.data.stagedTransactions > 0
                  ? plural(summary.data.stagedTransactions, "staged row")
                  : null,
                summary.data.importBatches > 0
                  ? plural(summary.data.importBatches, "import")
                  : null,
                summary.data.connectedAgents > 0
                  ? plural(summary.data.connectedAgents, "connected agent")
                  : null,
              ])}
              .
            </p>
          ) : null}
          <Field
            label="Type your email address to confirm"
            hint={session.user.email}
          >
            <Input
              value={confirmEmail}
              autoComplete="off"
              onChange={(event) => setConfirmEmail(event.target.value)}
              placeholder={session.user.email}
            />
          </Field>
          {deletion.error ? <Alert>{deletion.error.message}</Alert> : null}
          <div className="form-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setConfirmEmail("");
                deletion.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={!matches}
              loading={deletion.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              Delete my account and all my data
            </Button>
          </div>
        </>
      ) : (
        <div className="form-actions">
          <Button type="button" variant="danger" onClick={() => setOpen(true)}>
            Delete this account
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this account for good?"
        description={
          summary.data
            ? `${plural(summary.data.transactions, "transaction")} across ${plural(summary.data.accounts, "account")} and everything else in this ledger will be removed now. There is no copy and no undo. Any agent you have connected loses access immediately.`
            : "Everything in this ledger will be removed now. There is no copy and no undo."
        }
        confirmLabel="Delete everything"
        onConfirm={() => {
          setConfirmDelete(false);
          deletion.mutate();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}

type ConnectedApp = {
  clientId: string;
  name: string;
  scopes: string[];
  authorizedAt: string | null;
  lastIssuedAt: string | null;
  expiresAt: string | null;
  activeTokenCount: number;
  hasLiveAccess: boolean;
};

const scopeSummary = (scopes: string[]) => {
  const ledger = scopes.filter((scope) => scope.startsWith("ledger:"));
  if (ledger.includes("ledger:write")) return "Read, stage, and commit";
  if (ledger.includes("ledger:stage")) return "Read and queue for review";
  if (ledger.includes("ledger:read")) return "Read only";
  return "No ledger access";
};

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString() : null;

/**
 * What an agent was allowed to do, and the way to stop it.
 *
 * Authorizing an MCP client was previously a one-way door from the browser.
 * Revoking here deletes the tokens rather than waiting for them to expire, so
 * an agent loses access on its very next call.
 */
function ConnectedApps() {
  const queryClient = useQueryClient();
  const revocation = useConfirm<ConnectedApp>();
  const apps = useQuery({
    queryKey: ["connected-apps"],
    queryFn: () => api<ConnectedApp[]>("/api/v1/connected-apps"),
  });
  const revokeMutation = useMutation({
    mutationFn: (clientId: string) =>
      // The body is empty but has to be sent: /api/v1 requires a JSON content
      // type on anything that changes state, which a cross-origin form cannot
      // set. Every other destructive call in the app carries one for the same
      // reason.
      api(`/api/v1/connected-apps/${encodeURIComponent(clientId)}`, {
        ...json({}),
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["connected-apps"] });
    },
  });

  return (
    <section className="panel settings-section">
      <header className="section-title">
        <span><Bot size={19} /></span>
        <div>
          <h2>Connected agents</h2>
          <p>MCP clients you have let into this ledger, and what each may do.</p>
        </div>
      </header>

      {apps.isLoading ? <p className="settings-note">Loading…</p> : null}
      {apps.error ? <Alert>{apps.error.message}</Alert> : null}
      {revokeMutation.error ? <Alert>{revokeMutation.error.message}</Alert> : null}

      {apps.data && apps.data.length === 0 ? (
        <p className="settings-note">
          Nothing is connected. An agent appears here once you approve it, and
          you can withdraw that approval at any time.
        </p>
      ) : null}

      {apps.data?.map((app) => (
        <div key={app.clientId} className="connected-app">
          <div>
            <strong>{app.name}</strong>
            <Badge tone={app.hasLiveAccess ? "green" : undefined}>
              {app.hasLiveAccess ? "Active" : "No live token"}
            </Badge>
            <p className="settings-note">
              {scopeSummary(app.scopes)}
              {when(app.authorizedAt) ? ` · approved ${when(app.authorizedAt)}` : ""}
            </p>
          </div>
          <Button
            type="button"
            variant="danger"
            loading={
              revokeMutation.isPending &&
              revokeMutation.variables === app.clientId
            }
            onClick={() =>
              revocation.ask(app, () => revokeMutation.mutate(app.clientId))
            }
          >
            Revoke
          </Button>
        </div>
      ))}

      <ConfirmDialog
        open={revocation.open}
        title="Revoke this agent's access?"
        description={
          revocation.value
            ? `“${revocation.value.name}” loses access immediately, including any token it is already holding, and it cannot renew. Your ledger is not changed and anything it already recorded stays. To let it back in, authorize it again from the agent itself.`
            : undefined
        }
        confirmLabel="Revoke"
        onConfirm={revocation.confirm}
        onCancel={revocation.cancel}
      />
    </section>
  );
}
