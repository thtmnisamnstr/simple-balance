import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Combine,
  FolderTree,
  Pencil,
  Plus,
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
  MergePanel,
  Modal,
  PageHeader,
  RowMenu,
  SearchBox,
  Select,
  Skeleton,
  SortMenu,
  type SortState,
  useConfirm,
} from "../components.js";
import { emptyScreen, waysOut } from "../list-filters.js";
import { categoryKindLabels } from "../select-options.js";

const kindLabels: Record<CategoryKind, string> = categoryKindLabels;

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
    // because the whole point is that the person changes it afterward. The
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
          <Button
            type="submit"
            form="category-edit"
            disabled={!trimmed}
            disabledReason="Give the category a name."
          >
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
          <Input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
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

/** What a row action on a category would have done, for the sentence saying it did not. */
function rowActionVerb(input: { action: "update" | "archive" | "delete"; category: Category }) {
  if (input.action === "delete") return "deleted";
  if (input.action === "archive") return input.category.archivedAt ? "restored" : "archived";
  return "changed";
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
  /** What a row action just did, said where focus can reach it. See the mutation below. */
  const [rowNotice, setRowNotice] = useState("");
  // Two controls empty this list and the condition only ever read one of them,
  // so somebody who had archived every category was told they had none. The
  // toggle is `fromTheStart` because it ships off: counting it as narrowing
  // would make "no categories yet" unreachable on a ledger that really has
  // none.
  const { narrowed, ways } = emptyScreen([
    { set: Boolean(search.trim()), clear: "clear the search" },
    {
      set: !includeArchived,
      clear: "turn on Show archived to look at the ones you have put away",
      fromTheStart: true,
    },
  ]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [targetId, setTargetId] = useState("");
  const [mergeOutcome, setMergeOutcome] = useState<string | null>(null);
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
  // What the last group action did, beside the groups rather than beside the
  // categories, because a group's delete takes its own row and focus with it.
  const [groupNotice, setGroupNotice] = useState("");
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
    onMutate: () => setGroupNotice(""),
    onSuccess: async (_result, input) => {
      // Only a create clears the add form: a rename or a policy change elsewhere
      // on the page used to wipe a group name half typed into it.
      if (input.action === "create") setGroupName("");
      // A delete takes its row and the button that did it, so focus fell to
      // `<body>` with nothing saying the group had gone (`web.md` 13.3).
      if (input.action === "delete") {
        setGroupNotice(
          `Group “${input.group.name}” deleted. Its categories are still here, now in no group.`,
        );
      }
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
    // A notice about the last row action is not true of the next one, and left
    // up it sat beside that one's refusal saying the opposite.
    onMutate: () => setRowNotice(""),
    onSuccess: async (_result, input) => {
      /*
       * 13.3, and `web.md` 9.8 names this as the shape that keeps recurring:
       * archiving runs straight from the row menu with no dialog, and the row
       * leaves the list whenever Show archived is off — which it is by
       * default — so the menu closed, the button went with the row, and focus
       * fell to `<body>`. Deleting does the same whatever the toggle says. A
       * rename is not here: that row stays where it is and the dialog it came
       * from returns focus itself.
       */
      if (input.action === "archive")
        setRowNotice(
          input.category.archivedAt
            ? `${input.category.name} restored.`
            : `${input.category.name} archived.`,
        );
      if (input.action === "delete") setRowNotice(`${input.category.name} deleted.`);
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
    onMutate: () => setMergeOutcome(null),
    onSuccess: async (result) => {
      // 13.3's shape, which the rule states as a list of pages rather than as
      // a property: a control whose success unmounts the control. Merging
      // empties the participant set, the panel renders only at two or more, so
      // the button goes and focus falls to `<body>` — and the only Alert in
      // this panel was the error one, so a merge of nine spellings reported
      // nothing at all.
      //
      // Read off the answer, not off the request. 11.9: the server computes
      // `mergedSourceCategoryIds`, `updatedTransactionCount` and
      // `updatedStagedTransactionCount` and all three were dropped, so the one
      // message shown after an irreversible write said nothing about how much
      // of the ledger had just moved — and counted `sourceCategories.length`,
      // which is what was *asked for*. An idempotent replay of the same key,
      // or a source another tab had already folded, merges fewer than were
      // named and the sentence would still have claimed all of them.
      const folded = result.mergedSourceCategoryIds.length;
      const moved = result.updatedTransactionCount;
      const staged = result.updatedStagedTransactionCount;
      setMergeOutcome(
        `${folded} ${folded === 1 ? "category" : "categories"} folded into “${
          result.targetCategory.name
        }”. ${moved} committed ${moved === 1 ? "entry" : "entries"} and ${staged} staged ${
          staged === 1 ? "row" : "rows"
        } now name it.`,
      );
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
      <section className="panel panel-stack">
        {/* A form, so each control is a `Field` with a label on screen. They were
            bare controls named by `aria-label`, with a placeholder as the only
            visible word — "Groceries" — which vanishes on the first keystroke
            and was never a label (`web.md` 8.1, SC 3.3.2). A filter bar may be
            bare because it has no submit, no refusal and no required field;
            this has all three. */}
        <form className="inline-form" onSubmit={addCategory}>
          <Field label="Category name">
            <Input
              required
              placeholder="Groceries"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Applies to">
            <Select value={kind} onChange={(event) => setKind(event.target.value as CategoryKind)}>
              <option value="expense">{kindLabels.expense}</option>
              <option value="income">{kindLabels.income}</option>
              <option value="both">{kindLabels.both}</option>
            </Select>
          </Field>
          <Field label="Category group">
            <Select value={newGroupId} onChange={(event) => setNewGroupId(event.target.value)}>
              <option value="">No group</option>
              {(groups.data ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" loading={categoryMutation.isPending}>
            <Plus size={16} /> Add category
          </Button>
        </form>
        {categoryMutation.error && categoryMutation.variables?.action === "create" ? (
          <Alert>{categoryMutation.error.message}</Alert>
        ) : null}
      </section>

      <section className="panel panel-stack">
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
          <Field label="Group name">
            <Input
              required
              placeholder="Fixed costs"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
            />
          </Field>
          <Field label="Group budget">
            <Select
              value={groupPolicy}
              onChange={(event) => setGroupPolicy(event.target.value as CategoryGroup["policy"])}
            >
              <option value="standalone">Has a budget of its own</option>
              <option value="sum_of_children">Adds up its categories' budgets</option>
            </Select>
          </Field>
          <Button type="submit" loading={groupMutation.isPending}>
            <Plus size={16} /> Add group
          </Button>
        </form>
        {groupMutation.error ? <Alert>{groupMutation.error.message}</Alert> : null}
        {groupNotice ? (
          <Alert kind="success" takeFocus>
            {groupNotice}
          </Alert>
        ) : null}
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
          <EmptyState
            compact
            icon={FolderTree}
            title="No groups yet"
            body="Group related categories so one budget can cover all of them at once."
          />
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
                        onKeyDown={(event) => {
                          // Escape puts the stored name back and Enter commits,
                          // the two keys every other click-to-edit cell honors
                          // (`web.md` 8.10).
                          if (event.key === "Escape") event.currentTarget.value = group.name;
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        onBlur={(event) => {
                          const next = event.target.value.trim();
                          // A name cleared and left is put back rather than left
                          // blank on screen: nothing is sent for it, so a blank
                          // field was showing a group the server still names.
                          if (next === "") event.target.value = group.name;
                          else if (next !== group.name) {
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
                    {/* A trash icon in `.row-actions`, like every other
                        per-row delete in the product. It was a full-width ghost
                        button reading "Delete Fixed costs" in a row whose first
                        cell is an input already holding "Fixed costs", which is
                        the argument `BudgetsPage` records above its own table
                        and the state this one was left in. */}
                    <td className="row-actions">
                      <button
                        type="button"
                        aria-label={`Delete the group ${group.name}`}
                        onClick={() =>
                          removeGroup.ask(group, () =>
                            groupMutation.mutate({ action: "delete", group }),
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </button>
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

      <div className="filter-bar">
        <SearchBox
          label="Search categories"
          placeholder="Search by name"
          value={search}
          onChange={setSearch}
        />
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
        <MergePanel>
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
            disabledReason={
              target
                ? "Select at least one category to merge into it."
                : "Choose the category to keep."
            }
            onClick={() => {
              merge.ask(target?.name ?? "", () => mergeMutation.mutate());
            }}
          >
            <Combine size={16} /> Merge
          </Button>
          {/* "Clear selection", the word the three bulk bars use for the same
              escape. "Cancel" here was a fourth spelling of one operation, on
              a panel a person reaches from the same list. */}
          <Button
            variant="ghost"
            onClick={() => {
              setSelectedIds(new Set());
              setTargetId("");
            }}
          >
            Clear selection
          </Button>
          {mergeMutation.error ? <Alert>{mergeMutation.error.message}</Alert> : null}
        </MergePanel>
      ) : null}
      {mergeOutcome ? (
        <Alert kind="success" takeFocus>
          {mergeOutcome}
        </Alert>
      ) : null}

      {rowNotice ? (
        <Alert kind="success" takeFocus>
          {rowNotice}
        </Alert>
      ) : null}
      {/* A refusal from a row, beside the notices about rows and naming the
          category, taking focus. It used to render in the Add category panel
          at the top of the page, so a refused delete far down the list
          changed nothing anybody could see. */}
      {categoryMutation.error &&
      categoryMutation.variables &&
      categoryMutation.variables.action !== "create" ? (
        <Alert takeFocus>
          {`“${categoryMutation.variables.category.name}” was not ${rowActionVerb(
            categoryMutation.variables,
          )}. ${categoryMutation.error.message}`}
        </Alert>
      ) : null}

      {categories.error ? <Alert>{categories.error.message}</Alert> : null}
      {duplicates.error ? <Alert>{duplicates.error.message}</Alert> : null}

      {filtered.length ? (
        <div className="record-list record-list-card">
          {filtered.map((category, index) => (
            <div className="record-row" key={category.id}>
              <div className="record-name">
                <input
                  type="checkbox"
                  aria-label={`Select ${category.name} for merging`}
                  data-selection-home={index === 0 || undefined}
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
                {/* Here rather than in the badge cell below, which
                    `styles.css`'s 560px block hides outright. That is right for
                    the two badges under it — the kind and the count are both
                    already in the subtitle a line up — and wrong for this one,
                    which is said nowhere else. An archived category on a phone
                    showed nothing at all saying it was archived, on the only
                    screen you reach by turning "Show archived" on. */}
                {category.archivedAt ? <Badge>Archived</Badge> : null}
              </div>
              <div>
                <Badge tone={category.kind === "expense" ? "red" : "green"}>
                  {kindLabels[category.kind]}
                </Badge>
                <Badge tone="blue">
                  {category.totalCount} transaction
                  {category.totalCount === 1 ? "" : "s"}
                </Badge>
              </div>
              {/* The group, on the row, because until now the only way to put a
                  category in one was an unlabeled pencil that opens a modal —
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
              {/* Edit and Delete as icons, the rest behind a menu, which is
                  what the register and the staged queue do and what this was
                  the only list not to: three bare icons and no menu made it a
                  fourth pattern in a product that already had three. Archive is
                  the one that moves, because it is the action a person reaches
                  for least often on a category they are looking at. */}
              <div className="row-actions">
                <button aria-label={`Edit ${category.name}`} onClick={() => setEditing(category)}>
                  <Pencil size={16} />
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
                <RowMenu label={`Actions for ${category.name}`}>
                  <button
                    type="button"
                    onClick={() => categoryMutation.mutate({ action: "archive", category })}
                  >
                    {category.archivedAt ? (
                      <>
                        <ArchiveRestore size={15} /> Restore {category.name}
                      </>
                    ) : (
                      <>
                        <Archive size={15} /> Archive {category.name}
                      </>
                    )}
                  </button>
                </RowMenu>
              </div>
            </div>
          ))}
        </div>
      ) : categories.isPending ? (
        <Skeleton height={120} label="Loading categories…" />
      ) : categories.error ? null : (
        /* Three readings of an empty list, not two. "Nothing here yet" and
            "nothing matches what you typed" have different next actions, and
            between them sits the case this page kept getting wrong: nothing
            typed, and the archived ones hidden by a toggle that ships off. The
            page cannot ask whether archived categories exist — the hiding is
            the server's and the response holds only what it let through — so
            the title says "in this view" and the body names the toggle. */
        <EmptyState
          icon={Tags}
          title={
            narrowed
              ? "No categories match this view"
              : ways.length
                ? "No categories in this view"
                : "No categories yet"
          }
          body={
            narrowed
              ? waysOut(ways)
              : `Add one above, and every transaction filed under it is counted here.${
                  ways.length ? ` ${waysOut(ways)}` : ""
                }`
          }
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
