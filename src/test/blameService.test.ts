import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { fakeRepo, resetExtras, setGitRepositories } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { BlameService, defaultBlameDeps } from '../blame/blameService';
import { GitError } from '../blame/blameGit';
import type {
  BlameClient, BlameDeps, BlameDocument, BlameSettings, GitRunOptions, LineLookup, PrMatch,
} from '../blame/blameTypes';
import { AdoError } from '../client';
import type { LocalRepo } from '../git';
import type { PullRequest, WorkItem } from '../types';

const REMOTE = 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/web-shop';
const ROOT = '/w/shop';
const FILE = '/w/shop/src/cart.ts';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const ZERO = '0'.repeat(40);

function porcelain(entries: { sha: string; line: number; boundary?: boolean }[]): string {
  const seen = new Set<string>();
  return entries.map(e => {
    const head = `${e.sha} ${e.line} ${e.line}\n`;
    if (seen.has(e.sha)) {
      return `${head}\tcode\n`;
    }
    seen.add(e.sha);
    return `${head}author Lena Hoffmann\nauthor-time 1700000000\nsummary Fix cart total\n${e.boundary ? 'boundary\n' : ''}filename src/cart.ts\n\tcode\n`;
  }).join('');
}

const range = (from: number, to: number, sha = A) => Array.from({ length: to - from + 1 }, (_, i) => ({ sha, line: from + i }));

function pr(id: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    pullRequestId: id, title: `PR ${id}`, status: 'completed', createdBy: { id: 'l', displayName: 'Lena Hoffmann' },
    creationDate: '2026-01-01T00:00:00Z', sourceRefName: 'refs/heads/f', targetRefName: 'refs/heads/main',
    repository: { id: 'repo-1', name: 'web-shop', project: { id: 'proj-1', name: 'Fabrikam Shop' } }, reviewers: [],
    closedDate: '2026-01-02T00:00:00Z', ...over,
  } as PullRequest;
}

const wi = (id: number): WorkItem => ({ id, rev: 1, fields: { 'System.Title': `Item ${id}` } });

interface Env {
  svc: BlameService;
  deps: BlameDeps;
  gitCalls: { args: string[]; options?: GitRunOptions }[];
  rest: string[];
  repo: ReturnType<typeof fakeRepo>;
  local: LocalRepo;
  clock: { t: number };
  state: {
    output: string; shallow: string; gitError?: unknown; trusted: boolean; runner: boolean; foreignRoot: boolean;
    gate?: Promise<void>; settings: BlameSettings;
    byMerge: PullRequest[]; byCommit: PullRequest[]; byId: Map<number, PullRequest | Error>; repoError?: Error;
    prWi: number[] | Error; commitWi: number[] | Error; items: WorkItem[]; queryError?: Error;
  };
}

function setup(): Env {
  const repo = fakeRepo(ROOT, REMOTE);
  const local: LocalRepo = { repo, remoteName: 'origin', repoName: 'web-shop', project: 'Fabrikam Shop' };
  const gitCalls: Env['gitCalls'] = [];
  const rest: string[] = [];
  const clock = { t: 1_000_000 };
  const state: Env['state'] = {
    output: porcelain(range(1, 41)), shallow: 'false', trusted: true, runner: true, foreignRoot: false,
    settings: { ignoreWhitespace: true, detectCopies: false },
    byMerge: [], byCommit: [], byId: new Map(), prWi: [], commitWi: [], items: [],
  };
  const client: BlameClient = {
    async getRepository(name) {
      rest.push(`repo:${name}`);
      if (state.repoError) throw state.repoError;
      return { id: 'repo-1', name, project: { id: 'proj-1', name: 'Fabrikam Shop' } };
    },
    async queryPullRequestsByCommit(repoId, sha) {
      rest.push(`query:${repoId}:${sha.slice(0, 1)}`);
      if (state.queryError) throw state.queryError;
      return { byMergeCommit: state.byMerge, byCommit: state.byCommit };
    },
    async getPullRequest(_repoId, id) {
      rest.push(`pr:${id}`);
      const r = state.byId.get(id);
      if (!r || r instanceof Error) throw r ?? new AdoError('nf', 404);
      return r;
    },
    async getPullRequestById(id) {
      rest.push(`prById:${id}`);
      const r = state.byId.get(id);
      if (!r || r instanceof Error) throw r ?? new AdoError('nf', 404);
      return r;
    },
    async getPullRequestWorkItemIds(repoId, id) {
      rest.push(`prWi:${repoId}:${id}`);
      if (state.prWi instanceof Error) throw state.prWi;
      return state.prWi;
    },
    async getCommitWorkItemIds(projectId, repoId, _sha) {
      rest.push(`commitWi:${projectId}:${repoId}`);
      if (state.commitWi instanceof Error) throw state.commitWi;
      return state.commitWi;
    },
    async getWorkItems(ids) {
      rest.push(`wi:${ids.join(',')}`);
      return state.items.filter(i => ids.includes(i.id));
    },
    commitWebUrl: (name, sha) => `https://dev.azure.com/contoso/x/_git/${name}/commit/${sha}`,
  };
  const deps: BlameDeps = {
    clientFor: () => client,
    repoForFile: uri => (uri.fsPath.startsWith(ROOT) ? local : undefined),
    repoForRoot: root => (root === ROOT && !state.foreignRoot ? local : undefined),
    runner: () => (state.runner ? async (_root, args, options) => {
      gitCalls.push({ args, options });
      if (state.gate) await state.gate;
      if (state.gitError) throw state.gitError;
      return args[0] === 'rev-parse' ? state.shallow : state.output;
    } : undefined),
    isTrusted: () => state.trusted,
    settings: () => state.settings,
    now: () => clock.t,
  };
  return { svc: new BlameService(deps), deps, gitCalls, rest, repo, local, clock, state };
}

function doc(over: Partial<BlameDocument> = {}): BlameDocument {
  return {
    uri: { scheme: 'file', fsPath: FILE }, lineCount: 100, isDirty: false, version: 1, encoding: 'utf8',
    getText: () => 'text', ...over,
  };
}

const blameCalls = (e: Env) => e.gitCalls.filter(c => c.args[0] === 'blame');

describe('BlameService.lookupLine', () => {
  let e: Env;
  beforeEach(() => { e = setup(); });

  it('answers notAdo / untrusted / error before any git call', async () => {
    assert.deepEqual(await e.svc.lookupLine(doc({ uri: { scheme: 'git', fsPath: FILE } }), 1), { state: 'notAdo' });
    e.state.trusted = false;
    assert.deepEqual(await e.svc.lookupLine(doc(), 1), { state: 'untrusted' });
    e.state.trusted = true;
    assert.deepEqual(await e.svc.lookupLine(doc({ uri: { scheme: 'file', fsPath: '/other/a.ts' } }), 1), { state: 'notAdo' });
    e.state.runner = false;
    assert.deepEqual(await e.svc.lookupLine(doc(), 1), { state: 'error', message: 'The git extension is not available.', auth: false });
    assert.equal(e.gitCalls.length, 0);
  });

  it('checks the line, the size and the dirty buffer without calling git', async () => {
    for (const line of [-1, 100, 1.5, Number.NaN]) {
      assert.deepEqual(await e.svc.lookupLine(doc(), line), { state: 'noLine' });
    }
    assert.deepEqual(await e.svc.lookupLine(doc({ lineCount: 20001 }), 1), { state: 'tooBig' });
    assert.deepEqual(await e.svc.lookupLine(doc({ isDirty: true, encoding: 'windows1252' }), 1), { state: 'saveToBlame' });
    assert.deepEqual(await e.svc.lookupLine(doc({ isDirty: true, getText: () => 'x'.repeat(2 * 1024 * 1024 + 1) }), 1), { state: 'tooBig' });
    assert.equal(e.gitCalls.length, 0);
    // clean documents with another encoding and explicit requests are fine
    const r = await e.svc.lookupLine(doc({ lineCount: 20001, encoding: 'windows1252' }), 1, { explicit: true });
    assert.equal(r.state, 'commit');
  });

  it('returns a commit and passes git the right arguments', async () => {
    const r = await e.svc.lookupLine(doc(), 10);
    assert.equal(r.state, 'commit');
    if (r.state !== 'commit') return;
    assert.equal(r.line.sha, A);
    assert.equal(r.line.author, 'Lena Hoffmann');
    assert.equal(r.repo, e.local);
    const [call] = blameCalls(e);
    assert.deepEqual(call.args, ['blame', '--porcelain', '--no-textconv', '-w', '-M', '-L', '1,31', '--', 'src/cart.ts']);
    assert.equal(call.options?.stdin, undefined);
    assert.equal(call.options?.timeoutMs, undefined);
    assert.equal(e.rest.length, 0);
  });

  it('sends stdin only for dirty documents and a long timeout only when explicit', async () => {
    const signal = new AbortController().signal;
    await e.svc.lookupLine(doc({ isDirty: true, getText: () => 'changed' }), 10, { explicit: true, signal });
    const [call] = blameCalls(e);
    assert.equal(call.options?.stdin, 'changed');
    assert.equal(call.options?.timeoutMs, 15000);
    assert.equal(call.options?.signal, signal);
    assert.ok(call.args.includes('--contents'));
  });

  it('maps git failures', async () => {
    e.state.gitError = new GitError('fatal: no such path src/cart.ts in HEAD', 128);
    assert.deepEqual(await e.svc.lookupLine(doc(), 1), { state: 'untracked' });
    e.state.gitError = new GitError('fatal: file src/cart.ts has only 3 lines', 128);
    assert.deepEqual(await e.svc.lookupLine(doc(), 1), { state: 'noLine' });
    e.state.gitError = new GitError('fatal: something odd\nmore', 1);
    assert.deepEqual(await e.svc.lookupLine(doc(), 1), { state: 'error', message: 'fatal: something odd', auth: false, timedOut: false });
    e.state.gitError = new GitError('Command failed: git blame --porcelain secret', 1, true);
    assert.deepEqual(await e.svc.lookupLine(doc(), 1), { state: 'error', message: 'git blame timed out.', auth: false, timedOut: true });
    e.state.gitError = new GitError('Command failed: git blame -- x', 1);
    const r = await e.svc.lookupLine(doc(), 1);
    assert.equal(r.state === 'error' && r.message, 'git blame failed.');
    e.state.gitError = new TypeError('boom');
    assert.deepEqual(await e.svc.lookupLine(doc(), 1), { state: 'error', message: 'Blame failed.', auth: false });
  });

  it('does not cache failures', async () => {
    e.state.gitError = new GitError('fatal: x', 1);
    await e.svc.lookupLine(doc(), 1);
    e.state.gitError = undefined;
    assert.equal((await e.svc.lookupLine(doc(), 1)).state, 'commit');
    assert.equal(blameCalls(e).length, 2);
  });

  it('caches the whole window and keys on version, HEAD and settings', async () => {
    await e.svc.lookupLine(doc(), 10);
    await e.svc.lookupLine(doc(), 25);
    await e.svc.lookupLine(doc(), 10);
    assert.equal(blameCalls(e).length, 1);
    await e.svc.lookupLine(doc({ version: 2 }), 10);
    assert.equal(blameCalls(e).length, 2);
    (e.repo.state as any).HEAD = { commit: B };
    await e.svc.lookupLine(doc(), 10);
    assert.equal(blameCalls(e).length, 3);
    e.state.settings = { ignoreWhitespace: false, detectCopies: true };
    await e.svc.lookupLine(doc(), 10);
    assert.equal(blameCalls(e).length, 4);
  });

  it('evicts the least recently used lines beyond 5000', async () => {
    const big = doc({ lineCount: 100000 });
    e.state.output = '';
    for (let i = 0; i < 130; i++) {
      await e.svc.lookupLine(big, i * 100, { explicit: true });
    }
    const before = blameCalls(e).length;
    await e.svc.lookupLine(big, 129 * 100, { explicit: true });
    assert.equal(blameCalls(e).length, before);
    await e.svc.lookupLine(big, 0, { explicit: true });
    assert.equal(blameCalls(e).length, before + 1);
  });

  it('shares parallel identical requests', async () => {
    let open!: () => void;
    e.state.gate = new Promise<void>(r => { open = r; });
    const both = Promise.all([e.svc.lookupLine(doc(), 10), e.svc.lookupLine(doc(), 10)]);
    await new Promise(r => setImmediate(r));
    open();
    const [x, y] = await both;
    assert.equal(x.state, 'commit');
    assert.equal(y.state, 'commit');
    assert.equal(blameCalls(e).length, 1);
  });

  it('reports lines without an entry and uncommitted lines', async () => {
    e.state.output = porcelain([{ sha: ZERO, line: 5 }, { sha: A, line: 6 }]);
    assert.deepEqual(await e.svc.lookupLine(doc({ lineCount: 7 }), 4), { state: 'uncommitted' });
    assert.deepEqual(await e.svc.lookupLine(doc({ lineCount: 7 }), 6), { state: 'noLine' });
    assert.equal(blameCalls(e).length, 1);
    assert.equal(e.rest.length, 0);
  });

  it('treats a boundary as shallow only in a shallow clone, asked once per root', async () => {
    e.state.output = porcelain(range(1, 41).map(x => ({ ...x, boundary: true })));
    e.state.shallow = 'true\n';
    const r = await e.svc.lookupLine(doc(), 10);
    assert.equal(r.state, 'shallow');
    await e.svc.lookupLine(doc({ version: 2 }), 10);
    assert.equal(e.gitCalls.filter(c => c.args[0] === 'rev-parse').length, 1);
    e.svc.reset();
    e.state.shallow = 'false';
    assert.equal((await e.svc.lookupLine(doc(), 10)).state, 'commit');
  });

  it('counts a failing shallow check as not shallow', async () => {
    e.state.output = porcelain(range(1, 41).map(x => ({ ...x, boundary: true })));
    const orig = e.deps.runner;
    const d: BlameDeps = {
      ...e.deps,
      runner: () => async (root, args, o) => {
        if (args[0] === 'rev-parse') throw new GitError('x');
        return orig()?.(root, args, o) ?? '';
      },
    };
    assert.equal((await new BlameService(d).lookupLine(doc(), 10)).state, 'commit');
  });

  it('marks unpublished commits via the upstream log', async () => {
    (e.repo.state as any).HEAD = { commit: C, ahead: 2, upstream: { remote: 'origin', name: 'main' } };
    e.repo.logEntries = [{ hash: A, message: 'm' }];
    assert.equal((await e.svc.lookupLine(doc(), 10)).state, 'unpublished');
    e.state.output = porcelain(range(1, 41, B));
    assert.equal((await e.svc.lookupLine(doc({ version: 2 }), 10)).state, 'commit');
    const logs = e.repo.calls.filter(c => c[0] === 'log');
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0][1], { range: 'origin/main..HEAD', maxEntries: 1000 });
    assert.equal(e.rest.length, 0);
  });

  it('continues as commit without upstream or when the log fails', async () => {
    (e.repo.state as any).HEAD = { commit: C, ahead: 2 };
    assert.equal((await e.svc.lookupLine(doc(), 10)).state, 'commit');
    (e.repo.state as any).HEAD = { commit: C, ahead: 0, upstream: { remote: 'origin', name: 'main' } };
    assert.equal((await e.svc.lookupLine(doc({ version: 2 }), 10)).state, 'commit');
    (e.repo.state as any).HEAD = { commit: B, ahead: 1, upstream: { remote: 'origin', name: 'main' } };
    e.repo.log = async () => { throw new Error('no'); };
    assert.equal((await e.svc.lookupLine(doc({ version: 3 }), 10)).state, 'commit');
  });
});

describe('BlameService.lookupCommit', () => {
  let e: Env;
  beforeEach(() => {
    e = setup();
    e.repo.commits.set(A, { hash: A, message: 'Fix cart total\n\nFixes #12', authorName: 'Marco Rossi', authorDate: new Date(1700000000000) });
  });

  it('rejects nothing and does not call git for invalid input', async () => {
    const bad = (r: LineLookup) => assert.equal(r.state, 'error');
    bad(await e.svc.lookupCommit(42, A));
    bad(await e.svc.lookupCommit(ROOT, 'abc'));
    bad(await e.svc.lookupCommit(ROOT, undefined));
    e.state.foreignRoot = true;
    bad(await e.svc.lookupCommit(ROOT, A));
    assert.equal(e.repo.calls.length, 0);
    assert.equal(e.gitCalls.length, 0);
  });

  it('is untrusted when the workspace is not trusted', async () => {
    e.state.trusted = false;
    assert.deepEqual(await e.svc.lookupCommit(ROOT, A), { state: 'untrusted' });
  });

  it('builds the commit line', async () => {
    const r = await e.svc.lookupCommit(ROOT, A);
    assert.equal(r.state, 'commit');
    if (r.state !== 'commit') return;
    assert.deepEqual(r.line, { kind: 'commit', sha: A, author: 'Marco Rossi', authorTime: 1700000000, summary: 'Fix cart total', origLine: 0, boundary: false });
  });

  it('defaults a missing date to 0 and reports a missing commit', async () => {
    e.repo.commits.set(B, { hash: B, message: 'x' });
    const r = await e.svc.lookupCommit(ROOT, B);
    assert.equal(r.state === 'commit' && r.line.authorTime, 0);
    assert.equal((await e.svc.lookupCommit(ROOT, C)).state, 'error');
  });

  it('applies the unpublished check', async () => {
    (e.repo.state as any).HEAD = { commit: C, ahead: 1, upstream: { remote: 'origin', name: 'main' } };
    e.repo.logEntries = [{ hash: A, message: 'm' }];
    assert.equal((await e.svc.lookupCommit(ROOT, A)).state, 'unpublished');
  });

  it('works without a git runner', async () => {
    e.state.runner = false;
    assert.equal((await e.svc.lookupCommit(ROOT, A)).state, 'commit');
  });
});

describe('BlameService.pullRequest', () => {
  let e: Env;
  beforeEach(() => {
    e = setup();
    e.repo.commits.set(A, { hash: A, message: 'Merged PR 7: Fix cart' });
  });

  it('rejects an invalid SHA', async () => {
    await assert.rejects(e.svc.pullRequest(e.local, 'nope'));
    assert.throws(() => e.svc.commitUrl(e.local, 'nope'));
  });

  it('finds the pull request and loads the repository once', async () => {
    e.state.byMerge = [pr(7)];
    const r = await e.svc.pullRequest(e.local, A);
    assert.equal(r?.repoId, 'repo-1');
    assert.equal(r?.match?.pr.pullRequestId, 7);
    assert.equal(r?.match?.via, 'mergeCommit');
    await e.svc.pullRequest(e.local, B);
    assert.deepEqual(e.rest.filter(x => x.startsWith('repo:')), ['repo:web-shop']);
  });

  it('hydrates entries without title or status, at most 5', async () => {
    const stub = (id: number) => ({ pullRequestId: id }) as PullRequest;
    e.state.byMerge = [stub(1), stub(2), stub(1)];
    e.state.byCommit = [stub(3), stub(4), stub(5), stub(6), stub(7)];
    for (let i = 1; i <= 7; i++) e.state.byId.set(i, pr(i, { closedDate: `2026-01-0${i}T00:00:00Z` }));
    const r = await e.svc.pullRequest(e.local, A);
    assert.equal(e.rest.filter(x => x.startsWith('pr:')).length, 5);
    assert.equal(r?.match?.pr.pullRequestId, 1);
    assert.ok(!r?.match?.others.some(o => o.pullRequestId > 5));
  });

  it('drops entries that cannot be hydrated; auth errors propagate', async () => {
    e.state.byMerge = [{ pullRequestId: 9 } as PullRequest];
    e.state.byId.set(9, new AdoError('gone', 404));
    e.state.byId.set(7, pr(7));
    const r = await e.svc.pullRequest(e.local, A);
    assert.equal(r?.match?.via, 'message');
    e.state.byId.set(9, new AdoError('denied', 401, true));
    await assert.rejects(e.svc.pullRequest(e.local, B), /denied/);
  });

  it('falls back to the merge message and checks repository and status', async () => {
    e.state.byId.set(7, pr(7));
    const ok = await e.svc.pullRequest(e.local, A);
    assert.deepEqual(ok?.match && { via: ok.match.via, others: ok.match.others }, { via: 'message', others: [] });
    e.repo.commits.set(B, { hash: B, message: 'Merged PR 8: Other' });
    e.state.byId.set(8, pr(8, { repository: { id: 'repo-2', name: 'other' } as PullRequest['repository'] }));
    assert.equal((await e.svc.pullRequest(e.local, B))?.match, undefined);
    e.repo.commits.set(C, { hash: C, message: 'Merged PR 9: Active' });
    e.state.byId.set(9, pr(9, { status: 'active' }));
    assert.equal((await e.svc.pullRequest(e.local, C))?.match, undefined);
  });

  it('treats a 404 of the message PR as no match and does not look without a message', async () => {
    const D = 'd'.repeat(40);
    e.repo.commits.set(D, { hash: D, message: 'Merged PR 99: Gone' });
    assert.equal((await e.svc.pullRequest(e.local, D))?.match, undefined);
    assert.equal((await e.svc.pullRequest(e.local, 'e'.repeat(40)))?.match, undefined);
    assert.ok(!e.rest.includes('prById:undefined'));
  });

  it('propagates auth errors of the message confirmation and of the query', async () => {
    e.state.byId.set(7, new AdoError('denied', 403, true));
    await assert.rejects(e.svc.pullRequest(e.local, A), /denied/);
    e.state.queryError = new AdoError('server', 500);
    await assert.rejects(e.svc.pullRequest(e.local, B), /server/);
    e.state.queryError = undefined;
    e.state.byMerge = [pr(3)];
    assert.equal((await e.svc.pullRequest(e.local, B))?.match?.pr.pullRequestId, 3);
  });

  it('removes a rejected repository lookup', async () => {
    e.state.repoError = new AdoError('x', 500);
    await assert.rejects(e.svc.pullRequest(e.local, A));
    e.state.repoError = undefined;
    e.state.byMerge = [pr(3)];
    assert.ok(await e.svc.pullRequest(e.local, A));
  });

  it('caches completed matches without expiry and others for 15 minutes', async () => {
    e.state.byMerge = [pr(3)];
    await e.svc.pullRequest(e.local, A);
    e.clock.t += 24 * 3600 * 1000;
    await e.svc.pullRequest(e.local, A);
    assert.equal(e.rest.filter(x => x.startsWith('query:')).length, 1);

    e.state.byMerge = [pr(4, { status: 'active' })];
    await e.svc.pullRequest(e.local, B);
    await e.svc.pullRequest(e.local, B);
    assert.equal(e.rest.filter(x => x.startsWith('query:')).length, 2);
    e.clock.t += 15 * 60 * 1000 + 1;
    await e.svc.pullRequest(e.local, B);
    assert.equal(e.rest.filter(x => x.startsWith('query:')).length, 3);
  });

  it('shares parallel identical searches', async () => {
    e.state.byMerge = [pr(3)];
    const [x, y] = await Promise.all([e.svc.pullRequest(e.local, A), e.svc.pullRequest(e.local, A)]);
    assert.equal(x, y);
    assert.equal(e.rest.filter(r => r.startsWith('query:')).length, 1);
  });

  it('budgets background searches to 20 per sliding minute', async () => {
    e.state.byMerge = [];
    const sha = (i: number) => 'a'.repeat(38) + String(i).padStart(2, '0');
    for (let i = 0; i < 20; i++) {
      assert.ok(await e.svc.pullRequest(e.local, sha(i), { background: true }));
    }
    const queries = () => e.rest.filter(r => r.startsWith('query:')).length;
    assert.equal(queries(), 20);
    assert.equal(await e.svc.pullRequest(e.local, sha(20), { background: true }), undefined);
    assert.equal(queries(), 20);
    // cache hits do not count, and are served while the budget is used up
    assert.ok(await e.svc.pullRequest(e.local, sha(0), { background: true }));
    // not background always runs
    assert.ok(await e.svc.pullRequest(e.local, sha(21)));
    assert.equal(queries(), 21);
    e.clock.t += 60_001;
    assert.ok(await e.svc.pullRequest(e.local, sha(20), { background: true }));
  });

  it('does not count joined searches', async () => {
    e.state.byMerge = [];
    const sha = (i: number) => 'a'.repeat(38) + String(i).padStart(2, '0');
    const first = Array.from({ length: 20 }, (_, i) => e.svc.pullRequest(e.local, sha(i), { background: true }));
    const joined = e.svc.pullRequest(e.local, sha(0), { background: true });
    const over = await e.svc.pullRequest(e.local, sha(30), { background: true });
    assert.equal(over, undefined);
    assert.ok(await joined);
    await Promise.all(first);
  });

  it('builds commit URLs', () => {
    assert.match(e.svc.commitUrl(e.local, A), /web-shop\/commit\/a+$/);
  });
});

describe('BlameService.workItems', () => {
  let e: Env;
  let match: PrMatch;
  beforeEach(() => {
    e = setup();
    e.repo.commits.set(A, { hash: A, message: 'Fix cart (#30)\n\nSee #31' });
    match = { pr: pr(7), via: 'mergeCommit', others: [] };
    e.state.items = [wi(10), wi(20), wi(30), wi(31)];
  });

  it('merges the three sources with one getWorkItems call', async () => {
    e.state.prWi = [10, 20];
    e.state.commitWi = [20];
    const r = await e.svc.workItems(e.local, A, match);
    assert.deepEqual(r.map(x => [x.item.id, x.sources]), [[10, ['pr']], [20, ['pr', 'commit']], [30, ['mention']], [31, ['mention']]]);
    assert.equal(e.rest.filter(x => x.startsWith('wi:')).length, 1);
    assert.deepEqual(e.rest.filter(x => x.startsWith('prWi')), ['prWi:repo-1:7']);
    assert.deepEqual(e.rest.filter(x => x.startsWith('commitWi')), ['commitWi:proj-1:repo-1']);
  });

  it('skips the PR source without a match and getWorkItems without ids', async () => {
    e.repo.commits.set(B, { hash: B, message: 'plain' });
    const r = await e.svc.workItems(e.local, B);
    assert.deepEqual(r, []);
    assert.ok(!e.rest.some(x => x.startsWith('prWi') || x.startsWith('wi:')));
  });

  it('counts a failing source as empty but rejects on auth errors', async () => {
    e.state.prWi = new AdoError('boom', 500);
    e.state.commitWi = [20];
    const r = await e.svc.workItems(e.local, A, match);
    assert.deepEqual(r.map(x => x.item.id), [20, 30, 31]);
    e.state.commitWi = new AdoError('denied', 401, true);
    await assert.rejects(e.svc.workItems(e.local, B, match), /denied/);
    e.state.commitWi = [];
    e.state.prWi = [10];
    assert.equal((await e.svc.workItems(e.local, B, match)).length, 1);
  });

  it('works when the repository lookup fails and the message is unavailable', async () => {
    e.state.repoError = new AdoError('x', 500);
    e.state.prWi = [10];
    const r = await e.svc.workItems(e.local, C, match);
    assert.deepEqual(r.map(x => x.item.id), [10]);
    e.state.repoError = new AdoError('denied', 401, true);
    await assert.rejects(e.svc.workItems(e.local, B, match), /denied/);
  });

  it('caches for 5 minutes and keys on the pull request', async () => {
    await e.svc.workItems(e.local, A, match);
    await e.svc.workItems(e.local, A, match);
    assert.equal(e.rest.filter(x => x.startsWith('wi:')).length, 1);
    await e.svc.workItems(e.local, A);
    assert.equal(e.rest.filter(x => x.startsWith('wi:')).length, 2);
    e.clock.t += 5 * 60 * 1000 + 1;
    await e.svc.workItems(e.local, A, match);
    assert.equal(e.rest.filter(x => x.startsWith('wi:')).length, 3);
  });

  it('shares parallel calls and does not cache rejections', async () => {
    const [x, y] = await Promise.all([e.svc.workItems(e.local, A, match), e.svc.workItems(e.local, A, match)]);
    assert.equal(x, y);
    e.state.items = [];
    const orig = e.deps.clientFor('p').getWorkItems;
    const failing: BlameDeps = { ...e.deps, clientFor: () => ({ ...e.deps.clientFor('p'), getWorkItems: async () => { throw new AdoError('x', 500); } }) };
    const s2 = new BlameService(failing);
    await assert.rejects(s2.workItems(e.local, A, match));
    await assert.rejects(s2.workItems(e.local, A, match));
    assert.ok(orig);
    await assert.rejects(e.svc.workItems(e.local, 'bad', match));
  });
});

describe('BlameService.reset', () => {
  it('clears caches and the budget, and ignores results that arrive afterwards', async () => {
    const e = setup();
    e.state.byMerge = [pr(3)];
    await e.svc.lookupLine(doc(), 10);
    await e.svc.pullRequest(e.local, A);
    e.svc.reset();
    await e.svc.lookupLine(doc(), 10);
    await e.svc.pullRequest(e.local, A);
    assert.equal(blameCalls(e).length, 2);
    assert.equal(e.rest.filter(x => x.startsWith('query:')).length, 2);
    for (let i = 0; i < 20; i++) await e.svc.pullRequest(e.local, '3'.repeat(38) + String(i).padStart(2, '0'), { background: true });
    e.svc.reset();
    assert.ok(await e.svc.pullRequest(e.local, 'f'.repeat(40), { background: true }));

    let open!: () => void;
    e.state.gate = new Promise<void>(r => { open = r; });
    const late = e.svc.lookupLine(doc({ version: 9 }), 10);
    await new Promise(r => setImmediate(r));
    e.svc.reset();
    open();
    await late;
    e.state.gate = undefined;
    const n = blameCalls(e).length;
    await e.svc.lookupLine(doc({ version: 9 }), 10);
    assert.equal(blameCalls(e).length, n + 1);
  });
});

describe('defaultBlameDeps', () => {
  beforeEach(() => resetExtras());

  const conn = { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop'] } as any;

  it('maps repositories, runner, trust and settings', async () => {
    const repo = fakeRepo(ROOT, REMOTE);
    setGitRepositories([repo]);
    const seen: (string | undefined)[] = [];
    const client = { forProject: (p?: string) => { seen.push(p); return { tag: p }; } } as any;
    const deps = defaultBlameDeps(client, { current: conn });
    assert.deepEqual(deps.clientFor('X'), { tag: 'X' });
    assert.deepEqual(seen, ['X']);
    assert.equal(deps.repoForFile({ scheme: 'file', fsPath: FILE })?.repoName, 'web-shop');
    assert.equal(deps.repoForRoot(ROOT)?.project, 'Fabrikam Shop');
    assert.equal(deps.repoForRoot('/nope'), undefined);
    const run = deps.runner();
    assert.equal(typeof run, 'function');
    assert.equal(deps.runner(), run);
    (vscode.workspace as any).isTrusted = false;
    assert.equal(deps.isTrusted(), false);
    (vscode.workspace as any).isTrusted = true;
    assert.deepEqual(deps.settings(), { ignoreWhitespace: true, detectCopies: false });
    await vscode.workspace.getConfiguration('azureDevOps').update('blame.detectCopies', true);
    await vscode.workspace.getConfiguration('azureDevOps').update('blame.ignoreWhitespace', false);
    assert.deepEqual(deps.settings(), { ignoreWhitespace: false, detectCopies: true });
    await vscode.workspace.getConfiguration('azureDevOps').update('blame.detectCopies', undefined);
    await vscode.workspace.getConfiguration('azureDevOps').update('blame.ignoreWhitespace', undefined);
  });

  it('has no runner or repositories without the git extension, and no repo without a connection', () => {
    setGitRepositories(undefined);
    const deps = defaultBlameDeps({ forProject: () => ({}) } as any, { current: conn });
    assert.equal(deps.runner(), undefined);
    assert.equal(deps.repoForRoot(ROOT), undefined);
    assert.equal(deps.repoForFile({ scheme: 'file', fsPath: FILE }), undefined);
    setGitRepositories([fakeRepo(ROOT, REMOTE)]);
    assert.equal(defaultBlameDeps({} as any, { current: undefined }).repoForRoot(ROOT), undefined);
  });
});
