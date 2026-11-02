import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Uri as VsUri, WebviewView } from 'vscode';
import { AdoClient, AdoError } from '../client';
import { Connection, ConnectionManager } from '../connection';
import { ReviewedFiles } from '../pullRequests/reviewed';
import type { MyDayService } from '../myDay/service';
import type { MyDayResult } from '../myDay/types';
import { ASSIGNED_TO_ME, CHECKS_CACHE_MAX, SidebarProvider } from '../sidebar/sidebarProvider';
import { Approval, Build, IdentityRef, PullRequest, TeamIteration, WorkItem } from '../types';
import { cspNonce, FakeWebview } from './fakeWebview';
import * as vscode from './vscodeStub';

const EXT = vscode.Uri.file('/ext') as unknown as VsUri;
const ORG = 'https://dev.azure.com/contoso';
const ME: IdentityRef = { id: 'me', displayName: 'Alex Morgan', uniqueName: 'alex@contoso.com' };
const LENA: IdentityRef = { id: 'lena', displayName: 'Lena Hoffmann' };
const DAY = 86_400_000;
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString();

function build(id: number, queueTime: string): Build {
  return { id, buildNumber: `2026.${id}`, status: 'completed', result: 'succeeded', definition: { id: 1, name: 'Fabrikam CI' }, sourceBranch: 'refs/heads/main', queueTime };
}

function pr(id: number, project: string, creationDate: string): PullRequest {
  return {
    pullRequestId: id, title: `Change ${id}`, status: 'active', createdBy: LENA, creationDate, sourceRefName: 'refs/heads/feature/x', targetRefName: 'refs/heads/main',
    repository: { id: 'repo-web', name: 'web-shop', project: id === 3 ? undefined : { id: `pid-${project}`, name: project } },
    reviewers: [{ ...ME, vote: 5 }, { id: 'team', displayName: 'Reviewers', vote: 0, isContainer: true }], isDraft: id === 2, mergeStatus: 'succeeded',
  };
}

function workItem(id: number, project: string, changed: string, extra: Record<string, unknown> = {}): WorkItem {
  return {
    id, rev: 1, fields: {
      'System.Title': `Story ${id}`, 'System.WorkItemType': 'User Story', 'System.State': 'Active', 'System.TeamProject': project,
      'System.ChangedDate': changed, 'System.AssignedTo': ME, 'System.IterationPath': 'Fabrikam Shop\\Sprint 12', 'System.Tags': 'web; checkout ;', ...extra,
    },
  };
}

const ITERATIONS: TeamIteration[] = [
  { id: 'it-10', name: 'Sprint 10', path: 'Fabrikam Shop\\Sprint 10', attributes: { startDate: isoDay(-30), finishDate: isoDay(-17), timeFrame: 'past' } },
  { id: 'it-11', name: 'Sprint 11', path: 'Fabrikam Shop\\Sprint 11', attributes: { startDate: isoDay(-16), finishDate: isoDay(-9), timeFrame: 'past' } },
  { id: 'it-12', name: 'Sprint 12', path: 'Fabrikam Shop\\Sprint 12', attributes: { startDate: isoDay(-7), finishDate: isoDay(7), timeFrame: 'current' } },
  { id: 'it-13', name: 'Sprint 13', path: 'Fabrikam Shop\\Sprint 13', attributes: { startDate: isoDay(10), finishDate: isoDay(24), timeFrame: 'future' } },
];

type Calls = Record<string, unknown[][]>;

function fakeClient(calls: Calls, opts: { iterations?: TeamIteration[]; failing?: string[] } = {}) {
  const record = (name: string, args: unknown[]) => { const list = calls[name] ?? []; calls[name] = list; list.push(args); };
  const make = (project: string): Record<string, unknown> => {
    const fail = () => {
      if (opts.failing?.includes(project)) {
        throw new Error(`${project} is not reachable`);
      }
    };
    return {
      listProjects: async (org?: string) => { record('listProjects', [org]); return [{ id: 'p1', name: 'Fabrikam Shop' }]; },
      getMe: async () => ME,
      listPullRequests: async (criteria: unknown) => {
        record('listPullRequests', [project, criteria]);
        fail();
        return [pr(1, project, '2026-10-01T08:00:00Z'), pr(2, project, '2026-10-03T08:00:00Z'), pr(3, project, '2026-10-02T08:00:00Z')];
      },
      getPolicyEvaluations: async (_projectId: string, prId: number) => {
        record('getPolicyEvaluations', [prId]);
        if (prId === 2) {
          throw new Error('no access');
        }
        return [{ evaluationId: 'e', status: 'approved', configuration: { isEnabled: true, isBlocking: true, type: { id: 't', displayName: 'Build' } } }];
      },
      getLatestIteration: async () => 4,
      getIterationChanges: async () => [
        { changeType: 'edit', item: { path: '/src/z.ts', objectId: 'obj-z' } },
        { changeType: 'delete', item: { path: '/src/a.ts' } },
      ],
      listSavedQueries: async () => [{ id: 'q1', name: 'Open bugs', path: 'Shared Queries/Open bugs' }],
      runSavedQuery: async (id: string) => { record('runSavedQuery', [id]); return [11, 12]; },
      queryWiql: async (wiql: string) => { record('queryWiql', [project, wiql]); fail(); return project === 'Fabrikam Shop' ? [11, 12] : [21, 11]; },
      getWorkItems: async (ids: number[], fields?: string[]) => {
        record('getWorkItems', [ids, fields]);
        return ids.map(id => workItem(id, id > 20 ? 'Contoso Web' : 'Fabrikam Shop', `2026-10-${String(id).padStart(2, '0')}T08:00:00Z`,
          { 'Microsoft.VSTS.Scheduling.RemainingWork': 4, 'Microsoft.VSTS.Scheduling.Effort': 3 }));
      },
      getWorkItemStates: async (type: string) => {
        record('getWorkItemStates', [project, type]);
        return [{ name: 'Active', color: '007acc', category: 'InProgress' }];
      },
      listBuilds: async (o: unknown) => {
        record('listBuilds', [project, o]);
        return project === 'Fabrikam Shop' ? [build(1, '2026-10-01T08:00:00Z')] : [build(2, '2026-10-02T08:00:00Z')];
      },
      listDefinitions: async () => [{ id: 1, name: 'Fabrikam CI', path: '\\Web\\CI', latestBuild: build(1, '2026-10-01T08:00:00Z') }, { id: 2, name: 'Nightly', path: '\\' }],
      getTimeline: async (buildId: number) => {
        record('getTimeline', [project, buildId]);
        return [{ id: 's1', type: 'Stage', name: 'Build', order: 1 }];
      },
      listTeams: async () => [{ id: 't1', name: `${project} Team`, description: 'x' }],
      listTeamIterations: async (team: string) => { record('listTeamIterations', [project, team]); return opts.iterations ?? ITERATIONS; },
      getIterationWorkItems: async () => [{ target: { id: 11 } }, { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 11 }, target: { id: 12 } }],
      getCapacities: async () => [{ teamMember: ME, activities: [{ capacityPerDay: 6 }], daysOff: [] }],
      getTeamDaysOff: async () => { throw new Error('no days off'); },
      listPendingApprovals: async () => [
        { id: 'a1', status: 'pending', createdOn: '2026-10-01T08:00:00Z', instructions: 'Check <prod>', pipeline: { name: 'Release', owner: { id: 900, name: '2026.900' } },
          steps: [{ assignedApprover: ME, status: 'pending' }, { assignedApprover: LENA, status: 'approved' }] },
        { id: 'a2', status: 'pending' },
      ],
    };
  };
  const clients = new Map<string, Record<string, unknown>>();
  const get = (project: string) => {
    let c = clients.get(project);
    if (!c) {
      c = make(project);
      c.forProject = (p?: string) => get(p || 'Fabrikam Shop');
      clients.set(project, c);
    }
    return c;
  };
  return get('Fabrikam Shop') as unknown as AdoClient;
}

function fakeReviewed() {
  const listeners: ((e: unknown) => void)[] = [];
  const sets: unknown[][] = [];
  const reviewed = {
    onDidChange: (l: (e: unknown) => void) => { listeners.push(l); return { dispose() { /* nothing */ } }; },
    isReviewed: (_repo: string, _pr: number, path: string) => path === '/src/z.ts',
    set: async (...a: unknown[]) => { sets.push(a); },
  };
  return { reviewed: reviewed as unknown as ReviewedFiles, sets, fire: (e: unknown) => listeners.forEach(l => l(e)) };
}

/** A sidebar view: the webview plus the badge and visibility the provider drives. */
function fakeView(webview: FakeWebview) {
  const listeners: (() => void)[] = [];
  const view = {
    webview, badge: undefined as unknown, visible: true,
    onDidChangeVisibility: (l: () => void) => { listeners.push(l); return { dispose() { /* nothing */ } }; },
  };
  return { view, setVisible: (on: boolean) => { view.visible = on; listeners.forEach(l => l()); } };
}

function myDayResult(count: number): MyDayResult {
  return { items: [], deferred: [], failures: [], count, multi: false, loadedAt: 1 };
}

/** The part of MyDayService the sidebar uses; records what it was asked. */
function fakeService() {
  const log: unknown[][] = [];
  const listeners: ((r: MyDayResult) => void)[] = [];
  const reviews: PullRequest[] = [pr(7, 'x', '2026-10-05T08:00:00Z')];
  const approvals: Approval[] = [{ id: 'a9', status: 'pending', createdOn: '2026-10-01T08:00:00Z', steps: [{ assignedApprover: ME, status: 'pending' }] } as Approval];
  const service = {
    start: () => { log.push(['start']); },
    setVisible: (on: boolean) => { log.push(['visible', on]); },
    get: async (o?: { force?: boolean }) => { log.push(['get', o]); return myDayResult(3); },
    onDidChange: (l: (r: MyDayResult) => void) => { listeners.push(l); return { dispose() { /* nothing */ } }; },
    rawReviews: async (project: string) => { log.push(['reviews', project]); return reviews; },
    rawApprovals: async (project: string) => { log.push(['approvals', project]); return approvals; },
  };
  return { service: service as unknown as MyDayService, log, fire: (r: MyDayResult) => listeners.forEach(l => l(r)), listeners };
}

describe('SidebarProvider', () => {
  const originalWindowState = vscode.window.onDidChangeWindowState;
  let calls: Calls;
  let conn: { current?: Connection };
  let windowState: ((e: { focused: boolean }) => void) | undefined;

  beforeEach(() => {
    vscode.reset();
    calls = {};
    conn = { current: { orgUrl: ORG, project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false } };
    (vscode.window as Record<string, unknown>).onDidChangeWindowState = (l: (e: { focused: boolean }) => void) => {
      windowState = l;
      return { dispose() { /* nothing */ } };
    };
  });
  afterEach(() => {
    vscode.window.onDidChangeWindowState = originalWindowState;
  });

  function resolve(opts: { iterations?: TeamIteration[]; failing?: string[]; service?: MyDayService } = {}) {
    const r = fakeReviewed();
    const provider = new SidebarProvider(fakeClient(calls, opts), conn as unknown as ConnectionManager, r.reviewed, EXT);
    const webview = new FakeWebview();
    const fake = fakeView(webview);
    if (opts.service) {
      provider.useMyDay(opts.service);
    }
    provider.resolveWebviewView(fake.view as unknown as WebviewView);
    let next = 0;
    const rpc = async (method: string, params?: unknown) => {
      const id = ++next;
      await webview.send({ type: 'rpc', id, method, params });
      const answer = webview.ofType('rpc').find(m => m.id === id);
      if (answer.error) {
        throw Object.assign(new Error(answer.error.message), { auth: answer.error.auth });
      }
      return answer.result;
    };
    return { provider, webview, rpc, view: fake.view, setVisible: fake.setVisible, ...r };
  }

  it('renders the dashboard shell with a CSP nonce and scripts limited to media', () => {
    const { webview } = resolve();
    const n = cspNonce(webview.html);
    assert.ok(n);
    assert.ok(webview.html.includes(`<script nonce="${n}" src="vscode-webview://fake/file:///ext/media/sidebar.js">`));
    assert.ok(!webview.html.includes('unsafe-eval'));
    assert.deepEqual((webview.options as { enableScripts: boolean }).enableScripts, true);
  });

  it('forwards reviewed changes, focus changes and refreshes to the page', async () => {
    const { provider, webview, fire } = resolve();
    fire({ repoId: 'repo-web', prId: 7 });
    windowState?.({ focused: false });
    provider.refresh();
    assert.deepEqual(webview.posted, [
      { type: 'reviewed', repoId: 'repo-web', prId: 7 },
      { type: 'focus', focused: false },
      { type: 'refresh' },
    ]);
  });

  it('runs only azureDevOps commands and ignores unknown messages', async () => {
    const { webview } = resolve();
    await webview.send({ type: 'command', name: 'azureDevOps.pr.create', args: ['web-shop'] });
    await webview.send({ type: 'command', name: 'azureDevOps.refresh', args: 'nope' });
    await webview.send({ type: 'command', name: 'workbench.action.terminal.new' });
    await webview.send({ type: 'command', name: 42 });
    await webview.send({ type: 'other' });
    assert.deepEqual(vscode.executed, [['azureDevOps.pr.create', 'web-shop'], ['azureDevOps.refresh']]);
    assert.deepEqual(webview.posted, []);
  });

  it('answers context, projects, me and project selection', async () => {
    vscode.settings['azureDevOps.authMethod'] = 'pat';
    const { rpc } = resolve();
    assert.deepEqual(await rpc('context'), {
      configured: true, orgUrl: ORG, org: 'contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop'],
      authMethod: 'pat', refreshInterval: 10, autoRefreshInterval: 60, focused: true,
    });
    await rpc('projects', { org: ' contoso ' });
    await rpc('projects');
    assert.deepEqual(calls.listProjects, [[ORG], [undefined]]);
    assert.deepEqual(await rpc('me'), ME);

    assert.equal(await rpc('setProject', { org: 'contoso', projects: ['Fabrikam Shop', 'Contoso Web'] }), null);
    assert.equal(vscode.settings['azureDevOps.organization'], ORG);
    assert.equal(vscode.settings['azureDevOps.project'], 'Fabrikam Shop');
    assert.deepEqual(vscode.settings['azureDevOps.additionalProjects'], ['Contoso Web']);
    await rpc('setProject', { org: 'contoso', project: 'Contoso Web' });
    assert.equal(vscode.settings['azureDevOps.project'], 'Contoso Web');
    assert.equal(vscode.settings['azureDevOps.additionalProjects'], undefined);

    conn.current = undefined;
    const empty = await rpc('context') as { configured: boolean; projects: string[] };
    assert.equal(empty.configured, false);
    assert.deepEqual(empty.projects, []);
  });

  it('lists pull requests newest first with their checks', async () => {
    const { rpc } = resolve();
    const list = await rpc('prs', { filter: 'review' }) as { id: number; checks?: { state: string }; myVote: number; isDraft: boolean; reviewers: { isContainer: boolean }[] }[];
    assert.deepEqual(calls.listPullRequests, [['Fabrikam Shop', { reviewerId: 'me' }]]);
    assert.deepEqual(list.map(p => p.id), [2, 3, 1]);
    assert.deepEqual(list.map(p => p.checks?.state), [undefined, undefined, 'ok']);
    assert.equal(list[0].isDraft, true);
    assert.equal(list[0].myVote, 5);
    assert.deepEqual(list[0].reviewers.map(r => r.isContainer), [false, true]);
    await rpc('prs', { filter: 'mine' });
    await rpc('prs', { filter: 'all' });
    assert.deepEqual(calls.listPullRequests.slice(1).map(c => c[1]), [{ creatorId: 'me' }, {}]);
  });

  it('asks for the checks of a PR once in a burst, again when forced or refreshed', async () => {
    const { rpc, provider } = resolve();
    await rpc('prs', { filter: 'review' });
    assert.equal(calls.getPolicyEvaluations.length, 2);
    await rpc('prs', { filter: 'mine' });
    assert.equal(calls.getPolicyEvaluations.length, 2);
    await rpc('prs', { filter: 'mine', force: true });
    assert.equal(calls.getPolicyEvaluations.length, 4);
    provider.refresh();
    await rpc('prs', { filter: 'mine' });
    assert.equal(calls.getPolicyEvaluations.length, 6);
  });

  it('bounds the checks cache in a long session and keeps the newest entries', async () => {
    const { provider } = resolve();
    const internal = provider as unknown as { checksOf(projectId: string, prId: number, force: boolean): Promise<unknown>; checksCache: Map<string, unknown> };
    for (let id = 1000; id < 1000 + CHECKS_CACHE_MAX + 150; id++) {
      await internal.checksOf('pid-Fabrikam Shop', id, false);
    }
    assert.equal(internal.checksCache.size, CHECKS_CACHE_MAX);
    assert.ok(internal.checksCache.has(`pid-Fabrikam Shop/${1000 + CHECKS_CACHE_MAX + 149}`), 'the newest stays');
    assert.ok(!internal.checksCache.has('pid-Fabrikam Shop/1000'), 'the oldest went');
  });

  it('lists PR files with reviewed marks and stores reviews', async () => {
    const { rpc, sets } = resolve();
    const result = await rpc('prFiles', { repoId: 'repo-web', prId: '7' }) as { iteration: number; files: { path: string; version: string; reviewed: boolean }[] };
    assert.equal(result.iteration, 4);
    assert.deepEqual(result.files.map(f => [f.path, f.version, f.reviewed]), [['/src/a.ts', 'deleted', false], ['/src/z.ts', 'obj-z', true]]);
    assert.equal(await rpc('setReviewed', { repoId: 'repo-web', prId: '7', path: '/src/a.ts', version: 'deleted', reviewed: 1 }), null);
    assert.deepEqual(sets, [['repo-web', 7, '/src/a.ts', 'deleted', true]]);
  });

  it('lists queries and work items with state colors', async () => {
    const { rpc } = resolve();
    assert.deepEqual(await rpc('queries'), {
      builtin: [{ key: 'builtin:0', name: 'Assigned to me' }, { key: 'builtin:1', name: 'Recently updated by me' }, { key: 'builtin:2', name: 'Created by me' }],
      saved: [{ key: 'saved:q1', name: 'Open bugs', path: 'Shared Queries/Open bugs' }],
    });
    const items = await rpc('workItems', { query: 'builtin:1' }) as Record<string, unknown>[];
    assert.match(String(calls.queryWiql[0][1]), /\[System.ChangedBy\] = @Me/);
    assert.deepEqual(items[0], {
      id: 11, title: 'Story 11', type: 'User Story', state: 'Active', stateColor: '#007acc', stateCategory: 'InProgress', assignedTo: 'Alex Morgan',
      changed: '2026-10-11T08:00:00Z', priority: undefined, iteration: 'Sprint 12', tags: ['web', 'checkout'], project: undefined,
    });
    await rpc('workItems', { query: 'saved:q1' });
    assert.deepEqual(calls.runSavedQuery, [['q1']]);
    await rpc('workItems', {});
    // States are cached per project and type.
    assert.equal(calls.getWorkItemStates.length, 1);

    vscode.settings['azureDevOps.workItems.queries'] = [{ name: 'Fabrikam bugs', wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Bug'" }];
    assert.deepEqual((await rpc('queries') as { builtin: unknown[] }).builtin, [{ key: 'builtin:0', name: 'Fabrikam bugs' }]);
    await rpc('workItems', { query: 'builtin:5' });
    assert.match(String(calls.queryWiql.at(-1)?.[1]), /'Bug'/);
  });

  it('merges work items, builds and definitions of several projects', async () => {
    conn.current = { orgUrl: ORG, project: 'Fabrikam Shop', projects: ['Fabrikam Shop', 'Contoso Web'], detected: false };
    const { rpc } = resolve();
    const items = await rpc('workItems', { query: 'builtin:0' }) as { id: number; project?: string }[];
    assert.deepEqual(items.map(i => [i.id, i.project]), [[21, 'Contoso Web'], [12, 'Fabrikam Shop'], [11, 'Fabrikam Shop']]);

    const builds = await rpc('builds', { filter: 'mine' }) as { id: number; project?: string }[];
    assert.deepEqual(builds.map(b => [b.id, b.project]), [[2, 'Contoso Web'], [1, 'Fabrikam Shop']]);
    assert.deepEqual(calls.listBuilds[0][1], { requestedFor: 'me', top: 30 });

    const defs = await rpc('definitions') as { name: string; path: string; folder: string[]; latest?: unknown }[];
    assert.deepEqual(defs[0].folder, ['Fabrikam Shop', 'Web', 'CI']);
    assert.equal(defs[0].path, 'Fabrikam Shop / Web / CI');
    assert.ok(defs[0].latest);
    assert.equal(defs[1].latest, undefined);

    const teams = await rpc('teams') as { name: string; project: string }[];
    assert.deepEqual(teams, [{ id: 't1', name: 'Fabrikam Shop Team', project: 'Fabrikam Shop' }, { id: 't1', name: 'Contoso Web Team', project: 'Contoso Web' }]);
  });

  it('skips a failing project unless every project fails', async () => {
    conn.current = { orgUrl: ORG, project: 'Fabrikam Shop', projects: ['Fabrikam Shop', 'Contoso Web'], detected: false };
    let { rpc } = resolve({ failing: ['Contoso Web'] });
    const prs = await rpc('prs', { filter: 'all' }) as { project: string }[];
    assert.ok(prs.every(p => p.project === 'Fabrikam Shop'));

    ({ rpc } = resolve({ failing: ['Fabrikam Shop', 'Contoso Web'] }));
    await assert.rejects(rpc('prs', { filter: 'all' }), /Fabrikam Shop is not reachable/);
  });

  it('answers single-project builds, definitions, runs and timelines', async () => {
    const { rpc } = resolve();
    await rpc('builds', { filter: 'all' });
    assert.deepEqual(calls.listBuilds[0][1], { requestedFor: undefined, top: 30 });
    const defs = await rpc('definitions') as { path: string; folder: string[] }[];
    assert.deepEqual(defs.map(d => d.path), ['Web / CI', '']);
    const runs = await rpc('definitionBuilds', { project: 'Contoso Web', id: 1 }) as { id: number }[];
    assert.deepEqual(runs.map(r => r.id), [2]);
    assert.deepEqual(calls.listBuilds.at(-1), ['Contoso Web', { definitionId: 1, top: 10 }]);
    const tree = await rpc('timeline', { project: 'Contoso Web', buildId: 2 }) as unknown[];
    assert.equal(tree.length, 1);
    assert.deepEqual(calls.getTimeline, [['Contoso Web', 2]]);
  });

  it('loads a sprint with hierarchy, remaining work and capacity', async () => {
    const { rpc } = resolve();
    const sprint = await rpc('sprint', { project: 'Fabrikam Shop', team: 'Web Team' }) as {
      iteration: { id: string }; iterations: unknown[]; items: { id: number; parent?: number; remaining: number; points: number }[];
      people: unknown[]; daysLeft: number; daysTotal: number;
    };
    assert.equal(sprint.iteration.id, 'it-12');
    assert.equal(sprint.iterations.length, 4);
    assert.deepEqual(sprint.items.map(i => [i.id, i.parent, i.remaining, i.points]), [[11, undefined, 4, 3], [12, 11, 4, 3]]);
    assert.ok(sprint.people.length > 0);
    assert.ok(sprint.daysLeft > 0);
    assert.ok(sprint.daysTotal >= sprint.daysLeft);
    assert.deepEqual((calls.getWorkItems.at(-1)?.[1] as string[]).length, 4);

    const future = await rpc('sprint', { project: 'Fabrikam Shop', team: 'Web Team', iteration: 'it-13' }) as { iteration: { id: string }; daysLeft: number };
    assert.equal(future.iteration.id, 'it-13');
    assert.ok(future.daysLeft > 0);
  });

  it('falls back to the last past sprint, the first one, or none', async () => {
    let { rpc } = resolve({ iterations: ITERATIONS.slice(0, 2) });
    assert.equal((await rpc('sprint', { team: 'Web Team' }) as { iteration: { id: string }; daysLeft: number }).iteration.id, 'it-11');

    ({ rpc } = resolve({ iterations: [{ id: 'x', name: 'Backlog', path: 'Fabrikam Shop' }] }));
    const undated = await rpc('sprint', { team: 'Web Team' }) as { iteration: { id: string }; daysLeft: number; daysTotal?: number };
    assert.equal(undated.iteration.id, 'x');
    assert.equal(undated.daysLeft, 0);
    assert.equal(undated.daysTotal, undefined);

    ({ rpc } = resolve({ iterations: [] }));
    assert.deepEqual(await rpc('sprint', { team: 'Web Team' }), { iterations: [], iteration: undefined, items: [], people: [] });
  });

  it('lists approvals and marks the ones waiting for me', async () => {
    const { rpc } = resolve();
    const list = await rpc('approvals') as Record<string, unknown>[];
    assert.deepEqual(list[0], {
      id: 'a1', pipeline: 'Release', runId: 900, run: '2026.900', created: '2026-10-01T08:00:00Z', instructions: 'Check <prod>',
      approvers: [{ name: 'Alex Morgan', status: 'pending' }, { name: 'Lena Hoffmann', status: 'approved' }], mine: true,
    });
    assert.equal(list[1].mine, false);
    assert.deepEqual(list[1].approvers, []);
  });

  it('exports the Assigned to me query', () => {
    assert.equal(ASSIGNED_TO_ME.name, 'Assigned to me');
    assert.match(ASSIGNED_TO_ME.wiql, /@Me/);
  });

  it('shares the work item state cache through statesFor', async () => {
    const { provider } = resolve();
    const first = await provider.statesFor('Fabrikam Shop', 'User Story');
    const second = await provider.statesFor('Fabrikam Shop', 'User Story');
    assert.equal(first, second);
    assert.equal(calls.getWorkItemStates.length, 1);
    await provider.statesFor('Contoso Web', 'Bug');
    assert.equal(calls.getWorkItemStates.length, 2);
    provider.refresh();
    await provider.statesFor('Fabrikam Shop', 'User Story');
    assert.equal(calls.getWorkItemStates.length, 3);
  });

  it('caches an empty list when the states cannot be read, as work items do', async () => {
    const r = fakeReviewed();
    let tries = 0;
    const client = { forProject: () => client, getWorkItemStates: async () => { tries++; throw new Error('no access'); } } as unknown as AdoClient;
    const provider = new SidebarProvider(client, conn as unknown as ConnectionManager, r.reviewed, EXT);
    assert.deepEqual(await provider.statesFor('Fabrikam Shop', 'Bug'), []);
    assert.deepEqual(await provider.statesFor('Fabrikam Shop', 'Bug'), []);
    assert.equal(tries, 1);
  });

  it('uses the work item states cache for work items and the given client for sprints', async () => {
    const { rpc } = resolve();
    await rpc('workItems', {});
    await rpc('workItems', {});
    assert.equal(calls.getWorkItemStates.length, 1);
  });

  describe('My Day', () => {
    it('answers myDay through the service and passes force', async () => {
      const f = fakeService();
      const { rpc, view } = resolve({ service: f.service });
      assert.equal(((await rpc('myDay')) as MyDayResult).count, 3);
      await rpc('myDay', { force: true });
      assert.deepEqual(f.log.filter(l => l[0] === 'get'), [['get', { force: false }], ['get', { force: true }]]);
      assert.deepEqual(view.badge, { value: 3, tooltip: '3 items need you in My Day' });
    });

    it('fails clearly without a service', async () => {
      const { rpc } = resolve();
      await assert.rejects(rpc('myDay'), /My Day is not available/);
    });

    it('starts the service on resolve and sets the badge from the last result', () => {
      const f = fakeService();
      const r = fakeReviewed();
      const provider = new SidebarProvider(fakeClient(calls), conn as unknown as ConnectionManager, r.reviewed, EXT);
      provider.useMyDay(f.service);
      provider.useMyDay(f.service);
      assert.equal(f.listeners.length, 1);
      const first = fakeView(new FakeWebview());
      provider.resolveWebviewView(first.view as unknown as WebviewView);
      assert.deepEqual(f.log, [['start']]);
      assert.equal(first.view.badge, undefined);
      f.fire(myDayResult(1));
      assert.deepEqual(first.view.badge, { value: 1, tooltip: '1 item needs you in My Day' });
      const second = fakeView(new FakeWebview());
      provider.resolveWebviewView(second.view as unknown as WebviewView);
      assert.deepEqual(second.view.badge, { value: 1, tooltip: '1 item needs you in My Day' });
    });

    it('pushes changes to the page and clears the badge at 0', () => {
      const f = fakeService();
      const { webview, view } = resolve({ service: f.service });
      f.fire(myDayResult(4));
      assert.deepEqual(view.badge, { value: 4, tooltip: '4 items need you in My Day' });
      assert.deepEqual(webview.last('myDay'), { type: 'myDay', result: myDayResult(4) });
      f.fire(myDayResult(0));
      assert.equal(view.badge, undefined);
      assert.equal(webview.ofType('myDay').length, 2);
    });

    it('works without a view and without a service', async () => {
      const f = fakeService();
      const r = fakeReviewed();
      const provider = new SidebarProvider(fakeClient(calls), conn as unknown as ConnectionManager, r.reviewed, EXT);
      provider.useMyDay(f.service);
      f.fire(myDayResult(2));
      const plain = resolve();
      await plain.rpc('tab', { tab: 'myday' });
      plain.setVisible(false);
      assert.equal(plain.view.badge, undefined);
    });

    it('tells the service when its tab is on screen', async () => {
      const f = fakeService();
      const { rpc, setVisible } = resolve({ service: f.service });
      const visible = () => f.log.filter(l => l[0] === 'visible').map(l => l[1]);
      assert.equal(await rpc('tab', { tab: 'myday' }), null);
      await rpc('tab', { tab: 'prs' });
      await rpc('tab', { tab: 42 });
      await rpc('tab', { tab: 'myday' });
      setVisible(false);
      setVisible(true);
      assert.deepEqual(visible(), [true, false, false, true, false, true]);
    });

    it('reads reviews and approvals through the service', async () => {
      const f = fakeService();
      const { rpc } = resolve({ service: f.service });
      const prs = await rpc('prs', { filter: 'review' }) as { id: number }[];
      assert.deepEqual(prs.map(x => x.id), [7]);
      assert.equal(calls.listPullRequests, undefined);
      const approvals = await rpc('approvals') as { id: string; mine: boolean }[];
      assert.deepEqual(approvals.map(a => [a.id, a.mine]), [['a9', true]]);
      assert.deepEqual(f.log.filter(l => l[0] === 'reviews' || l[0] === 'approvals'), [['reviews', 'Fabrikam Shop'], ['approvals', 'Fabrikam Shop']]);
    });

    it('uses the primary project when the connection lists no projects and each project otherwise', async () => {
      const f = fakeService();
      conn.current = { orgUrl: ORG, project: 'Fabrikam Shop', projects: [], detected: false };
      const single = resolve({ service: f.service });
      await single.rpc('prs', { filter: 'review' });
      conn.current = { orgUrl: ORG, project: 'Fabrikam Shop', projects: ['Fabrikam Shop', 'Contoso Web'], detected: false };
      const many = resolve({ service: f.service });
      await many.rpc('approvals');
      assert.deepEqual(f.log.filter(l => l[0] === 'reviews' || l[0] === 'approvals'), [['reviews', 'Fabrikam Shop'], ['approvals', 'Fabrikam Shop'], ['approvals', 'Contoso Web']]);
    });

    it('keeps the other pull request filters on the client', async () => {
      const f = fakeService();
      const { rpc } = resolve({ service: f.service });
      await rpc('prs', { filter: 'mine' });
      assert.equal(calls.listPullRequests.length, 1);
      assert.deepEqual(f.log.filter(l => l[0] === 'reviews'), []);
    });
  });

  it('reports errors and marks sign-in problems', async () => {
    const { rpc, webview } = resolve();
    await assert.rejects(rpc('nope'), /Unknown method nope/);
    assert.equal(webview.last('rpc').error.auth, false);

    const r = fakeReviewed();
    const failing = { getMe: async () => { throw new AdoError('Sign in again.', 401, true); } } as unknown as AdoClient;
    const provider = new SidebarProvider(failing, conn as unknown as ConnectionManager, r.reviewed, EXT);
    const wv = new FakeWebview();
    provider.resolveWebviewView(fakeView(wv).view as unknown as WebviewView);
    await wv.send({ type: 'rpc', id: 1, method: 'me' });
    assert.deepEqual(wv.last('rpc'), { type: 'rpc', id: 1, error: { message: 'Sign in again.', auth: true } });
  });
});

/** Body of each `@keyframes` rule (brace matching, no regex over the whole sheet). */
function keyframes(css: string): Map<string, string> {
  const found = new Map<string, string>();
  let at = css.indexOf('@keyframes');
  while (at >= 0) {
    const open = css.indexOf('{', at);
    const name = css.slice(at + '@keyframes'.length, open).trim();
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}' && --depth === 0) break;
    }
    found.set(name, css.slice(open + 1, end));
    at = css.indexOf('@keyframes', end);
  }
  return found;
}

describe('sidebar.css', () => {
  const css = readFileSync(join(__dirname, '..', '..', 'media', 'sidebar.css'), 'utf8');

  it('animates only compositor-friendly properties (transform, opacity)', () => {
    const frames = keyframes(css);
    assert.ok(frames.size >= 5);
    for (const [name, body] of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]);
      assert.deepEqual(props.filter(p => p !== 'transform' && p !== 'opacity'), [], `@keyframes ${name}`);
    }
  });

  it('lists transitioned properties explicitly and does not transition box-shadow on cards', () => {
    assert.ok(!/transition:\s*all\b/.test(css));
    const card = /\n\.card \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(card, /transition: background-color/);
    assert.ok(!card.includes('box-shadow'));
  });
});
