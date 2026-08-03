import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link, Settings2 } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "../router.js";
import { api, json, type Session } from "../api.js";
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
import {
  currencyOptionLabel,
  currencyOptions,
  timezoneOptionLabel,
  timezoneOptions,
} from "../select-options.js";

export default function SettingsPage({ session }: { session: Session }) {
  const queryClient = useQueryClient();
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
        description="Choose local display defaults and manage your sign-in methods."
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
                There is no email-based password recovery in this self-hosted
                version. Keep the password in a password manager.
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </>
  );
}
