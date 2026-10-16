import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { fakeDoc, fakeRepo, fire, resetExtras, setGitRepositories } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { AdoClient } from '../client';
import { ConnectionManager } from '../connection';
import { PrStatusBar } from '../pullRequests/prStatusBar';
import { Build, PolicyEvaluation, PullRequest } from '../types';

const REMOTE = 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/web-shop';
const flush = () => new Promise(r => setImmediate(r));

function evaluation(status: string, blocking = true): PolicyEvaluation {
  return { evaluationId: status, status, configuration: { isEnabled: true, isBlocking: blocking, type: { id: 't', displayName: 'Build' } } };
}

function pr(opts: Partial<PullRequest> = {}): PullRequest {
  return {
    pullRequestId: 42, title: 'Fix cart [beta]', status: 'active', createdBy: { id: 'l', displayName: 'Lena Hoffmann' }, creationDate: '2026-01-01T00:00:00Z',
    sourceRefName: 'refs/heads/feature/cart', targetRefName: 'refs/heads/main',
    repository: { id: 'r1', name: 'web-shop', project: { id: 'p1', name: 'Fabrikam Shop' } } as PullRequest['repository'],
    reviewers: [{ id: 'm', displayName: 'Marco Rossi', vote: 10 }, { id: 'a', displayName: 'Alex Morgan', vote: 0 }], ...opts,
  };
}

function build(opts: Partial<Build> = {}): Build {
  return { id: 900, buildNumber: '2026.7', status: 'completed', result: 'succeeded', definition: { id: 1, name: 'Contoso CI' }, sourceBranch: 'refs/heads/feature/cart', ...opts } as Build;
}

interface State {
  prs: PullRequest[];
  builds: Build[] | Error;
  evaluations: PolicyEvaluation[] | Error;
  repoError?: Error;
  repoCalls: number;
  projects: (string | undefined)[];
}

function fakeClient(state: State): AdoClient {
  const api = {
    getRepository: async (name: string) => {
      state.repoCalls++;
      if (state.repoError) {
        throw state.repoError;
      }
      return { id: 'r1', name, defaultBranch: 'refs/heads/main', project: { id: 'p1', name: 'Fabrikam Shop' } };
    },
    findPullRequestsForBranch: async () => state.prs,
    listBuilds: async () => {
      if (state.builds instanceof Error) {
        throw state.builds;
      }
      return state.builds;
    },
  };
  return {
    forProject: (p?: string) => { state.projects.push(p); return api; },
    getPolicyEvaluations: async () => {
      if (state.evaluations instanceof Error) {
        throw state.evaluations;
      }
      return state.evaluations;
    },
  } as unknown as AdoClient;
}

describe('PrStatusBar', () => {
  let state: State;
  let connections: ConnectionManager;
  let bar: PrStatusBar;
  let repo: ReturnType<typeof fakeRepo>;

  const item = () => (bar as any).item as { text: string; tooltip: { value: string }; command: { command: string; arguments: unknown[] }; visible: boolean };
  const update = () => (bar as any).update() as Promise<void>;

  beforeEach(() => {
    vscode.reset();
    resetExtras();
    vscode.settings['azureDevOps.refreshInterval'] = 0;
    state = { prs: [], builds: [], evaluations: [], repoCalls: 0, projects: [] };
    repo = fakeRepo('/src/web-shop', REMOTE, 'feature/cart');
    setGitRepositories([repo]);
    connections = new ConnectionManager();
    connections.current = { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false };
    bar = new PrStatusBar(fakeClient(state), connections);
  });
  afterEach(() => {
    bar.dispose();
    mock.timers.reset();
  });

  it('shows the pull request with failing checks, approvals and the latest run', async () => {
    state.prs = [pr({ isDraft: true, autoCompleteSetBy: { id: 'l', displayName: 'Lena Hoffmann' } })];
    state.builds = [build()];
    state.evaluations = [evaluation('rejected'), evaluation('approved')];
    await update();
    const shown = item();
    assert.equal(shown.text, '$(git-pull-request) !42 $(error) $(thumbsup) 1 $(pass)');
    assert.ok(shown.visible);
    assert.equal(shown.tooltip.value, [
      '**!42 Fix cart \\[beta\\]** (draft)',
      '\n\nfeature/cart → main',
      '\n\n1 required check failing',
      '\n\nAuto-complete is set',
      '\n\nLatest run: Contoso CI #2026.7 — succeeded',
      '\n\nClick to open the overview.',
    ].join(''));
    assert.deepEqual(shown.command.arguments, ['r1', 42]);
    assert.equal(shown.command.command, 'azureDevOps.pr.openOverview');
    assert.deepEqual(state.projects, ['Fabrikam Shop']);
  });

  it('shows pending, passed and unknown checks', async () => {
    state.prs = [pr({ reviewers: [] })];
    state.evaluations = [evaluation('running')];
    await update();
    assert.equal(item().text, '$(git-pull-request) !42 $(clock)');
    assert.match(item().tooltip.value, /1 required check pending/);
    state.evaluations = [evaluation('approved')];
    await update();
    assert.equal(item().text, '$(git-pull-request) !42 $(check)');
    assert.match(item().tooltip.value, /All required checks passed/);
    state.evaluations = new Error('forbidden');
    state.builds = new Error('no access');
    await update();
    assert.equal(item().text, '$(git-pull-request) !42');
    state.prs = [pr({ repository: { id: 'r1', name: 'web-shop' } })];
    await update();
    assert.equal(item().text, '$(git-pull-request) !42 $(thumbsup) 1');
  });

  it('offers to create a pull request for a branch without one', async () => {
    state.builds = [build({ status: 'inProgress', result: undefined })];
    await update();
    assert.equal(item().text, '$(git-pull-request-create) Create PR $(sync~spin)');
    assert.match(item().tooltip.value, /^No pull request for \*\*feature\/cart\*\* yet\. Click to create one\.\n\nLatest run: Contoso CI #2026\.7 — inProgress$/);
    assert.deepEqual(item().command.arguments, ['web-shop', 'feature/cart']);
  });

  it('shows only the latest run on the default branch', async () => {
    repo.state.HEAD = { name: 'main' };
    await update();
    assert.ok(!item().visible);
    state.builds = [build({ result: 'canceled' })];
    await update();
    assert.equal(item().text, '$(rocket) $(circle-slash)');
    assert.deepEqual(item().command, { command: 'azureDevOps.pipelines.openRun', title: 'Open run', arguments: [900, 'Fabrikam Shop'] });
    state.builds = [build({ result: 'none' as Build['result'] })];
    await update();
    assert.equal(item().text, '$(rocket) $(circle-outline)');
  });

  it('hides without a repository or branch and retries a failed repository lookup', async () => {
    repo.state.HEAD = undefined;
    await update();
    assert.ok(!item().visible);
    repo.state.HEAD = { name: 'feature/cart' };
    state.repoError = new Error('offline');
    await update();
    assert.ok(!item().visible);
    state.repoError = undefined;
    await update();
    await update();
    assert.equal(state.repoCalls, 2, 'the repository is cached after a successful lookup');
    assert.ok(item().visible);
  });

  it('skips updates while the window is in the background', async () => {
    await update();
    (vscode.window as any).state.focused = false;
    state.prs = [pr()];
    await update();
    assert.match(item().text, /Create PR/);
  });

  it('prefers the repository of the active file', async () => {
    const api = fakeRepo('/src/api', 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/api', 'feature/api');
    setGitRepositories([repo, api]);
    (vscode.window as any).activeTextEditor = { document: fakeDoc(vscode.Uri.file('/src/api/index.ts'), ['']) };
    await update();
    assert.deepEqual(item().command.arguments, ['api', 'feature/api']);
    (vscode.window as any).activeTextEditor = { document: fakeDoc(vscode.Uri.file('/home/fabrikam/notes.md'), ['']) };
    await update();
    assert.deepEqual(item().command.arguments, ['web-shop', 'feature/cart']);
  });

  it('ignores the result of an update overtaken by a newer one', async () => {
    const first = update();
    state.prs = [pr()];
    const second = update();
    await Promise.all([first, second]);
    assert.match(item().text, /!42/);
  });

  it('updates on its timer, on events and after branch switches', async () => {
    bar.dispose();
    mock.timers.enable({ apis: ['setTimeout'] });
    vscode.settings['azureDevOps.refreshInterval'] = 10;
    bar = new PrStatusBar(fakeClient(state), connections);
    mock.timers.tick(2000);
    await flush();
    assert.equal(state.repoCalls, 1);
    assert.match(item().text, /Create PR/);

    state.prs = [pr()];
    mock.timers.tick(30_000);
    await flush();
    await flush();
    assert.match(item().text, /!42/);

    await fire(`repo:/src/web-shop`);
    repo.state.HEAD = { name: 'feature/other' };
    await fire(`repo:/src/web-shop`);
    mock.timers.tick(300);
    await flush();
    await flush();
    assert.match(item().tooltip.value, /feature\/cart → main/);
    assert.deepEqual(item().command.arguments, ['r1', 42]);

    const before = state.repoCalls;
    (connections as any).emitter.fire();
    bar.refresh();
    await fire('activeEditor');
    await fire('windowState', { focused: true });
    await vscode.workspace.getConfiguration('azureDevOps').update('refreshInterval', 10);
    mock.timers.tick(500);
    await flush();
    await flush();
    assert.equal(state.repoCalls, before + 1, 'the repository cache is cleared when the connection changes');
  });
});
