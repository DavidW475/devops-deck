import type { LocalRepo } from '../git';
import type { CommitPrQueryResult, GitRepository, PullRequest, WorkItem } from '../types';

/** One blamed line. Only the null SHA means "not committed", never the author text. */
export type BlameLine = { kind: 'uncommitted' } | CommitLine;

export interface CommitLine {
  kind: 'commit';
  /** full 40-character SHA */
  sha: string;
  author: string;
  /** author time in Unix seconds */
  authorTime: number;
  summary: string;
  /** 1-based line in the commit */
  origLine: number;
  /** the commit is a history boundary (shallow clone or root) */
  boundary: boolean;
}

/** Runs git in `root`. Rejects with `GitError`. A `timeoutMs` of 0 or undefined uses the default of 5 s. */
export type GitRunner = (root: string, args: string[], options?: GitRunOptions) => Promise<string>;

export interface GitRunOptions {
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BlameSettings {
  ignoreWhitespace: boolean;
  detectCopies: boolean;
}

export type PrSource = 'mergeCommit' | 'commit' | 'message';

export interface PrMatch {
  pr: PullRequest;
  via: PrSource;
  /** other non-abandoned pull requests with this commit */
  others: PullRequest[];
}

export type WiSource = 'pr' | 'commit' | 'mention';

export interface TraceWorkItem {
  item: WorkItem;
  sources: WiSource[];
}

/** The result of the local part of a lookup. No REST call has been made for it. */
export type LineLookup =
  | { state: 'notAdo' | 'untrusted' | 'untracked' | 'uncommitted' | 'noLine' | 'tooBig' | 'saveToBlame' }
  | { state: 'shallow' | 'unpublished' | 'commit'; line: CommitLine; repo: LocalRepo }
  | { state: 'error'; message: string; auth: boolean; timedOut?: boolean };

/** The result of the pull request search. `match` is undefined when no pull request was found. */
export interface PrLookup {
  /** GUID of the repository the search ran in */
  repoId: string;
  match?: PrMatch;
}

/** The part of a text document a lookup reads. */
export interface BlameDocument {
  uri: { scheme: string; fsPath: string };
  lineCount: number;
  isDirty: boolean;
  version: number;
  encoding?: string;
  getText(): string;
}

export interface LookupOptions {
  /** the user asked for it: longer timeout, no line limit */
  explicit?: boolean;
  signal?: AbortSignal;
}

/** The REST calls of a lookup, a subset of `AdoClient` so tests can fake them. */
export interface BlameClient {
  getRepository(nameOrId: string): Promise<GitRepository>;
  queryPullRequestsByCommit(repoId: string, sha: string): Promise<CommitPrQueryResult>;
  getPullRequest(repoId: string, prId: number): Promise<PullRequest>;
  getPullRequestById(prId: number): Promise<PullRequest>;
  getPullRequestWorkItemIds(repoId: string, prId: number): Promise<number[]>;
  getCommitWorkItemIds(projectId: string, repoId: string, sha: string): Promise<number[]>;
  getWorkItems(ids: number[]): Promise<WorkItem[]>;
  commitWebUrl(repoName: string, sha: string): string;
}

export interface BlameDeps {
  clientFor(project: string): BlameClient;
  repoForFile(uri: BlameDocument['uri']): LocalRepo | undefined;
  /** only roots of repositories the git extension knows */
  repoForRoot(root: string): LocalRepo | undefined;
  /** undefined while the git extension is not available */
  runner(): GitRunner | undefined;
  isTrusted(): boolean;
  settings(): BlameSettings;
  now?(): number;
}

/** What `BlameUi` needs from `BlameService`, so its tests can fake the service. */
export interface BlameLookups {
  /** Never rejects. */
  lookupLine(doc: BlameDocument, line: number, options?: LookupOptions): Promise<LineLookup>;
  /** Commit from the built-in hover. Rejects nothing: a foreign root or an invalid SHA gives state `error`. Never rejects. */
  lookupCommit(root: unknown, sha: unknown): Promise<LineLookup>;
  /** Rejects on REST errors. With `background`, returns undefined when the budget of 20 searches per minute is used up. */
  pullRequest(repo: LocalRepo, sha: string, options?: { background?: boolean }): Promise<PrLookup | undefined>;
  /** Rejects on auth errors; a failing single source otherwise counts as empty. */
  workItems(repo: LocalRepo, sha: string, match?: PrMatch): Promise<TraceWorkItem[]>;
  commitUrl(repo: Pick<LocalRepo, 'project' | 'repoName'>, sha: string): string;
  /** Drops every cache. */
  reset(): void;
}

/** Everything the hover shows for a commit. */
export interface HoverData {
  line: CommitLine;
  /** Azure Repos project and repository name, for the browser links */
  project: string;
  repoName: string;
  /** undefined while the search has not run */
  pr?: PrLookup;
  workItems?: TraceWorkItem[];
  unpublished?: boolean;
}

/** A row of the trace list. Pure data; `BlameUi` maps it to a `QuickPickItem`. */
export interface TraceRow {
  kind: 'separator' | 'item';
  label: string;
  description?: string;
  detail?: string;
  /** the command a selection runs; rows without one only inform */
  action?: { command: string; args: unknown[] };
}

/** State of the trace list while it fills step by step. */
export interface TraceData {
  line: CommitLine;
  project: string;
  repoName: string;
  /** which step is still running */
  loading?: 'pr' | 'workItems';
  pr?: PrLookup;
  workItems?: TraceWorkItem[];
  unpublished?: boolean;
  shallow?: boolean;
  /** a failed REST step, shown as a row */
  error?: string;
}

/** Which part of the annotation is known yet. */
export interface AnnotationData {
  lookup: LineLookup;
  /** the search is still running */
  loading?: boolean;
  pr?: PrLookup;
}
