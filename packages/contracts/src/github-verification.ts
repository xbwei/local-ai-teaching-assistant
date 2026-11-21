/** Volatile factual evidence for human review only; never model/History input. */
export interface GitHubVerification {
  repository: string;
  repositoryId: string;
  ref: string;
  commit: string;
  status: "OBSERVED" | "PARTIAL";
  files: {
    path: string;
    status: "PRESENT" | "ABSENT" | "UNKNOWN";
    reason?: string;
    blob?: string;
    size?: number;
    latestCommit?: string;
    authorTime?: string;
    committerTime?: string;
  }[];
  pullRequest: {
    required: boolean;
    status: "NOT_REQUIRED" | "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
    number?: number;
    base?: string;
    head?: string;
    headCommit?: string;
    baseCommit?: string;
    openedAt?: string;
    mergedAt?: string | null;
    reason?: string;
  };
}
