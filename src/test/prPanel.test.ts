import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Memento, Uri as VsUri } from 'vscode';
import { AdoClient } from '../client';
import { PullRequestPanel } from '../pullRequests/prPanel';
import { GitCommitRef, IdentityRef, PolicyEvaluation, PrIteration, PrThread, PullRequest, WorkItem } from '../types';
import { cspNonce, FakeWebview, FakeWebviewPanel, flush, inlineScript, lastPanel } from './fakeWebview';
import * as vscode from './vscodeStub';

const EXT = vscode.Uri.file('/ext') as unknown as VsUri;
const ME: IdentityRef = { id: 'me', displayName: 'Alex Morgan', uniqueName: 'alex@contoso.com' };
const LENA: IdentityRef = { id: 'lena', displayName: 'Lena <Hoffmann>', uniqueName: 'lena@contoso.com' };
const PROJECT = { id: 'proj-1', name: 'Fabrikam Shop' };

function pullRequest(): PullRequest {
  return {
    pullRequestId: 7, title: 'Fix <checkout> & totals', description: 'Fixes the **total**.', status: 'active', createdBy: LENA,
    creationDate: '2026-10-01T08:00:00Z', sourceRefName: 'refs/heads/feature/totals', targetRefName: 'refs/heads/main',
    repository: { id: 'repo-web', name: 'web-shop', project: PROJECT }, mergeStatus: 'conflicts',
    reviewers: [{ ...ME, vote: 10 }, { id: 'team', displayName: '[Fabrikam Shop]\\Reviewers', vote: -5, isRequired: true }],
    lastMergeSourceCommit: { commitId: 'abc123' },
  };
}

const THREADS: PrThread[] = [
  {
    id: 1, status: 1, publishedDate: '2026-10-02T08:00:00Z', threadContext: { filePath: '/src/cart.ts', rightFileStart: { line: 12, offset: 1 } },
    comments: [{ id: 1, parentCommentId: 0, author: LENA, content: 'Use <b>const</b>', publishedDate: '2026-10-02T08:00:00Z', commentType: 'text' }],
  },
  {
    id: 2, status: 'fixed', publishedDate: '2026-10-03T08:00:00Z',
    comments: [{ id: 2, parentCommentId: 0, author: ME, content: 'Done', publishedDate: '2026-10-03T08:00:00Z', commentType: 1 }],
  },
  { id: 3, status: 1, comments: [{ id: 3, parentCommentId: 0, author: ME, content: 'voted', publishedDate: '2026-10-03T08:00:00Z', commentType: 'system' }] },
];

const ITERATIONS: PrIteration[] = [
  { id: 1, author: LENA, createdDate: '2026-10-01T08:00:00Z' },
  { id: 2, description: 'Address <review>', author: LENA, createdDate: '2026-10-02T08:00:00Z' },
  { id: 3, author: LENA, createdDate: '2026-10-03T08:00:00Z' },
];

const COMMITS: GitCommitRef[] = [{ commitId: '0123456789abcdef', comment: 'Fix totals\n\nDetails <here>', author: { name: 'Lena Hoffmann', date: '2026-10-02T08:00:00Z' } }];

function evaluation(status: string, name: string, extra: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
  return {
    evaluationId: name, status,
    configuration: { isEnabled: true, isBlocking: true, type: { id: 't', displayName: 'Build' }, settings: { displayName: name } }, ...extra,
  };
}

function workItem(id: number): WorkItem {
  return { id, rev: 1, fields: { 'System.Title': `Totals <wrong> ${id}`, 'System.WorkItemType': 'Bug', 'System.State': 'Active' } };
}

function fakeClient() {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => async (...args: unknown[]) => { const list = calls[name] ?? []; calls[name] = list; list.push(args); };
  const state = {
    pr: pullRequest(), wiIds: [42], iterations: ITERATIONS, evaluations: [
      evaluation('rejected', 'Fabrikam CI', { context: { buildId: 900, buildDefinitionName: 'Fabrikam CI build' } }),
      evaluation('approved', 'Required reviewers'),
    ] as PolicyEvaluation[] | undefined, failPr: false, failSearch: false, failVote: false,
  };
  const client: Record<string, unknown> = {
    connection: { orgUrl: 'https://dev.azure.com/contoso' },
    getPullRequest: async () => {
      if (state.failPr) {
        throw new Error('PR not found');
      }
      return state.pr;
    },
    getThreads: async () => THREADS,
    getPullRequestWorkItemIds: async () => state.wiIds,
    getMe: async () => ME,
    getIterations: async () => state.iterations,
    getPullRequestCommits: async () => COMMITS,
    getWorkItems: async (ids: number[]) => ids.map(workItem),
    getPolicyEvaluations: async () => {
      if (!state.evaluations) {
        throw new Error('no policies');
      }
      return state.evaluations;
    },
    webUrl: (kind: string, repo: string, id: number, project?: string) => `https://dev.azure.com/contoso/${project}/_git/${repo}/${kind}/${id}`,
    searchIdentities: async () => state.failSearch ? Promise.reject(new Error('identities unavailable')) : [{ id: 'me', displayName: 'Alex Morgan' }, { id: 'u2', displayName: 'Marco Rossi', uniqueName: 'marco@contoso.com' }, { id: 'g', displayName: 'Testers', isGroup: true }],
    searchWorkItems: async () => {
      if (state.failSearch) {
        throw new Error('search failed');
      }
      return [workItem(42), workItem(43)];
    },
  };
  client.vote = async (...args: unknown[]) => {
    if (state.failVote) {
      throw new Error('TF401027: vote denied');
    }
    calls.vote = [...(calls.vote ?? []), args];
  };
  for (const name of ['removeReviewer', 'setAutoComplete', 'createThread', 'replyToThread', 'updateThreadStatus', 'updatePullRequest',
    'addReviewer', 'linkPullRequest', 'unlinkPullRequest']) {
    client[name] = record(name);
  }
  client.forProject = () => client;
  return { client: client as unknown as AdoClient, calls, state };
}

function memento() {
  const data = new Map<string, unknown>();
  const store = { get: (k: string) => data.get(k), update: async (k: string, v: unknown) => { data.set(k, v); }, keys: () => [...data.keys()] };
  return { store: store as unknown as Memento, data };
}

describe('PullRequestPanel', () => {
  let panel: FakeWebviewPanel | undefined;
  let changes = 0;

  beforeEach(() => {
    vscode.reset();
    changes = 0;
    vscode.commandResults['markdown.api.render'] = '<p>Rendered <strong>md</strong></p><script>alert(1)</script>';
  });
  afterEach(() => panel?.dispose());

  async function open(client: AdoClient, prId = 7): Promise<FakeWebview> {
    PullRequestPanel.show(client, EXT, 'repo-web', prId, () => changes++);
    panel = lastPanel();
    await flush(5);
    return panel.webview;
  }

  const commandsRun = () => vscode.executed.filter(e => e[0] !== 'markdown.api.render');

  it('renders the pull request with escaped server data, sanitized markdown and a CSP nonce', async () => {
    const { store } = memento();
    PullRequestPanel.useStore(store);
    const { client } = fakeClient();
    const wv = await open(client);
    const html = wv.html;
    const n = cspNonce(html);
    assert.ok(n);
    assert.ok(html.includes(`<script nonce="${n}">`));
    assert.equal(panel?.title, 'PR !7: Fix <checkout> & totals');
    assert.ok(html.includes('<h1>Fix &lt;checkout&gt; &amp; totals</h1>'));
    assert.ok(!html.includes('<checkout>'));
    assert.ok(html.includes('Lena &lt;Hoffmann&gt;'));
    assert.ok(html.includes('<strong>md</strong>'));
    assert.ok(!html.includes('alert(1)'));
    assert.ok(html.includes('Merge conflicts'));
    assert.ok(html.includes('1 required check failing'));
    assert.ok(html.includes('data-run="900"'));
    assert.ok(html.includes('Fabrikam CI build'));
    assert.ok(html.includes('/src/cart.ts:12'));
    assert.ok(html.includes('Totals &lt;wrong&gt; 42'));
    assert.ok(html.includes('Address &lt;review&gt;'));
    assert.ok(html.includes('Details &lt;here&gt;'));
    assert.ok(html.includes('Reset vote'));
    assert.ok(html.includes('data-action="autoComplete" data-value="true"'));
    // Two visible threads; the system comment is hidden.
    assert.ok(html.includes('Discussion <span class="count">2</span>'));
    assert.ok(html.includes('data-status="1" data-thread="2"'));
  });

  it('shows updates since the last visit and remembers the newest one when closed', async () => {
    const { store, data } = memento();
    PullRequestPanel.useStore(store);
    data.set('prVisit:https://dev.azure.com/contoso/repo-web/7', 1);
    const { client } = fakeClient();
    const wv = await open(client);
    assert.ok(wv.html.includes('2 new updates'));
    assert.ok(wv.html.includes('data-compare="1" data-target="3"'));

    await wv.send({ type: 'seen' });
    assert.equal(data.get('prVisit:https://dev.azure.com/contoso/repo-web/7'), 3);
    assert.equal(changes, 1);

    data.set('prVisit:https://dev.azure.com/contoso/repo-web/7', 2);
    panel?.dispose();
    await flush();
    assert.equal(data.get('prVisit:https://dev.azure.com/contoso/repo-web/7'), 3);
  });

  it('renders drafts, other states and missing data', async () => {
    const { client, state } = fakeClient();
    state.pr = { ...pullRequest(), isDraft: true, status: 'completed', description: undefined, mergeStatus: 'succeeded', reviewers: [], autoCompleteSetBy: LENA };
    state.wiIds = [];
    state.iterations = [];
    state.evaluations = undefined;
    const wv = await open(client, 8);
    const html = wv.html;
    assert.ok(html.includes('No description.'));
    assert.ok(html.includes('No reviewers.'));
    assert.ok(html.includes('None linked.'));
    assert.ok(html.includes('Publish'));
    assert.ok(html.includes('<span class="pill info">completed</span>'));
    assert.ok(!html.includes('data-action="autoComplete"'));
    assert.ok(!html.includes('Merge conflicts'));
    assert.ok(!html.includes('<h2>Checks'));
    assert.ok(!html.includes('<h2>Updates'));
  });

  it('reveals and re-renders an open overview, and reports load errors', async () => {
    const { client, state } = fakeClient();
    const wv = await open(client);
    PullRequestPanel.show(client, EXT, 'repo-web', 7, () => changes++);
    assert.equal(panel?.revealed, 1);

    state.failPr = true;
    await wv.send({ type: 'refresh' });
    assert.deepEqual(vscode.messages, ['DevOps Deck: PR not found']);
  });

  it('votes, comments, replies and changes thread and draft state', async () => {
    const { client, calls } = fakeClient();
    const wv = await open(client);
    await wv.send({ type: 'vote', vote: 10 });
    await wv.send({ type: 'comment', text: 'Looks good' });
    await wv.send({ type: 'reply', threadId: 1, text: 'Fixed' });
    await wv.send({ type: 'threadStatus', threadId: 1, status: 2 });
    await wv.send({ type: 'draft', value: true });
    await wv.send({ type: 'removeReviewer', id: 'team' });
    assert.deepEqual(calls.vote, [['repo-web', 7, 10]]);
    assert.deepEqual(calls.createThread, [['repo-web', 7, { comments: [{ parentCommentId: 0, content: 'Looks good', commentType: 1 }], status: 1 }]]);
    assert.deepEqual(calls.replyToThread, [['repo-web', 7, 1, 'Fixed']]);
    assert.deepEqual(calls.updateThreadStatus, [['repo-web', 7, 1, 2]]);
    assert.deepEqual(calls.updatePullRequest, [['repo-web', 7, { isDraft: true }]]);
    assert.deepEqual(calls.removeReviewer, [['repo-web', 7, 'team']]);
    assert.equal(changes, 6);
  });

  it('abandons only after confirmation', async () => {
    const { client, calls } = fakeClient();
    const wv = await open(client);
    await wv.send({ type: 'abandon' });
    assert.equal(calls.updatePullRequest, undefined);
    vscode.answers.message.push('Abandon');
    await wv.send({ type: 'abandon' });
    assert.deepEqual(calls.updatePullRequest, [['repo-web', 7, { status: 'abandoned' }]]);
    assert.equal(changes, 1);
  });

  it('completes and sets auto-complete with the chosen options', async () => {
    const { client, calls } = fakeClient();
    const wv = await open(client);

    vscode.answers.quickPick.push({ label: 'Rebase and fast-forward', value: 'rebase' }, 'Delete source branch');
    await wv.send({ type: 'complete' });
    assert.deepEqual(calls.updatePullRequest[0], ['repo-web', 7, {
      status: 'completed', lastMergeSourceCommit: { commitId: 'abc123' },
      completionOptions: { mergeStrategy: 'rebase', deleteSourceBranch: true, transitionWorkItems: true },
    }]);
    assert.ok(vscode.messages.includes('PR !7 completed.'));

    // Cancelled pickers change nothing.
    await wv.send({ type: 'complete' });
    vscode.answers.quickPick.push({ label: 'Squash commit', value: 'squash' });
    await wv.send({ type: 'autoComplete', value: true });
    assert.equal(calls.updatePullRequest.length, 1);
    assert.equal(calls.setAutoComplete, undefined);

    vscode.answers.quickPick.push({ label: 'Squash commit', value: 'squash' }, 'Keep source branch');
    await wv.send({ type: 'autoComplete', value: true });
    await wv.send({ type: 'autoComplete', value: false });
    assert.deepEqual(calls.setAutoComplete, [
      ['repo-web', 7, { mergeStrategy: 'squash', deleteSourceBranch: false, transitionWorkItems: true }],
      ['repo-web', 7, undefined],
    ]);
    assert.equal(changes, 3);
  });

  it('searches, adds and removes reviewers and work items', async () => {
    const { client, calls, state } = fakeClient();
    const wv = await open(client);

    await wv.send({ type: 'linkSearch', picker: 'reviewer', text: 'm', seq: 1 });
    assert.deepEqual(wv.last('linkResults'), { type: 'linkResults', picker: 'reviewer', seq: 1, items: [] });
    await wv.send({ type: 'linkSearch', picker: 'reviewer', text: 'mar', seq: 2 });
    assert.deepEqual(wv.last('linkResults').items, [
      { key: 'u2', title: 'Marco Rossi', sub: 'marco@contoso.com' },
      { key: 'g', title: 'Testers', sub: 'Group' },
    ]);

    await wv.send({ type: 'linkSearch', picker: 'link', text: 'totals', seq: 3 });
    assert.deepEqual(wv.last('linkResults'), { type: 'linkResults', seq: 3, items: [{ key: '43', title: '#43 Totals <wrong> 43', sub: 'Bug · Active' }] });
    state.failSearch = true;
    await wv.send({ type: 'linkSearch', picker: 'link', seq: 4 });
    assert.deepEqual(wv.last('linkResults'), { type: 'linkResults', seq: 4, error: 'search failed' });
    await wv.send({ type: 'linkSearch', picker: 'reviewer', text: 'marco', seq: 5 });
    assert.deepEqual(wv.last('linkResults'), { type: 'linkResults', picker: 'reviewer', seq: 5, error: 'identities unavailable' });

    await wv.send({ type: 'reviewerRequired', value: 1 });
    await wv.send({ type: 'link', picker: 'reviewer', key: 'u2' });
    await wv.send({ type: 'link', picker: 'link', key: '43' });
    await wv.send({ type: 'unlink', key: '42' });
    assert.deepEqual(calls.addReviewer, [['repo-web', 7, 'u2', true]]);
    const artifact = { projectId: 'proj-1', repoId: 'repo-web', prId: 7 };
    assert.deepEqual(calls.linkPullRequest, [[43, artifact]]);
    assert.deepEqual(calls.unlinkPullRequest, [[42, artifact]]);
  });

  it('refuses to link before the pull request has loaded', async () => {
    const { client, calls, state } = fakeClient();
    state.failPr = true;
    const wv = await open(client, 9);
    vscode.messages.length = 0;
    await wv.send({ type: 'unlink', key: '42' });
    assert.equal(calls.unlinkPullRequest, undefined);
    assert.deepEqual(vscode.messages, ['DevOps Deck: The pull request has not loaded yet.']);
    // Navigation needs the pull request too and does nothing without it.
    await wv.send({ type: 'checkout' });
    await wv.send({ type: 'browser' });
    await wv.send({ type: 'complete' });
    assert.deepEqual(vscode.opened, []);
  });

  it('navigates to runs, work items, iteration diffs and the browser', async () => {
    const { client } = fakeClient();
    const wv = await open(client);
    await wv.send({ type: 'openRun', id: '900' });
    await wv.send({ type: 'openWorkItem', id: 42 });
    await wv.send({ type: 'compare', base: '1', target: '3' });
    await wv.send({ type: 'browser' });
    await wv.send({ type: 'unknown' });
    assert.deepEqual(commandsRun(), [
      ['azureDevOps.pipelines.openRun', 900, 'Fabrikam Shop'],
      ['azureDevOps.wi.open', 42],
      ['azureDevOps.pr.compareIterations', 'repo-web', 7, 1, 3],
    ]);
    assert.equal(vscode.opened.length, 1);
    assert.match(vscode.opened[0], /\/contoso\/Fabrikam(%20| )Shop\/_git\/web-shop\/pr\/7$/);
    assert.equal(changes, 0);
  });

  it('reports that checkout needs the git extension', async () => {
    const { client } = fakeClient();
    const wv = await open(client);
    await wv.send({ type: 'checkout' });
    assert.deepEqual(vscode.messages, ['DevOps Deck: The built-in Git extension is not available.']);
  });
  it('renders the page once and updates it in place after actions', async () => {
    const { client } = fakeClient();
    const wv = await open(client);
    assert.equal(wv.htmlWrites, 2, 'loading page, then the pull request');
    assert.ok(wv.html.includes('<body><div id="root">'));
    const script = inlineScript(wv.html);
    assert.ok(script.indexOf('window.postAction') < script.indexOf("'reviewerRequired'"), 'the live update script runs first');
    assert.ok(!script.includes("getElementById('reqReviewer')"), 'no listeners bound to replaced elements');

    await wv.send({ type: 'reviewerRequired', value: true });
    await wv.send({ type: 'vote', vote: -5 });
    assert.equal(wv.htmlWrites, 2, 'the document is not replaced');
    const update = wv.last('update');
    assert.equal(update.title, 'Fix <checkout> & totals');
    assert.ok(update.html.includes('<h1>Fix &lt;checkout&gt; &amp; totals</h1>'));
    assert.ok(!update.html.includes('<checkout>'));
    assert.ok(!update.html.includes('alert(1)'));
    assert.ok(!update.html.includes('<div id="root">'), 'only the content of #root is sent');
    assert.ok(update.html.includes('id="reqReviewer" checked'), 'the required reviewer choice survives the update');
    assert.ok(update.html.includes('<details class="card" id="commits">'));
    assert.equal(wv.ofType('idle').length, 0);
  });

  it('tells the page when an action ends without new content', async () => {
    const { client, state } = fakeClient();
    const wv = await open(client);
    await wv.send({ type: 'abandon' });
    assert.equal(wv.ofType('idle').length, 1, 'cancelled');
    state.failVote = true;
    await wv.send({ type: 'vote', vote: 10 });
    assert.equal(wv.ofType('idle').length, 2, 'failed');
    assert.ok(vscode.messages.includes('DevOps Deck: TF401027: vote denied'));
    state.failPr = true;
    await wv.send({ type: 'refresh' });
    assert.equal(wv.ofType('idle').length, 3, 'the re-render failed');
    assert.equal(wv.ofType('update').length, 0);
    await wv.send({ type: 'unknown' });
    assert.equal(wv.ofType('idle').length, 4);
    await wv.send({ type: 'openWorkItem', id: 42 });
    assert.equal(wv.ofType('idle').length, 4, 'navigation does not mark the page busy');
  });

  it('posts nothing after the panel is closed', async () => {
    const { client } = fakeClient();
    const wv = await open(client);
    panel?.dispose();
    const before = wv.posted.length;
    await wv.send({ type: 'refresh' });
    await wv.send({ type: 'linkSearch', picker: 'link', text: 'totals', seq: 1 });
    assert.equal(wv.posted.length, before);
    assert.equal(wv.htmlWrites, 2);
  });
});
