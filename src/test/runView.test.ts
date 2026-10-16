import { afterEach, describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { RunViewPanel } from '../pipelines/runView';
import { cspNonce, flush, lastPanel, panels } from './fakeWebview';
import { answers, executed, messages, opened, prompts, reset, settings, terminals, workspace } from './vscodeStub';

const ORG = 'https://dev.azure.com/contoso';
const PROJECT = 'Fabrikam Shop';
const ext = vscode.Uri.file('/ext');

function build(id: number, status = 'completed'): unknown {
  return {
    id, buildNumber: '20261016.1', status, result: status === 'completed' ? 'succeeded' : undefined,
    definition: { id: 12, name: 'shop-web CI' }, sourceBranch: 'refs/heads/main', sourceVersion: 'abcdef0123456789',
    requestedFor: { displayName: 'Megan Bowen' },
  };
}

const RECORDS = [
  { id: 's1', type: 'Stage', name: 'Build', identifier: 'Build', order: 1, state: 'completed', result: 'succeeded', startTime: '2026-10-16T10:00:00Z', finishTime: '2026-10-16T10:05:00Z' },
  { id: 's2', type: 'Stage', name: 'Deploy', identifier: 'Deploy', order: 2, state: 'pending', startTime: '2026-10-16T10:06:00Z' },
  { id: 'cp', parentId: 's2', type: 'Checkpoint', name: 'Checkpoint', state: 'inProgress' },
  { id: 'ap1', parentId: 'cp', type: 'Checkpoint.Approval', name: 'Approval', state: 'inProgress' },
  { id: 'p1', parentId: 's1', type: 'Phase', name: 'Phase' },
  { id: 'j1', parentId: 'p1', type: 'Job', name: 'Compile', state: 'completed', result: 'succeeded', log: { id: 5 } },
];

const YAML = 'stages:\n- stage: Build\n- stage: Deploy\n  dependsOn: []\n';

type Calls = Record<string, unknown[][]>;

function fakeClient(buildId: number, overrides: Record<string, unknown> = {}): { client: AdoClient; calls: Calls } {
  const calls: Calls = {};
  const rec = (name: string, result: (...a: any[]) => unknown) => (...args: unknown[]) => {
    const list = calls[name] ?? []; calls[name] = list; list.push(args);
    return Promise.resolve().then(() => result(...args));
  };
  const client = {
    connection: { orgUrl: ORG, project: PROJECT },
    getBuild: rec('getBuild', () => build(buildId)),
    getTimeline: rec('getTimeline', () => RECORDS),
    getPipelineRun: rec('getPipelineRun', () => ({ resources: { repositories: { self: { refName: 'refs/heads/main', version: 'abc' } } }, templateParameters: { env: 'test' } })),
    previewPipeline: rec('previewPipeline', () => YAML),
    getDefinition: rec('getDefinition', () => ({ process: { type: 2, yamlFilename: 'azure-pipelines.yml' }, repository: { type: 'TfsGit', id: 'repo-1' } })),
    getFileTextAtCommit: rec('getFileTextAtCommit', () => YAML),
    getLogLines: rec('getLogLines', () => ['one', '\u001b[32mtwo\u001b[2J', 'three']),
    retryStage: rec('retryStage', () => undefined),
    listTestRuns: rec('listTestRuns', () => [{ id: 1, name: 'Unit tests', totalTests: 10, passedTests: 7, notApplicableTests: 1, incompleteTests: 0 }, { id: 2, name: 'Empty' }]),
    listFailedTestResults: rec('listFailedTestResults', () => [
      { id: 3, testCaseTitle: 'Cart adds <items>', automatedTestName: 'Shop.Cart.Adds', errorMessage: 'expected 2', stackTrace: 'at Cart', durationInMs: 12 },
      { id: 4, automatedTestName: 'Shop.Cart.Removes' },
      { id: 5 },
    ]),
    listArtifacts: rec('listArtifacts', () => [
      { name: 'drop', resource: { type: 'Container', downloadUrl: `${ORG}/_apis/drop.zip` } },
      { name: 'symbols', resource: { type: 'SymbolStore' } },
    ]),
    downloadTo: rec('downloadTo', () => undefined),
    webUrl: (kind: string, id: number) => `${ORG}/${PROJECT}/_${kind}/${id}`,
    ...overrides,
  };
  return { client: client as unknown as AdoClient, calls };
}

function open(buildId: number, overrides: Record<string, unknown> = {}) {
  const f = fakeClient(buildId, overrides);
  let changes = 0;
  RunViewPanel.show(f.client, ext, buildId, () => changes++);
  const panel = lastPanel();
  return { ...f, panel, web: panel.webview, changes: () => changes };
}

const ws = workspace as unknown as { workspaceFolders: unknown[] };

afterEach(() => {
  panels.forEach(p => p.dispose());
  mock.timers.reset();
  ws.workspaceFolders = [];
  reset();
});

describe('RunViewPanel loading', () => {
  it('renders the page with the run view script and posts run data, YAML deps and test runs', async () => {
    const { web, panel, calls } = open(101);
    const n = cspNonce(web.html);
    assert.ok(n && web.html.includes(`<script nonce="${n}" src=`));
    assert.ok(web.html.includes('runView.js'));
    await web.send({ type: 'ready' });
    assert.equal(panel.title, 'shop-web CI #20261016.1');
    const data = web.last('data');
    assert.equal(data.run.branch, 'main');
    assert.equal(data.showTimestamps, false);
    assert.deepEqual(data.stages.map((s: any) => s.name), ['Build', 'Deploy']);
    assert.deepEqual(data.stages[1].approvals, ['ap1']);
    assert.deepEqual(data.stages[0].children.map((j: any) => j.name), ['Compile']);
    assert.deepEqual(web.last('deps').deps, { s1: [], s2: [] });
    assert.deepEqual(calls.previewPipeline, [[12, 'refs/heads/main', 'abc', { env: 'test' }]]);
    assert.deepEqual(web.last('testRuns').runs, [
      { id: 1, name: 'Unit tests', total: 10, passed: 7, failed: 2, other: 1 },
      { id: 2, name: 'Empty', total: 0, passed: 0, failed: 0, other: 0 },
    ]);
    await web.send({ type: 'refresh' });
    assert.equal(calls.listTestRuns.length, 1, 'test runs are cached');
    assert.equal(calls.getPipelineRun.length, 1, 'YAML deps are loaded once');
  });

  it('reuses the panel for the same build and reloads it', async () => {
    const { client, panel, calls } = open(102);
    RunViewPanel.show(client, ext, 102, () => undefined);
    await flush();
    assert.equal(panel.revealed, 1);
    assert.equal(panels.length, 1);
    assert.equal(calls.getBuild.length, 1);
  });

  it('falls back to the YAML file when the preview fails', async () => {
    const { web, calls } = open(103, { previewPipeline: () => Promise.reject(new Error('classic')) });
    await web.send({ type: 'ready' });
    assert.deepEqual(calls.getFileTextAtCommit, [['repo-1', 'azure-pipelines.yml', 'abcdef0123456789']]);
    assert.ok(web.last('deps'));
  });

  it('sends no YAML deps for classic pipelines or a failing definition', async () => {
    const a = open(104, { previewPipeline: async () => 'jobs:\n- job: A\n', getDefinition: async () => ({ process: { type: 1 } }) });
    await a.web.send({ type: 'ready' });
    assert.equal(a.web.last('deps'), undefined);
    const b = open(105, { getPipelineRun: () => Promise.reject(new Error('x')), getDefinition: () => Promise.reject(new Error('y')) });
    await b.web.send({ type: 'ready' });
    assert.equal(b.web.last('deps'), undefined);
  });

  it('handles runs without stages and timeline errors', async () => {
    const { web, calls } = open(106, { getTimeline: () => Promise.reject(new Error('no timeline')) });
    await web.send({ type: 'ready' });
    assert.deepEqual(web.last('data').stages, []);
    assert.deepEqual(web.last('data').deps, {});
    assert.equal(calls.getPipelineRun, undefined);
  });

  it('posts an error when the build cannot be loaded', async () => {
    const { web } = open(107, { getBuild: () => Promise.reject(new Error('TF215010: not found')) });
    await web.send({ type: 'ready' });
    assert.deepEqual(web.last('error'), { type: 'error', message: 'TF215010: not found' });
  });

  it('polls a running build and notifies when it completes', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    settings['azureDevOps.pipelines.refreshInterval'] = 1; // raised to the 5 s minimum
    settings['azureDevOps.pipelines.showTimestamps'] = true;
    let status = 'inProgress';
    const { web, calls, changes } = open(108, { getBuild: async () => build(108, status) });
    await web.send({ type: 'ready' });
    assert.equal(web.last('data').showTimestamps, true);
    assert.equal(web.last('testRuns'), undefined);
    mock.timers.tick(4999);
    await flush();
    assert.equal(web.ofType('data').length, 1);
    status = 'completed';
    mock.timers.tick(1);
    await flush();
    assert.equal(web.ofType('data').length, 2);
    assert.equal(changes(), 1);
    assert.ok(web.last('testRuns'));
    assert.equal(calls.listTestRuns.length, 1);
  });

  it('stops posting after the panel is closed', async () => {
    const { web, panel } = open(109);
    panel.dispose();
    await web.send({ type: 'ready' });
    assert.equal(web.posted.length, 0);
  });
});

describe('RunViewPanel messages', () => {
  it('sends log lines from the given offset without non-color control sequences', async () => {
    const { web } = open(110);
    await web.send({ type: 'log', logId: '5', have: '1' });
    assert.deepEqual(web.last('log'), { type: 'log', logId: 5, from: 1, lines: ['\u001b[32mtwo[2J', 'three'], total: 3 }, 'only the ESC of non-color sequences is dropped');
    await web.send({ type: 'log', logId: 5, have: 'x' });
    assert.equal(web.last('log').from, 0);
  });

  it('reports log errors', async () => {
    const { web } = open(111, { getLogLines: () => Promise.reject(new Error('gone')) });
    await web.send({ type: 'log', logId: 5 });
    assert.deepEqual(web.last('log'), { type: 'log', logId: 5, error: 'gone' });
  });

  it('runs commands for logs, cancel, rerun, approvals and the browser', async () => {
    const { web, calls } = open(112);
    await web.send({ type: 'openLog', logId: 5, name: 'Compile' });
    await web.send({ type: 'cancel' });
    await web.send({ type: 'rerun', definitionId: 12 });
    await web.send({ type: 'approve', approvalId: 'ap1' });
    await web.send({ type: 'browser' });
    await web.send({ type: 'nothing' });
    assert.deepEqual(executed, [
      ['azureDevOps.pipelines.openLog', 112, 5, 'Compile', PROJECT],
      ['azureDevOps.pipelines.cancel', 112, PROJECT],
      ['azureDevOps.pipelines.run', 12, PROJECT],
      ['azureDevOps.pipelines.approve', 'ap1', undefined, PROJECT],
    ]);
    assert.equal(calls.getBuild.length, 2, 'cancel and approve reload the run');
    assert.deepEqual(opened, [vscode.Uri.parse(`${ORG}/${PROJECT}/_build/112`).toString()]);
  });

  it('streams the live log into a terminal', async () => {
    const { web } = open(113);
    await web.send({ type: 'ready' });
    await web.send({ type: 'stream' });
    assert.equal(terminals.length, 1);
    assert.equal((terminals[0].options as { name: string }).name, '⚡ shop-web CI #20261016.1');
    assert.equal(terminals[0].shown, 1);
  });

  it('retries a stage after confirmation', async () => {
    const { web, calls, changes } = open(114);
    await web.send({ type: 'retryStage', identifier: 'Deploy' });
    assert.equal(calls.retryStage, undefined);
    assert.deepEqual(messages, ['Run stage "Deploy" again?']);
    answers.message.push('Rerun all jobs');
    await web.send({ type: 'retryStage', identifier: 'Deploy', name: 'Deploy to test' });
    answers.message.push('Rerun failed jobs');
    await web.send({ type: 'retryStage', identifier: 'Deploy' });
    assert.deepEqual(calls.retryStage, [[114, 'Deploy', true], [114, 'Deploy', false]]);
    assert.equal(changes(), 2);
    assert.equal(calls.listTestRuns.length, 2, 'test runs are loaded again after a retry');
  });

  it('sends failed test results and their errors', async () => {
    const { web, calls } = open(115);
    await web.send({ type: 'tests', runId: '1' });
    assert.deepEqual(calls.listFailedTestResults, [[1]]);
    assert.deepEqual(web.last('testResults').results.map((r: any) => r.name), ['Cart adds <items>', 'Shop.Cart.Removes', 'Test 5']);
    assert.equal(web.last('testResults').results[0].stack, 'at Cart');
    const b = open(116, { listFailedTestResults: () => Promise.reject(new Error('denied')) });
    await b.web.send({ type: 'tests', runId: 2 });
    assert.deepEqual(b.web.last('testResults'), { type: 'testResults', runId: 2, error: 'denied' });
  });

  it('lists artifacts and reports errors', async () => {
    const { web } = open(117);
    await web.send({ type: 'artifacts' });
    assert.deepEqual(web.last('artifacts').items, [
      { name: 'drop', type: 'Container', downloadable: true },
      { name: 'symbols', type: 'SymbolStore', downloadable: false },
    ]);
    const b = open(118, { listArtifacts: () => Promise.reject(new Error('nope')) });
    await b.web.send({ type: 'artifacts' });
    assert.deepEqual(b.web.last('artifacts'), { type: 'artifacts', error: 'nope' });
  });
});

describe('RunViewPanel artifact download', () => {
  it('downloads to the chosen file and offers to reveal it', async () => {
    ws.workspaceFolders = [{ uri: vscode.Uri.file('/work') }];
    const { web, calls } = open(119);
    const target = vscode.Uri.file('/work/drop.zip');
    answers.saveDialog.push(target);
    answers.message.push('Reveal');
    await web.send({ type: 'download', name: 'drop' });
    assert.deepEqual(calls.downloadTo, [[`${ORG}/_apis/drop.zip`, '/work/drop.zip']]);
    assert.deepEqual(executed, [['revealFileInOS', target]]);
    assert.ok(messages.includes('Downloaded drop.'));
  });

  it('suggests a safe file name and does nothing when the dialog is cancelled', async () => {
    ws.workspaceFolders = [{ uri: vscode.Uri.file('/work') }];
    const { web, calls } = open(120, { listArtifacts: async () => [{ name: 'a:b/c', resource: { downloadUrl: 'https://dev.azure.com/contoso/x' } }] });
    await web.send({ type: 'download', name: 'a:b/c' });
    assert.equal((prompts.saveDialog as { defaultUri: vscode.Uri }).defaultUri.path, '/work/a_b_c.zip');
    assert.equal(calls.downloadTo, undefined);
  });

  it('refuses artifacts without a download URL and remote targets', async () => {
    const { web, calls } = open(121);
    await web.send({ type: 'download', name: 'symbols' });
    assert.ok(messages.some(m => m.includes('Artifact "symbols" cannot be downloaded.')));
    answers.saveDialog.push(vscode.Uri.parse('vscode-vfs://github/contoso/drop.zip'));
    await web.send({ type: 'download', name: 'drop' });
    assert.ok(messages.some(m => m.includes('Artifacts can only be saved to a local folder.')));
    assert.equal(calls.downloadTo, undefined);
  });
});
