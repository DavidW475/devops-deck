import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Uri as VsUri } from 'vscode';
import { AdoClient } from '../client';
import { ConnectionManager } from '../connection';
import { CreatePullRequestPanel } from '../pullRequests/createPrPanel';
import { GitRepository, PullRequest, WorkItem } from '../types';
import { cspNonce, FakeWebview, FakeWebviewPanel, lastPanel, panels } from './fakeWebview';
import * as vscode from './vscodeStub';

const EXT = vscode.Uri.file('/ext') as unknown as VsUri;
const ORG = 'https://dev.azure.com/contoso';
const REPOS: GitRepository[] = [
  { id: 'repo-web', name: 'web-shop', defaultBranch: 'refs/heads/main' },
  { id: 'repo-pay', name: 'Payments <API>' },
];

/** A local clone as the built-in git extension reports it. */
function localRepo(branch = 'feature/1234-login') {
  const calls = { fetch: [] as unknown[][], log: [] as unknown[], push: [] as unknown[][] };
  const repo = {
    rootUri: vscode.Uri.file('/src/web-shop'),
    state: { HEAD: { name: branch }, remotes: [{ name: 'origin', fetchUrl: `${ORG}/Fabrikam%20Shop/_git/web-shop` }] },
    fetch: async (...a: unknown[]) => { calls.fetch.push(a); },
    log: async (o: unknown) => { calls.log.push(o); return [{ message: 'Validate e-mail on login\n\nFixes #77' }, { message: 'Add login form' }]; },
    push: async (...a: unknown[]) => { calls.push.push(a); },
  };
  return { repo, calls };
}

function useGit(repos: unknown[]): void {
  const api = { repositories: repos };
  (vscode.extensions as Record<string, unknown>).getExtension = () => ({ isActive: true, exports: { getAPI: () => api } });
}

function workItem(id: number): WorkItem {
  return { id, rev: 1, fields: { 'System.Title': `Login <story> ${id}`, 'System.WorkItemType': 'User Story', 'System.State': 'Active' } };
}

function existingPr(id: number, target: string): PullRequest {
  return {
    pullRequestId: id, title: 'Login page', status: 'active', createdBy: { id: 'lena', displayName: 'Lena Hoffmann' }, creationDate: '2026-10-01T08:00:00Z',
    sourceRefName: 'refs/heads/feature/1234-login', targetRefName: `refs/heads/${target}`, repository: { id: 'repo-web', name: 'web-shop' }, reviewers: [],
  };
}

function fakeClient() {
  const calls: Record<string, unknown[][]> = {};
  const state = { failRepos: false, failAutoComplete: false, failSearch: false, branches: ['main', 'feature/1234-login'] };
  const record = (name: string, args: unknown[]) => { const list = calls[name] ?? []; calls[name] = list; list.push(args); };
  const client: Record<string, unknown> = {
    listRepositories: async () => {
      if (state.failRepos) {
        throw new Error('Repositories are not available.');
      }
      return REPOS;
    },
    listBranches: async (repoId: string) => { record('listBranches', [repoId]); return state.branches; },
    getWorkItems: async (ids: number[]) => { record('getWorkItems', [ids]); return ids.map(workItem); },
    findPullRequestsForBranch: async () => [existingPr(5, 'develop'), existingPr(6, 'main')],
    searchIdentities: async (text: string) => {
      record('searchIdentities', [text]);
      return [{ id: 'u1', displayName: 'Lena Hoffmann', uniqueName: 'lena@contoso.com' }, { id: 'g1', displayName: '[Fabrikam Shop]\\Reviewers', isGroup: true }];
    },
    searchWorkItems: async (text: string) => {
      if (state.failSearch) {
        throw new Error('search failed');
      }
      record('searchWorkItems', [text]);
      return [workItem(42)];
    },
    createPullRequest: async (repoId: string, body: unknown) => {
      record('createPullRequest', [repoId, body]);
      return { pullRequestId: 101, repository: { id: repoId } };
    },
    setAutoComplete: async (...a: unknown[]) => {
      record('setAutoComplete', a);
      if (state.failAutoComplete) {
        throw new Error('policy service down');
      }
    },
  };
  client.forProject = (project?: string) => { record('forProject', [project]); return client; };
  return { client: client as unknown as AdoClient, calls, state };
}

const connections = { current: { orgUrl: ORG, project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false } } as unknown as ConnectionManager;

const REQUEST = {
  repoId: 'repo-web', source: 'feature/1234-login', target: 'main', title: 'Login page', description: '', isDraft: false,
  autoComplete: true, mergeStrategy: '', deleteSourceBranch: true, reviewers: [{ id: 'u1', isRequired: true }], workItems: [1234],
};

describe('CreatePullRequestPanel', () => {
  const originalGetExtension = vscode.extensions.getExtension;
  let panel: FakeWebviewPanel | undefined;

  beforeEach(() => {
    vscode.reset();
    panel = undefined;
  });
  afterEach(() => {
    panel?.dispose();
    vscode.extensions.getExtension = originalGetExtension;
  });

  async function open(client: AdoClient, opts: { repoName?: string; source?: string } = {}, onCreated?: () => void): Promise<FakeWebview> {
    await CreatePullRequestPanel.show(client, connections, EXT, opts, onCreated);
    panel = lastPanel();
    return panel.webview;
  }

  it('renders the form and prefills repository and branches from the local clone', async () => {
    const { repo } = localRepo();
    useGit([repo]);
    const { client, calls } = fakeClient();
    const wv = await open(client);
    assert.deepEqual(calls.forProject, [['Fabrikam Shop']]);
    const n = cspNonce(wv.html);
    assert.ok(n);
    assert.ok(wv.html.includes(`<script nonce="${n}">`));
    assert.ok(wv.html.includes('data-picker="reviewer"'));

    await wv.send({ type: 'ready' });
    assert.deepEqual(wv.last('repos'), { type: 'repos', repos: REPOS.map(r => ({ id: r.id, name: r.name })), selected: 'repo-web' });
    assert.deepEqual(wv.last('branches'), { type: 'branches', repoId: 'repo-web', branches: ['main', 'feature/1234-login'], source: 'feature/1234-login', target: 'main' });

    // Another repository forgets the local clone; without a default branch the target is main.
    await wv.send({ type: 'repo', repoId: 'repo-pay' });
    assert.deepEqual(wv.last('branches'), { type: 'branches', repoId: 'repo-pay', branches: ['main', 'feature/1234-login'], source: '', target: 'main' });
    const before = wv.posted.length;
    await wv.send({ type: 'repo', repoId: 'unknown' });
    assert.equal(wv.posted.length, before);
  });

  it('reveals the open form instead of opening a second one', async () => {
    useGit([]);
    const { client } = fakeClient();
    await open(client, { repoName: 'web-shop' });
    await CreatePullRequestPanel.show(client, connections, EXT);
    assert.equal(panels.length, 1);
    assert.equal(panel?.revealed, 1);
  });

  it('shows a fatal error when repositories cannot be loaded', async () => {
    useGit([]);
    const { client, state } = fakeClient();
    state.failRepos = true;
    const wv = await open(client, { repoName: 'web-shop', source: 'feature/x' });
    await wv.send({ type: 'ready' });
    assert.deepEqual(wv.last('fatal'), { type: 'fatal', message: 'Repositories are not available.' });
  });

  it('suggests title, commits, work items and existing pull requests', async () => {
    const { repo, calls: git } = localRepo();
    useGit([repo]);
    const { client, calls } = fakeClient();
    const wv = await open(client, { repoName: 'WEB-SHOP' });
    await wv.send({ type: 'ready' });

    await wv.send({ type: 'suggest', repoId: 'repo-web', source: 'feature/1234-login', target: 'main' });
    const s = wv.last('suggestion');
    assert.equal(s.pushed, true);
    assert.deepEqual(s.commits, ['Validate e-mail on login', 'Add login form']);
    assert.equal(typeof s.title, 'string');
    assert.deepEqual(calls.getWorkItems.at(-1), [[1234, 77]]);
    assert.deepEqual(s.workItems[0], { id: 1234, title: '#1234 Login <story> 1234', sub: 'User Story · Active' });
    assert.deepEqual(s.existing, [{ id: 6, title: 'Login page', repoId: 'repo-web' }]);
    assert.deepEqual(git.fetch[0], ['origin', 'main']);
    assert.deepEqual(git.log[0], { range: 'origin/main..feature/1234-login', maxEntries: 100 });

    await wv.send({ type: 'suggest', repoId: 'repo-web', source: 'main', target: 'main' });
    assert.deepEqual(wv.last('suggestion'), { type: 'suggestion', seq: 2, commits: [], pushed: true });

    // A branch that is not checked out: no commits, not pushed yet, no work items.
    await wv.send({ type: 'suggest', repoId: 'repo-web', source: 'bugfix/typo', target: 'main' });
    const other = wv.last('suggestion');
    assert.equal(other.pushed, false);
    assert.deepEqual(other.commits, []);
    assert.deepEqual(other.workItems, []);
  });

  it('drops a suggestion that was overtaken by a newer one', async () => {
    useGit([]);
    const { client } = fakeClient();
    const wv = await open(client, { repoName: 'web-shop' });
    await Promise.all([
      wv.send({ type: 'suggest', repoId: 'repo-web', source: 'feature/a', target: 'main' }),
      wv.send({ type: 'suggest', repoId: 'repo-web', source: 'feature/b', target: 'main' }),
    ]);
    assert.deepEqual(wv.ofType('suggestion').map(s => s.seq), [2]);
  });

  it('searches reviewers and work items and adds picked ones', async () => {
    useGit([]);
    const { client, calls, state } = fakeClient();
    const wv = await open(client, { repoName: 'web-shop' });

    await wv.send({ type: 'linkSearch', picker: 'reviewer', text: 'l', seq: 1 });
    assert.deepEqual(wv.last('linkResults'), { type: 'linkResults', picker: 'reviewer', seq: 1, items: [] });
    assert.equal(calls.searchIdentities, undefined);

    await wv.send({ type: 'linkSearch', picker: 'reviewer', text: ' lena ', seq: 2 });
    const people = wv.last('linkResults');
    assert.deepEqual(calls.searchIdentities, [['lena']]);
    assert.deepEqual(people.items.map((i: { sub: string }) => i.sub), ['lena@contoso.com', 'Group']);
    assert.deepEqual(JSON.parse(people.items[1].key), { id: 'g1', title: '[Fabrikam Shop]\\Reviewers', sub: 'Group' });

    await wv.send({ type: 'linkSearch', picker: 'link', text: 'login', seq: 3 });
    const items = wv.last('linkResults');
    assert.equal(items.items[0].title, '#42 Login <story> 42');

    await wv.send({ type: 'link', picker: 'link', key: items.items[0].key });
    assert.deepEqual(wv.last('add'), { type: 'add', picker: 'link', item: { id: '42', title: '#42 Login <story> 42', sub: 'User Story · Active' } });

    state.failSearch = true;
    await wv.send({ type: 'linkSearch', picker: 'link', seq: 4 });
    assert.deepEqual(wv.last('linkResults'), { type: 'linkResults', picker: 'link', seq: 4, error: 'search failed' });
  });

  it('creates the pull request, sets auto-complete and opens it', async () => {
    useGit([]);
    const { client, calls } = fakeClient();
    let created = 0;
    const wv = await open(client, { repoName: 'web-shop' }, () => created++);
    await wv.send({ type: 'create', request: REQUEST, push: false });

    assert.deepEqual(calls.createPullRequest[0], ['repo-web', {
      sourceRefName: 'refs/heads/feature/1234-login', targetRefName: 'refs/heads/main', title: 'Login page', description: undefined,
      isDraft: false, reviewers: [{ id: 'u1', isRequired: true }], workItemRefs: [{ id: '1234' }],
    }]);
    assert.deepEqual(calls.setAutoComplete[0], ['repo-web', 101, { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true }]);
    assert.equal(created, 1);
    assert.equal(panel?.disposed, true);
    assert.deepEqual(vscode.messages, ['Created pull request !101.']);
    assert.deepEqual(vscode.executed, [['azureDevOps.pr.openOverview', 'repo-web', 101]]);
  });

  it('warns when auto-complete fails and skips it for drafts', async () => {
    useGit([]);
    const { client, calls, state } = fakeClient();
    state.failAutoComplete = true;
    let wv = await open(client, { repoName: 'web-shop' });
    await wv.send({ type: 'create', request: { ...REQUEST, mergeStrategy: 'rebase' }, push: false });
    assert.match(vscode.messages[0], /PR !101 was created, but auto-complete could not be set: policy service down/);
    assert.equal((calls.setAutoComplete[0][2] as { mergeStrategy: string }).mergeStrategy, 'rebase');

    wv = await open(client, { repoName: 'web-shop' });
    await wv.send({ type: 'create', request: { ...REQUEST, isDraft: true, description: 'Adds the login page.' }, push: false });
    assert.equal(calls.setAutoComplete.length, 1);
    assert.equal((calls.createPullRequest[1][1] as { description: string }).description, 'Adds the login page.');
  });

  it('pushes the checked-out branch first, and refuses other unpushed branches', async () => {
    const { repo, calls: git } = localRepo();
    useGit([repo]);
    const { client, calls } = fakeClient();
    let wv = await open(client, { repoName: 'web-shop' });
    await wv.send({ type: 'create', request: REQUEST, push: true });
    assert.deepEqual(git.push, [['origin', 'feature/1234-login', true]]);
    assert.equal(calls.createPullRequest.length, 1);

    wv = await open(client, { repoName: 'web-shop' });
    await wv.send({ type: 'create', request: { ...REQUEST, source: 'feature/other' }, push: true });
    assert.deepEqual(wv.last('createError'), { type: 'createError', message: 'The branch feature/other does not exist on the server yet. Push it first.' });
    assert.equal(calls.createPullRequest.length, 1);
    assert.equal(panel?.disposed, false);
  });

  it('opens an existing pull request and closes on cancel', async () => {
    useGit([]);
    const { client } = fakeClient();
    const wv = await open(client, { repoName: 'web-shop' });
    await wv.send({ type: 'openPr', repoId: 'repo-web', prId: '6' });
    await wv.send({ type: 'unknown' });
    assert.deepEqual(vscode.executed, [['azureDevOps.pr.openOverview', 'repo-web', 6]]);
    await wv.send({ type: 'cancel' });
    assert.equal(panel?.disposed, true);
  });
});
