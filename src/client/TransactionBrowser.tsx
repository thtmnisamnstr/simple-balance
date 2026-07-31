import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Download,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import {
  api,
  ApiClientError,
  json,
  queryString,
  type Account,
  type Category,
  type Page,
  type Transaction,
} from "./api.js";
import {
  Alert,
  Button,
  DateRangeBar,
  EmptyState,
  formatDate,
  formatMoney,
  Input,
  Modal,
  Select,
} from "./components.js";
import { useDateRange } from "./date-range.js";
import { TransactionForm } from "./forms.js";

const typeMeta = {
  deposit: { label: "Deposit", icon: ArrowDownLeft },
  withdrawal: { label: "Withdrawal", icon: ArrowUpRight },
  transfer: { label: "Transfer", icon: ArrowLeftRight },
};

export function TransactionBrowser({
  fixedAccountId,
  allowCreate = true,
  showDateRange = true,
}: {
  fixedAccountId?: string;
  allowCreate?: boolean;
  showDateRange?: boolean;
}) {
  const { start, end } = useDateRange();
  const [editing, setEditing] = useState<Transaction | "new" | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [accountId, setAccountId] = useState(fixedAccountId ?? "");
  const [showDeleted, setShowDeleted] = useState(false);
  const queryClient = useQueryClient();
  const selectedAccountId = fixedAccountId ?? accountId;
  const params = {
    start,
    end,
    search: search || undefined,
    type: type || undefined,
    accountId: selectedAccountId || undefined,
    includeDeleted: showDeleted ? "true" : undefined,
  };
  const transactions = useInfiniteQuery({
    queryKey: ["transactions", params],
    queryFn: ({ pageParam }) =>
      api<Page<Transaction>>(
        `/api/v1/transactions?${queryString({
          ...params,
          cursor: pageParam,
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<Category[]>("/api/v1/categories"),
  });
  const deleteMutation = useMutation({
    mutationFn: ({
      transaction,
      deleted,
      allowDuplicate = false,
    }: {
      transaction: Transaction;
      deleted: boolean;
      allowDuplicate?: boolean;
    }) =>
      api<Transaction>(`/api/v1/transactions/${transaction.id}/deleted`, {
        ...json({
          expectedVersion: transaction.version,
          deleted,
          allowDuplicate,
        }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
      ]);
    },
  });
  const items = transactions.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <div className="transaction-browser-actions">
        <a
          className="button button-secondary"
          href={`/api/v1/csv/export?${queryString(params)}`}
        >
          <Download size={16} /> Export CSV
        </a>
        {allowCreate ? (
          <Button
            onClick={() => setEditing("new")}
            disabled={!accounts.data?.length}
          >
            <Plus size={16} /> Add transaction
          </Button>
        ) : null}
      </div>
      {showDateRange ? <DateRangeBar /> : null}
      <div className="filter-bar">
        <label className="search-box">
          <Search size={16} />
          <Input
            aria-label="Search transactions"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search description, payee, or notes"
          />
        </label>
        <Select
          aria-label="Transaction type"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="">All types</option>
          <option value="deposit">Deposits</option>
          <option value="withdrawal">Withdrawals</option>
          <option value="transfer">Transfers</option>
        </Select>
        {!fixedAccountId ? (
          <Select
            aria-label="Account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">All accounts</option>
            {accounts.data?.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        ) : null}
        <label className="check-label">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(event) => setShowDeleted(event.target.checked)}
          />
          Show deleted
        </label>
      </div>
      {deleteMutation.error ? (
        <Alert>
          {deleteMutation.error.message}
          {deleteMutation.error instanceof ApiClientError &&
          deleteMutation.error.code === "DUPLICATE" &&
          deleteMutation.variables?.deleted === false &&
          !deleteMutation.variables.allowDuplicate ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                deleteMutation.mutate({
                  ...deleteMutation.variables!,
                  allowDuplicate: true,
                })
              }
            >
              Restore anyway
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {transactions.error ? <Alert>{transactions.error.message}</Alert> : null}
      {items.length ? (
        <>
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Transaction</th>
                  <th>Account</th>
                  <th>Category</th>
                  <th className="align-right">Amount</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((transaction) => {
                  const meta = typeMeta[transaction.type];
                  const Icon = meta.icon;
                  const isInboundTransfer =
                    transaction.type === "transfer" &&
                    Boolean(fixedAccountId) &&
                    transaction.destinationAccountId === fixedAccountId;
                  const amount =
                    transaction.type === "deposit" || isInboundTransfer
                      ? transaction.destinationAmount!
                      : transaction.sourceAmount!;
                  const currency =
                    transaction.type === "deposit" || isInboundTransfer
                      ? transaction.destinationCurrency!
                      : transaction.sourceCurrency!;
                  const sign =
                    transaction.type === "deposit" || isInboundTransfer
                      ? "+"
                      : transaction.type === "withdrawal" ||
                          (transaction.type === "transfer" && fixedAccountId)
                        ? "−"
                        : "";
                  const accountLabel =
                    transaction.type === "transfer"
                      ? `${transaction.sourceAccount?.name} → ${transaction.destinationAccount?.name}`
                      : transaction.sourceAccount?.name ??
                        transaction.destinationAccount?.name;
                  return (
                    <tr
                      key={transaction.id}
                      className={transaction.deletedAt ? "row-deleted" : ""}
                    >
                      <td className="nowrap">{formatDate(transaction.date)}</td>
                      <td>
                        <div className="transaction-cell">
                          <span
                            className={`transaction-icon ${transaction.type}`}
                          >
                            <Icon size={16} />
                          </span>
                          <div>
                            <strong>{transaction.description}</strong>
                            <span>{transaction.payee || meta.label}</span>
                          </div>
                        </div>
                      </td>
                      <td>{accountLabel}</td>
                      <td>
                        {transaction.category?.name ?? (
                          <span className="subtle">Uncategorized</span>
                        )}
                      </td>
                      <td
                        className={`align-right money ${
                          isInboundTransfer ? "deposit" : transaction.type
                        }`}
                      >
                        {sign}
                        {formatMoney(amount, currency)}
                        {!fixedAccountId &&
                        transaction.type === "transfer" &&
                        transaction.sourceCurrency !==
                          transaction.destinationCurrency ? (
                          <small>
                            →{" "}
                            {formatMoney(
                              transaction.destinationAmount!,
                              transaction.destinationCurrency!,
                            )}
                          </small>
                        ) : null}
                      </td>
                      <td className="row-actions">
                        {transaction.deletedAt ? (
                          <button
                            aria-label="Restore"
                            onClick={() =>
                              deleteMutation.mutate({
                                transaction,
                                deleted: false,
                              })
                            }
                          >
                            <RotateCcw size={16} />
                          </button>
                        ) : (
                          <>
                            <button
                              aria-label="Edit"
                              onClick={() => setEditing(transaction)}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              aria-label="Delete"
                              onClick={() =>
                                deleteMutation.mutate({
                                  transaction,
                                  deleted: true,
                                })
                              }
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {transactions.hasNextPage ? (
            <div className="load-more">
              <Button
                variant="secondary"
                loading={transactions.isFetchingNextPage}
                onClick={() => transactions.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </>
      ) : transactions.isPending ? (
        <p>Loading transactions…</p>
      ) : (
        <EmptyState
          icon={<ArrowLeftRight size={24} />}
          title="No transactions in this view"
          body="Adjust the date range or add a deposit, withdrawal, or transfer."
          action={
            allowCreate && accounts.data?.length ? (
              <Button onClick={() => setEditing("new")}>Add transaction</Button>
            ) : undefined
          }
        />
      )}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add a transaction" : "Edit transaction"}
      >
        {editing ? (
          <TransactionForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            transaction={editing === "new" ? undefined : editing}
            initialAccountId={fixedAccountId}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Modal>
    </>
  );
}
