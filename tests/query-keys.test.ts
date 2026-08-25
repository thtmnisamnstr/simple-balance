import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/client.md` 1.2: a query key names the resource, then
 * narrows. `["payees"]`, `["payees", "suggestions", term]`. Broad to narrow,
 * left to right, so invalidating `["payees"]` invalidates every suggestion list
 * under it.
 *
 * That prefix relationship is the whole rule, and it rests on one thing being
 * true of all 122 keys in `src/client`: the key is an array, and its first
 * element is a string somebody wrote out. A key that begins with a variable
 * cannot be invalidated by name, and a key that is not an array cannot be
 * invalidated by prefix at all.
 *
 * What this deliberately does not check is the guide's next sentence, "keep
 * them arrays of strings and primitives". Five keys in `TransactionBrowser.tsx`
 * carry an object or an array — the filter a list is showing, the sort it is
 * under — and they are correct: TanStack Query v5 hashes a key structurally,
 * with object keys sorted, so two equal filters produce one cache entry. A
 * check that banned them would have flagged five working queries, which is
 * exactly the trade this pass exists to avoid.
 */
const READERS = [
  "useQuery",
  "useQueries",
  "useSuspenseQuery",
  "useInfiniteQuery",
  "fetchQuery",
  "prefetchQuery",
  "ensureQueryData",
];

const WRITERS = [
  "invalidateQueries",
  "removeQueries",
  "refetchQueries",
  "cancelQueries",
  "resetQueries",
  "setQueryData",
  "setQueriesData",
  "getQueryData",
];

type KeyUse = {
  /** `src/client/…:123`, ready to paste into a failure message. */
  readonly where: string;
  /** The array literal as written, whitespace collapsed. */
  readonly key: string;
  /** The first element, or null when the key does not open with one. */
  readonly root: string | null;
  readonly reads: boolean;
};

/**
 * The index just past the `]` that closes an array opening at `start`.
 *
 * Strings are skipped rather than scanned, because a key may index into
 * something — `x["b"]` — and the bracket inside the quotes closes nothing.
 */
const endOfArray = (text: string, start: number): number => {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '"' || character === "'" || character === "`") {
      index += 1;
      while (index < text.length && text[index] !== character) {
        index += text[index] === "\\" ? 2 : 1;
      }
    } else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
};

/** The first element of an array literal, or null when it has none. */
const firstElement = (key: string): string | null => {
  const inner = key.slice(1, -1);
  let depth = 0;
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index]!;
    if (character === '"' || character === "'" || character === "`") {
      index += 1;
      while (index < inner.length && inner[index] !== character) {
        index += inner[index] === "\\" ? 2 : 1;
      }
    } else if ("[{(".includes(character)) depth += 1;
    else if ("]})".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) return inner.slice(0, index).trim();
  }
  const only = inner.trim();
  return only === "" ? null : only;
};

const isStringLiteral = (element: string | null) =>
  element !== null && /^(["'])[^"'\\]*\1$/.test(element);

const keyUsesIn = (code: string, where: string): KeyUse[] => {
  const found: KeyUse[] = [];
  for (const match of code.matchAll(/\bqueryKey:\s*/g)) {
    const start = match.index + match[0].length;
    const line = code.slice(0, start).split("\n").length;
    // Whichever TanStack function most recently opened decides whether this key
    // is declaring a cache entry or naming one that already exists. Looking back
    // rather than forward, because the key is inside that call's options object.
    // Matched by name rather than by `name(`, because `useQuery<Consent>({` puts
    // a type argument between the two and a call-shaped pattern misses it. That
    // one miss filed a live query as an invalidation of a resource nothing
    // declares, which is precisely the failure the last case here reports.
    const before = code.slice(Math.max(0, start - 500), start);
    const names = [...READERS, ...WRITERS].join("|");
    const caller = [...before.matchAll(new RegExp(`\\b(${names})\\b`, "g"))].at(-1)?.[1];
    const reads = caller !== undefined && READERS.includes(caller);
    const end = code[start] === "[" ? endOfArray(code, start) : -1;
    const key = code
      .slice(start, end === -1 ? start + 40 : end)
      .trim()
      .replaceAll(/\s+/g, " ");
    found.push({
      where: `${where}:${line}`,
      key,
      root: end === -1 ? null : firstElement(key),
      reads,
    });
  }
  return found;
};

const uses = sourceFiles("src/client").flatMap((file) => keyUsesIn(file.code, file.path));

describe("reading query keys", () => {
  it("tells an array literal from anything else", () => {
    const sample = [
      'const a = useQuery({ queryKey: ["payees", "suggestions", term], queryFn: f });',
      'queryClient.invalidateQueries({ queryKey: ["payees"] });',
      "const c = useQuery({ queryKey: keyFor(id), queryFn: f });",
      'const d = useQuery({ queryKey: [{ resource: "payees" }], queryFn: f });',
    ].join("\n");
    const read = keyUsesIn(sample, "sample.ts");
    expect(read.map((use) => use.root)).toEqual([
      `"payees"`,
      `"payees"`,
      null,
      `{ resource: "payees" }`,
    ]);
    expect(read.map((use) => use.reads)).toEqual([true, false, true, true]);
    expect(read.filter((use) => isStringLiteral(use.root))).toHaveLength(2);
  });

  it("finds the keys this app has", () => {
    expect(uses.length).toBeGreaterThan(100);
  });
});

describe("a query key", () => {
  it("is an array whose first element is a name somebody wrote", () => {
    const wrong = uses
      .filter((use) => !isStringLiteral(use.root))
      .map((use) => `${use.where} ${use.key}`);
    expect(wrong, "a key that does not open with a string cannot be invalidated by name").toEqual(
      [],
    );
  });

  // The other half of "broad to narrow": a prefix is only useful if something
  // is filed under it. An invalidation naming a resource no query declares is
  // silent — no error, no refetch, and a screen that keeps showing what it had.
  it("is invalidated under a name some query files itself under", () => {
    const declared = new Set(uses.filter((use) => use.reads).map((use) => use.root));
    const orphaned = uses
      .filter((use) => !use.reads && !declared.has(use.root))
      .map((use) => `${use.where} ${use.key}`);
    expect(orphaned).toEqual([]);
  });
});
