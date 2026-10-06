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
import { useId, useMemo, useState } from "react";
import { Link, useLocation } from "../router.js";
import {
  accountTypeLabels,
  groupAccountsByType,
  liabilityAccountTypes,
  type AccountType,
  accountAllowance,
  activeChoicePending,
  ARCHIVED_ACCOUNT_DELETE_REFUSAL,
  frozenAccountRefusal,
  MAX_FREE_ACCOUNTS,
  restoreAllowance,
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
  Note,
  PageHeader,
  RowMenu,
  SearchBox,
  Skeleton,
  SortMenu,
  type SortState,
  useConfirm,
} from "../components.js";
import { formatMoney, isNegativeMoney, isPositiveMoney, compareMoney } from "../money.js";
import { AccountForm } from "../forms.js";
import { calendarDateInTimezone } from "../timezone.js";
import { emptyScreen, waysOut } from "../list-filters.js";

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

/** "A", "A and B", "A, B and C" — names in a sentence rather than as a list. */
const readableNames = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export default function AccountsPage({ session }: { session: Session }) {
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState("");
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
  // And the one the server calls before a restore, which needs a free place
  // too. Asked here so an archived account whose place has gone says why on
  // the item, rather than asking to be confirmed and then coming back refused.
  const restore = restoreAllowance(
    session.plan?.entitlement ?? { billing: false },
    session.plan?.accountsUsed ?? 0,
  );
  const reasonId = useId();
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
    // Filtered before grouping, so a type whose every card is filtered out
    // takes its heading with it rather than leaving an empty band.
    const term = search.trim().toLocaleLowerCase();
    const matching = term
      ? (accounts.data ?? []).filter((account) => account.name.toLocaleLowerCase().includes(term))
      : (accounts.data ?? []);
    return groupAccountsByType(matching).map((group) => ({
      ...group,
      accounts: [...group.accounts].sort(compare),
    }));
  }, [accounts.data, search, sort]);
  const accountCount = groupedAccounts.reduce((total, group) => total + group.accounts.length, 0);
  // The only list page with no search box had its sort control thrown to the
  // far right of an otherwise empty bar by `margin-left: auto`, which is why
  // the bar looked unlike every other one before anybody noticed what was
  // missing. A paid ledger has no account limit at all, and archived accounts
  // are listed on top of that, so this is a page that can hold dozens of cards
  // across eight headings.
  const { narrowed, ways } = emptyScreen([
    { set: Boolean(search.trim()), clear: "clear the search" },
    {
      set: !includeArchived,
      clear: "turn on Show archived accounts to look at the ones you have put away",
      fromTheStart: true,
    },
  ]);

  /**
   * What the row action just did, said where focus can reach it.
   *
   * 13.3: a control that acts and then unmounts has to send focus somewhere.
   * Archiving an account with no balance is the one action on this page that
   * runs straight from the row menu with no dialog in between, so the menu
   * closed, the button went with the card, and focus fell to `<body>` — the
   * reader was left at the top of the document with nothing saying what had
   * happened. The two dialogs keep their own focus return, and a refusal is
   * already an `Alert` a line below this one.
   */
  const [notice, setNotice] = useState("");

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
    // The last notice is about the last press. Left up, it sat beside this
    // press's refusal saying the opposite.
    onMutate: () => setNotice(""),
    onSuccess: async (_result, { account, action }) => {
      setNotice(
        action === "delete"
          ? `${account.name} deleted.`
          : account.archivedAt
            ? `${account.name} restored.`
            : `${account.name} archived.`,
      );
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
      {/* A refusal above the bar, beside the controls that caused it. The read
          failure is not here: it renders where the list would have been, so
          the page does not become a header, a filter bar and nothing with the
          explanation scrolled off the top. 7.6. */}
      {/* Named, and taking focus: the press came from a menu far down the
          page, and the confirmation that asked first has closed, so without
          it focus fell to <body> and the refusal was off screen. */}
      {mutation.error && mutation.variables ? (
        <Alert takeFocus>
          {`“${mutation.variables.account.name}” was not ${
            mutation.variables.action === "delete"
              ? "deleted"
              : mutation.variables.account.archivedAt
                ? "restored"
                : "archived"
          }. ${mutation.error.message}`}
        </Alert>
      ) : null}
      {notice ? (
        <Alert kind="success" takeFocus>
          {notice}
        </Alert>
      ) : null}
      <div className="filter-bar">
        <SearchBox
          label="Search accounts"
          placeholder="Search by name"
          value={search}
          onChange={setSearch}
        />
        <SortMenu fields={accountSortFields} sort={sort} onSort={setSort} />
        <label className="check-label">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Show archived accounts
        </label>
      </div>
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
                const noPlace = Boolean(account.archivedAt) && !restore.ok;
                const noPlaceId = `${reasonId}-${account.id}`;
                // The sentence the server refuses an edit with, so a frozen
                // card says why Edit is gray instead of leaving the person to
                // find out from a 422. Under Edit, the one item it explains:
                // archiving and deleting stay open on a frozen account, because
                // neither gives it a place. The fallback is the only limit any
                // plan freezes under, for a session that arrived without one.
                // The Restore wiring never meets this: an archived account is
                // never frozen.
                const frozenReason = account.frozen
                  ? frozenAccountRefusal(activeLimit ?? MAX_FREE_ACCOUNTS, account.name)
                  : null;
                const frozenId = `${reasonId}-frozen-${account.id}`;
                const describedBy = frozenReason ? frozenId : undefined;
                // The server refuses to delete an archived account, so the item
                // says so before it is pressed rather than after a refusal.
                const archivedId = `${reasonId}-archived-${account.id}`;
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
                          <button
                            disabled={account.frozen}
                            aria-describedby={describedBy}
                            onClick={() => setEditing(account)}
                          >
                            <Pencil size={15} /> Edit
                          </button>
                          {frozenReason ? (
                            <small className="button-reason menu-reason" id={frozenId}>
                              {frozenReason}
                            </small>
                          ) : null}
                          <button
                            disabled={noPlace}
                            aria-describedby={noPlace ? noPlaceId : undefined}
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
                          {!restore.ok && noPlace ? (
                            <small className="button-reason menu-reason" id={noPlaceId}>
                              {restore.message}
                            </small>
                          ) : null}
                          <button
                            className="danger"
                            disabled={Boolean(account.archivedAt)}
                            aria-describedby={account.archivedAt ? archivedId : undefined}
                            onClick={() => {
                              removal.ask(account, () =>
                                mutation.mutate({ account, action: "delete" }),
                              );
                            }}
                          >
                            <Trash2 size={15} /> Delete if unused
                          </button>
                          {account.archivedAt ? (
                            <small className="button-reason menu-reason" id={archivedId}>
                              {ARCHIVED_ACCOUNT_DELETE_REFUSAL}
                            </small>
                          ) : null}
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
      ) : accounts.error ? (
        <Alert>{accounts.error.message}</Alert>
      ) : (
        <EmptyState
          icon={Landmark}
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
          title={
            narrowed
              ? "No accounts match this view"
              : ways.length
                ? "No accounts in this view"
                : "No accounts yet"
          }
          body={
            narrowed
              ? waysOut(ways)
              : `Start with a checking account, savings account, card, or cash wallet.${
                  ways.length ? ` ${waysOut(ways)}` : ""
                }`
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
            ? `${formatMoney(closing.value.balance, closing.value.currency)} is posted out of “${closing.value.name}” to Opening Balances, so the account ends at zero and that amount stops counting toward your totals. The books stay balanced and its history stays readable. Restoring the account posts the balance back.`
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
 * The whole set is saved at once because the choice is one decision — turning
 * one off to turn another on would be two saves and an intermediate state the
 * plan does not allow. And it puts two different questions depending on
 * `activeChoicePending`: the first choice, where any set within the limit is
 * open, and afterward, where the accounts in use are fixed and only a place
 * that has opened up can be filled. Both are the server's own rule, because
 * a panel that offered a choice the save refuses would be worse than no panel.
 *
 * Exported for `tests/active-accounts-ui.test.tsx`, which drives it directly:
 * the page around it needs a session, a router and four queries, and none of
 * them is what the panel's rule is about.
 */
export function ActiveAccountChooser({
  accounts,
  limit,
}: {
  readonly accounts: readonly Account[];
  readonly limit: number | null;
}) {
  const queryClient = useQueryClient();
  const live = useMemo(() => accounts.filter((account) => !account.archivedAt), [accounts]);
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  /**
   * What the save did, kept here rather than read off the mutation.
   *
   * 13.3's shape, and this panel is the newest instance of it: the button
   * disables itself while it works, so the browser has already blurred it when
   * the answer arrives, and then either the panel unmounts — the save unfroze
   * everything — or `unchanged` turns true and the button comes back disabled.
   * Either way focus is on `<body>`, and the only text that changed was
   * `disabledReason`, which says "Nothing to save yet." — the sentence written
   * for an untouched form standing in as the report of a save that worked.
   *
   * State rather than `save.isSuccess` because it has to survive the panel:
   * see the two returns below.
   */
  const [saved, setSaved] = useState<string | null>(null);
  // Where the selection starts: the accounts that work right now, which before
  // the choice is the ordering rule standing in for one.
  const current = useMemo(
    () => new Set(live.filter((account) => !account.frozen).map((account) => account.id)),
    [live],
  );
  // What the server has stored, which is what a save is compared against. The
  // two are the same set once the choice is made — the accounts marked active
  // are exactly the ones not frozen — and different before it, when every
  // live account is still marked active. Comparing against `current` read the
  // untouched default as nothing to save, so the one-time choice could be
  // closed only by an agent: the three the page had already picked were the
  // one set it would not send, although `activeAccountChange` accepts it.
  const stored = useMemo(
    () => new Set(live.filter((account) => account.active !== false).map((account) => account.id)),
    [live],
  );
  // A choice is held by id, and the list under it can change while the panel
  // is open — archiving or deleting an account happens a few rows up this same
  // page. An id that has gone takes a place in `free` and would make the save
  // name an account the server no longer has, so the held choice is narrowed
  // to what is still there rather than trusted.
  const selection = useMemo(() => {
    if (!chosen) return current;
    const present = new Set(live.map((account) => account.id));
    return new Set([...chosen].filter((id) => present.has(id)));
  }, [chosen, current, live]);
  const save = useMutation({
    mutationFn: (accountIds: string[]) =>
      api<Account[]>("/api/v1/accounts/active", { ...json({ accountIds }), method: "PUT" }),
    onMutate: () => setSaved(null),
    onSuccess: async (updated) => {
      // Read out of the write's own answer rather than off the boxes that were
      // ticked: the server decides which accounts end up in use, and this is
      // the list the panel is about to re-render from.
      const names = updated
        .filter((account) => !account.archivedAt && !account.frozen)
        .map((account) => account.name);
      setSaved(
        names.length
          ? `${readableNames(names)} ${names.length === 1 ? "is the account" : "are the accounts"} ` +
              "you are using now. The rest stay here in full, and refuse changes until a place " +
              "opens up."
          : "No account is in use now. They all stay here in full, and refuse changes until you " +
              "put one back.",
      );
      setChosen(null);
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      // Every figure on every other page is unchanged, but what those pages
      // may offer is not: a picker that was hiding an account now shows it.
      await queryClient.invalidateQueries({ queryKey: ["transactions"] });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });

  const anyFrozen = live.some((account) => account.frozen);
  if (limit === null) return null;
  // The save can be the thing that removes the panel: unfreeze the last frozen
  // account and there is no longer a choice to put. The sentence saying so has
  // to outlive it, or the one control on the page that decides which accounts a
  // downgraded ledger can still write to answers "did that land?" with an empty
  // space where the panel was.
  if (!anyFrozen) {
    return saved ? (
      <Alert kind="success" takeFocus>
        {saved}
      </Alert>
    ) : null;
  }

  // The same predicate the server asks, so the panel cannot offer a choice the
  // save would refuse, or fix a row the save would let go. Before the choice
  // any set is open; afterward an account in use is fixed and the only move
  // is filling a place that opened up.
  const choosing = activeChoicePending(limit, live);
  const free = limit - selection.size;
  const over = selection.size > limit;
  // The sets, not their sizes. Sizes are the same shape as a swap, and during
  // the one-time choice the default already holds exactly `limit` accounts —
  // so comparing sizes disabled every full first choice and told the person
  // there was nothing to save, which is the one thing this panel is for.
  // Against `stored`, for the reason given where it is built: while the
  // choice is open it holds more than the limit and no savable selection
  // does, so any selection within the limit is a change, the default included.
  const unchanged = selection.size === stored.size && [...selection].every((id) => stored.has(id));

  return (
    <section className="panel panel-stack">
      <header className="section-title">
        <div>
          <h2>{choosing ? "Choose which accounts stay usable" : "Accounts you are using"}</h2>
          <p>
            {choosing
              ? `Your plan keeps ${limit} accounts usable at a time, and this is the one time you ` +
                "pick them. The rest stay here in full — every balance, every entry, every " +
                "report — and refuse changes until a place opens up. Nothing is deleted, and " +
                "nothing is hidden."
              : `Your plan keeps ${limit} accounts usable at a time. These are fixed: an account ` +
                "you are using stays that way until you archive or delete it. When that frees a " +
                "place you can bring a frozen one back here."}
          </p>
        </div>
      </header>
      <ul className="active-account-choices">
        {live.map((account) => {
          // An account already in use cannot be given up to make room for
          // another — that is the swap the rule exists to stop — so its box is
          // fixed rather than merely unchecked.
          const fixed = !choosing && !account.frozen;
          const noRoom = !choosing && account.frozen && free <= 0 && !selection.has(account.id);
          return (
            <li key={account.id}>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={selection.has(account.id)}
                  disabled={fixed || noRoom}
                  onChange={(event) => {
                    const next = new Set(selection);
                    if (event.target.checked) next.add(account.id);
                    else next.delete(account.id);
                    setChosen(next);
                  }}
                />
                {account.name}
                {account.frozen ? <Badge tone="amber">Frozen</Badge> : null}
                {fixed ? <span className="subtle">In use</span> : null}
              </label>
            </li>
          );
        })}
      </ul>
      {!choosing && free <= 0 ? (
        <Note>
          {`All ${limit} places are in use. Archiving or deleting an account you are using frees ` +
            "one, and then a frozen account can take it."}
        </Note>
      ) : null}
      {save.error ? <Alert>{save.error.message}</Alert> : null}
      {saved ? (
        <Alert kind="success" takeFocus>
          {saved}
        </Alert>
      ) : null}
      <div className="form-actions">
        <span className="subtle">{`${selection.size} of ${limit} in use`}</span>
        <Button
          onClick={() => save.mutate([...selection])}
          loading={save.isPending}
          disabled={over || unchanged}
          disabledReason={
            over
              ? `Your plan keeps ${limit} accounts usable. Clear one to pick another.`
              : unchanged
                ? "Nothing to save yet."
                : undefined
          }
        >
          {choosing ? "Save which accounts are usable" : "Bring these back"}
        </Button>
      </div>
    </section>
  );
}
