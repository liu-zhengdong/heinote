import { setPriority } from "node:os";
import { Store } from "./store.ts";
import { runImportBody, type ImportJob, type ImportSource } from "./import.ts";

/* Runs one whole import off the main server event loop, inside an isolated
   low-priority child process with its own SQLite connection and heap limit.
   Progress updates are throttled (every 200ms) except for status transitions. */

try {
  setPriority(process.pid, 10);
} catch {
  /* Best-effort CPU niceness; ignore on platforms disallowing setPriority. */
}

interface StartMessage {
  kind: "start";
  dataDir: string;
  actor: unknown;
  source: ImportSource;
  jobId: string;
  archivePath: string;
  targetScope: string;
  parentId?: string;
  title: string;
}

const PROGRESS_THROTTLE_MS = 200;

let commitAckResolver: (() => void) | undefined;

process.on("disconnect", () => {
  process.exit(1);
});

process.on("message", async (message: StartMessage | { kind: string }) => {
  if (message.kind === "commit_ack") {
    commitAckResolver?.();
    commitAckResolver = undefined;
    return;
  }
  if (message.kind !== "start") return;

  const data = message as StartMessage;
  const nowMs = Date.now();
  const job: ImportJob = {
    id: data.jobId,
    userId: (data.actor as { user: { id: string } }).user.id,
    source: data.source,
    status: "queued",
    phase: "读取文件…",
    done: 0,
    total: 0,
    targetScope: data.targetScope,
    ...(data.parentId ? { parentId: data.parentId } : {}),
    title: data.title,
    totalBytes: 0,
    partSize: 0,
    partCount: 0,
    uploadedBytes: 0,
    created: nowMs,
    updatedAt: nowMs,
  };

  let lastSentAt = 0;
  let lastStatus = job.status;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && job.status === lastStatus && now - lastSentAt < PROGRESS_THROTTLE_MS) return;
    lastSentAt = now;
    lastStatus = job.status;
    process.send?.({
      kind: "job",
      job: {
        status: job.status,
        phase: job.phase,
        done: job.done,
        total: job.total,
        ...(job.result ? { result: job.result } : {}),
        ...(job.error ? { error: job.error } : {}),
      },
    });
  };

  const mirror = new Proxy(job, {
    set(target, key, value) {
      target[key as keyof ImportJob] = value as never;
      if (["status", "phase", "done", "total", "result", "error"].includes(String(key))) {
        emit(key === "status" || key === "result" || key === "error");
      }
      return true;
    },
  });

  try {
    const store = new Store(data.dataDir);
    await runImportBody(store, data.actor as never, mirror, data.archivePath, {
      onBeforeCommit() {
        return new Promise<void>((resolveAck) => {
          commitAckResolver = resolveAck;
          process.send?.({ kind: "committing" });
        });
      },
    });
    emit(true);
    process.exit(0);
  } catch (error) {
    mirror.status = "failed";
    mirror.error = error instanceof Error ? error.message : String(error);
    emit(true);
    process.exit(0);
  }
});
