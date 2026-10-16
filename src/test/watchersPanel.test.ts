import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Uri as VsUri } from 'vscode';
import { AdoClient } from '../client';
import { Build, IdentityRef, PullRequest, WorkItem } from '../types';
import { WatchersPanel } from '../watchers/watchersPanel';
import { cspNonce, FakeWebviewPanel, lastPanel } from './fakeWebview';
import * as vscode from './vscodeStub';

const ME: IdentityRef = { id: 'me', displayName: 'Alex Morgan', uniqueName: 'alex@contoso.com' };
const LENA: IdentityRef = { id: 'lena', displayName: 'Lena Hoffmann', uniqueName: 'lena@contoso.com' };
const EXT = vscode.Uri.file('/ext') as unknown as VsUri;

function build(id: number, opts: Partial<Build> = {}): Build {
  return {
    id, buildNumber: `2026.${id}`, status: 'completed', result: 'failed', definition: { id: 1, name: 'Fabrikam CI' },
    sourceBranch: 'refs/heads/main', requestedFor: LENA, startTime: '2026-10-01T08:00:00Z', ...opts,
  };
}

function pr(id: number): PullRequest {
  return {
    pullRequestId: id, title: `Improve checkout ${id}`, status: 'active', createdBy: LENA, creationDate: '2026-10-01T08:00:00Z',
    sourceRefName: `refs/heads/feature/${id}`, targetRefName: 'refs/heads/main', repository: { id: 'repo-1', name: 'web-shop' },
    reviewers: [], lastMergeSourceCommit: { commitId: 'c1' },
  };
}

function wi(id: number): WorkItem {
  return { id, rev: 1, fields: { 'System.Title': `Bug ${id}`, 'System.WorkItemType': 'Bug', 'System.State': 'Active' } };
}

function fakeClient() {
  const calls = { wiql: [] as string[] };
  const state = { ids: [7, 8], builds: [build(1), build(2, { status: 'inProgress', result: undefined, requestedFor: undefined })], prs: [pr(11)], fail: false };
  const client = {
    listRepositoryNames: async () => ['web-shop', 'payments'],
    listDefinitions: async () => [{ id: 1, name: 'Fabrikam CI', path: '\\' }],
    queryWiql: async (wiql: string) => {
      if (state.fail) {
        throw new Error('TF51005: bad <query>');
      }
      calls.wiql.push(wiql);
      return state.ids;
    },
    getWorkItems: async (ids: number[]) => ids.map(wi),
    getMe: async () => ME,
    listBuilds: async () => state.builds,
    listActivePullRequests: async () => state.prs,
  };
  return { client: client as unknown as AdoClient, calls, state };
}

function open(client: AdoClient, select?: number | 'new'): FakeWebviewPanel {
  WatchersPanel.show(client, EXT, select);
  return lastPanel();
}

describe('WatchersPanel', () => {
  let panel: FakeWebviewPanel | undefined;

  beforeEach(() => vscode.reset());
  afterEach(() => panel?.dispose());

  it('renders the form with a CSP nonce and sends watchers and suggestions on ready', async () => {
    vscode.settings['azureDevOps.watchers'] = [{ name: 'Bugs for me', type: 'workItem' }];
    const { client } = fakeClient();
    panel = open(client, 0);
    const html = panel.webview.html;
    const n = cspNonce(html);
    assert.ok(n);
    assert.ok(html.includes(`<script nonce="${n}">`));
    assert.ok(html.includes('Edit in settings.json'));

    await panel.webview.send({ type: 'ready' });
    assert.deepEqual(panel.webview.last('watchers'), { type: 'watchers', watchers: [{ name: 'Bugs for me', type: 'workItem' }], target: 'user settings' });
    assert.deepEqual(panel.webview.last('select'), { type: 'select', index: 0 });
    assert.deepEqual(panel.webview.last('repos'), { type: 'repos', repos: ['web-shop', 'payments'] });
    assert.deepEqual(panel.webview.last('pipelines'), { type: 'pipelines', names: ['Fabrikam CI'] });

    // A second ready (page reload) does not select again.
    await panel.webview.send({ type: 'ready' });
    assert.equal(panel.webview.ofType('select').length, 1);
  });

  it('reveals the open panel and forwards a new selection', () => {
    const { client } = fakeClient();
    panel = open(client);
    WatchersPanel.show(client, EXT, 'new');
    WatchersPanel.show(client, EXT);
    assert.equal(panel.revealed, 2);
    assert.deepEqual(panel.webview.ofType('select'), [{ type: 'select', index: 'new' }]);
  });

  it('saves, rejects duplicate names, toggles and deletes watchers', async () => {
    vscode.settings['azureDevOps.watchers'] = [{ name: 'Bugs for me', type: 'workItem' }];
    const { client } = fakeClient();
    panel = open(client);
    const wv = panel.webview;

    await wv.send({ type: 'save', index: -1, watcher: { name: ' bugs FOR me ', type: 'pipeline' } });
    assert.match(wv.last('saveError').message, /already exists/);

    await wv.send({ type: 'save', index: -1, watcher: { name: 'Failed builds', type: 'pipeline' } });
    assert.deepEqual(wv.last('saved'), { type: 'saved', index: 1 });
    // The configuration listener pushes the new list to the page.
    assert.equal(wv.last('watchers').watchers.length, 2);

    await wv.send({ type: 'save', index: 0, watcher: { name: 'Bugs for me', type: 'workItem', where: '[System.State] = \'New\'' } });
    assert.deepEqual(wv.last('saved'), { type: 'saved', index: 0 });

    await wv.send({ type: 'setEnabled', index: 1, enabled: false });
    await wv.send({ type: 'setEnabled', index: 9, enabled: false });
    const list = vscode.settings['azureDevOps.watchers'] as { name: string; enabled?: boolean; where?: string }[];
    assert.equal(list[0].where, '[System.State] = \'New\'');
    assert.equal(list[1].enabled, false);

    await wv.send({ type: 'setEnabled', index: 1, enabled: true });
    assert.equal((vscode.settings['azureDevOps.watchers'] as { enabled?: boolean }[])[1].enabled, undefined);

    await wv.send({ type: 'delete', index: 0 });
    assert.deepEqual((vscode.settings['azureDevOps.watchers'] as { name: string }[]).map(w => w.name), ['Failed builds']);
  });

  it('previews work items, pipeline runs and pull requests', async () => {
    const { client, calls, state } = fakeClient();
    panel = open(client);
    const wv = panel.webview;

    await wv.send({ type: 'preview', seq: 1, watcher: { name: 'w', type: 'workItem', where: "[System.WorkItemType] = 'Bug'" } });
    assert.match(calls.wiql[0], /AND \(\[System.WorkItemType\] = 'Bug'\)/);
    const items = wv.last('preview');
    assert.equal(items.seq, 1);
    assert.deepEqual(items.items[0], { title: '#7 Bug 7', sub: 'Bug · Active', open: ['azureDevOps.wi.open', 7] });

    state.ids = [];
    await wv.send({ type: 'preview', seq: 2, watcher: { name: 'w', type: 'workItem' } });
    assert.doesNotMatch(calls.wiql[1], / AND \(/);
    assert.match(wv.last('preview').note, /No work items match/);

    await wv.send({ type: 'preview', seq: 3, watcher: { name: 'w', type: 'pipeline' } });
    const runs = wv.last('preview');
    assert.match(runs.note, /^2 of the last 100 runs match/);
    assert.deepEqual(runs.items.map((i: { sub: string }) => i.sub), ['main · failed · Lena Hoffmann', 'main · inProgress']);
    assert.deepEqual(runs.items[0].open, ['azureDevOps.pipelines.openRun', 1]);

    state.builds = Array.from({ length: 12 }, (_, i) => build(i + 1));
    await wv.send({ type: 'preview', seq: 4, watcher: { name: 'w', type: 'pipeline' } });
    assert.match(wv.last('preview').note, /\(showing 10\)/);
    assert.equal(wv.last('preview').items.length, 10);

    await wv.send({ type: 'preview', seq: 5, watcher: { name: 'w', type: 'pipeline', pipeline: 'Other' } });
    assert.match(wv.last('preview').note, /None of the last 100 runs/);

    await wv.send({ type: 'preview', seq: 6, watcher: { name: 'w', type: 'pullRequest' } });
    const prs = wv.last('preview');
    assert.match(prs.note, /^1 active pull request matches/);
    assert.deepEqual(prs.items[0], {
      title: '!11 Improve checkout 11', sub: 'web-shop · feature/11 → main', open: ['azureDevOps.pr.openOverview', 'repo-1', 11],
    });

    state.prs = [pr(12), pr(13)];
    await wv.send({ type: 'preview', seq: 7, watcher: { name: 'w', type: 'pullRequest' } });
    assert.match(wv.last('preview').note, /^2 active pull requests match/);

    await wv.send({ type: 'preview', seq: 8, watcher: { name: 'w', type: 'pullRequest', repository: 'payments' } });
    assert.match(wv.last('preview').note, /No active pull requests/);

    state.fail = true;
    await wv.send({ type: 'preview', seq: 9, watcher: { name: 'w', type: 'workItem' } });
    assert.deepEqual(wv.last('preview'), { type: 'preview', seq: 9, error: 'TF51005: bad <query>' });
  });

  it('opens only azureDevOps commands and the settings file', async () => {
    const { client } = fakeClient();
    panel = open(client);
    const wv = panel.webview;
    await wv.send({ type: 'open', args: ['azureDevOps.wi.open', 7] });
    await wv.send({ type: 'open', args: ['workbench.action.terminal.sendSequence', { text: 'rm -rf /' }] });
    await wv.send({ type: 'open', args: 'azureDevOps.wi.open' });
    await wv.send({ type: 'json' });
    await wv.send({ type: 'unknown' });
    assert.deepEqual(vscode.executed, [
      ['azureDevOps.wi.open', 7],
      ['workbench.action.openSettingsJson', { revealSetting: { key: 'azureDevOps.watchers', edit: true } }],
    ]);
  });

  it('stops listening to settings once closed', async () => {
    const { client } = fakeClient();
    const closed = open(client);
    closed.dispose();
    const before = closed.webview.posted.length;
    await vscode.workspace.getConfiguration('azureDevOps').update('watchers', [{ name: 'x', type: 'pipeline' }]);
    assert.equal(closed.webview.posted.length, before);
    panel = open(client);
    assert.notEqual(panel, closed);
  });
});
