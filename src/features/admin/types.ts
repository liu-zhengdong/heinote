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
