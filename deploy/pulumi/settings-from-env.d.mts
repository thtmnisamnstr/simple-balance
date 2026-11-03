/**
 * The types of `./settings-from-env.mjs`, which is plain JavaScript so that
 * Node 20 runs it without a TypeScript step. Read by the test suite at the
 * repository root, which imports the script's functions to check them.
 */
export interface SettingsLists {
  server: string[];
  secret: string[];
  collector: string[];
  collectorSecret: string[];
}
export function settingsLists(source?: string): SettingsLists;
export const LEFT_OUT: Readonly<Record<string, string>>;
export function parseEnvFile(text: string): [name: string, value: string][];
export function plan(
  entries: [name: string, value: string][],
  lists?: SettingsLists,
): {
  set: { name: string; value: string; secret: boolean }[];
  skipped: [name: string, reason: string][];
};
