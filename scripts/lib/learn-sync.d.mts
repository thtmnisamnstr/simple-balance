/**
 * Types for `learn-sync.mjs`, which is plain ESM because `sync-learn.mjs` runs
 * under `node` with nothing to compile it. See `scripts/capacity/cohorts.d.mts`
 * for why a module a strict test imports has to be typed rather than left as
 * `any`.
 */
export declare const PACK_FORMAT: "simple-balance-learn-pack-1";
export declare const SITE: string;
export declare const EXIT_CODES: Readonly<{ inSync: 0; drifted: 1; unknown: 2 }>;

export declare class SyncError extends Error {}

export type PackArticle = {
  slug: string;
  title: string;
  description: string;
  url: string;
  updated: string;
  sha256: string;
  steps: string[];
  lines: string[];
};

export type Pack = {
  format: string;
  source: {
    site: string;
    from: string;
    builtAt: string | null;
    llmsSha256: string;
    syncedAt: string;
    license: string;
  };
  articles: PackArticle[];
};

export type Comparison = {
  inSync: boolean;
  added: string[];
  removed: string[];
  changed: { slug: string; stepsChanged: boolean; stepsBefore: string[]; stepsAfter: string[] }[];
  reordered: boolean;
  restamp: boolean;
};

export declare function sha256(text: string): string;
export declare function parseLlms(text: string, site?: string): string[];
export declare function parseCopy(
  text: string,
  slug: string,
  site?: string,
): { title: string; description: string; url: string; updated: string };
export declare function foldQuotes(text: string): string;
export declare function productHeadings(text: string): string[];
export declare function localProvenance(input: {
  sha: string | null;
  dirty: boolean;
  builtAt?: string | null;
}): string;
export declare function buildPack(input: {
  site?: string;
  from: string;
  builtAt?: string | null;
  llmsText: string;
  copies: ReadonlyMap<string, string>;
  syncedAt: string;
}): Pack;
export declare function comparePack(vendored: Pack | null, fresh: Pack): Comparison;
export declare function previewNote(pack: Pack | null): string | null;
export declare function formatReport(
  result: Partial<Comparison> & { note?: string },
  context: { vendoredFrom?: string | null; freshFrom?: string },
): string;
