import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AdoClient, ZERO_OBJECT_ID } from '../client';
import { ConnectionManager } from '../connection';
import { ReposPanel } from '../repos/reposPanel';
import { cspNonce, lastPanel, panels } from './fakeWebview';
import { answers, executed, extensionExports, messages, opened, prompts, reset } from './vscodeStub';

const ORG = 'https://dev.azure.com/contoso';
const PROJECT = 'Fabrikam Shop';
const ext = vscode.Uri.file('/ext');

const REPOS = [
  { id: 'r1', name: 'shop-api', defaultBranch: 'refs/heads/main', remoteUrl: `${ORG}/${PROJECT}/_git/shop-api`, size: 10 },
  { id: 'r2', name: 'shop-web', defaultBranch: 'refs/heads/main', size: 20 },
  { id: 'r3', name: 'empty-repo' },
];

function stats(name: string, ahead: number, date: string, isBaseVersion = false): unknown {
  return {
    name, aheadCount: ahead, behindCount: 1, isBaseVersion,
    commit: { commitId: `${name.length}abcdef0123456789`, comment: `Work on ${name}\nmore text`, author: { name: 'Adele Vance', date } },
  };
}

type Calls = Record<string, unknown[][]>;

function fakeClient(overrides: Record<string, unknown> = {}): { client: AdoClient; calls: Calls } {
  const calls: Calls = {};
  const rec = (name: string, result: (...a: any[]) => unknown) => (...args: unknown[]) => {
    const list = calls[name] ?? []; calls[name] = list; list.push(args);
    return Promise.resolve().then(() => result(...args));
  };
  const client = {
    connection: { orgUrl: ORG, project: PROJECT },
    listRepositories: rec('listRepositories', () => REPOS),
    getBranchStats: rec('getBranchStats', () => [
      stats('feature/old', 0, '2026-01-01'), stats('main', 0, '2026-02-01', true), stats('feature/new', 3, '2026-03-01'),
    ]),
    diffBranches: rec('diffBranches', () => ({
      aheadCount: 3, behindCount: 1,
      changes: [{ changeType: 'edit', item: { path: '/src/cart.ts', objectId: 'new1', originalObjectId: 'old1' } }],
    })),
    updateRef: rec('updateRef', () => undefined),
    webUrl: (kind: string, name: string) => `${ORG}/${PROJECT}/_${kind}/${name}`,
    ...overrides,
  };
  return { client: client as unknown as AdoClient, calls };
}

interface FakeGitRepo {
  state: { remotes: unknown[]; HEAD: { name: string }; refs: { type: number; name: string }[] };
  calls: unknown[][];
}

function installGit(repoName = 'shop-web'): FakeGitRepo {
  const calls: unknown[][] = [];
  const repo = {
    calls,
    state: { remotes: [{ name: 'origin', fetchUrl: `${ORG}/Fabrikam%20Shop/_git/${repoName}` }], HEAD: { name: 'feature/new' }, refs: [{ type: 0, name: 'feature/new' }] },
    fetch: async (...a: unknown[]) => { calls.push(['fetch', ...a]); },
    checkout: async (...a: unknown[]) => { calls.push(['checkout', ...a]); },
    createBranch: async (...a: unknown[]) => { calls.push(['createBranch', ...a]); },
    setBranchUpstream: async (...a: unknown[]) => { calls.push(['upstream', ...a]); },
  };
  extensionExports['vscode.git'] = { getAPI: () => ({ repositories: [repo] }) };
  return repo;
}

const connections = { current: { orgUrl: ORG, project: PROJECT, projects: [PROJECT], detected: false } } as unknown as ConnectionManager;

async function open(overrides: Record<string, unknown> = {}) {
  const f = fakeClient(overrides);
  let changes = 0;
  ReposPanel.show(f.client, connections, ext, () => changes++);
  const panel = lastPanel();
  return { ...f, panel, web: panel.webview, changes: () => changes };
}

afterEach(() => {
  panels.forEach(p => p.dispose());
  reset();
});

describe('ReposPanel', () => {
  it('renders the page with the repos script under the CSP nonce and reuses the panel', async () => {
    const { client, panel, web } = await open();
    const n = cspNonce(web.html);
    assert.ok(n);
    assert.ok(web.html.includes(`<script nonce="${n}" src="vscode-webview://fake/`));
    assert.ok(web.html.includes('repos.js'));
    ReposPanel.show(client, connections, ext, () => undefined);
    assert.equal(panel.revealed, 1);
    assert.equal(panels.length, 1);
  });

  it('selects the repository of the open folder and posts sorted branches', async () => {
    installGit('shop-web');
    const { web, panel, calls } = await open();
    await web.send({ type: 'ready' });
    assert.deepEqual(web.last('repos'), {
      type: 'repos', selected: 'r2',
      repos: [{ id: 'r1', name: 'shop-api', size: 10 }, { id: 'r2', name: 'shop-web', size: 20 }, { id: 'r3', name: 'empty-repo', size: undefined }],
    });
    assert.equal(panel.title, 'Branches: shop-web');
    assert.deepEqual(calls.getBranchStats, [['r2', 'main']]);
    const b = web.last('branches');
    assert.equal(b.current, 'feature/new');
    assert.equal(b.cloned, true);
    assert.deepEqual(b.branches.map((x: any) => x.name), ['main', 'feature/new', 'feature/old']);
    assert.equal(b.branches[1].message, 'Work on feature/new');
    assert.equal(b.branches[1].commit, '11abcdef');
  });

  it('prefers the requested repository and handles repos without a default branch', async () => {
    const { web, calls } = await open();
    await web.send({ type: 'ready', repoId: 'r1' });
    assert.equal(web.last('repos').selected, 'r1');
    assert.equal(web.last('branches').cloned, false);
    await web.send({ type: 'repo', repoId: 'r3' });
    assert.deepEqual(web.last('branches'), { type: 'branches', repoId: 'r3', base: '', branches: [], local: [] });
    await web.send({ type: 'repo', repoId: 'missing' });
    assert.equal(calls.getBranchStats.length, 1);
  });

  it('posts errors from listing repositories and branches', async () => {
    const a = await open({ listRepositories: () => Promise.reject(new Error('TF400813: no access')) });
    await a.web.send({ type: 'ready' });
    assert.deepEqual(a.web.last('error'), { type: 'error', message: 'TF400813: no access' });
    a.panel.dispose();
    const b = await open({ getBranchStats: () => Promise.reject(new Error('timeout')) });
    await b.web.send({ type: 'ready' });
    assert.equal(b.web.last('error').message, 'timeout');
  });

  it('compares a branch and opens the picked diff', async () => {
    const { web, calls } = await open();
    await web.send({ type: 'ready' });
    answers.quickPick.push(undefined);
    await web.send({ type: 'compare', branch: 'feature/new' });
    const q = prompts.quickPick as { items: any[]; options: { title: string } };
    assert.equal(q.options.title, 'feature/new vs main: 1 file (3 ahead, 1 behind)');
    assert.equal(q.items[0].label, 'cart.ts');
    assert.equal(q.items[0].description, '/src');
    assert.equal(executed.length, 0);
    answers.quickPick.push(q.items[0]);
    await web.send({ type: 'compare', branch: 'feature/new' });
    assert.equal(executed[0][0], 'vscode.diff');
    assert.equal(executed[0][3], 'cart.ts (main ↔ feature/new)');
    assert.deepEqual(calls.diffBranches[0], ['r1', 'main', 'feature/new']);
  });

  it('tells when a branch has no changes', async () => {
    const { web } = await open({ diffBranches: async () => ({ changes: [] }) });
    await web.send({ type: 'compare', branch: 'feature/new' }); // no repo yet: ignored
    assert.equal(messages.length, 0);
    await web.send({ type: 'ready' });
    await web.send({ type: 'compare', branch: 'feature/old' });
    assert.deepEqual(messages, ['feature/old has no changes compared with main.']);
  });

  it('creates a branch from the default or a given branch after validating the name', async () => {
    const { web, calls } = await open();
    await web.send({ type: 'create' }); // no repo yet: ignored
    assert.equal('inputBox' in prompts, false);
    await web.send({ type: 'ready' });
    answers.inputBox.push(' feature/gift-cards ');
    await web.send({ type: 'create' });
    const box = prompts.inputBox as { prompt: string; validateInput(v: string): string | undefined };
    assert.equal(box.prompt, 'Created from main');
    assert.equal(box.validateInput(''), 'Enter a name');
    assert.equal(box.validateInput('main'), 'A branch with this name exists');
    assert.equal(box.validateInput('bad name'), 'Not a valid branch name');
    assert.equal(box.validateInput('a..b'), 'Not a valid branch name');
    assert.equal(box.validateInput('feature/ok'), undefined);
    assert.deepEqual(calls.updateRef, [['r1', 'feature/gift-cards', ZERO_OBJECT_ID, '4abcdef0123456789']]);
    assert.equal(calls.getBranchStats.length, 2);
    answers.inputBox.push(undefined);
    await web.send({ type: 'create', from: 'feature/new' });
    assert.equal(calls.updateRef.length, 1);
    answers.inputBox.push('x');
    await web.send({ type: 'create', from: 'gone' });
    assert.ok(messages.some(m => m.includes('Branch gone was not found.')));
  });

  it('deletes a branch only after confirmation', async () => {
    const { web, calls, changes } = await open();
    await web.send({ type: 'ready' });
    await web.send({ type: 'delete', branch: 'unknown' });
    await web.send({ type: 'delete', branch: 'feature/new' });
    assert.equal(calls.updateRef, undefined);
    assert.ok(messages.at(-1)?.includes('It has 3 commits that are not in main.'));
    answers.message.push('Delete');
    await web.send({ type: 'delete', branch: 'feature/old' });
    assert.equal(messages.at(-1), 'Delete the branch "feature/old" on the server?');
    assert.deepEqual(calls.updateRef, [['r1', 'feature/old', '11abcdef0123456789', ZERO_OBJECT_ID]]);
    assert.equal(changes(), 1);
  });

  it('checks out existing and remote-only branches in the local clone', async () => {
    const git = installGit('shop-web');
    const { web } = await open();
    await web.send({ type: 'ready' });
    await web.send({ type: 'checkout', branch: 'not-listed' }); // only branches from the list
    await web.send({ type: 'checkout', branch: 'feature/new' });
    await web.send({ type: 'checkout', branch: 'feature/old' });
    assert.deepEqual(git.calls, [
      ['fetch', 'origin', 'feature/new'], ['checkout', 'feature/new'],
      ['fetch', 'origin', 'feature/old'], ['createBranch', 'feature/old', true, 'origin/feature/old'], ['upstream', 'feature/old', 'origin/feature/old'],
    ]);
  });

  it('refuses to check out without a local clone', async () => {
    const { web } = await open();
    await web.send({ type: 'ready' });
    await web.send({ type: 'checkout', branch: 'main' });
    assert.ok(messages.some(m => m.includes('No open folder is a clone of shop-api.')));
  });

  it('runs commands for PRs, clone, browser and refresh', async () => {
    const { web, calls } = await open();
    await web.send({ type: 'browser' }); // no repo yet: ignored
    await web.send({ type: 'ready' });
    await web.send({ type: 'pr', branch: 'feature/new' });
    await web.send({ type: 'clone' });
    await web.send({ type: 'browser' });
    await web.send({ type: 'browser', branch: 'feature/new' });
    await web.send({ type: 'refresh' });
    await web.send({ type: 'repo', repoId: 'r2' });
    await web.send({ type: 'clone' }); // no remote URL
    await web.send({ type: 'other' });
    assert.deepEqual(executed, [['azureDevOps.pr.create', 'shop-api', 'feature/new'], ['git.clone', `${ORG}/${PROJECT}/_git/shop-api`]]);
    assert.deepEqual(opened, [
      vscode.Uri.parse(`${ORG}/${PROJECT}/_repo/shop-api`).toString(),
      vscode.Uri.parse(`${ORG}/${PROJECT}/_repo/shop-api?version=GBfeature%2Fnew`).toString(),
    ]);
    assert.equal(calls.getBranchStats.length, 3);
  });
});
