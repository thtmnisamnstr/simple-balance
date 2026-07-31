import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Combine,
  Pencil,
  Plus,
  Search,
  Tags,
  Trash2,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useLocation } from "../router.js";
import type { CategoryKind } from "../../shared/domain.js";
import {
  api,
  json,
  type Category,
  type CategoryDuplicateGroup,
  type CategoryMergeResult,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
} from "../components.js";

const kindLabels: Record<CategoryKind, string> = {
  income: "Income",
  expense: "Expense",
  both: "Income or expense",
};

export default function CategoriesPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [targetId, setTargetId] = useState("");
  const categories = useQuery({
    queryKey: ["categories", includeArchived],
    queryFn: () =>
      api<Category[]>(
        `/api/v1/categories${includeArchived ? "?includeArchived=true" : ""}`,
      ),
  });
  const duplicates = useQuery({
    queryKey: ["categories", "duplicates"],
    queryFn: () =>
      api<CategoryDuplicateGroup[]>("/api/v1/categories/duplicates"),
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
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  const selectedCategories = (categories.data ?? []).filter((category) =>
    selectedIds.has(category.id),
  );
  const target = selectedCategories.find((category) => category.id === targetId);
  const sourceCategories = selectedCategories.filter(
    (category) => category.id !== targetId,
  );
  const mergeMutation = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("Choose the category to keep");
      return api<CategoryMergeResult>(
        "/api/v1/categories/merge",
        json({
          sourceCategoryIds: sourceCategories.map((category) => category.id),
          targetCategoryId: target.id,
          expectedVersions: Object.fromEntries(
            sourceCategories.map((category) => [
              category.id,
              category.version,
            ]),
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
    if (!value) return categories.data ?? [];
    return (categories.data ?? []).filter((category) =>
      category.name.toLocaleLowerCase().includes(value),
    );
  }, [categories.data, search]);

  const addCategory = (event: FormEvent) => {
    event.preventDefault();
    categoryMutation.mutate({ action: "create", name, kind });
  };

  const chooseDuplicateGroup = (group: CategoryDuplicateGroup) => {
    const targetCategory =
      group.categories.find((category) => !category.archivedAt) ??
      group.categories[0];
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
        description="Create simple income and expense labels, find duplicates, and merge them safely."
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
        {categoryMutation.error ? (
          <Alert>{categoryMutation.error.message}</Alert>
        ) : null}
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
              <span>
                {group.categories.map((category) => category.name).join(", ")}
              </span>
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
            aria-label="Search categories"
            placeholder="Search categories"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
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
            <strong>
              Merge {selectedCategories.length} selected categories
            </strong>
            <small>
              Transactions and staged rows will move to the category you keep.
            </small>
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
              if (
                window.confirm(
                  `Merge the selected categories into “${target?.name}”? This removes the source categories.`,
                )
              ) {
                mergeMutation.mutate();
              }
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
                    event.target.checked
                      ? next.add(category.id)
                      : next.delete(category.id);
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
                  <small>{kindLabels[category.kind]}</small>
                </span>
              </div>
              <div>
                <Badge tone={category.kind === "expense" ? "red" : "green"}>
                  {kindLabels[category.kind]}
                </Badge>
                {category.archivedAt ? <Badge>Archived</Badge> : null}
              </div>
              <div className="row-actions">
                <button
                  aria-label={`Edit ${category.name}`}
                  onClick={() => {
                    const nextName = window
                      .prompt("Category name", category.name)
                      ?.trim();
                    if (!nextName) return;
                    const nextKind = window
                      .prompt(
                        "Applicability: income, expense, or both",
                        category.kind,
                      )
                      ?.trim()
                      .toLowerCase();
                    if (
                      nextKind === "income" ||
                      nextKind === "expense" ||
                      nextKind === "both"
                    ) {
                      categoryMutation.mutate({
                        action: "update",
                        category,
                        name: nextName,
                        kind: nextKind,
                      });
                    }
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  aria-label={
                    category.archivedAt
                      ? `Restore ${category.name}`
                      : `Archive ${category.name}`
                  }
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
                  aria-label={`Delete unused ${category.name}`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete unused category “${category.name}”?`,
                      )
                    ) {
                      categoryMutation.mutate({ action: "delete", category });
                    }
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Tags size={24} />}
          title="No categories in this view"
          body="Add a category or change the search and archive filters."
        />
      )}
    </>
  );
}
