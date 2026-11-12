export interface StagedDirectory {
  dir: string;
  finalize(name: string): string;
  cleanup(): void;
}

export function stagedDirectory(parentDir: string): StagedDirectory;
export function snapshotDatabaseFile(databasePath: string, stagingDir: string): Promise<void>;
