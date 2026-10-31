import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { fakeDoc, fire, openedDocs, resetExtras, shownDocs } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { cspNonce, lastPanel } from './fakeWebview';
import { PipelinePreviewPanel } from '../pipelines/previewPanel';
import { PreviewError } from '../pipelines/yamlTemplates';
import { AdoError } from '../client';

const ext = vscode.Uri.file('/ext') as any;
const ROOT = 'parameters:\n- name: runTests\n  type: boolean\n  default: true\n- name: environment\n  values: [staging, production]\nsteps: []\n';

function memento() {
  const data = new Map<string, unknown>();
  return { get: (k: string) => data.get(k), update: async (k: string, v: unknown) => { data.set(k, v); }, data };
}

/** A fake YamlTemplateSupport: records the calls and answers with small expanded pipelines. */
function fakeSupport() {
  const calls: { local: unknown[][]; server: unknown[][] } = { local: [], server: [] };
  const support = {
    calls,
    localResult: async (): Promise<any> => ({
      doc: { stages: [{ stage: 'Build' }, { stage: 'Deploy', jobs: [{ deployment: 'Web', environment: 'contoso-staging' }] }] },
      sourceOf: (n: object) => ((n as any).stage === 'Deploy' ? { uri: 'file:///work/contoso-app/stages.yml', label: 'stages.yml · contoso-app (local)', line: 4 } : undefined),
      warnings: ['stages.yml: something odd'], files: 2,
    }),
    serverResult: async (): Promise<any> => ({ yaml: 'jobs:\n- job: Server\n  steps:\n  - script: echo hi\n', definition: { id: 7, name: 'Contoso CI' }, branch: 'main', filePath: '/azure-pipelines.yml' }),
    expandLocally: async (...a: unknown[]) => { calls.local.push(a); return support.localResult(); },
    expandOnServer: async (...a: unknown[]) => { calls.server.push(a); return support.serverResult(); },
  };
  return support;
}

let doc: any;
let docNo = 0;
let store: ReturnType<typeof memento>;
beforeEach(() => {
  vscode.reset();
  resetExtras();
  store = memento();
  PipelinePreviewPanel.useStore(store as any);
  doc = Object.assign(fakeDoc(vscode.Uri.file(`/work/contoso-app/azure-pipelines-${++docNo}.yml`), ROOT.split('\n'), 'yaml'), { version: 1 });
});

const open = async (support = fakeSupport(), mode?: 'local' | 'server') => {
  PipelinePreviewPanel.show(support as any, ext, doc, mode);
  const panel = lastPanel();
  await panel.webview.send({ type: 'ready' });
  return { support, panel, web: panel.webview };
};

describe('PipelinePreviewPanel', () => {
  it('renders the local expansion with sources, parameters and warnings', async () => {
    const { support, panel, web } = await open();
    assert.ok(cspNonce(web.html));
    assert.match(web.html, /pipelinePreview\.js/);
    assert.match(web.html, /data-mode="local"/);
    assert.match(web.html, /data-mode="server"/);
    assert.equal(panel.title.startsWith('Preview azure-pipelines-'), true);
    assert.equal(web.ofType('busy').length, 1);
    const m = web.last('model');
    assert.equal(m.mode, 'local');
    assert.deepEqual(m.model.stages.map((s: any) => [s.id, s.column]), [['Build', 0], ['Deploy', 1]]);
    assert.deepEqual(m.model.sources, [{ label: 'stages.yml · contoso-app (local)', line: 5 }]);
    assert.deepEqual(m.warnings, ['stages.yml: something odd']);
    assert.equal(m.info, 'Expanded locally from 3 files');
    assert.deepEqual(m.params.map((p: any) => [p.name, p.value, p.changed]), [['runTests', 'true', false], ['environment', '', false]]);
    assert.equal(support.calls.local.length, 1);

    await web.send({ type: 'open', source: 0 });
    assert.equal(String(openedDocs.at(-1)), 'file:///work/contoso-app/stages.yml');
    assert.equal(shownDocs.length, 1);
    await web.send({ type: 'designer' });
    assert.deepEqual(vscode.executed.at(-1), ['azureDevOps.yaml.openDesigner', doc.uri]);
    await web.send({ type: 'open', source: 5 });
    await web.send({ type: 'open', source: 'x' });
    assert.equal(shownDocs.length, 1);
  });

  it('switches to Azure DevOps, keeps the chosen pipeline and remembers the mode', async () => {
    const { support, web } = await open();
    await web.send({ type: 'mode', mode: 'server' });
    await web.send({ type: 'mode', mode: 'bogus' });
    const m = web.last('model');
    assert.equal(m.mode, 'server');
    assert.equal(m.info, 'Expanded by Azure DevOps as "Contoso CI" at main');
    assert.deepEqual(m.model.stages[0].jobs.map((j: any) => [j.name, j.steps.length]), [['Server', 1]]);
    assert.equal(store.data.get('pipelinePreview.mode'), 'server');
    await web.send({ type: 'refresh' });
    assert.deepEqual(support.calls.server.map(c => c[2]), [undefined, 7]);
    await web.send({ type: 'pipeline' });
    assert.equal(support.calls.server.at(-1)![2], undefined);

    // A new panel starts in the remembered mode.
    doc = Object.assign(fakeDoc(vscode.Uri.file('/work/contoso-app/ci.yml'), ['steps: []'], 'yaml'), { version: 1 });
    const second = await open(support);
    assert.equal(second.web.last('model').mode, 'server');
  });

  it('passes runtime parameters and resets them', async () => {
    const { support, web } = await open();
    await web.send({ type: 'param', name: 'environment', value: 'production' });
    await web.send({ type: 'param', name: 'notDeclared', value: 'x' });
    assert.deepEqual(support.calls.local.at(-1)![1], { environment: 'production' });
    assert.equal(web.last('model').params[1].changed, true);
    await web.send({ type: 'resetParams' });
    assert.deepEqual(support.calls.local.at(-1)![1], {});
    assert.equal(support.calls.local.length, 3);
  });

  it('shows problems in the panel', async () => {
    const support = fakeSupport();
    support.serverResult = async () => { throw new PreviewError('This file is not in a clone of an Azure Repos repository.', 'warning'); };
    const { web } = await open(support, 'server');
    assert.equal(web.last('error').message, 'This file is not in a clone of an Azure Repos repository.');
    support.serverResult = async () => undefined;
    await web.send({ type: 'refresh' });
    assert.match(web.last('error').message, /No pipeline selected/);
    support.localResult = async () => { throw new AdoError('Azure DevOps rejected the credentials.', 401, true); };
    await web.send({ type: 'mode', mode: 'local' });
    assert.equal(web.last('error').message, 'Azure DevOps rejected the credentials.');
  });

  it('reads the document again after its editor was closed', async () => {
    const workspace = vscode.workspace as any;
    const openDoc = workspace.openTextDocument;
    try {
      const { web } = await open();
      assert.deepEqual(web.last('model').params.map((p: any) => p.name), ['runTests', 'environment']);
      const reopened = fakeDoc(doc.uri, ['parameters:', '- name: region', '  default: westeurope', 'steps: []'], 'yaml');
      workspace.openTextDocument = async () => reopened;
      doc.isClosed = true;
      await web.send({ type: 'param', name: 'region', value: 'northeurope' });
      assert.deepEqual(web.last('model').params.map((p: any) => [p.name, p.value, p.changed]), [['region', 'northeurope', true]]);

      workspace.openTextDocument = async () => { throw new Error('deleted'); };
      (reopened as any).isClosed = true;
      await web.send({ type: 'refresh' });
      assert.deepEqual(web.last('model').params.map((p: any) => p.name), ['region'], 'a deleted file keeps its last text');
    } finally {
      workspace.openTextDocument = openDoc;
    }
  });

  it('follows edits in local mode and saves in server mode, and reuses the open panel', async () => {
    const { support, panel, web } = await open();
    await fire('changeDoc', { document: { uri: vscode.Uri.file('/elsewhere/readme.md'), languageId: 'markdown' } });
    await fire('changeDoc', { document: { uri: vscode.Uri.file('/work/pipeline-templates/stages.yml'), languageId: 'yaml' } });
    await fire('saveDoc', doc);
    await new Promise(r => setTimeout(r, 800));
    assert.equal(support.calls.local.length, 2);

    PipelinePreviewPanel.show(support as any, ext, doc, 'server');
    assert.equal(panel.revealed, 1);
    await new Promise(r => setImmediate(r));
    assert.equal(support.calls.server.length, 1);
    await fire('changeDoc', { document: doc });
    await fire('saveDoc', doc);
    await new Promise(r => setTimeout(r, 800));
    assert.equal(support.calls.server.length, 2);
    assert.equal(support.calls.local.length, 2);

    const posted = web.posted.length;
    panel.dispose();
    await web.send({ type: 'refresh' });
    assert.equal(web.posted.length, posted, 'nothing is posted after dispose');
    PipelinePreviewPanel.show(support as any, ext, doc);
    assert.notEqual(lastPanel(), panel);
  });
});
