import { parentPort, workerData } from "node:worker_threads";
import { Store } from "./store.ts";
import { runImportBody, type ImportJob } from "./import.ts";

/* Runs one whole import off the event loop, in its own SQLite connection.
   Every job field the pipeline touches is mirrored to the main thread as a
   progress message; a failed job ends with `failed` plus the error text. */

const data = workerData as { dataDir: string; actor: unknown; source: "obsidian" | "notion"; jobId: string; zip: ArrayBuffer };
const job: ImportJob = {
  id: data.jobId,
  userId: "",
  status: "queued",
  source: data.source,
  phase: "读取文件…",
  done: 0,
  total: 0,
  created: Date.now(),
};

const mirror = new Proxy(job, {
  set(target, key, value) {
    target[key as keyof ImportJob] = value as never;
    if (["status", "phase", "done", "total", "result", "error"].includes(String(key)))
      parentPort?.postMessage({ kind: "job", job: JSON.parse(JSON.stringify(target)) });
    return true;
  },
});

try {
  const store = new Store(data.dataDir);
  runImportBody(store, data.actor as never, mirror, Buffer.from(data.zip));
  mirror.userId = (data.actor as { user: { id: string } }).user.id;
  parentPort?.postMessage({ kind: "job", job });
  process.exit(0);
} catch (error) {
  mirror.status = "failed";
  mirror.error = error instanceof Error ? error.message : String(error);
  parentPort?.postMessage({ kind: "job", job });
  process.exit(0);
}
