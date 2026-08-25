import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Combine, Pencil, Plus, Search, Tags, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "../router.js";
import { type CategoryKind, categoryKinds } from "../../shared/domain.js";
import {
  api,
  json,
  type Category,
  type CategoryDuplicateGroup,
  type CategoryMergeResult,
  type CategorySummary,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  compareForSort,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  SortMenu,
  type SortState,
  useConfirm,
} from "../components.js";

const kindLabels: Record<CategoryKind, string> = {
  income: "Income",
  expense: "Expense",
  both: "Income or expense",
};

const categorySortFields = [
  { field: "name", label: "Name" },
  { field: "kind", label: "Kind" },
  { field: "status", label: "Status" },
  { field: "committed", label: "Committed" },
  { field: "staged", label: "Staged" },
  { field: "total", label: "Total transactions" },
] as const;
type CategorySortField = (typeof categorySortFields)[number]["field"];

/**
 * Renaming a category and changing what it applies to, in one form. The
 * applicability was previously typed as free text into a browser prompt, where
 * a misspelling silently did nothing at all.
 */
function CategoryDialog({
  category,
  onClose,
  onSave,
}: {
  category: Category | null;
  onClose: () => void;
  onSave: (name: string, kind: CategoryKind) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryKind>("expense");
  useEffect(() => {
    if (!category) return;
    // The deliberate copy: a record seeds the fields once and then the fields
    // are the truth until Save. Nothing here can be worked out during render,
    // because the whole point is that the person changes it afterwards. The
    // dialog stays mounted so the modal can close, which is why this is an
    // effect on the record rather than a fresh mount keyed on its id — a
    // remount on close would empty the fields while they were still on screen.
    // oxlint-disable-next-line react/set-state-in-effect
    setName(category.name);
    setKind(category.kind);
  }, [category]);

  const trimmed = name.trim();
  return (
    <Modal
      open={Boolean(category)}
      title="Edit category"
      description="Renaming keeps every transaction filed under it."
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="category-edit" disabled={!trimmed}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="category-edit"
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onSave(trimmed, kind);
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <Field
          label="Applies to"
          hint="Whether this category can be chosen for money coming in, going out, or both."
        >
          <Select value={kind} onChange={(event) => setKind(event.target.value as CategoryKind)}>
            {categoryKinds.map((value) => (
              <option key={value} value={value}>
                {kindLabels[value]}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Modal>
  );
}

export default function CategoriesPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Category | null>(null);
  const removal = useConfirm<Category>();
  const merge = useConfirm<string>();
  const [sort, setSort] = useState<SortState<CategorySortField>>({
    field: "name",
    direction: "asc",
  });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [targetId, setTargetId] = useState("");
  const categories = useQuery({
    queryKey: ["categories", "summaries", includeArchived],
    queryFn: () =>
      api<CategorySummary[]>(
        `/api/v1/categories/summaries${includeArchived ? "?includeArchived=true" : ""}`,
      ),
  });
  const duplicates = useQuery({
    queryKey: ["categories", "duplicates"],
    queryFn: () => api<CategoryDuplicateGroup[]>("/api/v1/categories/duplicates"),
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
        return api<Category>("/api/v1/categories", json({ name: input.name, kind: input.kind }));
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
        return api<Category>(`/api/v1/categories/${input.category.id}/archived`, {
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
      setName("");
      // A rename changes what every transaction row and every category figure
      // says, so those have to be refetched too. The merge below already does
      // this; a rename is the same change by another name.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
      ]);
    },
  });

  const selectedCategories = (categories.data ?? []).filter((category) =>
    selectedIds.has(category.id),
  );
  const target = selectedCategories.find((category) => category.id === targetId);
  const sourceCategories = selectedCategories.filter((category) => category.id !== targetId);
  const mergeMutation = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("Choose the category to keep");
      return api<CategoryMergeResult>(
        "/api/v1/categories/merge",
        json({
          sourceCategoryIds: sourceCategories.map((category) => category.id),
          targetCategoryId: target.id,
          expectedVersions: Object.fromEntries(
            sourceCategories.map((category) => [category.id, category.version]),
          ),
          targetExpectedVersion: target.version,
        }),
      );
    },
    onSuccess: async () => {
      setSelectedIds(new Set());
      setTargetId("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
      ]);
    },
  });

  const filtered = useMemo(() => {
    const value = search.trim().toLocaleLowerCase();
    const matching = value
      ? (categories.data ?? []).filter((category) =>
          category.name.toLocaleLowerCase().includes(value),
        )
      : (categories.data ?? []);
    return [...matching].sort((left, right) => {
      const of = (category: CategorySummary) => {
        switch (sort.field) {
          case "kind":
            return kindLabels[category.kind];
          case "status":
            return category.archivedAt ? "Archived" : "Active";
          case "committed":
            return category.transactionCount;
          case "staged":
            return category.stagedTransactionCount;
          case "total":
            return category.totalCount;
          default:
            return category.name;
        }
      };
      return (
        compareForSort(of(left), of(right), sort.direction) || left.name.localeCompare(right.name)
      );
    });
  }, [categories.data, search, sort]);

  const addCategory = (event: FormEvent) => {
    event.preventDefault();
    categoryMutation.mutate({ action: "create", name, kind });
  };

  const chooseDuplicateGroup = (group: CategoryDuplicateGroup) => {
    const targetCategory =
      group.categories.find((category) => !category.archivedAt) ?? group.categories[0];
    if (!targetCategory) return;
    setIncludeArchived(true);
    setTargetId(targetCategory.id);
    setSelectedIds(new Set(group.categories.map((category) => category.id)));
  };

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Categories"
        description="Group income and spending, with how much each one is used across the whole ledger. Spot near-duplicates and merge them."
      />
      <section className="panel settings-section">
        <form className="inline-form" onSubmit={addCategory}>
          <Input
            required
            aria-label="Category name"
            placeholder="Groceries"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            aria-label="Category applies to"
            value={kind}
            onChange={(event) => setKind(event.target.value as CategoryKind)}
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="both">Both</option>
          </Select>
          <Button type="submit" loading={categoryMutation.isPending}>
            <Plus size={16} /> Add category
          </Button>
        </form>
        {categoryMutation.error ? <Alert>{categoryMutation.error.message}</Alert> : null}
      </section>

      {duplicates.data?.length ? (
        <section className="duplicate-groups" aria-label="Duplicate categories">
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
              <span>{group.categories.map((category) => category.name).join(", ")}</span>
              <Button type="button" variant="secondary" onClick={() => chooseDuplicateGroup(group)}>
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
            aria-label="Search categories"
            placeholder="Search categories"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <SortMenu fields={categorySortFields} sort={sort} onSort={setSort} />
        <label className="check-label">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Show archived
        </label>
      </div>

      {selectedCategories.length >= 2 ? (
        <section className="panel merge-panel">
          <div>
            <strong>Merge {selectedCategories.length} selected categories</strong>
            <small>Transactions and staged rows will move to the category you keep.</small>
          </div>
          <Select
            aria-label="Category to keep"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            <option value="">Choose category to keep</option>
            {selectedCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.archivedAt ? " (archived)" : ""}
              </option>
            ))}
          </Select>
          <Button
            variant="danger"
            loading={mergeMutation.isPending}
            disabled={!target || sourceCategories.length === 0}
            onClick={() => {
              merge.ask(target?.name ?? "", () => mergeMutation.mutate());
            }}
          >
            <Combine size={16} /> Merge
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setSelectedIds(new Set());
              setTargetId("");
            }}
          >
            Cancel
          </Button>
          {mergeMutation.error ? <Alert>{mergeMutation.error.message}</Alert> : null}
        </section>
      ) : null}

      {categories.error ? <Alert>{categories.error.message}</Alert> : null}
      {duplicates.error ? <Alert>{duplicates.error.message}</Alert> : null}

      {filtered.length ? (
        <div className="category-list category-page-list">
          {filtered.map((category) => (
            <div className="category-row" key={category.id}>
              <div className="category-select">
                <input
                  type="checkbox"
                  aria-label={`Select ${category.name} for merging`}
                  checked={selectedIds.has(category.id)}
                  onChange={(event) => {
                    const next = new Set(selectedIds);
                    if (event.target.checked) next.add(category.id);
                    else next.delete(category.id);
                    setSelectedIds(next);
                    if (!event.target.checked && targetId === category.id) {
                      setTargetId("");
                    }
                  }}
                />
                <span className="account-icon">
                  <Tags size={16} />
                </span>
                <span>
                  <strong>
                    <Link
                      to={{
                        pathname: `/categories/${category.id}`,
                        search: location.search,
                      }}
                    >
                      {category.name}
                    </Link>
                  </strong>
                  <small>
                    {kindLabels[category.kind]} · {category.transactionCount} committed ·{" "}
                    {category.stagedTransactionCount} staged
                  </small>
                </span>
              </div>
              <div>
                <Badge tone={category.kind === "expense" ? "red" : "green"}>
                  {kindLabels[category.kind]}
                </Badge>
                <Badge tone="blue">
                  {category.totalCount} transaction
                  {category.totalCount === 1 ? "" : "s"}
                </Badge>
                {category.archivedAt ? <Badge>Archived</Badge> : null}
              </div>
              <div className="row-actions">
                <button aria-label={`Edit ${category.name}`} onClick={() => setEditing(category)}>
                  <Pencil size={16} />
                </button>
                <button
                  aria-label={
                    category.archivedAt ? `Restore ${category.name}` : `Archive ${category.name}`
                  }
                  onClick={() => categoryMutation.mutate({ action: "archive", category })}
                >
                  {category.archivedAt ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                </button>
                <button
                  aria-label={`Delete unused ${category.name}`}
                  onClick={() =>
                    removal.ask(category, () =>
                      categoryMutation.mutate({ action: "delete", category }),
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : categories.isPending ? (
        <Skeleton height={120} label="Loading categories…" />
      ) : categories.error ? null : (
        <EmptyState
          icon={<Tags size={24} />}
          title="No categories in this view"
          body="Add a category or change the search and archive filters."
        />
      )}

      <CategoryDialog
        category={editing}
        onClose={() => setEditing(null)}
        onSave={(name, kind) => {
          if (!editing) return;
          categoryMutation.mutate({ action: "update", category: editing, name, kind });
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={merge.open}
        title="Merge these categories?"
        description={
          merge.value
            ? `Every transaction and staged row filed under the others moves to “${merge.value}”, and the others are removed. This cannot be undone.`
            : undefined
        }
        confirmLabel="Merge"
        onConfirm={merge.confirm}
        onCancel={merge.cancel}
      />

      <ConfirmDialog
        open={removal.open}
        title="Delete this category?"
        description={
          removal.value
            ? `A category can only be deleted while nothing is filed under it. If anything still names “${removal.value.name}”, this is refused and nothing changes. Deleting one that is unused cannot be undone; to put it out of the way instead, archive it.`
            : undefined
        }
        onConfirm={removal.confirm}
        onCancel={removal.cancel}
      />
    </>
  );
}
