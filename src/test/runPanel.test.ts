import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { RunPipelinePanel } from '../pipelines/runPanel';
import { cspNonce, flush, lastPanel, panels } from './fakeWebview';
import { executed, messages, reset } from './vscodeStub';

const ORG = 'https://dev.azure.com/contoso';
const PROJECT = 'Fabrikam Shop';
const ext = vscode.Uri.file('/ext');

const YAML_DEF = {
  id: 12, name: 'shop-web CI', path: '\\Web\\CI',
  process: { type: 2, yamlFilename: 'azure-pipelines.yml' },
  repository: { id: 'repo-1', type: 'TfsGit', name: 'shop-web', defaultBranch: 'refs/heads/develop' },
  variables: {
    region: { value: 'westeurope', allowOverride: true },
    token: { value: 'hidden', isSecret: true, allowOverride: true },
    fixed: { value: 'x' },
  },
};
const CLASSIC_DEF = { id: 13, name: 'Nightly', path: '\\', process: { type: 1 }, repository: { type: 'GitHub', name: 'contoso/docs' } };
const PARAMS = 'parameters:\n- name: env\n  type: string\n  default: test\n  values:\n  - test\n  - prod\n';

type Calls = Record<string, unknown[][]>;

function fakeClient(overrides: Record<string, unknown> = {}): { client: AdoClient; calls: Calls } {
  const calls: Calls = {};
  const rec = (name: string, result: (...a: any[]) => unknown) => (...args: unknown[]) => {
    const list = calls[name] ?? []; calls[name] = list; list.push(args);
    return Promise.resolve().then(() => result(...args));
  };
  const client = {
    connection: { orgUrl: ORG, project: PROJECT },
    listDefinitions: rec('listDefinitions', () => [YAML_DEF, CLASSIC_DEF]),
    getDefinition: rec('getDefinition', (id: number) => (id === 13 ? CLASSIC_DEF : YAML_DEF)),
    listBranches: rec('listBranches', () => ['develop', 'main']),
    getFileText: rec('getFileText', () => PARAMS),
    runPipeline: rec('runPipeline', () => ({ id: 501, name: '20261016.2' })),
    queueClassicBuild: rec('queueClassicBuild', () => ({ id: 502, buildNumber: '20261016.3' })),
    ...overrides,
  };
  return { client: client as unknown as AdoClient, calls };
}

function open(id: number | undefined, overrides: Record<string, unknown> = {}) {
  const f = fakeClient(overrides);
  let queued = 0;
  RunPipelinePanel.show(f.client, ext, id, () => queued++);
  const panel = lastPanel();
  return { ...f, panel, web: panel.webview, queued: () => queued };
}

afterEach(() => {
  panels.forEach(p => p.dispose());
  reset();
});

describe('RunPipelinePanel', () => {
  it('lists pipelines with folders and loads the preselected one with branches, variables and parameters', async () => {
    const { web, panel, calls } = open(12);
    const n = cspNonce(web.html);
    assert.ok(n && web.html.includes(`<script nonce="${n}">`));
    await web.send({ type: 'ready' });
    assert.deepEqual(web.last('definitions').items, [{ id: 12, name: 'shop-web CI', folder: 'Web / CI' }, { id: 13, name: 'Nightly', folder: '' }]);
    assert.equal(panel.title, 'Run shop-web CI');
    const d = web.last('definition');
    assert.equal(d.branch, 'develop');
    assert.equal(d.yaml, true);
    assert.deepEqual(d.variables, [{ name: 'region', value: 'westeurope', isSecret: false }, { name: 'token', value: '', isSecret: true }]);
    assert.deepEqual(web.last('branches'), { type: 'branches', id: 12, branches: ['develop', 'main'] });
    assert.deepEqual(calls.getFileText, [['repo-1', 'azure-pipelines.yml', 'develop']]);
    assert.ok(web.last('parametersLoading'));
    assert.equal(web.last('parameters').params[0].name, 'env');
  });

  it('reads parameters again when the branch changes and reports read errors', async () => {
    let fail = false;
    const { web } = open(12, { getFileText: async () => { if (fail) { throw new Error('file not found'); } return PARAMS; } });
    await web.send({ type: 'ready' });
    fail = true;
    await web.send({ type: 'branch', branch: 'feature/x' });
    assert.deepEqual(web.last('parameters'), {
      type: 'parameters', id: 12, params: [], note: "Couldn't read azure-pipelines.yml on feature/x: file not found",
    });
  });

  it('shows no parameters for classic pipelines or before a pipeline is selected', async () => {
    const { web } = open(undefined);
    await web.send({ type: 'branch', branch: 'main' });
    assert.deepEqual(web.last('parameters'), { type: 'parameters', id: undefined, params: [] });
    await web.send({ type: 'ready' });
    assert.equal(web.last('definition'), undefined);
    await web.send({ type: 'definition', id: '13' });
    assert.equal(web.last('definition').folder, '');
    assert.equal(web.last('definition').branch, 'main');
    assert.deepEqual(web.last('parameters'), { type: 'parameters', id: 13, params: [] });
  });

  it('notes that parameters of YAML files outside Azure Repos cannot be read', async () => {
    const { web } = open(14, { getDefinition: async () => ({ ...YAML_DEF, id: 14, repository: { type: 'GitHub', name: 'contoso/web' } }) });
    await web.send({ type: 'ready' });
    assert.match(web.last('parameters').note, /only be read from Azure Repos/);
  });

  it('posts fatal errors for failing lists and definitions', async () => {
    const { web } = open(12, {
      listDefinitions: () => Promise.reject(new Error('TF400813')),
      getDefinition: () => Promise.reject(new Error('gone')),
    });
    await web.send({ type: 'ready' });
    assert.deepEqual(web.ofType('fatal').map(m => m.message), ['TF400813', 'gone']);
    assert.deepEqual(web.last('definitions').items, []);
  });

  it('runs a YAML pipeline and opens the run', async () => {
    const { web, panel, calls, queued } = open(12);
    await web.send({ type: 'run', branch: 'main', parameters: {}, variables: {} }); // nothing selected yet
    assert.equal(calls.runPipeline, undefined);
    await web.send({ type: 'ready' });
    await web.send({ type: 'run', branch: 'main', commit: 'abc1234', parameters: { env: 'prod' }, variables: { region: 'northeurope' } });
    assert.deepEqual(calls.runPipeline, [[12, { refName: 'refs/heads/main', version: 'abc1234', templateParameters: { env: 'prod' }, variables: { region: 'northeurope' } }]]);
    assert.equal(panel.disposed, true);
    assert.equal(queued(), 1);
    assert.deepEqual(executed, [['azureDevOps.pipelines.openRun', 501, PROJECT]]);
  });

  it('queues a classic build with a full ref', async () => {
    const { web, calls } = open(13);
    await web.send({ type: 'ready' });
    await web.send({ type: 'run', branch: 'refs/tags/v1', parameters: {}, variables: { a: '1' } });
    assert.deepEqual(calls.queueClassicBuild, [[13, 'refs/tags/v1', { a: '1' }, undefined]]);
    assert.deepEqual(executed, [['azureDevOps.pipelines.openRun', 502, PROJECT]]);
  });

  it('keeps the form open when queueing fails', async () => {
    const { web, panel } = open(12, { runPipeline: () => Promise.reject(new Error('Could not queue the build')) });
    await web.send({ type: 'ready' });
    await web.send({ type: 'run', branch: 'main', parameters: {}, variables: {} });
    assert.deepEqual(web.last('runFailed'), { type: 'runFailed', message: 'Could not queue the build' });
    assert.equal(panel.disposed, false);
  });

  it('reuses the panel for the same project and replaces it for another one', async () => {
    const first = open(12);
    await first.web.send({ type: 'ready' });
    RunPipelinePanel.show(first.client, ext, 13, () => undefined);
    await flush();
    assert.equal(first.panel.revealed, 1);
    assert.equal(first.web.last('definition').id, 13);
    RunPipelinePanel.show(first.client, ext, undefined, () => undefined);
    assert.equal(first.panel.revealed, 2);
    const second = open(12);
    assert.equal(first.panel.disposed, true);
    assert.notEqual(second.panel, first.panel);
  });

  it('closes on cancel', async () => {
    const { web, panel } = open(undefined);
    await web.send({ type: 'cancel' });
    await web.send({ type: 'other' });
    assert.equal(panel.disposed, true);
    assert.equal(messages.length, 0);
  });
});
