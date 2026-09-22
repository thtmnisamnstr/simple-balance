import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Building2,
  CreditCard,
  Landmark,
  Pencil,
  Plus,
  Trash2,
  WalletCards,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "../router.js";
import {
  accountTypeLabels,
  groupAccountsByType,
  liabilityAccountTypes,
  type AccountType,
  accountAllowance,
} from "../../shared/domain.js";
import { api, json, type Account, type Session } from "../api.js";
import {
  Alert,
  Badge,
  Button,
  compareForSort,
  ConfirmDialog,
  EmptyState,
  Modal,
  PageHeader,
  RowMenu,
  Skeleton,
  SortMenu,
  type SortState,
  useConfirm,
} from "../components.js";
import { formatMoney, isNegativeMoney, isPositiveMoney, compareMoney } from "../money.js";
import { AccountForm } from "../forms.js";
import { calendarDateInTimezone } from "../timezone.js";

const iconFor = (type: AccountType) => {
  if (type === "cash" || type === "crypto_wallet") return WalletCards;
  if (type === "credit_card") return CreditCard;
  if (type === "loan" || type.includes("liability")) return Building2;
  return Landmark;
};

const accountSortFields = [
  { field: "name", label: "Name" },
  { field: "currency", label: "Currency" },
  { field: "balance", label: "Balance" },
  { field: "status", label: "Status" },
] as const;
type AccountSortField = (typeof accountSortFields)[number]["field"];

/** Non-zero without turning a decimal string into a float. */
const hasBalance = (amount: string) => isPositiveMoney(amount) || isNegativeMoney(amount);

export default function AccountsPage({ session }: { session: Session }) {
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const removal = useConfirm<Account>();
  const location = useLocation();
  const closing = useConfirm<Account>();
  const restoring = useConfirm<Account>();
  const [sort, setSort] = useState<SortState<AccountSortField>>({
    field: "name",
    direction: "asc",
  });
  const queryClient = useQueryClient();
  // The same function the server calls before it inserts, so the sentence on
  // the disabled button and the sentence on the refusal cannot drift apart.
  const allowance = accountAllowance(
    session.plan?.entitlement ?? { billing: false },
    session.plan?.accountsUsed ?? 0,
  );
  // Null unless a plan limits how many accounts may be active, which is the
  // only reason anything is ever frozen.
  const entitlement = session.plan?.entitlement ?? { billing: false };
  const activeLimit = entitlement.billing ? entitlement.accountLimit : null;
  const today = calendarDateInTimezone(new Date(), session.preferences.timezone);
  const accounts = useQuery({
    queryKey: ["accounts", "all", includeArchived, today],
    queryFn: () =>
      api<Account[]>(
        `/api/v1/accounts?end=${today}${includeArchived ? "&includeArchived=true" : ""}`,
      ),
  });
  // The list arrives whole, so ordering it here keeps it instant and avoids
  // asking the server to re-sort something it already sent. The sort orders
  // accounts inside their type rather than across the page, because the type is
  // what the headings already answer.
  const groupedAccounts = useMemo(() => {
    const compare = (left: Account, right: Account) => {
      // A balance is compared as a decimal rather than through Number, because a
      // float cannot hold eighteen fractional digits and two balances that
      // differ in the last of them would otherwise sort arbitrarily.
      if (sort.field === "balance") {
        const order = compareMoney(left.balance, right.balance);
        return (sort.direction === "asc" ? order : -order) || left.name.localeCompare(right.name);
      }
      const value = (account: Account) => {
        switch (sort.field) {
          case "currency":
            return account.currency;
          case "status":
            return account.archivedAt ? "Archived" : "Active";
          default:
            return account.name;
        }
      };
      return (
        compareForSort(value(left), value(right), sort.direction) ||
        left.name.localeCompare(right.name)
      );
    };
    return groupAccountsByType(accounts.data ?? []).map((group) => ({
      ...group,
      accounts: [...group.accounts].sort(compare),
    }));
  }, [accounts.data, sort]);
  const accountCount = groupedAccounts.reduce((total, group) => total + group.accounts.length, 0);

  const mutation = useMutation({
    mutationFn: ({ account, action }: { account: Account; action: "archive" | "delete" }) =>
      action === "archive"
        ? api<Account>(`/api/v1/accounts/${account.id}/archived`, {
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
      // The session carries how many accounts the plan has left, so without
      // this the button stays disabled after deleting one — or stays offered
      // after adding the last one the plan allows.
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      // Budgets and the forecast read the same postings; without these two
      // the Budgets page showed pre-mutation figures for its staleTime.
      await queryClient.invalidateQueries({ queryKey: ["budgets"] });
      await queryClient.invalidateQueries({ queryKey: ["forecast"] });
    },
  });

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Everything you track, from checking and cards to cash and crypto wallets."
        actions={
          <Button
            onClick={() => setEditing("new")}
            disabled={!allowance.ok}
            disabledReason={allowance.ok ? undefined : allowance.message}
          >
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
        <SortMenu fields={accountSortFields} sort={sort} onSort={setSort} />
      </div>
      {accounts.error ? <Alert>{accounts.error.message}</Alert> : null}
      {mutation.error ? <Alert>{mutation.error.message}</Alert> : null}
      <ActiveAccountChooser accounts={accounts.data ?? []} limit={activeLimit} />
      {accountCount ? (
        groupedAccounts.map((group) => (
          <section className="account-type-section" key={group.type}>
            <h2 className="account-type-heading">
              {group.label}
              <span className="subtle">
                {`${group.accounts.length} account${group.accounts.length === 1 ? "" : "s"}`}
              </span>
            </h2>
            <div className="account-card-grid">
              {group.accounts.map((account) => {
                const Icon = iconFor(account.type);
                const liability = liabilityAccountTypes.has(account.type);
                return (
                  <article
                    className={`account-card ${account.archivedAt ? "archived" : ""}`}
                    key={account.id}
                  >
                    <header>
                      <span className="account-icon">
                        <Icon size={20} />
                      </span>
                      <div className="account-card-actions">
                        {account.archivedAt ? <Badge>Archived</Badge> : null}
                        {account.frozen ? <Badge tone="amber">Frozen</Badge> : null}
                        <RowMenu label={`Actions for ${account.name}`}>
                          <button disabled={account.frozen} onClick={() => setEditing(account)}>
                            <Pencil size={15} /> Edit
                          </button>
                          <button
                            disabled={account.frozen}
                            onClick={() => {
                              // Archiving moves money: the balance is posted
                              // out to equity so the account ends at zero.
                              // Restoring posts it back. Neither is something
                              // to do by brushing past a menu item, and for a
                              // while only the archive half asked — restoring
                              // a five-thousand-dollar closing was one click.
                              // Every restore asks, because the closed row
                              // shows a zero balance and cannot say here what
                              // the reversal will move.
                              if (!account.archivedAt && hasBalance(account.balance)) {
                                closing.ask(account, () =>
                                  mutation.mutate({ account, action: "archive" }),
                                );
                                return;
                              }
                              if (account.archivedAt) {
                                restoring.ask(account, () =>
                                  mutation.mutate({ account, action: "archive" }),
                                );
                                return;
                              }
                              mutation.mutate({ account, action: "archive" });
                            }}
                          >
                            {account.archivedAt ? (
                              <ArchiveRestore size={15} />
                            ) : (
                              <Archive size={15} />
                            )}
                            {account.archivedAt ? "Restore" : "Archive"}
                          </button>
                          <button
                            className="danger"
                            disabled={account.frozen}
                            onClick={() => {
                              removal.ask(account, () =>
                                mutation.mutate({ account, action: "delete" }),
                              );
                            }}
                          >
                            <Trash2 size={15} /> Delete if unused
                          </button>
                        </RowMenu>
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
                              !liability && isNegativeMoney(account.balance) ? "money-negative" : ""
                            }
                          >
                            {formatMoney(account.balancePresentation.amount, account.currency)}
                          </strong>
                        </div>
                        <Badge tone="blue">{account.currency}</Badge>
                      </footer>
                    </Link>
                  </article>
                );
              })}
            </div>
          </section>
        ))
      ) : accounts.isPending ? (
        <Skeleton height={120} label="Loading accounts…" />
      ) : accounts.error ? null : (
        <EmptyState
          icon={<Landmark size={24} />}
          // Two screens, `web.md` 12.1, and this list needs the distinction more
          // than most: archived accounts are hidden by default, so somebody who
          // has put all of theirs away lands here and is told they have none —
          // which is false, and the way out is the toggle above rather than the
          // button below.
          //
          // It cannot say whether archived accounts exist, because the filter is
          // the server's: `includeArchived` is a query parameter and the response
          // holds only what it let through. So the message names what is hidden
          // rather than asserting what is there, which is true either way and
          // points at the control that would settle it.
          title={includeArchived ? "No accounts yet" : "No accounts in this view"}
          body={
            includeArchived
              ? "Start with a checking account, savings account, card, or cash wallet."
              : "Archived accounts are hidden. Turn on Show archived to look at those, or start with a checking account, savings account, card, or cash wallet."
          }
          action={
            // Gated for the same reason the header button is, and it is not a
            // duplicate of that gate: the list hides archived accounts by
            // default and the limit counts them, so somebody at the limit with
            // everything archived sees this empty state rather than the list.
            <Button
              onClick={() => setEditing("new")}
              disabled={!allowance.ok}
              disabledReason={allowance.ok ? undefined : allowance.message}
            >
              Create an account
            </Button>
          }
        />
      )}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Create an account" : "Edit account"}
        description="Set the opening balance as of the date you start tracking."
      >
        {editing ? (
          <AccountForm
            account={editing === "new" ? undefined : editing}
            defaultCurrency={session.preferences.defaultCurrency}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Modal>
      <ConfirmDialog
        open={closing.open}
        title="Archive this account?"
        description={
          closing.value
            ? `${formatMoney(closing.value.balance, closing.value.currency)} is posted out of “${closing.value.name}” to Opening Balances, so the account closes at zero and that amount stops counting toward your totals. The books stay balanced and its history stays readable. Restoring the account posts the balance back.`
            : undefined
        }
        confirmLabel="Archive"
        onConfirm={closing.confirm}
        onCancel={closing.cancel}
      />

      <ConfirmDialog
        open={restoring.open}
        title="Restore this account?"
        description={
          restoring.value
            ? `Whatever “${restoring.value.name}” held when it was archived is posted back from Opening Balances, and starts counting toward your totals again. Its history was readable all along; this changes the money, not the record.`
            : undefined
        }
        confirmLabel="Restore"
        onConfirm={restoring.confirm}
        onCancel={restoring.cancel}
      />

      <ConfirmDialog
        open={removal.open}
        title="Delete this account?"
        description={
          removal.value
            ? `An account can only be deleted while it has no transactions and no ledger history. If “${removal.value.name}” has either, this is refused and nothing changes. To put a used account out of the way, archive it instead.`
            : undefined
        }
        onConfirm={removal.confirm}
        onCancel={removal.cancel}
      />
    </>
  );
}

/**
 * Choosing which accounts stay usable, when a plan limits how many may be.
 *
 * Shown only where it can do something: a plan with a limit, and more live
 * accounts than places. On every other ledger it renders nothing at all rather
 * than a panel explaining a rule that is not in force.
 *
 * The whole set is saved at once because swapping is one decision — turning
 * one off to turn another on would be two saves and an intermediate state the
 * plan does not allow. So the button is disabled until the selection fits,
 * carrying the same sentence the server would refuse with.
 */
function ActiveAccountChooser({
  accounts,
  limit,
}: {
  readonly accounts: readonly Account[];
  readonly limit: number | null;
}) {
  const queryClient = useQueryClient();
  const live = useMemo(() => accounts.filter((account) => !account.archivedAt), [accounts]);
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const current = useMemo(
    () => new Set(live.filter((account) => !account.frozen).map((account) => account.id)),
    [live],
  );
  const selection = chosen ?? current;
  const save = useMutation({
    mutationFn: (accountIds: string[]) =>
      api<Account[]>("/api/v1/accounts/active", { ...json({ accountIds }), method: "PUT" }),
    onSuccess: async () => {
      setChosen(null);
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      // Every figure on every other page is unchanged, but what those pages
      // may offer is not: a picker that was hiding an account now shows it.
      await queryClient.invalidateQueries({ queryKey: ["transactions"] });
    },
  });

  // Driven by what is actually frozen rather than by a count of its own. The
  // two used to be separate conditions and they could disagree — archiving an
  // active account took the list back under the limit and took the panel away
  // while an account was still frozen, with no way left to unfreeze it.
  const anyFrozen = live.some((account) => account.frozen);
  if (limit === null || !anyFrozen) return null;
  const over = selection.size > limit;
  return (
    <section className="panel panel-stack">
      <header className="section-title">
        <div>
          <h2>Which accounts stay usable</h2>
          <p>
            {`Your plan keeps ${limit} accounts usable at a time. The rest stay here in full — every ` +
              "balance, every entry, every report — and refuse changes until you pick them instead. " +
              "Nothing is deleted, and nothing is hidden."}
          </p>
        </div>
      </header>
      <ul className="active-account-choices">
        {live.map((account) => (
          <li key={account.id}>
            <label className="check-label">
              <input
                type="checkbox"
                checked={selection.has(account.id)}
                onChange={(event) => {
                  const next = new Set(selection);
                  if (event.target.checked) next.add(account.id);
                  else next.delete(account.id);
                  setChosen(next);
                }}
              />
              {account.name}
              {account.frozen ? <Badge tone="amber">Frozen</Badge> : null}
            </label>
          </li>
        ))}
      </ul>
      {save.error ? <Alert>{save.error.message}</Alert> : null}
      <div className="form-actions">
        <span className="subtle">{`${selection.size} of ${limit} chosen`}</span>
        <Button
          onClick={() => save.mutate([...selection])}
          loading={save.isPending}
          disabled={over}
          disabledReason={
            over
              ? `Your plan keeps ${limit} accounts usable. Clear one to pick another.`
              : undefined
          }
        >
          Save which accounts are usable
        </Button>
      </div>
    </section>
  );
}
