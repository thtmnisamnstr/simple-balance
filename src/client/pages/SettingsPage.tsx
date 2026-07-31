import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  KeyRound,
  Link,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { useSearchParams } from "../router.js";
import type { CategoryKind } from "../../shared/domain.js";
import { api, json, type Category, type Session } from "../api.js";
import { authClient } from "../auth-client.js";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  PageHeader,
  Select,
} from "../components.js";

const kindLabels: Record<CategoryKind, string> = {
  income: "Income",
  expense: "Expense",
  both: "Income or expense",
};

export default function SettingsPage({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [timezone, setTimezone] = useState(session.preferences.timezone);
  const [currency, setCurrency] = useState(session.preferences.defaultCurrency);
  const [categoryName, setCategoryName] = useState("");
  const [categoryKind, setCategoryKind] = useState<CategoryKind>("expense");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");

  const categories = useQuery({
    queryKey: ["categories", includeArchived],
    queryFn: () =>
      api<Category[]>(
        `/api/v1/categories${includeArchived ? "?includeArchived=true" : ""}`,
      ),
  });
  const preferencesMutation = useMutation({
    mutationFn: () =>
      api("/api/v1/preferences", {
        ...json({ timezone, defaultCurrency: currency.toUpperCase() }),
        method: "PUT",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });
  const categoryMutation = useMutation({
    mutationFn: async (
      input:
        | { action: "create"; name: string; kind: CategoryKind }
        | {
            action: "update";
            category: Category;
            name: string;
            kind: CategoryKind;
          }
        | { action: "archive" | "delete"; category: Category },
    ) => {
      if (input.action === "create") {
        return api<Category>(
          "/api/v1/categories",
          json({ name: input.name, kind: input.kind }),
        );
      }
      if (input.action === "update") {
        return api<Category>(`/api/v1/categories/${input.category.id}`, {
          ...json({
            name: input.name,
            kind: input.kind,
            expectedVersion: input.category.version,
          }),
          method: "PUT",
        });
      }
      if (input.action === "archive") {
        return api<Category>(`/api/v1/categories/${input.category.id}/archive`, {
          ...json({
            expectedVersion: input.category.version,
            archived: !input.category.archivedAt,
          }),
        });
      }
      return api(`/api/v1/categories/${input.category.id}`, {
        ...json({ expectedVersion: input.category.version }),
        method: "DELETE",
      });
    },
    onSuccess: async () => {
      setCategoryName("");
      await queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
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

  const addCategory = (event: FormEvent) => {
    event.preventDefault();
    categoryMutation.mutate({
      action: "create",
      name: categoryName,
      kind: categoryKind,
    });
  };

  return (
    <>
      <PageHeader
        eyebrow="Preferences"
        title="Settings"
        description="Choose local display defaults and keep your category list tidy."
      />
      <div className="settings-grid">
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
              <Input
                required
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="America/Los_Angeles"
              />
            </Field>
            <Field label="Default account currency">
              <Input
                required
                value={currency}
                maxLength={3}
                pattern="[A-Za-z]{3}"
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              />
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

        {(session.auth.localEnabled || session.auth.googleEnabled) ? (
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
                  <strong>Local password</strong>
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
                      : "Create local password"
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
                  <Alert kind="success">Local password updated.</Alert>
                ) : null}
                <div className="form-actions">
                  <Button type="submit" loading={passwordMutation.isPending}>
                    {session.auth.localPasswordConfigured
                      ? "Change password"
                      : "Add local password"}
                  </Button>
                </div>
              </form>
            ) : null}
            {session.auth.googleEnabled && !session.auth.googleLinked ? (
              <div className="provider-action">
                {session.auth.googleEligible ? (
                  <Button
                    type="button"
                    variant="secondary"
                    loading={googleLinkMutation.isPending}
                    onClick={() => googleLinkMutation.mutate()}
                  >
                    <Link size={16} /> Connect Google
                  </Button>
                ) : (
                  <Alert kind="info">
                    Add this account’s email to ALLOWED_EMAILS before connecting Google.
                  </Alert>
                )}
                {googleLinkMutation.error ? (
                  <Alert>{googleLinkMutation.error.message}</Alert>
                ) : null}
              </div>
            ) : null}
            {session.auth.localPasswordConfigured ? (
              <p className="settings-note">
                There is no email-based password recovery in this self-hosted
                version. Keep the password in a password manager.
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="panel settings-section">
          <div className="section-title category-heading">
            <div>
              <h2>Categories</h2>
              <p>Flat, simple labels for reporting. Used categories can be archived.</p>
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              Show archived
            </label>
          </div>
          <form className="inline-form" onSubmit={addCategory}>
            <Input
              required
              aria-label="Category name"
              placeholder="Groceries"
              value={categoryName}
              onChange={(event) => setCategoryName(event.target.value)}
            />
            <Select
              aria-label="Category applies to"
              value={categoryKind}
              onChange={(event) =>
                setCategoryKind(event.target.value as CategoryKind)
              }
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
              <option value="both">Both</option>
            </Select>
            <Button type="submit" loading={categoryMutation.isPending}>
              <Plus size={16} /> Add
            </Button>
          </form>
          {categoryMutation.error ? <Alert>{categoryMutation.error.message}</Alert> : null}
          <div className="category-list">
            {categories.data?.map((category) => (
              <div className="category-row" key={category.id}>
                <div>
                  <strong>{category.name}</strong>
                  <Badge tone={category.kind === "expense" ? "red" : "green"}>
                    {kindLabels[category.kind]}
                  </Badge>
                  {category.archivedAt ? <Badge>Archived</Badge> : null}
                </div>
                <div className="row-actions">
                  <button
                    aria-label="Rename category"
                    onClick={() => {
                      const name = window.prompt("Category name", category.name)?.trim();
                      if (!name) return;
                      const requestedKind = window
                        .prompt(
                          "Applicability: income, expense, or both",
                          category.kind,
                        )
                        ?.trim()
                        .toLowerCase();
                      if (
                        requestedKind === "income" ||
                        requestedKind === "expense" ||
                        requestedKind === "both"
                      ) {
                        categoryMutation.mutate({
                          action: "update",
                          category,
                          name,
                          kind: requestedKind,
                        });
                      }
                    }}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    aria-label={category.archivedAt ? "Restore category" : "Archive category"}
                    onClick={() =>
                      categoryMutation.mutate({ action: "archive", category })
                    }
                  >
                    {category.archivedAt ? (
                      <ArchiveRestore size={16} />
                    ) : (
                      <Archive size={16} />
                    )}
                  </button>
                  <button
                    aria-label="Delete unused category"
                    onClick={() => {
                      if (window.confirm(`Delete unused category “${category.name}”?`)) {
                        categoryMutation.mutate({ action: "delete", category });
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
            {!categories.data?.length ? (
              <p className="panel-empty">No categories yet. Transactions can remain uncategorized.</p>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}
