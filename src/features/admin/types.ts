import type { Person } from "../../core/types";

export type QuotaSource = "default" | "custom";

export interface AdminUser extends Person {
  siteRole: "admin" | "user";
  createdAt: string | null;
  storageBytes: number;
  storageLimit: number;
  storageSource: QuotaSource;
  storageOver: number;
  teamCount: number;
  teamLimit: number;
  teamLimitSource: QuotaSource;
}

export interface AdminTeam {
  spaceId: string;
  name: string;
  ownerId: string;
  ownerName: string;
  memberCount: number;
  archived: boolean;
  createdAt: string;
  storageBytes: number;
  storageLimit: number;
  storageSource: QuotaSource;
  storageOver: number;
}

export interface Overview {
  timezone: string;
  users: number;
  newToday: number;
  teams: { active: number; archived: number };
  quotaBytes: { personal: number; teams: number; total: number };
  disk: { databaseBytes: number; attachmentsBytes: number; freeBytes: number | null };
  over: { kind: "user" | "kb"; id: string; used: number; limit: number; source: QuotaSource; over: number; label: string }[];
}

export interface QuotaSettings {
  personalStorageBytes: number;
  teamStorageBytes: number;
  teamCreation: number;
}

export interface QuotaImpact {
  affected: number;
  newlyOver: number;
  overIds: string[];
}

export interface About {
  name: string;
  version: string;
  repository: string;
  node: string;
  timezone: string;
  startedAt: string;
}

export interface UpdateCheck {
  tag: string;
  name: string;
  notes: string;
  asset: string | null;
  newer: boolean;
}

export type UpdateStep = "download" | "verify" | "unpack" | "install" | "switch" | "restart" | "check";
export interface UpdateStatus {
  status: "idle" | "running" | "failed" | "applied";
  step?: UpdateStep;
  version?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/* UC-31 backup admin types. `password` never leaves the server; the client
   sees only `passwordSet`. */
export interface BackupMaskedConfig {
  enabled: boolean;
  webdav: { url: string; user: string; passwordSet: boolean };
  schedule: { hour: number; minute: number };
  retention: number;
  chunkBytes: number;
}

export type BackupResultKind = "ok" | "auth" | "network" | "other" | "interrupted";

export interface BackupState {
  running: boolean;
  runningSince: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastResult: BackupResultKind | null;
  lastError: string | null;
  lastArchiveId: string | null;
  remoteCount: number | null;
  pending: { archiveId: string; file: string; url: string; user: string } | null;
}

export interface BackupStatus {
  config: BackupMaskedConfig;
  state: BackupState;
}

export interface BackupTestResult {
  ok: boolean;
  warning?: string;
  kind?: string;
  error?: string;
}

export interface AccountQuota {
  storage: { used: number; limit: number; source: QuotaSource; over: number };
  teams: { count: number; limit: number; source: QuotaSource };
  managed: { spaceId: string; name: string; used: number; limit: number; over: number }[];
}

export function formatBytes(bytes: number): string {
  const GB = 1_000_000_000;
  if (bytes >= GB) return `${Math.round(bytes / GB * 10) / 10} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000 * 10) / 10} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

export function parseBytesInput(text: string): number | null {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 1_000_000_000);
}

export function formatDate(iso: string | null): string {
  if (!iso) return "未知";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "未知";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
