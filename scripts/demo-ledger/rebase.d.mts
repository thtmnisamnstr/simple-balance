/**
 * Types for `rebase.mjs`, which is plain ESM because `build.mjs` and `load.mjs`
 * import it and both are plain ESM. See `scripts/capacity/cohorts.d.mts` for
 * why a module a strict test imports has to be typed rather than left as `any`.
 */
export declare const DEMO_LEDGER_PATH: string;
export declare const DEMO_PERSON: Readonly<{ name: string; email: string; password: string }>;
export declare function readDemoLedger(): unknown;
export declare function shiftDay(date: string, months: number): string;
export declare function lastEntryDate(file: {
  entries: { date: string }[];
  throughDate: string;
}): string;
export declare function monthsBetween(from: string, to: string): number;
export declare function shiftLedgerFile<File>(file: File, months: number): File;
export declare function rebaseLedgerFile<File>(
  file: File,
  options: { today: string; monthsBack?: number },
): File;
export declare function demoLedgerMove(options: { today: string; monthsBack?: number }): {
  ledgerFile: string;
  fileName: string;
  idempotencyKey: string;
};
