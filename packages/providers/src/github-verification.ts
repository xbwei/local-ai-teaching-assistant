import type { GitHubVerification } from "@laita/contracts";
import type { SecretProvider, SecretReference } from "@laita/runtime";
import {
  VerificationError,
  verificationDigest,
  verificationId,
} from "./verification-support.ts";

export interface GitHubExpectation {
  canvasOrigin: string;
  courseId: string;
  teacherId: string;
  studentId: string;
  assignmentId: string;
  repository: string;
  repositoryId: string;
  studentGitHubId: string;
  readerGitHubId: string;
  studentGitHubLogin: string;
  ref: string;
  paths: string[];
  pullRequest: null | { number: number; head: string };
}
export interface GitHubVerificationAuthority {
  revision: string;
  tokenReference: SecretReference;
  secretProvider: SecretProvider;
  expectation: GitHubExpectation;
}
function fail(code = "GITHUB_INVALID"): never {
  throw new VerificationError(code);
}
const exact = (v: object, keys: string) =>
  Object.keys(v).sort().join() === keys;
const segment = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u.test(s) &&
  !s.includes("..") &&
  !s.endsWith(".lock") &&
  !s.endsWith(".");
export const githubBranch = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 150 && v.split("/").every(segment);
function httpsOrigin(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 250) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.origin === value &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export function validGitHubExpectation(v: GitHubExpectation): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    exact(
      v,
      "assignmentId,canvasOrigin,courseId,paths,pullRequest,readerGitHubId,ref,repository,repositoryId,studentGitHubId,studentGitHubLogin,studentId,teacherId",
    ) &&
    [
      v.courseId,
      v.teacherId,
      v.studentId,
      v.assignmentId,
      v.repositoryId,
      v.studentGitHubId,
      v.readerGitHubId,
    ].every(verificationId) &&
    httpsOrigin(v.canvasOrigin) &&
    v.teacherId !== v.studentId &&
    typeof v.repository === "string" &&
    v.repository.split("/").length === 2 &&
    v.repository.split("/").every(segment) &&
    typeof v.studentGitHubLogin === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(
      v.studentGitHubLogin,
    ) &&
    githubBranch(v.ref) &&
    Array.isArray(v.paths) &&
    v.paths.length > 0 &&
    v.paths.length <= 4 &&
    new Set(v.paths).size === v.paths.length &&
    v.paths.every((p) => githubBranch(p) && p.split("/").length <= 4) &&
    (v.pullRequest === null ||
      (!!v.pullRequest &&
        typeof v.pullRequest === "object" &&
        exact(v.pullRequest, "head,number") &&
        Number.isSafeInteger(v.pullRequest.number) &&
        v.pullRequest.number > 0 &&
        v.pullRequest.number <= 1e9 &&
        githubBranch(v.pullRequest.head) &&
        v.pullRequest.head !== v.ref))
  );
}
type Row = Record<string, unknown>;
const row = (v: unknown): Row => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  return v as Row;
};
const id = (v: unknown) =>
  Number.isSafeInteger(v) && Number(v) > 0 ? String(v) : fail();
const sha = (v: unknown): string =>
  typeof v === "string" && /^[a-f0-9]{40}$/u.test(v) ? v : fail();
const time = (v: unknown): string =>
  typeof v === "string" &&
  v.length <= 40 &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(v) &&
  Number.isFinite(Date.parse(v))
    ? v
    : fail();

/** GET-only fixed api.github.com endpoints. Reads tree metadata, never blobs,
 * Contents, diffs, notebooks, arbitrary URLs, collaborators or org/Team state. */
export async function verifyGitHub(
  get: () => GitHubVerificationAuthority,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const a = get(),
    e = a.expectation;
  if (!validGitHubExpectation(e)) fail("GITHUB_NOT_CONFIGURED");
  const binding = verificationDigest([a.revision, e, a.tokenReference]);
  const check = () => {
    signal.throwIfAborted();
    const current = get();
    if (
      verificationDigest([
        current.revision,
        current.expectation,
        current.tokenReference,
      ]) !== binding
    )
      fail("STATE_DRIFT");
  };
  let count = 0,
    total = 0,
    credential: string | undefined;
  const operation = AbortSignal.any([signal, AbortSignal.timeout(18_000)]);
  function bounded<T>(
    pending: Promise<T>,
    deadline: AbortSignal,
    discard?: (v: T) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      const abort = () => {
        if (!done) {
          done = true;
          reject(
            new VerificationError(
              signal.aborted ? "GITHUB_CANCELLED" : "GITHUB_TIMEOUT",
            ),
          );
        }
      };
      deadline.addEventListener("abort", abort, { once: true });
      if (deadline.aborted) abort();
      pending.then(
        (value) => {
          deadline.removeEventListener("abort", abort);
          if (done) {
            discard?.(value);
            return;
          }
          done = true;
          resolve(value);
        },
        (error: unknown) => {
          deadline.removeEventListener("abort", abort);
          if (!done) {
            done = true;
            reject(
              error instanceof VerificationError
                ? error
                : new VerificationError("GITHUB_UNAVAILABLE"),
            );
          }
        },
      );
    });
  }
  const request = async (endpoint: string): Promise<unknown> => {
    check();
    operation.throwIfAborted();
    if (++count > 32) fail("GITHUB_LIMIT");
    if (total >= 1024 * 1024) fail("GITHUB_OVERSIZED");
    const deadline = AbortSignal.any([operation, AbortSignal.timeout(4000)]);
    const resolved = await bounded(
      Promise.resolve().then(() => {
        deadline.throwIfAborted();
        return a.secretProvider.resolve(a.tokenReference, { signal: deadline });
      }),
      deadline,
      (late) => {
        if (late?.status === "RESOLVED")
          void late.secret.consume(() => undefined).catch(() => {});
      },
    );
    if (resolved?.status !== "RESOLVED") fail("GITHUB_SECRET_UNAVAILABLE");
    try {
      return await bounded(
        resolved.secret.consume(async (token) => {
          deadline.throwIfAborted();
          check();
          if (!/^[\x21-\x7e]{20,512}$/u.test(token))
            fail("GITHUB_SECRET_UNAVAILABLE");
          const digest = verificationDigest(token);
          if (credential && credential !== digest) fail("STATE_DRIFT");
          credential = digest;
          const url = `https://api.github.com${endpoint}`;
          const response = await bounded(
            fetcher(url, {
              method: "GET",
              redirect: "error",
              signal: deadline,
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            }),
            deadline,
            (late) => {
              void late.body?.cancel().catch(() => {});
            },
          );
          const cancel = () => {
            void response.body?.cancel().catch(() => {});
          };
          if (response.redirected || (response.url && response.url !== url)) {
            cancel();
            fail("GITHUB_REDIRECT");
          }
          if (!response.ok) {
            cancel();
            fail(
              response.status === 401 ||
                response.status === 403 ||
                response.status === 404
                ? "GITHUB_DENIED_OR_MISSING"
                : response.status >= 300 && response.status < 400
                  ? "GITHUB_REDIRECT"
                  : "GITHUB_UNAVAILABLE",
            );
          }
          if (!response.headers.get("content-type")?.includes("json")) {
            cancel();
            fail();
          }
          const reader = response.body?.getReader();
          if (!reader) return fail();
          let size = 0;
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const next = await bounded(reader.read(), deadline);
              if (next.done) break;
              size += next.value.length;
              total += next.value.length;
              if (size > 128 * 1024 || total > 1024 * 1024)
                fail("GITHUB_OVERSIZED");
              chunks.push(next.value);
            }
            deadline.throwIfAborted();
            check();
            const value: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            // No token echo, raw exception or provider body escapes this boundary.
            JSON.stringify(value, (_k, v: unknown) => {
              if (typeof v === "string" && v.includes(token)) fail();
              return v;
            });
            return value;
          } finally {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }),
        deadline,
      );
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      return fail("GITHUB_UNAVAILABLE");
    }
  };
  const prefix = `/repos/${e.repository.split("/").map(encodeURIComponent).join("/")}`;
  const repository = async () => {
    const r = row(await request(prefix));
    if (
      id(r.id) !== e.repositoryId ||
      r.full_name !== e.repository ||
      r.private !== true ||
      r.archived !== false ||
      r.disabled !== false ||
      row(r.permissions).pull !== true
    )
      fail("GITHUB_TARGET_DENIED");
  };
  const head = async () => {
    const r = row(
      await request(
        `${prefix}/git/ref/heads/${e.ref.split("/").map(encodeURIComponent).join("/")}`,
      ),
    );
    if (r.ref !== `refs/heads/${e.ref}` || row(r.object).type !== "commit")
      fail();
    return sha(row(r.object).sha);
  };
  if (id(row(await request("/user")).id) !== e.readerGitHubId)
    fail("GITHUB_TARGET_DENIED");
  const assertAccount = async () => {
    const account = row(
      await request(`/users/${encodeURIComponent(e.studentGitHubLogin)}`),
    );
    if (
      id(account.id) !== e.studentGitHubId ||
      account.login !== e.studentGitHubLogin ||
      account.type !== "User"
    )
      fail("GITHUB_TARGET_DENIED");
  };
  await assertAccount();
  await repository();
  const commit = await head();
  const c = row(await request(`${prefix}/git/commits/${commit}`));
  if (sha(c.sha) !== commit) fail();
  const root = sha(row(c.tree).sha);
  const trees = new Map<string, Row[]>();
  const tree = async (hash: string) => {
    if (trees.has(hash)) return trees.get(hash)!;
    const r = row(await request(`${prefix}/git/trees/${hash}`));
    if (r.truncated !== false) fail("GITHUB_PARTIAL");
    if (sha(r.sha) !== hash || !Array.isArray(r.tree) || r.tree.length > 1000)
      fail();
    const entries = r.tree.map(row);
    const names = entries.map((v) => v.path);
    if (
      names.some(
        (n) =>
          typeof n !== "string" || n.includes("/") || n === "." || n === "..",
      ) ||
      new Set(names).size !== names.length
    )
      fail();
    trees.set(hash, entries);
    return entries;
  };
  const recoverable = new Set([
    "GITHUB_INVALID",
    "GITHUB_DENIED_OR_MISSING",
    "GITHUB_UNAVAILABLE",
    "GITHUB_PARTIAL",
    "GITHUB_OVERSIZED",
    "GITHUB_LIMIT",
    "GITHUB_REDIRECT",
  ]);
  const reason = (err: unknown) => {
    if (err instanceof VerificationError && recoverable.has(err.code))
      return err.code;
    throw err;
  };
  const files: GitHubVerification["files"] = [];
  for (const path of e.paths) {
    try {
      let hash = root,
        entry: Row | undefined;
      const parts = path.split("/");
      for (let i = 0; i < parts.length; i++) {
        entry = (await tree(hash)).find((v) => v.path === parts[i]);
        if (!entry) break;
        if (i < parts.length - 1) {
          if (entry.type !== "tree" || entry.mode !== "040000") fail();
          hash = sha(entry.sha);
        }
      }
      if (!entry) {
        files.push({ path, status: "ABSENT" });
        continue;
      }
      if (
        entry.type !== "blob" ||
        !["100644", "100755"].includes(String(entry.mode)) ||
        !Number.isSafeInteger(entry.size) ||
        Number(entry.size) < 0
      )
        fail();
      const blob = sha(entry.sha);
      const commits = await request(
        `${prefix}/commits?sha=${commit}&path=${encodeURIComponent(path)}&per_page=1&page=1`,
      );
      if (!Array.isArray(commits) || commits.length !== 1) fail();
      const latest = row(commits[0]),
        meta = row(latest.commit);
      files.push({
        path,
        status: "PRESENT",
        blob,
        size: Number(entry.size),
        latestCommit: sha(latest.sha),
        authorTime: time(row(meta.author).date),
        committerTime: time(row(meta.committer).date),
      });
    } catch (err) {
      files.push({ path, status: "UNKNOWN", reason: reason(err) });
    }
  }
  const readPR = async (): Promise<GitHubVerification["pullRequest"]> => {
    if (!e.pullRequest) return { required: false, status: "NOT_REQUIRED" };
    const p = e.pullRequest,
      r = row(await request(`${prefix}/pulls/${p.number}`));
    const base = row(r.base),
      h = row(r.head);
    if (
      r.number !== p.number ||
      id(row(base.repo).id) !== e.repositoryId ||
      row(base.repo).full_name !== e.repository ||
      id(row(h.repo).id) !== e.repositoryId ||
      row(h.repo).full_name !== e.repository ||
      base.ref !== e.ref ||
      h.ref !== p.head ||
      id(row(r.user).id) !== e.studentGitHubId ||
      !["open", "closed"].includes(String(r.state)) ||
      typeof r.merged !== "boolean" ||
      (r.merged && r.state !== "closed") ||
      (!r.merged && r.merged_at !== null)
    )
      fail("GITHUB_TARGET_DENIED");
    return {
      required: true,
      number: p.number,
      base: e.ref,
      head: p.head,
      headCommit: sha(h.sha),
      baseCommit: sha(base.sha),
      status: r.merged ? "MERGED" : r.state === "open" ? "OPEN" : "CLOSED",
      openedAt: time(r.created_at),
      mergedAt: r.merged ? time(r.merged_at) : null,
    };
  };
  let pullRequest: GitHubVerification["pullRequest"];
  try {
    pullRequest = await readPR();
    if (verificationDigest(await readPR()) !== verificationDigest(pullRequest))
      fail("STATE_DRIFT");
  } catch (err) {
    pullRequest = {
      required: e.pullRequest !== null,
      ...(e.pullRequest
        ? {
            number: e.pullRequest.number,
            base: e.ref,
            head: e.pullRequest.head,
          }
        : {}),
      status: "UNKNOWN",
      reason: reason(err),
    };
  }
  await assertAccount();
  await repository();
  if ((await head()) !== commit) fail("STATE_DRIFT");
  check();
  operation.throwIfAborted();
  return {
    repository: e.repository,
    repositoryId: e.repositoryId,
    ref: e.ref,
    commit,
    files,
    pullRequest,
    status:
      files.some((f) => f.status === "UNKNOWN") ||
      pullRequest.status === "UNKNOWN"
        ? ("PARTIAL" as const)
        : ("OBSERVED" as const),
  };
}
