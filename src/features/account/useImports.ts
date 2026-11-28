import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeImportUpdates } from "../../collaboration/client";
import { api } from "./api";

export type ImportSource = "obsidian" | "notion";
export type ImportStatus = "uploading" | "queued" | "scanning" | "importing" | "committing" | "done" | "failed";

export interface ImportInitiator {
  userId: string;
  displayName: string;
  tokenId?: string;
  avatar?: string;
}

export interface ImportReportDto {
  rootPageId: string;
  parentPageId?: string;
  topLevelPageIds: string[];
  title: string;
  pages: number;
  attachments: number;
  links: number;
  unresolved: string[];
  warnings: string[];
}

export interface ImportJobDto {
  id: string;
  source: ImportSource;
  status: ImportStatus;
  phase: string;
  done: number;
  total: number;
  targetScope: string;
  parentId?: string;
  title: string;
  totalBytes: number;
  partSize: number;
  partCount: number;
  uploadedBytes: number;
  receivedParts?: number[];
  expiresAt?: number;
  result?: ImportReportDto;
  error?: string;
  created: number;
  updatedAt: number;
  dismissed?: boolean;
  initiator?: ImportInitiator;
  queuePosition?: number;
}

export function isActiveImportStatus(status: ImportStatus): boolean {
  return status === "uploading" || status === "queued" || status === "scanning" || status === "importing" || status === "committing";
}

export function useImportJobs(enabled: boolean) {
  const [jobs, setJobs] = useState<ImportJobDto[]>([]);
  const mountedRef = useRef(true);
  const inflightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || inflightRef.current) return;
    inflightRef.current = true;
    try {
      const payload = await api<{ jobs: ImportJobDto[] }>("/api/v1/imports");
      if (mountedRef.current) setJobs(Array.isArray(payload.jobs) ? payload.jobs : []);
    } catch {
      /* Ignore transient polling errors; next WS event or tick retries. */
    } finally {
      inflightRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      setJobs([]);
      return () => { mountedRef.current = false; };
    }
    void refresh();
    const stopWs = subscribeImportUpdates(() => {
      void refresh();
    });
    return () => {
      mountedRef.current = false;
      stopWs();
    };
  }, [enabled, refresh]);

  const hasActive = jobs.some((job) => isActiveImportStatus(job.status));

  useEffect(() => {
    if (!enabled || !hasActive) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 700);
    return () => window.clearInterval(timer);
  }, [enabled, hasActive, refresh]);

  const cancelJob = useCallback(async (id: string) => {
    await api<{ ok: boolean }>(`/api/v1/imports/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  const dismissJob = useCallback(async (id: string) => {
    await api<{ ok: boolean }>(`/api/v1/imports/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
    setJobs((current) => current.filter((job) => job.id !== id));
  }, []);

  return { jobs, refresh, cancelJob, dismissJob };
}
