import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdoClient } from '../client';
import { ConnectionManager } from '../connection';
import { Build, IdentityRef, PullRequest, WorkItem, WorkItemUpdate } from '../types';
import { buildEvent, matchesBuild, matchesPullRequest, PipelineWatcherConfig, PullRequestWatcherConfig, WatcherConfig, Watchers, watcherSummary } from '../watchers/watchers';
import * as vscode from './vscodeStub';

const ME: IdentityRef = { id: 'me', displayName: 'Alex Morgan', uniqueName: 'alex@contoso.com' };
const LENA: IdentityRef = { id: 'lena', displayName: 'Lena Hoffmann', uniqueName: 'lena@contoso.com' };
const MARCO: IdentityRef = { id: 'marco', displayName: 'Marco Rossi' };
const now = () => new Date().toISOString();
const byText = (a: string, b: string) => a.localeCompare(b);

function pr(id: number, opts: Partial<PullRequest> = {}): PullRequest {
  return {
    pullRequestId: id, title: `PR ${id}`, status: 'active', createdBy: LENA, creationDate: now(),
    sourceRefName: `refs/heads/feature/${id}`, targetRefName: 'refs/heads/main', repository: { id: 'r1', name: 'web-shop' },
    reviewers: [{ ...ME, vote: 0 }], lastMergeSourceCommit: { commitId: 'c1' }, ...opts,
  };
}

function wi(id: number, rev: number, by: IdentityRef, createdMinutesAgo: number, updates: WorkItemUpdate[] = []): WorkItem & { updates: WorkItemUpdate[] } {
  return {
    id, rev, updates, fields: {
      'System.WorkItemType': 'Bug', 'System.Title': `Bug ${id}`, 'System.State': 'Active', 'System.ChangedBy': by, 'System.CreatedBy': by,
      'System.CreatedDate': new Date(Date.now() - createdMinutesAgo * 60_000).toISOString(), 'System.ChangedDate': now(),
    },
  };
}

function build(id: number, opts: Partial<Build> = {}): Build {
  return {
    id, buildNumber: `2026.${id}`, status: 'completed', result: 'failed', definition: { id: 1, name: 'Contoso CI' },
    sourceBranch: 'refs/heads/main', requestedFor: LENA, startTime: now(), finishTime: now(), ...opts,
  };
}

describe('matchesBuild and buildEvent', () => {
  const c = (x: Partial<PipelineWatcherConfig>): PipelineWatcherConfig => ({ name: 'w', type: 'pipeline', ...x });
  it('filters by pipeline name, branch and who started the run', () => {
    const b = build(1, { sourceBranch: 'refs/heads/release/2.0' });
    assert.ok(matchesBuild(c({}), b, ME));
    assert.ok(matchesBuild(c({ pipeline: ['other', 'contoso *'] }), b, ME));
    assert.ok(!matchesBuild(c({ pipeline: 'Fabrikam*' }), b, ME));
    assert.ok(matchesBuild(c({ branch: 'release/*' }), b, ME));
    assert.ok(!matchesBuild(c({ branch: 'main' }), b, ME));
    assert.ok(!matchesBuild(c({ requestedBy: '@me' }), b, ME));
    assert.ok(matchesBuild(c({ requestedBy: 'Lena Hoffmann' }), b, ME));
  });

  it('maps results to events', () => {
    assert.equal(buildEvent(build(1)), 'failed');
    assert.equal(buildEvent(build(1, { result: 'partiallySucceeded' })), 'failed');
    assert.equal(buildEvent(build(1, { result: 'succeeded' })), 'succeeded');
    assert.equal(buildEvent(build(1, { status: 'inProgress', result: undefined })), 'started');
    assert.equal(buildEvent(build(1, { status: 'notStarted', result: undefined, startTime: undefined })), undefined);
  });
});

describe('matchesPullRequest', () => {
  const c = (x: Partial<PullRequestWatcherConfig>): PullRequestWatcherConfig => ({ name: 'w', type: 'pullRequest', ...x });

  it('filters by repository, branches with wildcards, people and title', () => {
    const p = pr(1, { targetRefName: 'refs/heads/release/2.8', title: 'Fix checkout' });
    assert.ok(matchesPullRequest(c({}), p, ME));
    assert.ok(matchesPullRequest(c({ repository: ['other', 'WEB-SHOP'] }), p, ME));
    assert.ok(!matchesPullRequest(c({ repository: 'other' }), p, ME));
    assert.ok(matchesPullRequest(c({ targetBranch: 'release/*' }), p, ME));
    assert.ok(!matchesPullRequest(c({ targetBranch: 'main' }), p, ME));
    assert.ok(matchesPullRequest(c({ sourceBranch: 'feature/*' }), p, ME));
    assert.ok(matchesPullRequest(c({ reviewer: '@me' }), p, ME));
    assert.ok(!matchesPullRequest(c({ createdBy: '@me' }), p, ME));
    assert.ok(matchesPullRequest(c({ createdBy: 'lena@contoso.com' }), p, ME));
    assert.ok(matchesPullRequest(c({ titleContains: 'CHECKOUT' }), p, ME));
  });

  it('treats glob special characters literally', () => {
    assert.ok(!matchesPullRequest(c({ targetBranch: 'release/2.8' }), pr(1, { targetRefName: 'refs/heads/release/208' }), ME));
  });

  it('can skip drafts', () => {
    assert.ok(!matchesPullRequest(c({ includeDrafts: false }), pr(1, { isDraft: true }), ME));
    assert.ok(matchesPullRequest(c({}), pr(1, { isDraft: true }), ME));
  });
});

describe('watcherSummary', () => {
  it('describes type, events and interval', () => {
    assert.equal(watcherSummary({ name: 'a', type: 'workItem' }), 'Work items · created, changed · every 5 min');
    assert.equal(watcherSummary({ name: 'b', type: 'pullRequest', events: ['voted'], interval: 30 }), 'Pull requests · voted · every 1 min');
    assert.equal(watcherSummary({ name: 'c', type: 'pipeline' }), 'Pipelines · failed · every 5 min');
  });
});

describe('Watchers', () => {
  let items: Record<number, ReturnType<typeof wi>>;
  let changed: number[];
  let active: PullRequest[];
  let closed: Record<number, PullRequest>;
  let requests: string[];
  let watchers: Watchers;
  let finished: Build[];
  let started: Build[];

  const client = {
    getMe: async () => { requests.push('me'); return ME; },
    queryWiql: async () => { requests.push('wiql'); return changed; },
    getWorkItems: async (ids: number[]) => { requests.push('workItems'); return ids.map(id => items[id]); },
    getWorkItemUpdates: async (id: number) => { requests.push('updates'); return items[id].updates; },
    listActivePullRequests: async () => { requests.push('prs'); return active; },
    getPullRequest: async (_r: string, id: number) => { requests.push('pr'); return closed[id]; },
    listBuildsSince: async (_since: Date, order: string) => { requests.push(`builds:${order}`); return order === 'finished' ? finished : started; },
    webUrl: (kind: string, a: string | number, b?: number) => `https://dev.azure.com/contoso/${kind}/${b ?? a}`,
  } as unknown as AdoClient;
  const connections = { current: { orgUrl: 'https://dev.azure.com/contoso', project: 'p' }, onDidChange: () => ({ dispose() { /* stub */ } }) } as unknown as ConnectionManager;

  type Internals = { running: boolean; states: { nextRun: number }[]; tick(): Promise<void> };
  /** Runs one check of every watcher and returns the requests it made and the notifications it showed. */
  async function check(): Promise<{ requests: string[]; messages: string[] }> {
    const w = watchers as unknown as Internals;
    while (w.running) {
      await new Promise(r => setTimeout(r, 1));
    }
    requests = [];
    vscode.messages.length = 0;
    w.states.forEach(s => { s.nextRun = 0; });
    await w.tick();
    return { requests: [...requests], messages: [...vscode.messages] };
  }

  function start(config: WatcherConfig[]): void {
    vscode.settings['azureDevOps.watchers'] = config;
    watchers = new Watchers(client, connections);
  }

  beforeEach(() => {
    vscode.reset();
    items = {};
    changed = [];
    active = [];
    closed = {};
    requests = [];
    finished = [];
    started = [];
  });
  afterEach(() => watchers?.dispose());

  it('starts with a silent baseline and costs one request per watcher type when nothing changed', async () => {
    items[1] = wi(1, 3, LENA, 600);
    changed = [1];
    active = [pr(10)];
    start([{ name: 'Bugs', type: 'workItem' }, { name: 'PRs', type: 'pullRequest' }, { name: 'More PRs', type: 'pullRequest' }]);
    const baseline = await check();
    assert.deepEqual(baseline.messages, [], 'no notifications for existing items');

    changed = [];
    const quiet = await check();
    assert.deepEqual(quiet.requests.toSorted(byText), ['prs', 'wiql'], 'one shared PR request for both PR watchers');
    assert.deepEqual(quiet.messages, []);
  });

  it('reports new and changed work items, but not my own changes', async () => {
    items[1] = wi(1, 3, LENA, 600);
    changed = [1];
    start([{ name: 'Bugs', type: 'workItem' }]);
    await check();

    items[1] = wi(1, 4, MARCO, 600);
    items[2] = wi(2, 1, LENA, 0);
    items[3] = wi(3, 1, ME, 0);
    changed = [1, 2, 3];
    const { messages } = await check();
    assert.deepEqual(messages, [
      'Bugs: Bug #1 changed by Marco Rossi: Bug 1',
      'Bugs: Bug #2 created by Lena Hoffmann: Bug 2',
    ]);

    const again = await check();
    assert.deepEqual(again.messages, [], 'the same revision is reported only once');
  });

  it('with fields, reports only changes of those fields and shows old → new', async () => {
    items[1] = wi(1, 3, LENA, 600);
    changed = [1];
    start([{ name: 'State', type: 'workItem', events: ['changed'], fields: ['System.State'] }]);
    await check();

    items[1] = wi(1, 4, MARCO, 600, [{ id: 4, rev: 4, fields: { 'System.Title': { oldValue: 'a', newValue: 'b' } } }]);
    assert.deepEqual((await check()).messages, [], 'title change is not watched');

    items[1] = wi(1, 5, MARCO, 600, [{ id: 5, rev: 5, fields: { 'System.State': { oldValue: 'Active', newValue: 'Resolved' } } }]);
    assert.deepEqual((await check()).messages, ['State: Bug #1 changed (State: Active → Resolved) by Marco Rossi: Bug 1']);
  });

  it('detects new pull requests, pushes, votes and completion', async () => {
    active = [pr(10), pr(11, { targetRefName: 'refs/heads/release/1.0', reviewers: [] })];
    start([
      { name: 'Mine', type: 'pullRequest', reviewer: '@me', events: ['created', 'pushed', 'voted', 'completed'] },
      { name: 'Release', type: 'pullRequest', targetBranch: 'release/*', events: ['completed'] },
    ]);
    await check();

    active = [
      pr(10, { lastMergeSourceCommit: { commitId: 'c2' }, reviewers: [{ ...ME, vote: 0 }, { ...MARCO, vote: 10 }] }),
      pr(12),
    ];
    closed[11] = pr(11, { status: 'completed', targetRefName: 'refs/heads/release/1.0', reviewers: [], closedBy: MARCO });
    const { requests: req, messages } = await check();
    assert.deepEqual(req, ['prs', 'pr']);
    assert.deepEqual(messages.toSorted(byText), [
      'Mine: Marco Rossi: Approved on PR !10: PR 10',
      'Mine: New PR !12 in web-shop by Lena Hoffmann: PR 12',
      'Mine: PR !10 has new changes: PR 10',
      'Release: PR !11 completed by Marco Rossi: PR 11',
    ]);
  });

  it('folds many events into one notification and runs command actions per event', async () => {
    start([{ name: 'All', type: 'pullRequest', actions: ['notify', { command: 'my.command', args: ['${id}', { url: '${url}' }] }] }]);
    await check();
    active = [1, 2, 3, 4, 5].map(id => pr(id));
    const { messages } = await check();
    assert.deepEqual(messages, ['All: 5 new events']);
    assert.equal(vscode.executed.length, 5);
    assert.deepEqual(vscode.executed[0], ['my.command', '1', { url: 'https://dev.azure.com/contoso/pr/1' }]);
  });

  it('ignores disabled watchers and keeps its history of events', async () => {
    start([{ name: 'Off', type: 'pullRequest', enabled: false }, { name: 'On', type: 'pullRequest' }]);
    await check();
    active = [pr(1)];
    const { messages } = await check();
    assert.deepEqual(messages, ['On: New PR !1 in web-shop by Lena Hoffmann: PR 1']);
    assert.equal(watchers.eventsOf('On').length, 1);
    assert.equal(watchers.unseenCount, 1);
    watchers.markSeen();
    assert.equal(watchers.unseenCount, 0);
  });

  it('reports failed pipeline runs once, including my own, with one request per check', async () => {
    start([{ name: 'CI', type: 'pipeline', branch: 'main' }, { name: 'Green', type: 'pipeline', events: ['succeeded'] }]);
    assert.deepEqual((await check()).messages, [], 'runs from before the start are not reported');

    finished = [build(1, { requestedFor: ME }), build(2, { result: 'succeeded' }), build(3, { sourceBranch: 'refs/heads/dev' })];
    const { requests: req, messages } = await check();
    assert.deepEqual(req, ['builds:finished']);
    assert.deepEqual(messages.toSorted(byText), [
      'CI: Contoso CI #2026.1 failed on main (Alex Morgan)',
      'Green: Contoso CI #2026.2 succeeded on main (Lena Hoffmann)',
    ]);
    assert.deepEqual((await check()).messages, [], 'overlapping query windows do not repeat events');
  });

  it('keeps the pipeline query window when a check fails', async () => {
    start([{ name: 'CI', type: 'pipeline' }]);
    await check();
    const realList = (client as unknown as { listBuildsSince: unknown }).listBuildsSince;
    let since: Date | undefined;
    (client as unknown as { listBuildsSince: unknown }).listBuildsSince = async (s: Date) => { since = s; throw new Error('503'); };
    await check();
    const failedFrom = since!;
    (client as unknown as { listBuildsSince: unknown }).listBuildsSince = async (s: Date) => { since = s; return []; };
    await check();
    (client as unknown as { listBuildsSince: unknown }).listBuildsSince = realList;
    assert.equal(since!.getTime(), failedFrom.getTime(), 'the retry asks from the same point in time');
  });

  it('asks for started runs only when a watcher wants them', async () => {
    start([{ name: 'Starts', type: 'pipeline', events: ['started'] }]);
    await check();
    started = [build(5, { status: 'inProgress', result: undefined })];
    const { requests: req, messages } = await check();
    assert.deepEqual(req.toSorted(byText), ['builds:finished', 'builds:started']);
    assert.deepEqual(messages, ['Starts: Contoso CI #2026.5 started on main (Lena Hoffmann)']);
  });
});
