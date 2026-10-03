/** Types for `schedule.mjs`. See `cohorts.d.mts` for why these exist. */
export interface Schedule {
  warmupMinutes: number;
  measureMinutes: number;
  rps: number;
  burstRps: number;
  burstAtMinute: number;
  burstMinutes: number;
  importsAtMinute: number;
  concurrentImports: number;
  importRows: number;
  dueRecurrences: number;
  virtualUsers: number;
  reports: string[];
}

export interface MixEntry {
  kind: string;
  percent: number;
  what: string;
}

export interface Thresholds {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorRate: number;
  cpuPercent: number;
  memoryPercent: number;
  connections: number;
  diskPercent: number;
}

export const SCHEDULE: Schedule;
export const MIX: MixEntry[];
export const THRESHOLDS: Thresholds;
