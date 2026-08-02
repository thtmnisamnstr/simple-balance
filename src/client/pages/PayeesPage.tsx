import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Combine,
  Search,
  UserRound,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, useLocation } from "../router.js";
import {
  api,
  json,
  type PayeeDuplicateGroup,
  type PayeeMergeResult,
  type PayeeSummary,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  SortMenu,
  type SortState,
  compareForSort,
} from "../components.js";

function payeeDetailSearch(search: string, payee: string) {
  const params = new URLSearchParams(search);
  params.set("name", payee);
  return params.toString();
}

const payeeSortFields = [
  { field: "name", label: "Name" },
  { field: "committed", label: "Committed" },
  { field: "staged", label: "Staged" },
  { field: "total", label: "Total transactions" },
] as const;
type PayeeSortField = (typeof payeeSortFields)[number]["field"];

export default function PayeesPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState<PayeeSortField>>({
    field: "name",
    direction: "asc",
  });
  const [participants, setParticipants] = useState<Set<string>>(new Set());
  const [targetPayee, setTargetPayee] = useState("");
  const mergeIdempotencyKey = useRef(crypto.randomUUID());
  const payees = useQuery({
    queryKey: ["payees", "list"],
    queryFn: () => api<PayeeSummary[]>("/api/v1/payees"),
  });
  const duplicates = useQuery({
    queryKey: ["payees", "duplicates"],
    queryFn: () =>
      api<PayeeDuplicateGroup[]>("/api/v1/payees/duplicates"),
  });

  const selectedPayees = (payees.data ?? []).filter((payee) =>
    participants.has(payee.name),
  );
  const selectedTarget = selectedPayees.find(
    (payee) => payee.name === targetPayee,
  );
  const mergeMutation = useMutation({
    mutationFn: () => {
      if (!selectedTarget || selectedPayees.length < 2) {
        throw new Error("Select at least two payees and choose the one to keep");
      }
      return api<PayeeMergeResult>(
        "/api/v1/payees/merge",
        json({
          sourcePayees: selectedPayees
            .filter((payee) => payee.name !== selectedTarget.name)
            .map((payee) => payee.name),
          targetPayee: selectedTarget.name,
          idempotencyKey: mergeIdempotencyKey.current,
        }),
      );
    },
    onSuccess: async () => {
      mergeIdempotencyKey.current = crypto.randomUUID();
      setParticipants(new Set());
      setTargetPayee("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["payees"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["audit-events"] }),
      ]);
    },
  });

  const filtered = useMemo(() => {
    const value = search.trim().toLocaleLowerCase();
    const matching = value
      ? (payees.data ?? []).filter((payee) =>
          payee.name.toLocaleLowerCase().includes(value),
        )
      : (payees.data ?? []);
    return [...matching].sort((left, right) => {
      const of = (payee: PayeeSummary) => {
        switch (sort.field) {
          case "committed":
            return payee.transactionCount;
          case "staged":
            return payee.stagedTransactionCount;
          case "total":
            return payee.totalCount;
          default:
            return payee.name;
        }
      };
      return (
        compareForSort(of(left), of(right), sort.direction) ||
        left.name.localeCompare(right.name)
      );
    });
  }, [payees.data, search, sort]);

  const chooseDuplicateGroup = (group: PayeeDuplicateGroup) => {
    const ranked = [...group.payees].sort(
      (left, right) =>
        right.totalCount - left.totalCount || left.name.localeCompare(right.name),
    );
    const target = ranked[0];
    if (!target) return;
    setParticipants(new Set(group.payees.map((payee) => payee.name)));
    setTargetPayee(target.name);
  };

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Payees"
        description="People and businesses you pay or get paid by. Spot near-duplicates and merge them."
      />

      {duplicates.data?.length ? (
        <section className="duplicate-groups" aria-label="Duplicate payees">
          <div className="section-title">
            <span>
              <Combine size={19} />
            </span>
            <div>
              <h2>Possible duplicates</h2>
              <p>Names are compared without case or extra spacing.</p>
            </div>
          </div>
          {duplicates.data.map((group) => (
            <Alert kind="info" key={group.normalizedName}>
              <span>{group.payees.map((payee) => payee.name).join(", ")}</span>
              <Button
                type="button"
                variant="secondary"
                onClick={() => chooseDuplicateGroup(group)}
              >
                Review merge
              </Button>
            </Alert>
          ))}
        </section>
      ) : null}

      <div className="category-toolbar">
        <label className="search-box">
          <Search size={16} />
          <Input
            aria-label="Search payees"
            placeholder="Search payees"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <SortMenu fields={payeeSortFields} sort={sort} onSort={setSort} />
      </div>

      {selectedPayees.length >= 2 ? (
        <section className="panel merge-panel">
          <div>
            <strong>Merge {selectedPayees.length} selected payees</strong>
            <small>
              Committed transactions and staged rows will use the payee you keep.
            </small>
          </div>
          <Select
            aria-label="Payee to keep"
            value={targetPayee}
            onChange={(event) => setTargetPayee(event.target.value)}
          >
            <option value="">Choose payee to keep</option>
            {selectedPayees.map((payee) => (
              <option key={payee.name} value={payee.name}>
                {payee.name}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="danger"
            loading={mergeMutation.isPending}
            disabled={!selectedTarget}
            onClick={() => {
              if (
                window.confirm(
                  `Merge the selected payees into “${selectedTarget?.name}”? This updates their transactions and staged rows.`,
                )
              ) {
                mergeMutation.mutate();
              }
            }}
          >
            <Combine size={16} /> Merge
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setParticipants(new Set());
              setTargetPayee("");
            }}
          >
            Cancel
          </Button>
          {mergeMutation.error ? <Alert>{mergeMutation.error.message}</Alert> : null}
        </section>
      ) : null}

      {payees.error ? <Alert>{payees.error.message}</Alert> : null}
      {duplicates.error ? <Alert>{duplicates.error.message}</Alert> : null}
      {filtered.length ? (
        <div className="category-list category-page-list">
          {filtered.map((payee) => (
            <div className="category-row" key={payee.name}>
              <div className="category-select">
                <input
                  type="checkbox"
                  aria-label={`Select ${payee.name} for merging`}
                  checked={participants.has(payee.name)}
                  onChange={(event) => {
                    const next = new Set(participants);
                    if (event.target.checked) {
                      next.add(payee.name);
                    } else {
                      next.delete(payee.name);
                      if (targetPayee === payee.name) setTargetPayee("");
                    }
                    setParticipants(next);
                  }}
                />
                <span className="account-icon">
                  <UserRound size={16} />
                </span>
                <span>
                  <strong>
                    <Link
                      to={{
                        pathname: "/payees/transactions",
                        search: payeeDetailSearch(location.search, payee.name),
                      }}
                    >
                      {payee.name}
                    </Link>
                  </strong>
                  <small>
                    {payee.transactionCount} committed · {payee.stagedTransactionCount}{" "}
                    staged
                  </small>
                </span>
              </div>
              <div>
                <Badge tone="blue">
                  {payee.totalCount} transaction{payee.totalCount === 1 ? "" : "s"}
                </Badge>
              </div>
              <div className="row-actions">
                <Link
                  aria-label={`View transactions for ${payee.name}`}
                  to={{
                    pathname: "/payees/transactions",
                    search: payeeDetailSearch(location.search, payee.name),
                  }}
                >
                  <ArrowRight size={16} />
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : payees.isPending ? (
        <p>Loading payees…</p>
      ) : (
        <EmptyState
          icon={<UserRound size={24} />}
          title="No payees in this view"
          body="Payees appear here when you commit or stage a transaction."
        />
      )}
    </>
  );
}
