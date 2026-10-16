import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { fakeRepo, resetExtras, setGitRepositories } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { AdoClient } from '../client';
import { checkoutPullRequest, makeBlobUri, makePrUri, openBranchDiff, openPrDiff, parsePrUri, PrContentProvider } from '../pullRequests/prFiles';
import { PullRequest } from '../types';

const REMOTE = 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/web-shop';

function pr(): PullRequest {
  return {
    pullRequestId: 42, title: 'Add checkout', status: 'active', createdBy: { id: 'l', displayName: 'Lena Hoffmann' }, creationDate: '2026-01-01T00:00:00Z',
    sourceRefName: 'refs/heads/feature/checkout', targetRefName: 'refs/heads/main', repository: { id: 'r1', name: 'Web-Shop' }, reviewers: [],
  };
}

function gitRepo(root: string, url: string, existing: boolean) {
  const r = fakeRepo(root, url);
  if (existing) {
    r.state.refs.push({ type: 0, name: 'feature/checkout' });
  }
  return Object.assign(r, {
    fetch: async (...a: unknown[]) => { r.calls.push(['fetch', ...a]); },
    checkout: async (...a: unknown[]) => { r.calls.push(['checkout', ...a]); },
    pull: async () => { r.calls.push(['pull']); throw new Error('conflict'); },
    createBranch: async (...a: unknown[]) => { r.calls.push(['createBranch', ...a]); },
    setBranchUpstream: async (...a: unknown[]) => { r.calls.push(['upstream', ...a]); },
  });
}

describe('PR file URIs', () => {
  it('round-trips the query and adds a leading slash', () => {
    const uri = makePrUri('src/app.ts', { repo: 'r1', pr: 7, obj: 'abc', side: 'left', ct: 3, iter: 4, base: 2 });
    assert.equal(uri.scheme, 'ado-pr');
    assert.equal(uri.path, '/src/app.ts');
    assert.deepEqual(parsePrUri(uri), { repo: 'r1', pr: 7, obj: 'abc', side: 'left', ct: 3, iter: 4, base: 2 });
  });

  it('falls back to defaults for missing values', () => {
    const q = parsePrUri(vscode.Uri.parse('ado-pr://x/src/a.ts') as any);
    assert.equal(q.repo, '');
    assert.equal(q.obj, '');
    assert.equal(q.side, 'right');
    assert.equal(q.base, 1);
  });

  it('builds blob URIs for branch comparisons', () => {
    const uri = makeBlobUri('r1', 'docs/readme.md', undefined, 'main');
    assert.equal(uri.scheme, 'ado-git');
    assert.equal(uri.path, '/docs/readme.md');
    const q = new URLSearchParams(uri.query);
    assert.equal(q.get('obj'), '');
    assert.equal(q.get('ref'), 'main');
  });
});

describe('PrContentProvider', () => {
  it('returns empty text without a blob id and caches blobs', async () => {
    const calls: string[] = [];
    const client = { getBlobText: async (repo: string, obj: string) => { calls.push(`${repo}/${obj}`); return 'text'; } } as unknown as AdoClient;
    const p = new PrContentProvider(client);
    assert.equal(await p.provideTextDocumentContent(makePrUri('/a.ts', { repo: 'r1', pr: 1, obj: '', side: 'left', ct: 1, iter: 1, base: 1 })), '');
    const uri = makePrUri('/a.ts', { repo: 'r1', pr: 1, obj: 'b1', side: 'right', ct: 1, iter: 1, base: 1 });
    assert.equal(await p.provideTextDocumentContent(uri), 'text');
    assert.equal(await p.provideTextDocumentContent(uri), 'text');
    assert.deepEqual(calls, ['r1/b1']);
  });

  it('forgets failed loads so they are retried', async () => {
    let n = 0;
    const client = { getBlobText: async () => { n++; throw new Error('offline'); } } as unknown as AdoClient;
    const p = new PrContentProvider(client);
    const uri = makeBlobUri('r1', '/a.ts', 'b2', 'main');
    await assert.rejects(p.provideTextDocumentContent(uri), /offline/);
    await assert.rejects(p.provideTextDocumentContent(uri), /offline/);
    assert.equal(n, 2);
  });
});

describe('openPrDiff and openBranchDiff', () => {
  beforeEach(() => vscode.reset());

  it('opens a diff against the target branch, with an empty right side for deletions', async () => {
    await openPrDiff({ repoId: 'r1', prId: 7, iteration: 3, change: { changeTrackingId: 5, changeType: 'delete', item: { path: '/src/old.ts', objectId: 'o2', originalObjectId: 'o1' } } });
    const [cmd, left, right, title] = vscode.executed[0] as [string, any, any, string];
    assert.equal(cmd, 'vscode.diff');
    assert.equal(parsePrUri(left).obj, 'o1');
    assert.equal(parsePrUri(right).obj, '');
    assert.equal(parsePrUri(right).base, 1);
    assert.equal(title, 'old.ts (PR !7)');
  });

  it('names the compared updates and uses the original path on the left', async () => {
    await openPrDiff({
      repoId: 'r1', prId: 7, iteration: 4, baseIteration: 2,
      change: { changeTrackingId: 5, changeType: 'rename, edit', originalPath: '/src/a.ts', item: { path: '/src/b.ts', objectId: 'n1' } },
    });
    const [, left, right, title] = vscode.executed[0] as [string, any, any, string];
    assert.equal(left.path, '/src/a.ts');
    assert.equal(parsePrUri(left).obj, '');
    assert.equal(parsePrUri(right).obj, 'n1');
    assert.equal(parsePrUri(right).base, 2);
    assert.equal(title, 'b.ts (PR !7, update 2 → 4)');
  });

  it('diffs a file between two branches', async () => {
    await openBranchDiff('r1', { changeType: 'add', item: { path: '/new.ts', objectId: 'n', originalObjectId: 'x' } }, 'main', 'feature/x');
    const [, left, right, title] = vscode.executed[0] as [string, any, any, string];
    assert.equal(new URLSearchParams(left.query).get('obj'), '');
    assert.equal(new URLSearchParams(right.query).get('obj'), 'n');
    assert.equal(title, 'new.ts (main ↔ feature/x)');
    vscode.executed.length = 0;
    await openBranchDiff('r1', { changeType: 'delete', item: { path: '/gone.ts', objectId: 'g', originalObjectId: 'o' } }, 'main', 'dev');
    const [, l2, r2] = vscode.executed[0] as [string, any, any];
    assert.equal(new URLSearchParams(l2.query).get('obj'), 'o');
    assert.equal(new URLSearchParams(r2.query).get('obj'), '');
  });
});

describe('checkoutPullRequest', () => {
  beforeEach(() => { vscode.reset(); resetExtras(); });

  it('fails without the git extension', async () => {
    await assert.rejects(checkoutPullRequest(pr()), /Git extension is not available/);
  });

  it('fails when no repository has a matching remote', async () => {
    setGitRepositories([gitRepo('/src/other', 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/api', false)]);
    await assert.rejects(checkoutPullRequest(pr()), /No open git repository has a remote pointing to "Web-Shop"/);
  });

  it('checks out and pulls an existing local branch', async () => {
    const other = gitRepo('/src/api', 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/api', true);
    other.state.remotes.push({ name: 'upstream', fetchUrl: undefined as unknown as string });
    const repo = gitRepo('/src/web-shop', `${REMOTE}.git`, true);
    setGitRepositories([other, repo]);
    await checkoutPullRequest(pr());
    assert.deepEqual(repo.calls, [['fetch', 'origin', 'feature/checkout'], ['checkout', 'feature/checkout'], ['pull']]);
    assert.deepEqual(other.calls, []);
    assert.deepEqual(vscode.messages, ['Checked out feature/checkout in web-shop.']);
  });

  it('refuses a source branch that git would read as an option', async () => {
    const repo = gitRepo('/src/web-shop', REMOTE, false);
    setGitRepositories([repo]);
    await assert.rejects(checkoutPullRequest({ ...pr(), sourceRefName: 'refs/heads/--upload-pack=evil' }), /is not a valid branch name/);
    assert.deepEqual(repo.calls, []);
  });

  it('creates a tracking branch when it does not exist locally', async () => {
    const repo = gitRepo('/src/web-shop', `${REMOTE}/`, false);
    setGitRepositories([repo]);
    await checkoutPullRequest(pr());
    assert.deepEqual(repo.calls, [
      ['fetch', 'origin', 'feature/checkout'],
      ['createBranch', 'feature/checkout', true, 'origin/feature/checkout'],
      ['upstream', 'feature/checkout', 'origin/feature/checkout'],
    ]);
  });
});
