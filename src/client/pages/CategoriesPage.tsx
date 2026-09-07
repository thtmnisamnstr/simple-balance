import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Combine,
  FolderTree,
  Pencil,
  Plus,
  Search,
  Tags,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "../router.js";
import { newIdempotencyKey } from "../idempotency.js";
import { type CategoryKind, categoryKinds } from "../../shared/domain.js";
import {
  api,
  json,
  type Category,
  type CategoryDuplicateGroup,
  type CategoryGroup,
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
  groups,
  onClose,
  onSave,
}: {
  category: Category | null;
  groups: CategoryGroup[];
  onClose: () => void;
  onSave: (name: string, kind: CategoryKind, groupId: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [groupId, setGroupId] = useState("");
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
    setGroupId(category.groupId ?? "");
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
            Save category
          </Button>
        </>
      }
    >
      <form
        id="category-edit"
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onSave(trimmed, kind, groupId === "" ? null : groupId);
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
        <Field
          label="Group"
          hint="Groups are read together on the budget page. A category belongs to at most one."
        >
          <Select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
            <option value="">No group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
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
  const [newGroupId, setNewGroupId] = useState("");
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
  const [groupName, setGroupName] = useState("");
  const [groupPolicy, setGroupPolicy] = useState<CategoryGroup["policy"]>("standalone");
  const removeGroup = useConfirm<CategoryGroup>();
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
  const groups = useQuery({
    queryKey: ["category-groups"],
    queryFn: () => api<CategoryGroup[]>("/api/v1/category-groups"),
  });

  const [groupResetNonce, setGroupResetNonce] = useState(0);
  const groupMutation = useMutation({
    mutationFn: async (
      input:
        | { action: "create"; name: string; policy: CategoryGroup["policy"] }
        | {
            action: "update";
            group: CategoryGroup;
            policy?: CategoryGroup["policy"];
            name?: string;
          }
        | { action: "delete"; group: CategoryGroup },
    ) => {
      if (input.action === "create") {
        return api<CategoryGroup>(
          "/api/v1/category-groups",
          json({ name: input.name, policy: input.policy }),
        );
      }
      if (input.action === "update") {
        return api<CategoryGroup>(`/api/v1/category-groups/${input.group.id}`, {
          ...json({
            // Only what changed. A patch key left out leaves the field alone,
            // which is what makes renaming and re-policying the same request.
            ...(input.policy === undefined ? {} : { policy: input.policy }),
            ...(input.name === undefined ? {} : { name: input.name }),
            expectedVersion: input.group.version,
          }),
          method: "PUT",
        });
      }
      return api<{ id: string }>(`/api/v1/category-groups/${input.group.id}`, {
        ...json({ expectedVersion: input.group.version }),
        method: "DELETE",
      });
    },
    onSuccess: async () => {
      setGroupName("");
      // Both, because a group's categories are shown with it and deleting a
      // group leaves them behind without one.
      await queryClient.invalidateQueries({ queryKey: ["category-groups"] });
      await queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
    // The rename inputs are uncontrolled, so a refused name would stay on
    // screen looking accepted while the server still holds the old one. The
    // nonce remounts them back to what is actually stored, beside the error.
    onError: () => setGroupResetNonce((nonce) => nonce + 1),
  });

  const categoryMutation = useMutation({
    mutationFn: async (
      input:
        | { action: "create"; name: string; kind: CategoryKind; groupId: string | null }
        | {
            action: "update";
            category: Category;
            name: string;
            kind: CategoryKind;
            groupId: string | null;
          }
        | { action: "archive" | "delete"; category: Category },
    ) => {
      if (input.action === "create") {
        return api<Category>(
          "/api/v1/categories",
          // `groupId` too. `create_category` has always accepted it, so leaving
          // it off here made it a request field only an agent could set — the
          // `categoryKind` defect, one level down and in the same place.
          json({ name: input.name, kind: input.kind, groupId: input.groupId }),
        );
      }
      if (input.action === "update") {
        return api<Category>(`/api/v1/categories/${input.category.id}`, {
          ...json({
            name: input.name,
            kind: input.kind,
            // Always sent, so clearing a group is a clear rather than a skip.
            groupId: input.groupId,
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
        // The groups too: a group carries how many categories are in it, and
        // moving one is exactly what changes that number. Without this the
        // count sat at zero beside a row that had just been filed.
        queryClient.invalidateQueries({ queryKey: ["category-groups"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["budgets"] }),
        queryClient.invalidateQueries({ queryKey: ["forecast"] }),
      ]);
    },
  });

  const selectedCategories = (categories.data ?? []).filter((category) =>
    selectedIds.has(category.id),
  );
  const target = selectedCategories.find((category) => category.id === targetId);
  const sourceCategories = selectedCategories.filter((category) => category.id !== targetId);
  // One key per intended merge, not per attempt, so a click that timed out and
  // was pressed again is the same merge asked for twice rather than two merges.
  // Replaced on success, because the next merge is a different intention.
  const mergeIdempotencyKey = useRef(newIdempotencyKey());
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
          idempotencyKey: mergeIdempotencyKey.current,
        }),
      );
    },
    onSuccess: async () => {
      mergeIdempotencyKey.current = newIdempotencyKey();
      setSelectedIds(new Set());
      setTargetId("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["budgets"] }),
        queryClient.invalidateQueries({ queryKey: ["forecast"] }),
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
    categoryMutation.mutate({ action: "create", name, kind, groupId: newGroupId || null });
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
          <Select
            aria-label="Category group"
            value={newGroupId}
            onChange={(event) => setNewGroupId(event.target.value)}
          >
            <option value="">No group</option>
            {(groups.data ?? []).map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
          <Button type="submit" loading={categoryMutation.isPending}>
            <Plus size={16} /> Add category
          </Button>
        </form>
        {categoryMutation.error ? <Alert>{categoryMutation.error.message}</Alert> : null}
      </section>

      <section className="panel settings-section">
        <div className="section-title">
          <span>
            <FolderTree size={19} />
          </span>
          <div>
            <h2>Groups</h2>
            <p>
              One level of grouping, read together on the budget page. Nothing on a transaction
              names a group, so grouping changes no figure until you budget one.
            </p>
          </div>
        </div>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = groupName.trim();
            if (trimmed) {
              groupMutation.mutate({ action: "create", name: trimmed, policy: groupPolicy });
            }
          }}
        >
          <Input
            required
            aria-label="Group name"
            placeholder="Fixed costs"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
          />
          <Select
            aria-label="Group budget"
            value={groupPolicy}
            onChange={(event) => setGroupPolicy(event.target.value as CategoryGroup["policy"])}
          >
            <option value="standalone">Has a budget of its own</option>
            <option value="sum_of_children">Adds up its categories' budgets</option>
          </Select>
          <Button type="submit" loading={groupMutation.isPending}>
            <Plus size={16} /> Add group
          </Button>
        </form>
        {groupMutation.error ? <Alert>{groupMutation.error.message}</Alert> : null}
        {/* Three states, not one. A failed read used to render the same "No
            groups yet." as an empty ledger, while every group picker on the
            page silently offered nothing but "No group" — which reads exactly
            like a product where categories cannot be grouped at all. */}
        {groups.isError ? (
          <Alert kind="error">
            The groups could not be loaded, so this list and every group picker on this page are
            empty for a reason that is not the ledger. {(groups.error as Error).message}
          </Alert>
        ) : groups.isPending ? (
          <Skeleton height={90} label="Loading groups…" />
        ) : groups.data.length === 0 ? (
          <p className="settings-note">No groups yet.</p>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Category groups">
            <table className="data-table">
              <caption className="sr-only">Category groups</caption>
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Budgeted as</th>
                  <th scope="col" className="align-right">
                    Categories
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(groups.data ?? []).map((group) => (
                  <tr key={group.id}>
                    <th scope="row">
                      {/* Renamed in place. The agent surface could rename a
                          group from the first day it existed and this page
                          could not, which is the parity rule pointing the other
                          way. */}
                      <Input
                        key={`${group.id}:${group.version}:${groupResetNonce}`}
                        aria-label={`Name of ${group.name}`}
                        defaultValue={group.name}
                        onBlur={(event) => {
                          const next = event.target.value.trim();
                          if (next !== "" && next !== group.name) {
                            groupMutation.mutate({ action: "update", group, name: next });
                          }
                        }}
                      />
                    </th>
                    <td>
                      <Select
                        aria-label={`How ${group.name} is budgeted`}
                        value={group.policy}
                        onChange={(event) =>
                          groupMutation.mutate({
                            action: "update",
                            group,
                            policy: event.target.value as CategoryGroup["policy"],
                          })
                        }
                      >
                        <option value="standalone">Has a budget of its own</option>
                        <option value="sum_of_children">Adds up its categories' budgets</option>
                      </Select>
                    </td>
                    <td className="align-right">{group.categoryCount}</td>
                    <td className="align-right">
                      <Button
                        variant="ghost"
                        onClick={() =>
                          removeGroup.ask(group, () =>
                            groupMutation.mutate({ action: "delete", group }),
                          )
                        }
                      >
                        Delete {group.name}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ConfirmDialog
        open={removeGroup.open}
        title="Delete this group?"
        description="The categories in it stay exactly where they are and lose their group. A budget set on the group itself goes with it, because a budget about nothing is not a budget."
        confirmLabel="Delete group"
        onCancel={removeGroup.cancel}
        onConfirm={removeGroup.confirm}
      />

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
              {/* The group, on the row, because until now the only way to put a
                  category in one was an unlabelled pencil that opens a modal —
                  and no row ever said which group it was already in. A group
                  you cannot see is a group nobody fills. */}
              <Select
                aria-label={`Group of ${category.name}`}
                value={category.groupId ?? ""}
                disabled={categoryMutation.isPending}
                onChange={(event) =>
                  categoryMutation.mutate({
                    action: "update",
                    category,
                    name: category.name,
                    kind: category.kind,
                    groupId: event.target.value === "" ? null : event.target.value,
                  })
                }
              >
                <option value="">No group</option>
                {(groups.data ?? []).map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </Select>
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
      ) : categories.error ? null : search.trim() ? (
        /* Two screens, not one. "Nothing here yet" and "nothing matches what
            you typed" have different next actions, and one sentence asking for
            both leaves a reader who has typed a search wondering whether their
            ledger is empty. */
        <EmptyState
          icon={<Tags size={24} />}
          title="No categories match this search"
          body="Change what you typed, or turn on Show archived to look at the ones you have put away."
        />
      ) : (
        <EmptyState
          icon={<Tags size={24} />}
          title="No categories yet"
          body="Add one above, and every transaction filed under it is counted here."
        />
      )}

      <CategoryDialog
        category={editing}
        groups={groups.data ?? []}
        onClose={() => setEditing(null)}
        onSave={(name, kind, groupId) => {
          if (!editing) return;
          categoryMutation.mutate({ action: "update", category: editing, name, kind, groupId });
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
