import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Building2,
  CreditCard,
  Landmark,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  WalletCards,
} from "lucide-react";
import { useState } from "react";
import { Link } from "../router.js";
import {
  accountTypeLabels,
  liabilityAccountTypes,
  type AccountType,
} from "../../shared/domain.js";
import { api, json, type Account, type Session } from "../api.js";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  formatMoney,
  isNegativeMoney,
  Modal,
  PageHeader,
} from "../components.js";
import { AccountForm } from "../forms.js";
import { calendarDateInTimezone } from "../timezone.js";

const iconFor = (type: AccountType) => {
  if (type === "cash" || type === "crypto_wallet") return WalletCards;
  if (type === "credit_card" || type === "debit_card") return CreditCard;
  if (type === "loan" || type.includes("liability")) return Building2;
  return Landmark;
};

export default function AccountsPage({ session }: { session: Session }) {
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const queryClient = useQueryClient();
  const today = calendarDateInTimezone(
    new Date(),
    session.preferences.timezone,
  );
  const accounts = useQuery({
    queryKey: ["accounts", "all", includeArchived, today],
    queryFn: () =>
      api<Account[]>(
        `/api/v1/accounts?end=${today}${
          includeArchived ? "&includeArchived=true" : ""
        }`,
      ),
  });
  const mutation = useMutation({
    mutationFn: ({
      account,
      action,
    }: {
      account: Account;
      action: "archive" | "delete";
    }) =>
      action === "archive"
        ? api<Account>(`/api/v1/accounts/${account.id}/archive`, {
            ...json({
              expectedVersion: account.version,
              archived: !account.archivedAt,
            }),
          })
        : api(`/api/v1/accounts/${account.id}`, {
            ...json({ expectedVersion: account.version }),
            method: "DELETE",
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["summary"] });
    },
  });

  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="Places your money lives"
        description="Each account keeps its native currency. In-use accounts are archived instead of erased."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus size={16} /> New account
          </Button>
        }
      />
      <div className="toolbar">
        <label className="check-label">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Show archived accounts
        </label>
      </div>
      {mutation.error ? <Alert>{mutation.error.message}</Alert> : null}
      {accounts.data?.length ? (
        <div className="account-card-grid">
          {accounts.data.map((account) => {
            const Icon = iconFor(account.type);
            const liability = liabilityAccountTypes.has(account.type);
            return (
              <article
                className={`account-card ${account.archivedAt ? "archived" : ""}`}
                key={account.id}
              >
                <header>
                  <span className="account-icon"><Icon size={20} /></span>
                  <div className="account-card-actions">
                    {account.archivedAt ? <Badge>Archived</Badge> : null}
                    <details className="menu">
                      <summary aria-label={`Actions for ${account.name}`}>
                        <MoreHorizontal size={18} />
                      </summary>
                      <div className="menu-popover">
                        <button onClick={() => setEditing(account)}>
                          <Pencil size={15} /> Edit
                        </button>
                        <button
                          onClick={() => mutation.mutate({ account, action: "archive" })}
                        >
                          {account.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                          {account.archivedAt ? "Restore" : "Archive"}
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            if (window.confirm(`Delete unused account “${account.name}”?`)) {
                              mutation.mutate({ account, action: "delete" });
                            }
                          }}
                        >
                          <Trash2 size={15} /> Delete if unused
                        </button>
                      </div>
                    </details>
                  </div>
                </header>
                <Link
                  className="account-card-link"
                  to={{ pathname: `/accounts/${account.id}`, search: location.search }}
                >
                  <div className="account-card-main">
                    <span>{accountTypeLabels[account.type]}</span>
                    <h2>{account.name}</h2>
                    {account.institution ? <p>{account.institution}</p> : null}
                  </div>
                  <footer>
                    <div>
                      <span>{account.balancePresentation.label}</span>
                      <strong
                        className={
                          !liability && isNegativeMoney(account.balance)
                            ? "money-negative"
                            : ""
                        }
                      >
                        {formatMoney(
                          account.balancePresentation.amount,
                          account.currency,
                        )}
                      </strong>
                    </div>
                    <Badge tone="blue">{account.currency}</Badge>
                  </footer>
                </Link>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Landmark size={24} />}
          title="No accounts yet"
          body="Start with a checking account, savings account, card, or cash wallet."
          action={<Button onClick={() => setEditing("new")}>Create an account</Button>}
        />
      )}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Create an account" : "Edit account"}
        description="Balances are signed internally but presented in everyday language."
      >
        {editing ? (
          <AccountForm
            account={editing === "new" ? undefined : editing}
            defaultCurrency={session.preferences.defaultCurrency}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Modal>
    </>
  );
}
