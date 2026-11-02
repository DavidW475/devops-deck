import * as assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { AdoError } from '../client';
import { MyDayDefers } from '../myDay/defers';
import { MyDayService } from '../myDay/service';
import type { MyDayClient, MyDayDeps, MyDayResult } from '../myDay/types';
import type { Approval, Build, ClassificationIteration, IdentityRef, PullRequest, WorkItem, WorkItemState } from '../types';
import { flush } from './fakeWebview';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Wednesday, 4 November 2026, 12:00 UTC. */
const START = Date.UTC(2026, 10, 4, 12, 0, 0);
const ME: IdentityRef = { id: 'me-1', displayName: 'Erika Muster' };
const LENA: IdentityRef = { id: 'lena-1', displayName: 'Lena H.' };
const SHOP = 'Fabrikam Shop';
const WEB = 'Contoso Web';

function pr(id: number): PullRequest {
  return {
    pullRequestId: id, title: `Totals ${id}`, status: 'active', createdBy: LENA, creationDate: new Date(START - 3 * HOUR).toISOString(),
    sourceRefName: 'refs/heads/feature/totals', targetRefName: 'refs/heads/main', repository: { id: 'repo-1', name: 'fabrikam-shop' },
    reviewers: [{ ...ME, vote: 0, isRequired: true }], lastMergeSourceCommit: { commitId: `c${id}` },
  };
}

function approval(id: string): Approval {
  return {
    id, status: 'pending', createdOn: new Date(START - 6 * HOUR).toISOString(), minRequiredApprovers: 1,
    steps: [{ assignedApprover: ME, status: 'pending' }], pipeline: { id: 7, name: 'Release Web', owner: { id: 114, name: '2026.114' } },
  };
}

function build(id: number): Build {
  return {
    id, buildNumber: `2026.${id}`, status: 'completed', result: 'failed', definition: { id: 7, name: 'Web Shop CI' },
    sourceBranch: 'refs/heads/main', finishTime: new Date(START - 40 * MINUTE).toISOString(),
  };
}

function workItem(id: number, project: string, state = 'Active', iteration = `${project}\\Sprint 1`): WorkItem {
  return {
    id, rev: 1,
    fields: {
      'System.Title': `Task ${id}`, 'System.State': state, 'System.WorkItemType': 'Bug', 'System.TeamProject': project,
      'System.IterationPath': iteration, 'System.ChangedDate': new Date(START - HOUR).toISOString(), 'Microsoft.VSTS.Common.Priority': 1,
    },
  };
}

type Handler = (...a: any[]) => unknown;
type Overrides = Partial<Record<keyof MyDayClient, Handler>>;

interface Harness {
  service: MyDayService;
  calls: string[];
  count(prefix: string): number;
  state: { now: number; focused: boolean; refresh: number; throttledUntil: number; projects: string[]; me: Handler; states: Handler };
  overrides: Record<string, Overrides>;
  store: Map<string, unknown>;
  defers: MyDayDefers;
  events: MyDayResult[];
  advance(ms: number): Promise<void>;
}

function setup(): Harness {
  const calls: string[] = [];
  const overrides: Record<string, Overrides> = {};
  const state = {
    now: START, focused: true, refresh: 60, throttledUntil: 0, projects: [SHOP],
    me: (async () => ME) as Handler,
    states: (async (): Promise<WorkItemState[]> => [{ name: 'Active', color: 'f00', category: 'InProgress' }, { name: 'Closed', color: '0f0', category: 'Completed' }]) as Handler,
  };
  const defaults = (project: string): Record<keyof MyDayClient, Handler> => ({
    listPullRequests: async () => [pr(project === SHOP ? 1 : 2)],
    listPendingApprovals: async () => [approval(`ap-${project}`)],
    listBuildsSince: async () => [build(project === SHOP ? 10 : 20)],
    queryWiql: async () => (project === SHOP ? [101] : [202]),
    getWorkItems: async (ids: number[]) => ids.map(id => workItem(id, id === 101 ? SHOP : WEB)),
    listIterationDates: async (): Promise<ClassificationIteration[]> => [{ path: `${project}\\Sprint 1`, finishDate: new Date(START + 24 * HOUR).toISOString() }],
  });
  const clientFor = (project: string): MyDayClient => {
    const wrap = (name: keyof MyDayClient) => (...args: unknown[]) => {
      calls.push(`${name}:${project}`);
      const fn = overrides[project]?.[name] ?? defaults(project)[name];
      return Promise.resolve().then(() => fn(...args));
    };
    return {
      listPullRequests: wrap('listPullRequests'), listPendingApprovals: wrap('listPendingApprovals'), listBuildsSince: wrap('listBuildsSince'),
      queryWiql: wrap('queryWiql'), getWorkItems: wrap('getWorkItems'), listIterationDates: wrap('listIterationDates'),
    } as MyDayClient;
  };
  const deps: MyDayDeps = {
    getMe: () => state.me() as Promise<IdentityRef>,
    clientFor,
    projects: () => state.projects,
    statesFor: (...a) => state.states(...a) as Promise<WorkItemState[]>,
    assignedWiql: () => 'SELECT [System.Id] FROM WorkItems',
    importantBranches: () => ['main'],
    refreshSeconds: () => state.refresh,
    isFocused: () => state.focused,
    throttledUntil: () => state.throttledUntil,
    now: () => state.now,
  };
  const store = new Map<string, unknown>();
  const memento = { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => { store.set(k, v); } };
  const defers = new MyDayDefers(memento as any, () => 'https://dev.azure.com/contoso');
  const service = new MyDayService(deps, defers);
  const events: MyDayResult[] = [];
  service.onDidChange(r => events.push(r));
  const h: Harness = {
    service, calls, state, overrides, store, defers, events,
    count: prefix => calls.filter(c => c.startsWith(prefix)).length,
    advance: async ms => {
      state.now += ms;
      mock.timers.tick(ms);
      await flush();
    },
  };
  return h;
}

let current: MyDayService | undefined;
function make(): Harness {
  mock.timers.enable({ apis: ['setInterval'] });
  const h = setup();
  current = h.service;
  return h;
}

afterEach(() => {
  current?.dispose();
  current = undefined;
  mock.timers.reset();
});

const REQUESTS = ['listPullRequests', 'listPendingApprovals', 'listBuildsSince', 'queryWiql', 'getWorkItems', 'listIterationDates'];
const total = (h: Harness): number => h.calls.length;
const authError = (): AdoError => new AdoError('Sign in again', 401, true);

describe('MyDayService loading', () => {
  it('sends no request before get or start', async () => {
    const h = make();
    h.service.setVisible(true);
    h.service.invalidate();
    h.state.now += HOUR;
    mock.timers.tick(HOUR);
    await flush();
    assert.equal(total(h), 0);
  });

  it('loads the sources of one project within the budget and ranks the result', async () => {
    const h = make();
    const r = await h.service.get();
    assert.deepEqual(h.calls.toSorted((a, b) => a.localeCompare(b)), [
      'getWorkItems:Fabrikam Shop', 'listBuildsSince:Fabrikam Shop', 'listIterationDates:Fabrikam Shop',
      'listPendingApprovals:Fabrikam Shop', 'listPullRequests:Fabrikam Shop', 'queryWiql:Fabrikam Shop',
    ]);
    assert.deepEqual(r.items.map(i => i.source).toSorted((a, b) => a.localeCompare(b)), ['approvals', 'reviews', 'runs', 'workItems']);
    assert.equal(r.items[0].source, 'approvals');
    assert.equal(r.count, r.items.filter(i => i.tier !== 'later').length);
    assert.equal(r.multi, false);
    assert.equal(r.loadedAt, START);
    assert.deepEqual(r.failures, []);
    assert.ok(r.items.find(i => i.source === 'workItems')?.reasons.some(x => x.rule === 'W4'));
    assert.equal(h.service.itemByKey(r.items[0].key)?.key, r.items[0].key);
    assert.equal(h.service.itemByKey('nope'), undefined);
  });

  it('uses one WIQL per project and one shared getWorkItems for several projects', async () => {
    const h = make();
    h.state.projects = [SHOP, WEB];
    const r = await h.service.get();
    assert.equal(h.count('queryWiql'), 2);
    assert.equal(h.count('getWorkItems'), 1);
    assert.equal(h.count('getWorkItems:Fabrikam Shop'), 1);
    assert.equal(h.count('listPullRequests'), 2);
    assert.equal(r.multi, true);
    assert.deepEqual(r.items.filter(i => i.source === 'workItems').map(i => i.project).toSorted((a, b) => a.localeCompare(b)), [WEB, SHOP]);
    assert.ok(REQUESTS.every(n => h.count(n) > 0));
  });

  it('shares one flight between concurrent calls', async () => {
    const h = make();
    const [a, b] = await Promise.all([h.service.get(), h.service.get()]);
    assert.equal(h.count('listPullRequests'), 1);
    assert.equal(a.items.length, b.items.length);
  });

  it('a click on Refresh that joins a running flight loads the projects the flight did not cover', async () => {
    const h = make();
    h.state.projects = [SHOP, WEB];
    h.overrides[WEB] = { listPullRequests: async () => { throw new AdoError('No access', 403); } };
    await h.service.get();
    assert.equal(h.count('listPullRequests:Contoso Web'), 1);
    h.state.now += 6 * MINUTE; // everything is due again, but Contoso Web reviews are in the 403 backoff
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    h.overrides[SHOP] = { listPullRequests: async () => { await gate; return [pr(1)]; } };
    const timer = h.service.get(); // the flight for reviews covers Fabrikam Shop only
    await flush();
    let refreshed = false;
    h.overrides[WEB] = { listPullRequests: async () => [pr(2)] }; // the backoff is over on the server side
    const click = h.service.get({ user: true }).then(r => { refreshed = true; return r; });
    await flush();
    assert.equal(refreshed, false, 'the click waits for the joined flight');
    release();
    const [, clicked] = await Promise.all([timer, click]);
    assert.equal(h.count('listPullRequests:Contoso Web'), 2, 'the project in backoff was loaded for the click');
    assert.equal(h.count('listPullRequests:Fabrikam Shop'), 2, 'and the covered one only once more, not again');
    assert.deepEqual(clicked.failures.filter(f => f.source === 'reviews'), []);
    assert.ok(clicked.items.some(i => i.key.includes('2')), 'with its data');
  });

  it('caps the work item ids at 200', async () => {
    const h = make();
    h.overrides[SHOP] = { queryWiql: async () => Array.from({ length: 300 }, (_, i) => i + 1) };
    let asked: number[] = [];
    h.overrides[SHOP].getWorkItems = async (ids: number[]) => { asked = ids; return []; };
    await h.service.get();
    assert.equal(asked.length, 200);
  });

  it('reports a failed state lookup as a failed work item source instead of listing items without a category', async () => {
    const h = make();
    h.overrides[SHOP] = { getWorkItems: async () => [workItem(101, SHOP, 'Closed')] };
    h.state.states = async () => { throw new Error('boom'); };
    const r = await h.service.get();
    assert.equal(r.items.filter(i => i.source === 'workItems').length, 0, 'a completed item is not shown as if it were open');
    assert.deepEqual(r.failures.filter(f => f.source === 'workItems').map(f => f.message), ['boom']);
    h.state.states = async () => [{ name: 'Active', color: 'f00', category: 'InProgress' }, { name: 'Closed', color: '0f0', category: 'Completed' }];
    const again = await h.service.get({ force: true });
    assert.equal(again.items.filter(i => i.source === 'workItems').length, 0, 'now it is known to be completed');
    assert.deepEqual(again.failures, []);
  });

  it('drops completed work items by their state category', async () => {
    const h = make();
    h.overrides[SHOP] = { getWorkItems: async () => [workItem(101, SHOP, 'Closed')] };
    const r = await h.service.get();
    assert.equal(r.items.filter(i => i.source === 'workItems').length, 0);
  });

  it('a failing iteration list only drops rule W4', async () => {
    const h = make();
    h.overrides[SHOP] = { listIterationDates: async () => { throw new Error('no'); } };
    const r = await h.service.get();
    const wi = r.items.find(i => i.source === 'workItems');
    assert.ok(wi);
    assert.ok(!wi.reasons.some(x => x.rule === 'W4'));
    assert.deepEqual(r.failures, []);
  });

  it('matches the iteration and the defers by project name without regard to case', async () => {
    const h = make();
    h.state.projects = ['fabrikam shop'];
    h.overrides['fabrikam shop'] = {
      getWorkItems: async (ids: number[]) => ids.map(id => workItem(id, SHOP)),
      listIterationDates: async () => [{ path: `${SHOP}\\sprint 1`, finishDate: new Date(START + 24 * HOUR).toISOString() }],
    };
    const r = await h.service.get();
    const wi = r.items.find(i => i.source === 'workItems')!;
    assert.ok(wi.reasons.some(x => x.rule === 'W4'), 'sprint end found although the spelling differs');
    // An old defer of that project is garbage collected: its source counts as loaded.
    await h.defers.set('wi:999', { kind: 'hide', fingerprint: 'x', seenAt: START - 40 * 24 * HOUR, title: 'Old', source: 'workItems', project: SHOP });
    await h.service.get({ force: true });
    await flush();
    assert.equal(h.defers.get('wi:999'), undefined);
  });

  it('asks for the iterations once per hour', async () => {
    const h = make();
    await h.service.get();
    await h.service.get({ force: true });
    assert.equal(h.count('listIterationDates'), 1);
    h.state.now += HOUR;
    await h.service.get({ force: true });
    assert.equal(h.count('listIterationDates'), 2);
  });

  it('rejects when getMe fails', async () => {
    const h = make();
    h.state.me = async () => { throw new Error('offline'); };
    await assert.rejects(h.service.get(), /offline/);
    assert.equal(total(h), 0);
  });
});

describe('MyDayService timing', () => {
  it('reloads reviews, approvals and runs after max(60 s, refresh) when visible and focused', async () => {
    const h = make();
    h.service.setVisible(true);
    await h.service.get();
    h.state.now += 59 * SECOND;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 1);
    h.state.now += 2 * SECOND;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 2);
    assert.equal(h.count('queryWiql'), 1);
  });

  it('honours a longer refresh interval', async () => {
    const h = make();
    h.state.refresh = 120;
    h.service.setVisible(true);
    await h.service.get();
    h.state.now += 90 * SECOND;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 1);
    h.state.now += 31 * SECOND;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 2);
  });

  it('uses 5 minutes when the view is hidden, and for work items always', async () => {
    const h = make();
    await h.service.get();
    h.state.now += 4 * MINUTE;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 1);
    h.state.now += 2 * MINUTE;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 2);
    assert.equal(h.count('queryWiql'), 2);
    h.service.setVisible(true);
    h.state.now += 2 * MINUTE;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 3);
    assert.equal(h.count('queryWiql'), 2);
  });

  it('never polls more often hidden or for work items than visible with a long refresh interval', async () => {
    const h = make();
    h.state.refresh = 600;
    h.service.setVisible(true);
    await h.service.get();
    h.service.setVisible(false);
    h.state.now += 301 * SECOND;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 1, 'hidden: not after the 5 minute default, the setting wins');
    assert.equal(h.count('queryWiql'), 1, 'work items follow the setting too');
    h.state.now += 300 * SECOND;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 2);
    assert.equal(h.count('queryWiql'), 2);
  });

  it('with refresh 0 loads only first, on invalidate and on force', async () => {
    const h = make();
    h.state.refresh = 0;
    h.service.setVisible(true);
    await h.service.get();
    h.state.now += HOUR;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 1);
    h.service.invalidate();
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 2);
    await h.service.get({ force: true });
    assert.equal(h.count('listPullRequests'), 3);
  });

  it('invalidate marks sources due without requests', async () => {
    const h = make();
    await h.service.get();
    h.service.invalidate();
    assert.equal(total(h), 6);
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 2);
    assert.equal(h.count('queryWiql'), 2);
  });

  it('without focus get() serves data, except first load and force', async () => {
    const h = make();
    h.state.focused = false;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 1);
    h.state.now += HOUR;
    const r = await h.service.get();
    assert.equal(h.count('listPullRequests'), 1);
    assert.ok(r.items.length > 0);
    await h.service.get({ force: true });
    assert.equal(h.count('listPullRequests'), 2);
  });

  it('the timer does nothing without focus and catches up when focus returns', async () => {
    const h = make();
    h.service.setVisible(true);
    h.service.start();
    h.service.start();
    h.state.focused = false;
    await h.advance(15 * SECOND);
    assert.equal(total(h), 0);
    h.state.focused = true;
    await h.advance(15 * SECOND);
    assert.equal(h.count('listPullRequests'), 1);
    await h.advance(15 * SECOND);
    assert.equal(h.count('listPullRequests'), 1);
    await h.advance(MINUTE);
    assert.ok(h.count('listPullRequests') >= 2);
  });

  it('a tick right after the view becomes visible loads what is due', async () => {
    const h = make();
    h.service.start();
    h.service.setVisible(true);
    await flush();
    assert.equal(h.count('listPullRequests'), 1);
    h.service.setVisible(true);
    h.service.setVisible(false);
    h.service.setVisible(true);
    await flush();
    assert.equal(h.count('listPullRequests'), 1);
  });

  it('fires onDidChange from the timer only when the result differs', async () => {
    const h = make();
    h.service.setVisible(true);
    await h.service.get();
    h.service.start();
    await h.advance(15 * SECOND);
    assert.equal(h.events.length, 0);
    h.overrides[SHOP] = { listPullRequests: async () => [pr(1), pr(3)] };
    await h.advance(MINUTE);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].items.filter(i => i.source === 'reviews').length, 2);
    await h.advance(15 * SECOND);
    assert.equal(h.events.length, 1);
  });

  it('a listener that throws does not leave an unhandled rejection in the timer', async () => {
    const h = make();
    h.service.onDidChange(() => { throw new Error('listener'); });
    const seen: unknown[] = [];
    const onReject = (e: unknown): void => { seen.push(e); };
    process.on('unhandledRejection', onReject);
    try {
      h.service.start();
      await h.advance(15 * SECOND);
      await flush();
    } finally {
      process.off('unhandledRejection', onReject);
    }
    assert.deepEqual(seen, []);
  });

  it('a failing getMe in the timer is ignored', async () => {
    const h = make();
    h.state.me = async () => { throw new Error('offline'); };
    h.service.start();
    await h.advance(15 * SECOND);
    assert.equal(h.events.length, 0);
  });

  it('dispose stops the timer', async () => {
    const h = make();
    h.service.start();
    h.service.dispose();
    await h.advance(HOUR);
    assert.equal(total(h), 0);
    h.service.start();
    await h.advance(HOUR);
    assert.equal(total(h), 0);
  });
});

describe('MyDayService failures', () => {
  it('keeps the last good data of a failed source with staleSince and recovers', async () => {
    const h = make();
    h.service.setVisible(true);
    await h.service.get();
    h.overrides[SHOP] = { listPullRequests: async () => { throw new Error('TF400 down'); } };
    h.state.now += 2 * MINUTE;
    const r = await h.service.get();
    const review = r.items.find(i => i.source === 'reviews');
    assert.equal(review?.staleSince, START);
    assert.deepEqual(r.failures, [{ source: 'reviews', project: SHOP, message: 'TF400 down', kind: 'other', staleSince: START }]);
    assert.ok(r.items.find(i => i.source === 'runs') && r.items.find(i => i.source === 'runs')?.staleSince === undefined);
    h.overrides[SHOP] = {};
    h.state.now += 2 * MINUTE;
    const ok = await h.service.get();
    assert.deepEqual(ok.failures, []);
    assert.equal(ok.items.find(i => i.source === 'reviews')?.staleSince, undefined);
  });

  it('fails per project and keeps the other project', async () => {
    const h = make();
    h.state.projects = [SHOP, WEB];
    h.overrides[WEB] = { listPendingApprovals: async () => { throw new AdoError('Rate', 429); } };
    const r = await h.service.get();
    assert.equal(r.failures.length, 1);
    assert.deepEqual([r.failures[0].project, r.failures[0].source, r.failures[0].kind, r.failures[0].staleSince], [WEB, 'approvals', 'throttled', undefined]);
    assert.equal(r.items.filter(i => i.source === 'approvals').length, 1);
  });

  it('records work item failures from WIQL and from the shared fetch', async () => {
    const h = make();
    h.state.projects = [SHOP, WEB];
    h.overrides[WEB] = { queryWiql: async () => { throw new Error('wiql'); } };
    let r = await h.service.get();
    assert.deepEqual(r.failures.map(f => [f.source, f.project]), [['workItems', WEB]]);
    assert.equal(r.items.filter(i => i.source === 'workItems').length, 1);
    h.overrides[WEB] = {};
    h.overrides[SHOP] = { getWorkItems: async () => { throw new Error('fetch'); } };
    r = await h.service.get({ force: true });
    assert.deepEqual(r.failures.map(f => f.project).toSorted((a, b) => a.localeCompare(b)), [WEB, SHOP]);
  });

  it('rejects with the auth error when every source failed with auth and nothing is loaded', async () => {
    const h = make();
    for (const n of ['listPullRequests', 'listPendingApprovals', 'listBuildsSince', 'queryWiql'] as const) {
      h.overrides[SHOP] = { ...h.overrides[SHOP], [n]: async () => { throw authError(); } };
    }
    await assert.rejects(h.service.get(), (e: unknown) => e instanceof AdoError && e.isAuthError);
  });

  it('does not reject when only some sources fail with auth', async () => {
    const h = make();
    h.overrides[SHOP] = { listPullRequests: async () => { throw authError(); } };
    const r = await h.service.get();
    assert.equal(r.failures[0].kind, 'auth');
    assert.ok(r.items.length > 0);
  });

  it('retries a forbidden source only after 30 minutes, also on invalidate, but on force', async () => {
    const h = make();
    h.service.setVisible(true);
    h.overrides[SHOP] = { listBuildsSince: async () => { throw new AdoError('No access', 403); } };
    let r = await h.service.get();
    assert.equal(r.failures[0].kind, 'forbidden');
    h.service.invalidate();
    h.state.now += 10 * MINUTE;
    await h.service.get();
    assert.equal(h.count('listBuildsSince'), 1);
    assert.equal(h.count('listPullRequests'), 2);
    h.state.now += 21 * MINUTE;
    await h.service.get();
    assert.equal(h.count('listBuildsSince'), 2);
    await h.service.get({ force: true });
    assert.equal(h.count('listBuildsSince'), 2, 'a reload after a change does not skip the 403 backoff');
    h.overrides[SHOP] = {};
    await h.service.get({ user: true });
    assert.equal(h.count('listBuildsSince'), 3, 'a click on Refresh or Retry does');
    r = await h.service.get();
    assert.deepEqual(r.failures, []);
  });

  it('makes no background request while throttled, loads on a direct user action, and resumes after', async () => {
    const h = make();
    h.service.setVisible(true);
    await h.service.get();
    h.state.throttledUntil = START + 5 * MINUTE;
    h.state.now += 2 * MINUTE;
    const r = await h.service.get();
    assert.equal(total(h), 6);
    assert.deepEqual(r.failures, []);
    h.service.start();
    await h.advance(15 * SECOND);
    assert.equal(total(h), 6, 'the timer honours the pause');
    await h.service.get({ force: true });
    assert.equal(h.count('listPullRequests'), 1, 'a reload after a change honours the pause');
    const forced = await h.service.get({ user: true });
    assert.equal(h.count('listPullRequests'), 2, 'Retry is a user action: not blocked');
    assert.deepEqual(forced.failures, []);
    h.state.now = START + 6 * MINUTE;
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 3);
  });

  it('a reload after the user\'s own change loads during a pause and drops the answered approval', async () => {
    const h = make();
    await h.service.get();
    h.state.throttledUntil = START + 5 * MINUTE;
    h.state.now += 2 * MINUTE;
    h.overrides[SHOP] = { listPendingApprovals: async () => [] };
    h.service.invalidate(true);
    const r = await h.service.get({ force: true });
    assert.equal(h.count('listPendingApprovals'), 2);
    assert.ok(!r.items.some(i => i.source === 'approvals'));
  });

  it('a forced reload does not load a source twice when another source is blocked after a 403', async () => {
    const h = make();
    h.overrides[SHOP] = { listBuildsSince: async () => { throw new AdoError('No access', 403); } };
    await h.service.get();
    h.service.invalidate();
    const before = h.calls.length;
    await h.service.get({ force: true });
    const added = h.calls.slice(before);
    for (const name of ['listPullRequests', 'listPendingApprovals', 'queryWiql']) {
      assert.equal(added.filter(c => c.startsWith(name)).length, 1, name);
    }
    assert.equal(added.filter(c => c.startsWith('listBuildsSince')).length, 0);
  });

  it('get while throttled before any load says the sources are not loaded, and Retry loads them', async () => {
    const h = make();
    h.state.throttledUntil = START + MINUTE;
    const r = await h.service.get();
    assert.equal(total(h), 0);
    assert.deepEqual(r.items, []);
    assert.equal(r.failures.length, 4, 'one per source: the page must not say "all done"');
    assert.ok(r.failures.every(f => f.kind === 'throttled' && f.project === SHOP));
    assert.equal(total(h), 0);
    await h.service.get({ force: true });
    assert.equal(total(h), 0, 'a reload after a change does not break the pause');
    const retried = await h.service.get({ user: true });
    assert.ok(retried.items.length > 0);
    assert.deepEqual(retried.failures, []);
  });

  it('stop ends the polling until start is called again', async () => {
    const h = make();
    h.service.start();
    h.service.stop();
    await h.advance(60 * SECOND);
    assert.equal(total(h), 0);
    h.service.start();
    await h.advance(15 * SECOND);
    assert.ok(total(h) > 0);
  });

  it('a pause that ends clears the notice on the next tick', async () => {
    const h = make();
    h.state.throttledUntil = START + MINUTE;
    await h.service.get();
    h.service.start();
    h.state.now = START + 2 * MINUTE;
    await h.advance(15 * SECOND);
    assert.ok(h.events.at(-1)!.items.length > 0);
    assert.deepEqual(h.events.at(-1)!.failures, []);
  });
});

describe('MyDayService defers', () => {
  it('apply hides an item without requests, restores it and fires', async () => {
    const h = make();
    const r = await h.service.get();
    const review = r.items.find(i => i.source === 'reviews');
    assert.ok(review);
    const before = total(h);
    await h.service.applyDefer(review, 'snooze', START + 2 * HOUR);
    assert.equal(total(h), before);
    assert.equal(h.events.length, 1);
    assert.ok(!h.events[0].items.some(i => i.key === review.key));
    assert.equal(h.events[0].count, r.count - 1);
    assert.deepEqual(h.events[0].deferred.map(d => [d.key, d.kind, d.until, d.project]), [[review.key, 'snooze', START + 2 * HOUR, SHOP]]);
    assert.equal(h.defers.get(review.key)?.fingerprint, review.fingerprint);
    await h.service.restore(review.key);
    assert.equal(h.events.length, 2);
    assert.ok(h.events[1].items.some(i => i.key === review.key));
    assert.deepEqual(h.events[1].deferred, []);
  });

  it('restore ignores non-strings and unknown keys', async () => {
    const h = make();
    await h.service.get();
    await h.service.restore(42);
    await h.service.restore('pr:nope:1');
    assert.equal(h.events.length, 0);
  });

  it('an expired snooze returns on a tick with no request', async () => {
    const h = make();
    h.state.refresh = 0;
    const r = await h.service.get();
    const run = r.items.find(i => i.source === 'runs');
    assert.ok(run);
    await h.service.applyDefer(run, 'snooze', START + 20 * SECOND);
    h.service.start();
    const before = total(h);
    await h.advance(15 * SECOND);
    assert.equal(h.events.length, 1);
    await h.advance(15 * SECOND);
    assert.equal(h.events.length, 2);
    assert.ok(h.events[1].items.some(i => i.key === run.key));
    assert.equal(total(h), before);
  });

  it('lists hide and done entries that are no longer seen, but not unseen snoozes', async () => {
    const h = make();
    const base = { fingerprint: 'x', seenAt: START, source: 'runs' as const, project: SHOP };
    await h.defers.set('run:Fabrikam Shop:99', { ...base, kind: 'hide', title: 'Old run' });
    await h.defers.set('run:Fabrikam Shop:98', { ...base, kind: 'done', title: 'Done run' });
    await h.defers.set('run:Fabrikam Shop:97', { ...base, kind: 'snooze', until: START + HOUR, title: 'Gone' });
    const r = await h.service.get();
    assert.deepEqual(r.deferred.map(d => d.title).toSorted((a, b) => a.localeCompare(b)), ['Done run', 'Old run']);
    await flush();
    assert.equal(Object.keys(h.defers.all()).length, 3, 'nothing is deleted because an item is not listed');
  });

  it('asks for the iteration dates again after a failure, and not again within the hour after success', async () => {
    const h = make();
    let fail = true;
    h.overrides[SHOP] = { listIterationDates: async () => { if (fail) { throw new Error('down'); } return []; } };
    await h.service.get();
    assert.equal(h.count('listIterationDates'), 1);
    fail = false;
    await h.service.get({ force: true });
    assert.equal(h.count('listIterationDates'), 2, 'a failure is not remembered');
    await h.service.get({ force: true });
    assert.equal(h.count('listIterationDates'), 2, 'a success is');
  });

  it('forgets a done entry once its item changed, so it does not come back under Deferred when the item is gone', async () => {
    const h = make();
    const r = await h.service.get();
    const review = r.items.find(i => i.source === 'reviews')!;
    await h.service.applyDefer(review, 'done');
    // The pull request gets a new commit: it shows up again.
    h.overrides[SHOP] = { listPullRequests: async () => [{ ...pr(1), lastMergeSourceCommit: { commitId: 'new' } }] };
    const back = await h.service.get({ force: true });
    assert.ok(back.items.some(i => i.key === review.key));
    await flush();
    assert.equal(h.defers.get(review.key), undefined, 'the stale entry is dropped');
    // Later the pull request is merged and leaves the list.
    h.overrides[SHOP] = { listPullRequests: async () => [] };
    const gone = await h.service.get({ force: true });
    assert.ok(!gone.deferred.some(d => d.key === review.key));
  });

  it('keeps a done entry whose item is unchanged', async () => {
    const h = make();
    const r = await h.service.get();
    const review = r.items.find(i => i.source === 'reviews')!;
    await h.service.applyDefer(review, 'done');
    await h.service.get({ force: true });
    await flush();
    assert.ok(h.defers.get(review.key));
  });

  it('marks listed deferred items as seen after a load', async () => {
    const h = make();
    const r = await h.service.get();
    const run = r.items.find(i => i.source === 'runs');
    assert.ok(run);
    await h.defers.set(run.key, { kind: 'hide', fingerprint: run.fingerprint, seenAt: START - 2 * HOUR, title: run.title, source: 'runs', project: SHOP });
    await h.service.get({ force: true });
    await flush();
    assert.equal(h.defers.get(run.key)?.seenAt, START);
  });

  it('prunes old entries of loaded sources, but not of failed ones', async () => {
    const h = make();
    h.overrides[SHOP] = { listPendingApprovals: async () => { throw new Error('down'); } };
    const old = START - 40 * 24 * HOUR;
    const base = { kind: 'hide' as const, fingerprint: 'x', seenAt: old, project: SHOP, title: 't' };
    await h.defers.set('run:Fabrikam Shop:1', { ...base, source: 'runs' });
    await h.defers.set('approval:a', { ...base, source: 'approvals' });
    await h.service.get();
    await flush();
    assert.deepEqual(Object.keys(h.defers.all()), ['approval:a']);
  });

  it('survives failing defer storage', async () => {
    const h = make();
    h.defers.markSeen = async () => { throw new Error('disk'); };
    h.defers.prune = async () => { throw new Error('disk'); };
    const r = await h.service.get();
    await flush();
    assert.ok(r.items.length > 0);
  });
});

describe('MyDayService reset and raw lists', () => {
  it('numbers its results by reset so the page can tell a new account from an older answer', async () => {
    const h = make();
    const first = await h.service.get();
    h.service.reset();
    const second = await h.service.get();
    assert.equal(second.generation, first.generation + 1);
  });

  it('reset drops data and ignores a late answer', async () => {
    const h = make();
    let release: (v: PullRequest[]) => void = (_v: PullRequest[]) => undefined;
    h.overrides[SHOP] = { listPullRequests: () => new Promise<PullRequest[]>(r => { release = r; }) };
    const pending = h.service.get();
    await flush();
    h.service.reset();
    release([pr(1)]);
    await flush();
    const events = h.events.length;
    // The answer of the old generation was dropped: the call starts over instead of claiming that nothing is waiting.
    release([pr(2)]);
    const r = await pending;
    assert.deepEqual(r.items.filter(i => i.source === 'reviews').map(i => i.key.split(':').at(-1)), ['2']);
    assert.equal(h.events.length, events);
    h.overrides[SHOP] = {};
    const again = await h.service.get();
    assert.ok(again.items.some(i => i.source === 'reviews'));
  });

  it('rawReviews and rawApprovals share the load for 30 seconds and feed My Day', async () => {
    const h = make();
    h.state.projects = [SHOP, WEB];
    const reviews = await h.service.rawReviews(SHOP);
    assert.equal(reviews[0].pullRequestId, 1);
    assert.equal((await h.service.rawReviews(WEB))[0].pullRequestId, 2);
    assert.equal(h.count('listPullRequests'), 2);
    assert.equal((await h.service.rawApprovals(SHOP))[0].id, 'ap-Fabrikam Shop');
    assert.equal(h.count('listPendingApprovals'), 2);
    h.state.now += 20 * SECOND;
    await h.service.rawReviews(SHOP);
    assert.equal(h.count('listPullRequests'), 2);
    const r = await h.service.get();
    assert.equal(h.count('listPullRequests'), 2);
    assert.equal(r.items.filter(i => i.source === 'reviews').length, 2);
    h.state.now += 20 * SECOND;
    await h.service.rawReviews(SHOP);
    assert.equal(h.count('listPullRequests'), 4);
  });

  it('raw lists reject on errors and record them', async () => {
    const h = make();
    h.overrides[SHOP] = { listPullRequests: async () => { throw new AdoError('Nope', 403); } };
    await assert.rejects(h.service.rawReviews(SHOP), /Nope/);
    const r = await h.service.get();
    assert.equal(r.failures[0].kind, 'forbidden');
    assert.deepEqual(await h.service.rawReviews('Unknown'), []);
  });

  it('raw lists load during a pause only for a click, and say "not loaded" instead of an empty list', async () => {
    const h = make();
    h.state.throttledUntil = START + HOUR;
    await assert.rejects(h.service.rawApprovals(SHOP), (e: unknown) => e instanceof AdoError && e.status === 429);
    assert.equal(h.count('listPendingApprovals'), 0, 'a tab that is merely open does not request');
    assert.equal((await h.service.rawApprovals(SHOP, { user: true })).length, 1);
    assert.equal(h.count('listPendingApprovals'), 1);
    h.overrides[SHOP] = { listPendingApprovals: async () => { throw new AdoError('Too many', 429); } };
    h.state.now += MINUTE;
    await assert.rejects(h.service.rawApprovals(SHOP, { user: true }), (e: unknown) => e instanceof AdoError && e.status === 429);
  });

  it('raw lists reload on force although they are fresh', async () => {
    const h = make();
    await h.service.rawReviews(SHOP);
    h.state.now += 5 * SECOND;
    await h.service.rawReviews(SHOP);
    assert.equal(h.count('listPullRequests'), 1);
    await h.service.rawReviews(SHOP, { force: true });
    assert.equal(h.count('listPullRequests'), 2);
  });

  it('raw lists do not serve a cached list after invalidate', async () => {
    const h = make();
    assert.equal((await h.service.rawApprovals(SHOP)).length, 1);
    h.overrides[SHOP] = { listPendingApprovals: async () => [] };
    h.state.now += 5 * SECOND;
    assert.equal((await h.service.rawApprovals(SHOP)).length, 1, 'still cached');
    h.service.invalidate();
    assert.equal((await h.service.rawApprovals(SHOP)).length, 0, 'the answered approval is gone');
    assert.equal(h.count('listPendingApprovals'), 2);
  });

  it('reset while getMe is pending starts over in the new generation', async () => {
    const h = make();
    let release: (v: IdentityRef) => void = (_v: IdentityRef) => undefined;
    h.state.me = () => new Promise<IdentityRef>(r => { release = r; });
    const first = h.service.get();
    await flush();
    h.service.reset();
    h.state.me = async () => ME;
    release(ME);
    const r = await first;
    assert.ok(r.items.some(i => i.source === 'reviews'), 'the stale call loads in the new generation');
    const again = await h.service.get();
    assert.ok(again.items.some(i => i.source === 'reviews'), 'and later callers see the data');
    assert.equal(h.count('listPullRequests'), 1);
  });

  it('get with force reloads when a change came in while it joined a running load', async () => {
    const h = make();
    let release: (v: PullRequest[]) => void = (_v: PullRequest[]) => undefined;
    h.overrides[SHOP] = { listPullRequests: () => new Promise<PullRequest[]>(r => { release = r; }) };
    const first = h.service.get();
    await flush();
    h.overrides[SHOP] = { listPullRequests: async () => [] };
    const forced = h.service.get({ force: true }); // the user acted: the answered PR is gone on the server
    h.service.invalidate();
    release([pr(1)]);
    await first;
    const r = await forced;
    assert.ok(!r.items.some(i => i.source === 'reviews'), 'the answered item does not stay until the next tick');
  });

  it('an invalidate during a flight keeps the slot due', async () => {
    const h = make();
    let release: (v: PullRequest[]) => void = (_v: PullRequest[]) => undefined;
    h.overrides[SHOP] = { listPullRequests: () => new Promise<PullRequest[]>(r => { release = r; }) };
    const pending = h.service.get();
    await flush();
    h.service.invalidate();
    release([pr(1)]);
    await pending;
    h.overrides[SHOP] = {};
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 2, 'the answer predates the invalidation');
    await h.service.get();
    assert.equal(h.count('listPullRequests'), 2, 'and a later load clears it');
  });
});
