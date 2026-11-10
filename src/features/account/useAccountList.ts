import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";

export function useAccountList<T>(path: string, active = true) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<T[]>(path, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setItems(next);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, revision, active]);
  return { items, setItems, loading, error, setError, retry };
}

export function formatDate(value: string | null): string {
  if (!value) return "未使用";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-CN") : "未知日期";
}
