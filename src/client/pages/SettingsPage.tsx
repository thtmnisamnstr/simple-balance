import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useThemeSetting } from "../theme.js";
import { Bot, KeyRound, Link, Plug, Settings2, SunMoon, TriangleAlert } from "lucide-react";
import { useState, useId } from "react";
import { useSearchParams } from "../router.js";
import { formatTimestamp } from "../money.js";
import { useTimezone } from "../timezone.js";
import { api, json, type AuthPublicOptions, type Session } from "../api.js";
import { authClient } from "../auth-client.js";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Note,
  PageHeader,
  Select,
  SettingsTabs,
  Skeleton,
  useConfirm,
} from "../components.js";
import {
  currencyOptionLabel,
  currencyOptions,
  timezoneOptionLabel,
  timezoneOptions,
} from "../select-options.js";

/**
 * Named for what each one does rather than for the value it stores. "Follow my
 * system" is a standing instruction, not a color, and calling it "System"
 * leaves somebody guessing whose system and when.
 */
const THEME_CHOICES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Follow my system" },
] as const;

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
  const theme = useThemeSetting(session);
  // Two instances of this page would otherwise share one radio group and fight
  // over which is checked.
  const themeGroup = useId();
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
        eyebrow="Settings"
        title="Preferences"
        description="Choose how the app looks, how dates and amounts are shown, and how you sign in."
      />
      <SettingsTabs
        current="preferences"
        billingAvailable={authOptions.data?.billingAvailable ?? false}
      />
      <div className="settings-grid">
        {/* Two columns of independent cards rather than a grid of rows. Sharing
            rows made the short panels line up with the tall one beside them,
            leaving a stretch of nothing between this card and the next one
            under it. */}
        <div className="settings-column">
          <section className="panel panel-stack">
            <header className="section-title">
              <span>
                <SunMoon size={19} />
              </span>
              <div>
                <h2>Appearance</h2>
                <p>How the app is colored. Nothing here changes a figure.</p>
              </div>
            </header>
            {/* Outside a form and with no Save button, unlike everything else on
              this page. This is the one preference whose result is visible while
              you are choosing it, so it applies as you pick — and a Save button
              would let this and the toggle in the sidebar disagree about one
              value until somebody pressed it.

              Not wrapped in `form-fieldset`: that legend renders as a section
              label and would repeat the heading directly above it, announcing
              "Appearance" twice. The `aria-label` is kept identical to the
              heading so what is seen and what is announced agree. */}
            <div className="radio-row" role="radiogroup" aria-label="Appearance">
              {THEME_CHOICES.map(({ value, label }) => (
                <label className="check-label" key={value}>
                  <input
                    type="radio"
                    // A shared name is what makes these one group to the browser,
                    // so the arrow keys move between them and the three are one
                    // tab stop rather than three.
                    name={themeGroup}
                    value={value}
                    checked={theme.preference === value}
                    onChange={() => theme.setTheme(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <Note>
              Follow my system takes whatever this device is set to, and changes when it does. Light
              and Dark stay where you put them. Whichever you choose is saved to your account, so it
              comes back on any browser you sign in from.
            </Note>
            {theme.error ? <Alert>{theme.error.message}</Alert> : null}
          </section>

          <section className="panel panel-stack">
            <header className="section-title">
              <span>
                <Settings2 size={19} />
              </span>
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

        <div className="settings-column">
          {session.auth.localEnabled || session.auth.googleEnabled ? (
            <section className="panel panel-stack">
              <header className="section-title">
                <span>
                  <KeyRound size={19} />
                </span>
                <div>
                  <h2>Sign-in methods</h2>
                  <p>
                    {session.auth.localEnabled && session.auth.googleEnabled
                      ? "Both methods open this same private ledger when connected."
                      : "How you open this ledger."}
                  </p>
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
                <Alert>
                  Google could not be connected. Your existing sign-in method is unchanged.
                </Alert>
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
            </section>
          ) : null}

          {/* Its own card. One panel used to hold the method list, the Google
              button, the password form and a note about passwords — four jobs,
              and the note ended up below the Google button rather than beside
              the form it is about. */}
          {session.auth.localEnabled ? (
            <section className="panel panel-stack">
              <header className="section-title">
                <span>
                  <KeyRound size={19} />
                </span>
                <div>
                  <h2>Password</h2>
                  <p>Used with your email address to open this ledger.</p>
                </div>
              </header>
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
                  label={session.auth.localPasswordConfigured ? "New password" : "Set a password"}
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
                <small>
                  Changing your password signs out every other session and disconnects every MCP
                  client, so an agent authorized before the change has to be authorized again.
                </small>
                {passwordMutation.error ? <Alert>{passwordMutation.error.message}</Alert> : null}
                {passwordMutation.isSuccess ? (
                  <Alert kind="success">
                    Password updated. Any connected agents have been disconnected.
                  </Alert>
                ) : null}
                <div className="form-actions">
                  <Button type="submit" loading={passwordMutation.isPending}>
                    {session.auth.localPasswordConfigured ? "Change password" : "Set a password"}
                  </Button>
                </div>
              </form>
              {session.auth.localPasswordConfigured ? (
                <Note>
                  {authOptions.data?.passwordResetAvailable
                    ? "Forgot this password? The sign-in screen can send a link to reset it."
                    : "This deployment has no mail server, so a forgotten password cannot be reset. Keep it in a password manager."}
                </Note>
              ) : null}
            </section>
          ) : null}
        </div>
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
  recurrences: number;
  importBatches: number;
  payees: number;
  connectedAgents: number;
  activeSubscription: boolean;
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
 * Its own section at the bottom of the page rather than a menu item, because
 * nothing here is recoverable and it should not sit next to anything somebody
 * clicks by habit. What will be destroyed is counted and shown before the
 * confirmation, and the address has to be typed: it is the one thing on the
 * screen a stray click cannot produce.
 *
 * Exported for `tests/account-deletion-ui.test.tsx`, which renders it alone:
 * the page around it needs the auth client and four other sections, and none
 * of them is what the deletion copy is about.
 */
export function DeleteAccount({ session }: { session: Session }) {
  const [confirmEmail, setConfirmEmail] = useState("");
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const summary = useQuery({
    queryKey: ["own-data"],
    queryFn: () => api<OwnDataSummary>("/api/v1/me/data"),
    enabled: open,
  });
  const deletion = useMutation({
    mutationFn: () => api("/api/v1/me", { ...json({ confirmEmail }), method: "DELETE" }),
    onSuccess: () => {
      // The session went with the account, so there is nothing to return to.
      // A full load rather than a route change, to leave no cached ledger
      // behind in memory.
      window.location.href = "/";
    },
  });

  const matches = confirmEmail.trim().toLowerCase() === session.user.email.trim().toLowerCase();

  return (
    <section className="panel panel-stack danger-zone">
      <header className="section-title">
        <span>
          <TriangleAlert size={19} />
        </span>
        <div>
          <h2>Delete this account</h2>
          <p>
            Everything in it goes: accounts, transactions, categories, payees, staged rows,
            recurring transactions, import history, and every agent you have connected. This cannot
            be undone and there is no copy kept.
          </p>
        </div>
      </header>

      {open ? (
        // A `<form>`, so Enter in the one text field does what the button
        // does. BudgetsPage diagnosed this identical shape twice and left the
        // reason in a comment both times; this is the third instance, and a
        // lone confirmation field outside a form is the one where pressing
        // Enter and nothing happening reads as a page that is broken.
        <form
          className="panel-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches) setConfirmDelete(true);
          }}
        >
          {summary.isLoading ? <Skeleton height={20} label="Counting your records…" /> : null}
          {summary.error ? <Alert>{summary.error.message}</Alert> : null}
          {summary.data ? (
            <Note>
              This will delete {plural(summary.data.transactions, "transaction")} across{" "}
              {plural(summary.data.accounts, "account")}, along with{" "}
              {readableList([
                plural(summary.data.categories, "category", "categories"),
                plural(summary.data.payees, "payee"),
                summary.data.stagedTransactions > 0
                  ? plural(summary.data.stagedTransactions, "staged row")
                  : null,
                summary.data.recurrences > 0
                  ? plural(summary.data.recurrences, "recurring transaction")
                  : null,
                summary.data.importBatches > 0
                  ? plural(summary.data.importBatches, "import")
                  : null,
                summary.data.connectedAgents > 0
                  ? plural(summary.data.connectedAgents, "connected agent")
                  : null,
              ])}
              .
              {/* Last, and a sentence of its own rather than an item in the
                  list above. Everything in that list is a number saying how
                  much is lost; this is the one that costs money, cannot be
                  undone by re-entering it, and is the thing somebody would most
                  want to have been told before they typed their address.

                  Worded to be true of everything the flag covers, which is
                  narrower than what the deletion cancels and deliberately so.
                  `hasLiveSubscription` reads `paidForSubscriptionStatuses` —
                  the live statuses minus `incomplete` — while
                  `closeBillingForDeletion` deletes the Stripe customer and so
                  ends every subscription it owns, a first payment that never
                  finished included. Saying nothing about that one is the point:
                  nothing was charged for it and the plan tab calls its owner
                  Free, so a note about a canceled plan told somebody who had
                  paid nothing that they were losing one. The one status in the
                  set nobody paid for is an operator's hand-made `trialing`, and
                  the sentence below does not claim they did. And it says what
                  the deletion does not do:
                  deleting the Stripe customer ends the subscription at once
                  with no proration and no refund, and the sentence used to stop
                  at "cannot be restored", which a person who paid for a year in
                  March could read as the rest of it coming back. A refund is
                  the operator's to give by hand, so it names who to ask, in the
                  words the deletion's own refusal uses. */}
              {summary.data.activeSubscription ? (
                <>
                  {" "}
                  Your subscription is canceled at the same time, immediately and for good — a
                  canceled subscription cannot be restored. Nothing is refunded, so any time left on
                  what you paid for is lost. If you think you are owed a refund, contact whoever
                  runs this server before you delete.
                </>
              ) : null}
            </Note>
          ) : null}
          {/* The person's own address, so it says so (SC 1.3.5): `type="email"`
              and the `email` token, which is what lets a password manager or
              a speech tool fill it. It turned autofill off, and repeated the
              address in a placeholder beside the hint that already shows it.
              What makes this deliberate is the button and the dialog after
              it, not making somebody retype what their browser knows. */}
          <Field label="Type your email address to confirm" hint={session.user.email}>
            <Input
              required
              type="email"
              autoComplete="email"
              value={confirmEmail}
              onChange={(event) => setConfirmEmail(event.target.value)}
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
              type="submit"
              variant="danger"
              disabled={!matches}
              loading={deletion.isPending}
              disabledReason="Type your email address exactly as it appears above."
            >
              Delete my account and all my data
            </Button>
          </div>
        </form>
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
        // The last thing somebody confirms, so it names the one item that
        // costs money as the note above does. It used to leave the subscription
        // out entirely, although the summary saying there is one has loaded by
        // the time this can open.
        description={
          summary.data
            ? `${plural(summary.data.transactions, "transaction")} across ${plural(summary.data.accounts, "account")} and everything else in this ledger will be removed now. There is no copy and no undo. Any agent you have connected loses access immediately.${
                summary.data.activeSubscription
                  ? " Your subscription ends now, and nothing is refunded."
                  : ""
              }`
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

// Through the shared formatter, in the account's zone — a bare
// toLocaleString() answered in the browser's.
const when = (value: string | null, timezone: string) =>
  value ? formatTimestamp(value, timezone) : null;

function ConnectedApps() {
  const queryClient = useQueryClient();
  const timezone = useTimezone();
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
    // `revokedTokenCount` goes unread: how many tokens an authorization had
    // issued is the server's bookkeeping, and what a person asked is whether
    // the agent is gone, which the list read again here answers.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["connected-apps"] });
    },
  });

  return (
    <section className="panel panel-stack">
      <header className="section-title">
        <span>
          <Bot size={19} />
        </span>
        <div>
          <h2>Connected agents</h2>
          <p>MCP clients you have let into this ledger, and what each may do.</p>
        </div>
      </header>

      {revokeMutation.error ? <Alert>{revokeMutation.error.message}</Alert> : null}

      {/* One chain, not three sibling expressions. 12.1's four states are
          exclusive, and written as siblings the error rendered BESIDE the
          empty state rather than in front of it — the same shape six other
          lists were fixed out of. `isPending` rather than `isLoading`, which
          is `isPending && isFetching`: this was the one list slot in the app
          keyed on the second, so a query that had not started yet showed the
          empty state instead of the skeleton. */}
      {apps.isPending ? (
        <Skeleton height={64} label="Loading connected apps…" />
      ) : apps.isError ? (
        <Alert>{apps.error.message}</Alert>
      ) : apps.data.length === 0 ? (
        <EmptyState
          compact
          icon={Plug}
          title="Nothing is connected"
          body="An agent appears here once you approve it, and you can withdraw that approval at any time."
        />
      ) : (
        apps.data.map((app) => (
          <div key={app.clientId} className="connected-app">
            <div>
              <strong>{app.name}</strong>
              <Badge tone={app.hasLiveAccess ? "green" : undefined}>
                {app.hasLiveAccess ? "Active" : "No live token"}
              </Badge>
              <Note>
                {/* When it last took a token, how many it holds, and when the
                    approval runs out, because "is this thing still using my
                    ledger" is the question this page exists to answer — the
                    API sent all four from the first day and the page dropped
                    them on the floor. `expiresAt` was still on the floor after
                    the other two were picked up, two lines from the comment
                    recording it. */}
                {scopeSummary(app.scopes)}
                {when(app.authorizedAt, timezone)
                  ? ` · approved ${when(app.authorizedAt, timezone)}`
                  : ""}
                {when(app.lastIssuedAt, timezone)
                  ? ` · last token ${when(app.lastIssuedAt, timezone)}`
                  : ""}
                {when(app.expiresAt, timezone)
                  ? ` · approval runs out ${when(app.expiresAt, timezone)}`
                  : ""}
                {app.activeTokenCount > 0
                  ? ` · ${app.activeTokenCount} active token${app.activeTokenCount === 1 ? "" : "s"}`
                  : ""}
              </Note>
            </div>
            <Button
              type="button"
              variant="danger"
              loading={revokeMutation.isPending && revokeMutation.variables === app.clientId}
              onClick={() => revocation.ask(app, () => revokeMutation.mutate(app.clientId))}
            >
              Revoke
            </Button>
          </div>
        ))
      )}

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
