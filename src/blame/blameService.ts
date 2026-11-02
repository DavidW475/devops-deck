import * as path from 'node:path';
import * as vscode from 'vscode';
import { AdoClient, AdoError } from '../client';
import { ConnectionManager, gitApi } from '../connection';
import { LocalRepo, adoRemoteOf, adoRepoForFile, workItemIdsFromText } from '../git';
import type { PullRequest, WorkItem } from '../types';
import { mapLimit } from '../util';
import {
  GitError, blameArgs, blameWindow, isFullSha, isPastEndError, isUntrackedError, makeGitRunner, parsePorcelain, shallowArgs,
} from './blameGit';
import { mergeWorkItems, pickPullRequest, prIdFromMessage } from './blameModel';
import type {
  BlameClient, BlameDeps, BlameDocument, BlameLine, BlameLookups, BlameSettings, CommitLine, GitRunner, LineLookup,
  LookupOptions, PrLookup, PrMatch, TraceWorkItem,
} from './blameTypes';

const MAX_LINES = 20000;
const MAX_DIRTY_BYTES = 2 * 1024 * 1024;
const EXPLICIT_TIMEOUT_MS = 15000;
const BLAME_LINE_LIMIT = 5000;
const MESSAGE_LIMIT = 500;
const PR_LIMIT = 1000;
const PR_PENDING_TTL_MS = 15 * 60 * 1000;
const WI_LIMIT = 200;
const WI_TTL_MS = 5 * 60 * 1000;
const BUDGET_PER_MINUTE = 20;
const BUDGET_WINDOW_MS = 60 * 1000;
const HYDRATE_MAX = 5;
const HYDRATE_PARALLEL = 3;
const UNPUBLISHED_LOG_MAX = 1000;
const UNPUBLISHED_LIMIT = 50;

interface BlameFlight {
  promise: Promise<Map<number, BlameLine>>;
  signal: AbortSignal | undefined;
  explicit: boolean;
}

interface RepoInfo {
  id: string;
  projectId?: string;
}

/** A small LRU map; with a TTL, entries also expire. */
class Cache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(private readonly limit: number, private readonly ttlMs: number | undefined, private readonly now: () => number) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      return undefined;
    }
    this.map.delete(key);
    if (entry.expires <= this.now()) {
      return undefined;
    }
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.ttlMs === undefined ? Infinity : this.now() + this.ttlMs });
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done) {
        return;
      }
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

const rethrowAuth = (err: unknown): void => {
  if (err instanceof AdoError && err.isAuthError) {
    throw err;
  }
};

/** A failing source counts as empty, except for auth errors. */
async function orEmpty(load: () => Promise<number[]>): Promise<number[]> {
  try {
    return await load();
  } catch (err) {
    rethrowAuth(err);
    return [];
  }
}

function gitMessage(err: GitError): string {
  if (err.timedOut) {
    return 'git blame timed out.';
  }
  if (err.tooLarge) {
    return 'git blame output is too large.';
  }
  const first = err.message.split('\n', 1)[0].trim();
  // execFile's own text starts with "Command failed: <git> <args>", which must not reach the user
  return first && !first.startsWith('Command failed') ? first : 'git blame failed.';
}

function toError(err: unknown): LineLookup {
  if (err instanceof GitError) {
    if (isUntrackedError(err.message)) {
      return { state: 'untracked' };
    }
    if (isPastEndError(err.message)) {
      return { state: 'noLine' };
    }
    return { state: 'error', message: gitMessage(err), timedOut: err.timedOut, ...(err.tooLarge ? { tooLarge: true } : {}) };
  }
  return { state: 'error', message: 'Blame failed.' };
}

function toSeconds(date: unknown): number {
  const ms = date instanceof Date ? date.getTime() : new Date(date as string | number).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

const firstLine = (text: string): string => text.split('\n', 1)[0].trim();

export class BlameService implements BlameLookups {
  private gen = 0;
  private readonly blame: Cache<BlameLine | null>;
  private readonly messages: Cache<string>;
  private readonly completed: Cache<PrLookup>;
  private readonly pending: Cache<PrLookup>;
  private readonly items: Cache<TraceWorkItem[]>;
  private readonly unpublishedSets: Cache<Set<string>>;
  private readonly shallowRoots = new Map<string, boolean>();
  private readonly repoInfos = new Map<string, Promise<RepoInfo>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Running blame processes by line: callers join one only when its signal and timeout fit them. */
  private readonly blameFlights = new Map<string, BlameFlight>();
  private readonly remotePublished: Cache<boolean>;
  private searchTimes: number[] = [];

  constructor(private readonly deps: BlameDeps) {
    const now = () => this.now();
    this.blame = new Cache(BLAME_LINE_LIMIT, undefined, now);
    this.messages = new Cache(MESSAGE_LIMIT, undefined, now);
    this.completed = new Cache(PR_LIMIT, undefined, now);
    this.pending = new Cache(PR_LIMIT, PR_PENDING_TTL_MS, now);
    this.items = new Cache(WI_LIMIT, WI_TTL_MS, now);
    this.unpublishedSets = new Cache(UNPUBLISHED_LIMIT, undefined, now);
    this.remotePublished = new Cache(BLAME_LINE_LIMIT, undefined, now);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** One running load per key; a reset detaches running loads from the maps. */
  private share<V>(key: string, load: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<V>;
    }
    const promise: Promise<V> = load().finally(() => {
      if (this.inflight.get(key) === promise) {
        this.inflight.delete(key);
      }
    });
    this.inflight.set(key, promise);
    return promise;
  }

  reset(): void {
    this.gen++;
    this.blame.clear();
    this.messages.clear();
    this.completed.clear();
    this.pending.clear();
    this.items.clear();
    this.unpublishedSets.clear();
    this.shallowRoots.clear();
    this.repoInfos.clear();
    this.inflight.clear();
    this.blameFlights.clear();
    this.remotePublished.clear();
    this.searchTimes = [];
  }

  // ---- lines ----

  async lookupLine(doc: BlameDocument, line: number, options?: LookupOptions): Promise<LineLookup> {
    try {
      return await this.doLookupLine(doc, line, options ?? {});
    } catch (err) {
      return toError(err);
    }
  }

  private async doLookupLine(doc: BlameDocument, line: number, options: LookupOptions): Promise<LineLookup> {
    if (doc.uri.scheme !== 'file') {
      return { state: 'notAdo' };
    }
    if (!this.deps.isTrusted()) {
      return { state: 'untrusted' };
    }
    const repo = this.deps.repoForFile(doc.uri);
    if (!repo) {
      return { state: 'notAdo' };
    }
    const run = this.deps.runner();
    if (!run) {
      return { state: 'error', message: 'The git extension is not available.' };
    }
    if (!Number.isInteger(line) || line < 0 || line >= doc.lineCount) {
      return { state: 'noLine' };
    }
    if (!options.explicit && doc.lineCount > MAX_LINES) {
      return { state: 'tooBig' };
    }
    const text = doc.isDirty ? doc.getText() : undefined;
    if (doc.isDirty) {
      const early = this.dirtyProblem(doc, text ?? '');
      if (early) {
        return early;
      }
    }
    const entry = await this.blameLine(repo, run, doc, line, text, options);
    if (!entry) {
      return { state: 'noLine' };
    }
    if (entry.kind === 'uncommitted') {
      return { state: 'uncommitted' };
    }
    return this.classify(repo, run, entry);
  }

  private dirtyProblem(doc: BlameDocument, text: string): LineLookup | undefined {
    const enc = doc.encoding;
    if (enc && enc !== 'utf8' && enc !== 'utf8bom') {
      return { state: 'saveToBlame' };
    }
    return Buffer.byteLength(text) > MAX_DIRTY_BYTES ? { state: 'tooBig' } : undefined;
  }

  private rootOf(repo: LocalRepo): string {
    return repo.repo.rootUri.fsPath;
  }

  private async blameLine(
    repo: LocalRepo, run: GitRunner, doc: BlameDocument, line: number, stdin: string | undefined, options: LookupOptions,
  ): Promise<BlameLine | undefined> {
    const root = this.rootOf(repo);
    const rel = path.relative(root, doc.uri.fsPath).split(path.sep).join('/');
    const settings = this.deps.settings();
    const head = repo.repo.state?.HEAD?.commit ?? '';
    const base = [root, rel, head, doc.version, Number(settings.ignoreWhitespace), Number(settings.detectCopies)].join('|');
    const key = `${base}|${line}`;
    const hit = this.blame.get(key);
    if (hit !== undefined) {
      return hit ?? undefined;
    }
    const parsed = await this.blameFlight(key, options, () => this.runBlame({ run, root, rel, base, line, doc, stdin, settings, options }));
    // The answer comes from the run itself: after a `reset` nothing was cached, but the caller still gets its line.
    return parsed.get(line + 1);
  }

  /**
   * One git process per line, shared between callers. A caller joins a running one only when that run has not been aborted
   * and does not have a shorter timeout; when the owner aborts a run that was joined, the joiner starts its own.
   */
  private async blameFlight(key: string, options: LookupOptions, start: () => Promise<Map<number, BlameLine>>): Promise<Map<number, BlameLine>> {
    for (let attempt = 0; ; attempt++) {
      const flight = this.blameFlights.get(key);
      if (flight && !flight.signal?.aborted && (flight.explicit || !options.explicit)) {
        try {
          return await flight.promise;
        } catch (err) {
          // The run was cancelled by its owner, not by us: try again with our own.
          if (!flight.signal?.aborted || options.signal?.aborted || attempt > 0) {
            throw err;
          }
          continue;
        }
      }
      const promise: Promise<Map<number, BlameLine>> = start().finally(() => {
        if (this.blameFlights.get(key)?.promise === promise) {
          this.blameFlights.delete(key);
        }
      });
      this.blameFlights.set(key, { promise, signal: options.signal, explicit: options.explicit === true });
      return promise;
    }
  }

  private async runBlame(a: {
    run: GitRunner; root: string; rel: string; base: string; line: number; doc: BlameDocument;
    stdin: string | undefined; settings: BlameSettings; options: LookupOptions;
  }): Promise<Map<number, BlameLine>> {
    const gen = this.gen;
    const args = blameArgs({
      path: a.rel, line: a.line, lineCount: a.doc.lineCount, ignoreWhitespace: a.settings.ignoreWhitespace,
      detectCopies: a.settings.detectCopies, dirty: a.stdin !== undefined,
    });
    const out = await a.run(a.root, args, {
      stdin: a.stdin, signal: a.options.signal, timeoutMs: a.options.explicit ? EXPLICIT_TIMEOUT_MS : undefined,
    });
    const parsed = parsePorcelain(out);
    if (gen === this.gen) {
      const { from, to } = blameWindow(a.line, a.doc.lineCount);
      for (let n = from; n <= to; n++) {
        this.blame.set(`${a.base}|${n - 1}`, parsed.get(n) ?? null);
      }
    }
    return parsed;
  }

  /** Turns a committed line into shallow / unpublished / commit. */
  private async classify(repo: LocalRepo, run: GitRunner | undefined, entry: CommitLine): Promise<LineLookup> {
    if (run && entry.boundary && await this.isShallow(repo, run)) {
      return { state: 'shallow', line: entry, repo };
    }
    if (await this.isUnpublished(repo, entry.sha)) {
      return { state: 'unpublished', line: entry, repo };
    }
    return { state: 'commit', line: entry, repo };
  }

  private isShallow(repo: LocalRepo, run: GitRunner): Promise<boolean> {
    const root = this.rootOf(repo);
    const known = this.shallowRoots.get(root);
    if (known !== undefined) {
      return Promise.resolve(known);
    }
    return this.share(`shallow|${root}`, async () => {
      const gen = this.gen;
      let shallow = false;
      try {
        shallow = (await run(root, shallowArgs())).trim() === 'true';
      } catch {
        shallow = false;
      }
      if (gen === this.gen) {
        this.shallowRoots.set(root, shallow);
      }
      return shallow;
    });
  }

  private async isUnpublished(repo: LocalRepo, sha: string): Promise<boolean> {
    const head = repo.repo.state?.HEAD;
    const upstream = head?.upstream;
    if (!upstream) {
      // No upstream to compare with: the commit is unpublished when no remote branch contains it.
      return !(await this.isOnRemote(repo, sha));
    }
    if ((head?.ahead ?? 0) <= 0) {
      return false;
    }
    const key = `${this.rootOf(repo)}|${head.commit ?? ''}|${upstream.remote}/${upstream.name}`;
    const known = this.unpublishedSets.get(key);
    if (known) {
      return known.has(sha);
    }
    const set = await this.share(`unpublished|${key}`, async () => {
      const gen = this.gen;
      const hashes = new Set<string>();
      try {
        const commits: { hash: string }[] = await repo.repo.log({
          range: `${upstream.remote}/${upstream.name}..HEAD`, maxEntries: UNPUBLISHED_LOG_MAX,
        });
        commits.forEach(c => hashes.add(c.hash));
      } catch {
        hashes.clear();
      }
      if (gen === this.gen) {
        this.unpublishedSets.set(key, hashes);
      }
      return hashes;
    });
    return set.has(sha);
  }

  /** True when a remote branch contains the commit, and also when that cannot be found out (no claim without evidence). */
  private async isOnRemote(repo: LocalRepo, sha: string): Promise<boolean> {
    const key = `${this.rootOf(repo)}|${sha}`;
    const known = this.remotePublished.get(key);
    if (known !== undefined) {
      return known;
    }
    const getBranches = repo.repo.getBranches;
    if (typeof getBranches !== 'function') {
      return true;
    }
    const gen = this.gen;
    let published = true;
    try {
      const branches: unknown[] = await getBranches.call(repo.repo, { remote: true, contains: sha, count: 1 });
      published = branches.length > 0;
    } catch {
      return true; // not cached: the next lookup may succeed
    }
    if (gen === this.gen && published) {
      // Only "published" is stable; an unpublished commit may be pushed any time.
      this.remotePublished.set(key, published);
    }
    return published;
  }

  // ---- commits ----

  async lookupCommit(root: unknown, sha: unknown): Promise<LineLookup> {
    try {
      return await this.doLookupCommit(root, sha);
    } catch (err) {
      return toError(err);
    }
  }

  private async doLookupCommit(root: unknown, sha: unknown): Promise<LineLookup> {
    const repo = typeof root === 'string' && isFullSha(sha) ? this.deps.repoForRoot(root) : undefined;
    if (!repo || !isFullSha(sha)) {
      return { state: 'error', message: 'Unknown repository or invalid commit.' };
    }
    if (!this.deps.isTrusted()) {
      return { state: 'untrusted' };
    }
    let commit: any;
    try {
      commit = await repo.repo.getCommit(sha);
    } catch {
      return { state: 'error', message: 'The commit could not be read.' };
    }
    const message = String(commit?.message ?? '');
    this.messages.set(`${this.rootOf(repo)}|${sha}`, message);
    const line: CommitLine = {
      kind: 'commit', sha, author: String(commit?.authorName ?? ''), authorTime: toSeconds(commit?.authorDate),
      summary: firstLine(message), boundary: false,
    };
    return this.classify(repo, undefined, line);
  }

  private async commitMessage(repo: LocalRepo, sha: string): Promise<string | undefined> {
    const key = `${this.rootOf(repo)}|${sha}`;
    const known = this.messages.get(key);
    if (known !== undefined) {
      return known;
    }
    const gen = this.gen;
    try {
      const message = String((await repo.repo.getCommit(sha))?.message ?? '');
      if (gen === this.gen) {
        this.messages.set(key, message);
      }
      return message;
    } catch {
      return undefined;
    }
  }

  // ---- pull requests ----

  private repoInfo(repo: LocalRepo, client: BlameClient): Promise<RepoInfo> {
    const key = `${this.rootOf(repo)}|${repo.project}`;
    const known = this.repoInfos.get(key);
    if (known) {
      return known;
    }
    const promise = client.getRepository(repo.repoName).then(r => ({ id: r.id, projectId: r.project?.id }));
    this.repoInfos.set(key, promise);
    promise.catch(() => {
      if (this.repoInfos.get(key) === promise) {
        this.repoInfos.delete(key);
      }
    });
    return promise;
  }

  /** True and the search is counted when the budget allows it. */
  private takeBudget(background: boolean): boolean {
    const now = this.now();
    this.searchTimes = this.searchTimes.filter(t => now - t < BUDGET_WINDOW_MS);
    if (background && this.searchTimes.length >= BUDGET_PER_MINUTE) {
      return false;
    }
    this.searchTimes.push(now);
    return true;
  }

  async pullRequest(repo: LocalRepo, sha: string, options?: { background?: boolean }): Promise<PrLookup | undefined> {
    if (!isFullSha(sha)) {
      throw new Error('Invalid commit SHA.');
    }
    const key = `${this.rootOf(repo)}|${repo.project}|${sha}`;
    // A trace the user asked for does not trust the 15 minute cache of "no pull request": it may have been created since.
    const cached = this.completed.get(key) ?? (options?.background ? this.pending.get(key) : undefined);
    if (cached) {
      return cached;
    }
    const joined = this.inflight.get(`pr|${key}`);
    if (joined) {
      return joined as Promise<PrLookup>;
    }
    if (!this.takeBudget(options?.background === true)) {
      return undefined;
    }
    return this.share(`pr|${key}`, async () => {
      const gen = this.gen;
      const result = await this.search(repo, sha);
      if (gen === this.gen) {
        if (result.match?.pr.status === 'completed') {
          this.completed.set(key, result);
        } else {
          this.pending.set(key, result);
        }
      }
      return result;
    });
  }

  private async search(repo: LocalRepo, sha: string): Promise<PrLookup> {
    const client = this.deps.clientFor(repo.project);
    const info = await this.repoInfo(repo, client);
    const found = await client.queryPullRequestsByCommit(info.id, sha);
    const hydrated = await this.hydrate(client, info.id, [...(found.byMergeCommit ?? []), ...(found.byCommit ?? [])]);
    const byMergeCommit = (found.byMergeCommit ?? []).map(p => hydrated.get(p.pullRequestId)).filter(isPr);
    const byCommit = (found.byCommit ?? []).map(p => hydrated.get(p.pullRequestId)).filter(isPr);
    const match = pickPullRequest(byMergeCommit, byCommit) ?? await this.matchByMessage(repo, sha, info.id, client);
    return { repoId: info.id, match };
  }

  /** The endpoint's result form is not verified: entries without title or status are loaded again. */
  private async hydrate(client: BlameClient, repoId: string, list: SparsePr[]): Promise<Map<number, SparsePr | undefined>> {
    const result = new Map<number, SparsePr | undefined>();
    const missing: number[] = [];
    for (const p of list) {
      if (hasTitleAndStatus(p)) {
        result.set(p.pullRequestId, p);
      } else if (!missing.includes(p.pullRequestId)) {
        missing.push(p.pullRequestId);
      }
    }
    const loaded = await mapLimit(missing.slice(0, HYDRATE_MAX), HYDRATE_PARALLEL, async id => {
      try {
        return await client.getPullRequest(repoId, id);
      } catch (err) {
        rethrowAuth(err);
        return undefined;
      }
    });
    missing.slice(0, HYDRATE_MAX).forEach((id, i) => result.set(id, loaded[i]));
    return result;
  }

  private async matchByMessage(repo: LocalRepo, sha: string, repoId: string, client: BlameClient): Promise<PrMatch | undefined> {
    const message = await this.commitMessage(repo, sha);
    const id = message === undefined ? undefined : prIdFromMessage(message);
    if (id === undefined) {
      return undefined;
    }
    try {
      const pr = await client.getPullRequestById(id);
      return pr.repository?.id === repoId && pr.status === 'completed' ? { pr, via: 'message', others: [] } : undefined;
    } catch (err) {
      rethrowAuth(err);
      return undefined;
    }
  }

  // ---- work items ----

  workItems(repo: LocalRepo, sha: string, match?: PrMatch): Promise<TraceWorkItem[]> {
    if (!isFullSha(sha)) {
      return Promise.reject(new Error('Invalid commit SHA.'));
    }
    const key = `${this.rootOf(repo)}|${repo.project}|${sha}|${match?.pr.pullRequestId ?? 0}`;
    const cached = this.items.get(key);
    if (cached) {
      return Promise.resolve(cached);
    }
    return this.share(`wi|${key}`, async () => {
      const gen = this.gen;
      const result = await this.loadWorkItems(repo, sha, match);
      if (gen === this.gen) {
        this.items.set(key, result);
      }
      return result;
    });
  }

  private async loadWorkItems(repo: LocalRepo, sha: string, match: PrMatch | undefined): Promise<TraceWorkItem[]> {
    const client = this.deps.clientFor(repo.project);
    let info: RepoInfo | undefined;
    try {
      info = await this.repoInfo(repo, client);
    } catch (err) {
      rethrowAuth(err);
    }
    const prRepoId = match?.pr.repository?.id ?? info?.id;
    const [pr, commit, mention] = await Promise.all([
      match && prRepoId ? orEmpty(() => client.getPullRequestWorkItemIds(prRepoId, match.pr.pullRequestId)) : Promise.resolve([]),
      info?.projectId ? orEmpty(() => client.getCommitWorkItemIds(info.projectId as string, info.id, sha)) : Promise.resolve([]),
      this.mentions(repo, sha),
    ]);
    const ids = [...new Set([...pr, ...commit, ...mention])];
    let loaded: WorkItem[] = [];
    if (ids.length > 0) {
      try {
        loaded = await client.getWorkItems(ids);
      } catch (err) {
        rethrowAuth(err); // like the other sources: a failing one counts as empty
      }
    }
    return mergeWorkItems(loaded, { pr, commit, mention });
  }

  private async mentions(repo: LocalRepo, sha: string): Promise<number[]> {
    const message = await this.commitMessage(repo, sha);
    return message === undefined ? [] : workItemIdsFromText(message);
  }

  commitUrl(repo: Pick<LocalRepo, 'project' | 'repoName'>, sha: string): string {
    if (!isFullSha(sha)) {
      throw new Error('Invalid commit SHA.');
    }
    return this.deps.clientFor(repo.project).commitWebUrl(repo.repoName, sha);
  }
}

/** A pull request as the REST endpoint may really return it: title and status can be missing. */
type SparsePr = Omit<PullRequest, 'title' | 'status'> & Partial<Pick<PullRequest, 'title' | 'status'>>;
const hasTitleAndStatus = (p: SparsePr): p is PullRequest => p.title !== undefined && p.status !== undefined;
const isPr = (p: SparsePr | undefined): p is PullRequest => p?.status !== undefined;

/** The dependencies of the extension: real git extension, real REST client, VS Code settings. */
export function defaultBlameDeps(client: AdoClient, connections: Pick<ConnectionManager, 'current'>): BlameDeps {
  const runners = new Map<string, GitRunner>();
  return {
    clientFor: project => client.forProject(project),
    repoForFile: uri => adoRepoForFile(connections.current, uri),
    repoForRoot: root => {
      const repo = (gitApi()?.repositories as any[] | undefined)?.find(r => r.rootUri?.fsPath === root);
      return repo ? adoRemoteOf(repo, connections.current) : undefined;
    },
    runner: () => {
      const gitPath: unknown = gitApi()?.git?.path;
      if (typeof gitPath !== 'string' || gitPath === '') {
        return undefined;
      }
      let run = runners.get(gitPath);
      if (!run) {
        run = makeGitRunner(gitPath);
        runners.set(gitPath, run);
      }
      return run;
    },
    isTrusted: () => vscode.workspace.isTrusted,
    settings: () => {
      const cfg = vscode.workspace.getConfiguration('azureDevOps');
      return {
        ignoreWhitespace: cfg.get<boolean>('blame.ignoreWhitespace', true),
        detectCopies: cfg.get<boolean>('blame.detectCopies', false),
      };
    },
  };
}
