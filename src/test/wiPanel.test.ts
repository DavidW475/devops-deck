import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { WorkItem } from '../types';
import { WorkItemPanel } from '../workItems/wiPanel';
import { cspNonce, flush, lastPanel, panels } from './fakeWebview';
import { executed, messages, opened, reset } from './vscodeStub';

const ORG = 'https://dev.azure.com/contoso';
const PROJECT = 'Fabrikam Shop';
const ext = vscode.Uri.file('/ext');

function wi(id: number, fields: Record<string, unknown>, relations?: { rel: string; url: string }[]): WorkItem {
  return { id, rev: 7, fields: { 'System.TeamProject': PROJECT, ...fields }, relations } as unknown as WorkItem;
}

const MAIN = wi(42, {
  'System.WorkItemType': 'User Story',
  'System.Title': 'Checkout <b>fails</b> for gift cards',
  'System.State': 'Active',
  'System.AssignedTo': { displayName: 'Megan Bowen', uniqueName: 'megan@contoso.com' },
  'System.CreatedBy': { displayName: 'Alex Wilber' },
  'System.CreatedDate': '2026-09-01T10:00:00Z',
  'System.ChangedDate': '2026-10-01T10:00:00Z',
  'System.Description': '<p>Steps</p><script>alert(1)</script><img src="x" onerror="alert(2)">',
  'System.Tags': 'checkout; payments',
  'System.IterationPath': 'Fabrikam Shop\\Sprint 42',
  'System.AreaPath': 'Fabrikam Shop',
  'Microsoft.VSTS.Common.Priority': 2,
  'Microsoft.VSTS.Scheduling.StoryPoints': 5,
}, [
  { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${ORG}/_apis/wit/workItems/10` },
  { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${ORG}/_apis/wit/workItems/43` },
  { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${ORG}/_apis/wit/workItems/44` },
  { rel: 'System.LinkTypes.Related', url: `${ORG}/_apis/wit/workItems/50` },
  { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/p1%2Frepo-1%2F7' },
  { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/p1%2Frepo-1%2F8' },
  ...[20, 21, 22].map(id => ({ rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/p1%2Frepo-1%2F${id}` })),
]);

const PR_STATES: Record<number, [string, boolean]> = { 7: ['completed', false], 20: ['abandoned', false], 21: ['active', true], 22: ['active', false] };

function pr(id: number, title: string, status = 'active', isDraft = false): unknown {
  return {
    pullRequestId: id, title, status, isDraft,
    repository: { id: 'repo-1', name: 'shop-web', project: { id: 'p1' } },
    sourceRefName: 'refs/heads/feature/gift-cards', targetRefName: 'refs/heads/main',
    createdBy: { displayName: 'Adele Vance' },
  };
}

type Calls = Record<string, unknown[][]>;

function fakeClient(overrides: Record<string, unknown> = {}): { client: AdoClient; calls: Calls } {
  const calls: Calls = {};
  const rec = (name: string, result: (...a: any[]) => unknown) => (...args: unknown[]) => {
    const list = calls[name] ?? []; calls[name] = list; list.push(args);
    return Promise.resolve().then(() => result(...args));
  };
  const base: Record<string, unknown> = {
    connection: { orgUrl: ORG, project: PROJECT },
    getWorkItem: rec('getWorkItem', () => MAIN),
    getWorkItems: rec('getWorkItems', (ids: number[]) => ids.filter(i => i !== 44).map(i => wi(i, {
      'System.WorkItemType': i === 10 ? 'Feature' : 'Task', 'System.Title': `Item ${i}`, 'System.State': i === 43 ? 'Done' : 'New',
    }))),
    getWorkItemStates: rec('getWorkItemStates', () => [{ name: 'New', color: 'b2b2b2' }, { name: 'Active', color: '007acc' }]),
    getWorkItemComments: rec('getWorkItemComments', () => [{
      createdBy: { displayName: 'Lee Gu' }, createdDate: '2026-10-02T10:00:00Z', text: 'Looks good <script>bad()</script>',
    }]),
    getPullRequestById: rec('getPullRequestById', (id: number) => {
      if (id === 8) {
        throw new Error('no access');
      }
      const [status, draft] = PR_STATES[id];
      return pr(id, 'Gift card <fix>', status, draft);
    }),
    getWorkItemTypeFields: rec('getWorkItemTypeFields', () => [
      { referenceName: 'Microsoft.VSTS.Common.Priority', allowedValues: [1, 2, 3, 4] },
      { referenceName: 'Microsoft.VSTS.Scheduling.StoryPoints' },
    ]),
    getWorkItemUpdates: rec('getWorkItemUpdates', () => [{
      rev: 2, revisedBy: { displayName: 'Megan Bowen' }, revisedDate: '2026-10-01T10:00:00Z',
      fields: { 'System.State': { oldValue: 'New', newValue: 'Active' } },
    }]),
    getWorkItemTypes: rec('getWorkItemTypes', () => ['Bug', 'Task']),
    listClassificationPaths: rec('listClassificationPaths', (kind: string) =>
      kind === 'Iterations' ? ['Fabrikam Shop\\Sprint 41'] : ['Fabrikam Shop', 'Fabrikam Shop\\Web']),
    updateWorkItem: rec('updateWorkItem', () => MAIN),
    getMe: rec('getMe', () => ({ displayName: 'Megan Bowen', uniqueName: 'megan@contoso.com' })),
    createWorkItem: rec('createWorkItem', () => ({ id: 99 })),
    removeWorkItemRelation: rec('removeWorkItemRelation', () => undefined),
    addWorkItemComment: rec('addWorkItemComment', () => undefined),
    linkPullRequest: rec('linkPullRequest', () => undefined),
    unlinkPullRequest: rec('unlinkPullRequest', () => undefined),
    searchIdentities: rec('searchIdentities', () => [
      { displayName: 'Megan Bowen', uniqueName: 'megan@contoso.com' },
      { displayName: 'Contributors', isGroup: true, uniqueName: 'x' },
    ]),
    listPullRequests: rec('listPullRequests', () => [pr(7, 'Linked already'), pr(9, 'Gift card balance'), pr(11, 'Unrelated', 'active', true)]),
    webUrl: (kind: string, id: number) => `${ORG}/${PROJECT}/_${kind}/${id}`,
    ...overrides,
  };
  base.forProject = () => base;
  return { client: base as unknown as AdoClient, calls };
}

async function open(id = 42, overrides: Record<string, unknown> = {}) {
  const f = fakeClient(overrides);
  let changes = 0;
  WorkItemPanel.show(f.client, ext, id, () => changes++);
  await flush();
  const panel = lastPanel();
  return { ...f, panel, web: panel.webview, changes: () => changes };
}

afterEach(() => {
  panels.forEach(p => p.dispose());
  reset();
});

describe('WorkItemPanel rendering', () => {
  it('renders fields, hierarchy, PRs, comments and history with escaping and a CSP nonce', async () => {
    const { panel, web } = await open();
    const html = web.html;
    assert.equal(panel.title, '#42 Checkout <b>fails</b> for gift cards');
    const n = cspNonce(html);
    assert.ok(n && html.includes(`<script nonce="${n}">`));
    assert.ok(html.includes('Checkout &lt;b&gt;fails&lt;/b&gt; for gift cards'));
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(!html.includes('onerror'));
    assert.ok(!html.includes('bad()'));
    assert.ok(html.includes('--accent:#007acc'));
    assert.ok(html.includes('data-remove-parent="10"'));
    assert.ok(html.includes('1/1 done'), 'only children that loaded are counted');
    assert.ok(html.includes('Gift card &lt;fix&gt;'));
    for (const pill of ['pill ok">Completed', 'pill muted">Abandoned', 'pill muted">Draft', 'pill info">Active']) {
      assert.ok(html.includes(pill), pill);
    }
    assert.ok(html.includes('!8 (not accessible)'));
    assert.ok(html.includes('Sprint 41'));
    assert.ok(html.includes('Sprint 42'), 'the current iteration is added to the options');
    assert.ok(html.includes('value="checkout, payments"'));
    assert.ok(html.includes('History <span class="count">1</span>'));
    assert.ok(html.includes('Related'));
    assert.ok(html.includes('data-kind="int"'));
  });

  it('reuses an open panel and reveals it', async () => {
    const { client, calls, panel } = await open();
    WorkItemPanel.show(client, ext, 42, () => undefined);
    await flush();
    assert.equal(panel.revealed, 1);
    assert.equal(panels.length, 1);
    assert.equal(calls.getWorkItem.length, 2);
  });

  it('renders a minimal work item and falls back when lists fail', async () => {
    const fail = () => Promise.reject(new Error('down'));
    const { web } = await open(43, {
      getWorkItem: async () => wi(43, { 'System.WorkItemType': 'Bug', 'System.Title': 'Empty', 'System.State': 'Odd' }),
      getWorkItemStates: fail, getWorkItemComments: fail, getWorkItemTypeFields: fail, getWorkItemUpdates: fail,
      getWorkItemTypes: async () => ['Bug'], listClassificationPaths: fail,
    });
    await web.send({ type: 'refresh' }); // the type and path lists are cached across panels
    const html = web.html;
    assert.ok(html.includes('<option>Odd</option>'));
    assert.ok(html.includes('No comments yet.'));
    assert.ok(html.includes('No parent.'));
    assert.ok(html.includes('No children.'));
    assert.ok(html.includes('None linked.'));
    assert.ok(html.includes('Unassigned'));
    assert.ok(html.includes('<option selected>Bug</option>'));
    assert.ok(!html.includes('History'));
  });

  it('shows an error when the work item cannot be loaded', async () => {
    await open(44, { getWorkItem: () => Promise.reject(new Error('TF401232: not found')) });
    assert.ok(messages.some(m => m.includes('TF401232')));
  });
});

describe('WorkItemPanel messages', () => {
  it('updates fields and re-renders', async () => {
    const { web, calls, changes } = await open(45);
    await web.send({ type: 'state', value: 'Resolved' });
    await web.send({ type: 'title', value: 'New title' });
    await web.send({ type: 'unassign' });
    await web.send({ type: 'assignMe' });
    await web.send({ type: 'tags', value: 'a, b; a' });
    await web.send({ type: 'tags', value: '' });
    await web.send({ type: 'field', name: 'Microsoft.VSTS.Scheduling.StoryPoints', kind: 'number', value: '2,5' });
    await web.send({ type: 'field', name: 'Microsoft.VSTS.Common.Priority', kind: 'int', value: '3' });
    await web.send({ type: 'field', name: 'System.IterationPath', kind: 'path', value: '' });
    assert.deepEqual(calls.updateWorkItem.map(c => c[1]), [
      { 'System.State': 'Resolved' },
      { 'System.Title': 'New title' },
      { 'System.AssignedTo': '' },
      { 'System.AssignedTo': 'megan@contoso.com' },
      { 'System.Tags': 'a; b' },
      { 'System.Tags': null },
      { 'Microsoft.VSTS.Scheduling.StoryPoints': 2.5 },
      { 'Microsoft.VSTS.Common.Priority': 3 },
      { 'System.IterationPath': null },
    ]);
    assert.equal(changes(), 9);
  });

  it('rejects a non-numeric number field', async () => {
    const { web, calls } = await open(46);
    await web.send({ type: 'field', name: 'Microsoft.VSTS.Scheduling.Effort', kind: 'number', value: 'lots' });
    assert.equal(calls.updateWorkItem, undefined);
    assert.ok(messages.some(m => m.includes('"lots" is not a number.')));
  });

  it('adds children, comments and removes the parent link', async () => {
    const { web, calls } = await open(42);
    await web.send({ type: 'addChild', childType: 'Task', title: '  Write tests ' });
    await web.send({ type: 'addChild', childType: 'Task', title: '   ' });
    assert.deepEqual(calls.createWorkItem, [['Task', {
      'System.Title': 'Write tests', 'System.AreaPath': 'Fabrikam Shop', 'System.IterationPath': 'Fabrikam Shop\\Sprint 42',
    }, { parentId: 42 }]]);
    await web.send({ type: 'comment', text: 'Ship it' });
    assert.deepEqual(calls.addWorkItemComment, [[42, 'Ship it']]);
    await web.send({ type: 'removeParent', id: 10 });
    await web.send({ type: 'removeParent', id: 77 });
    assert.deepEqual(calls.removeWorkItemRelation, [[42, 7, 0]]);
  });

  it('links and unlinks pull requests and assignees', async () => {
    const { web, calls } = await open(42);
    const key = JSON.stringify({ projectId: 'p1', repoId: 'repo-1', prId: 9 });
    await web.send({ type: 'link', key });
    await web.send({ type: 'link', key: 'Lee Gu <lee@contoso.com>', picker: 'assignee' });
    await web.send({ type: 'unlink', key });
    assert.deepEqual(calls.linkPullRequest, [[42, { projectId: 'p1', repoId: 'repo-1', prId: 9 }]]);
    assert.deepEqual(calls.unlinkPullRequest, [[42, { projectId: 'p1', repoId: 'repo-1', prId: 9 }]]);
    assert.deepEqual(calls.updateWorkItem, [[42, { 'System.AssignedTo': 'Lee Gu <lee@contoso.com>' }]]);
  });

  it('searches pull requests without the linked ones and caches the list until refresh', async () => {
    const { web, calls } = await open(42);
    await web.send({ type: 'linkSearch', text: '', seq: 1 });
    assert.deepEqual(web.last('linkResults').items.map((i: any) => i.title), ['!9 Gift card balance', '!11 Unrelated']);
    await web.send({ type: 'linkSearch', text: '!9', seq: 2 });
    const r = web.last('linkResults');
    assert.equal(r.seq, 2);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].sub, 'shop-web · feature/gift-cards → main · Adele Vance');
    await web.send({ type: 'linkSearch', text: 'balance', seq: 3 });
    assert.equal(calls.listPullRequests.length, 1);
    await web.send({ type: 'refresh' });
    await web.send({ type: 'linkSearch', text: 'x', seq: 4 });
    assert.equal(calls.listPullRequests.length, 2);
  });

  it('reports pull request search errors', async () => {
    const { web } = await open(47, { listPullRequests: () => Promise.reject(new Error('offline')) });
    await web.send({ type: 'linkSearch', text: 'a', seq: 5 });
    assert.deepEqual(web.last('linkResults'), { type: 'linkResults', seq: 5, error: 'offline' });
  });

  it('searches people for the assignee picker', async () => {
    const { web, calls } = await open(48);
    await web.send({ type: 'linkSearch', picker: 'assignee', text: 'm', seq: 1 });
    assert.deepEqual(web.last('linkResults').items, []);
    assert.equal(calls.searchIdentities, undefined);
    await web.send({ type: 'linkSearch', picker: 'assignee', text: ' meg ', seq: 2 });
    assert.deepEqual(web.last('linkResults').items, [{ key: 'Megan Bowen <megan@contoso.com>', title: 'Megan Bowen', sub: 'megan@contoso.com' }]);
    assert.deepEqual(calls.searchIdentities, [['meg']]);
  });

  it('reports people search errors', async () => {
    const { web } = await open(49, { searchIdentities: () => Promise.reject(new Error('denied')) });
    await web.send({ type: 'linkSearch', picker: 'assignee', text: 'megan', seq: 3 });
    assert.deepEqual(web.last('linkResults'), { type: 'linkResults', picker: 'assignee', seq: 3, error: 'denied' });
  });

  it('navigates without re-rendering', async () => {
    const { web, calls, changes } = await open(42);
    await web.send({ type: 'browser' });
    await web.send({ type: 'branch' });
    await web.send({ type: 'openPr', repoId: 'repo-1', prId: 9 });
    await web.send({ type: 'openWi', id: '43' });
    await web.send({ type: 'unknown' });
    assert.deepEqual(opened, [vscode.Uri.parse(`${ORG}/${PROJECT}/_workItem/42`).toString()]);
    assert.deepEqual(executed, [
      ['azureDevOps.wi.createBranch', 42],
      ['azureDevOps.pr.openOverview', 'repo-1', 9],
      ['azureDevOps.wi.open', 43],
    ]);
    assert.equal(calls.getWorkItem.length, 1);
    assert.equal(changes(), 0);
  });

  it('forgets the panel when it is closed', async () => {
    const { client, panel } = await open(50);
    panel.dispose();
    WorkItemPanel.show(client, ext, 50, () => undefined);
    await flush();
    assert.equal(panels.length, 2);
  });
});
