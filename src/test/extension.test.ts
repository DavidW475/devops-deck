import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fakeDoc, openedDocs, quickPicks, registered, resetExtras, shownDocs } from './vscodeExtras';
import { lastPanel } from './fakeWebview';
import * as vscode from './vscodeStub';
import { activate, deactivate } from '../extension';
import { BlameUi } from '../blame/blameUi';
import { ConnectionManager } from '../connection';
import { MyDayService } from '../myDay/service';
import { FakeWebview } from './fakeWebview';

const pkg = require('../../package.json') as { contributes: { commands: { command: string }[] } };
const flush = () => new Promise(r => setImmediate(r));
const w = vscode.window as any;

function memento() {
  const data = new Map<string, unknown>();
  return { get: (k: string, d?: unknown) => (data.has(k) ? data.get(k) : d), update: async (k: string, v: unknown) => { data.set(k, v); }, keys: () => [...data.keys()], setKeysForSync() { /* stub */ } };
}

const secrets = new Map<string, string>();
const requests: string[] = [];
let taskReply: unknown[] | undefined;
const context = {
  subscriptions: [] as { dispose(): unknown }[],
  secrets: {
    get: async (k: string) => secrets.get(k),
    store: async (k: string, v: string) => { secrets.set(k, v); },
    delete: async (k: string) => { secrets.delete(k); },
    onDidChange: () => ({ dispose() { /* stub */ } }),
  },
  globalState: memento(),
  workspaceState: memento(),
  extensionUri: vscode.Uri.file('/ext'),
};

/** Answers the project list; every other request fails, so commands end in their error path without network access. */
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = String(url);
  requests.push(u);
  if (u.includes('/_apis/projects')) {
    return json({ value: [{ name: 'Fabrikam Shop' }, { name: 'Contoso Web' }] });
  }
  if (u.includes('/_apis/distributedtask/tasks') && taskReply) {
    return json({ value: taskReply });
  }
  if (u.includes('/_apis/build/definitions/5?')) {
    return json({ id: 5, name: 'Contoso CI' });
  }
  if (init?.method === 'POST' && u.includes('/_apis/build/builds?')) {
    return json({ id: 901, buildNumber: '2026.8', definition: { id: 5, name: 'Contoso CI' } });
  }
  return new Response('{"message":"not in this test"}', { status: 404, headers: { 'content-type': 'application/json' } });
}

const run = (id: string, ...args: unknown[]) => registered.get(id)!(...args);
let inputs: unknown[] = [];
let warnings: unknown[] = [];
let sidebarProvider: { resolveWebviewView(view: unknown): void } | undefined;
const resetSpy = { calls: 0 };
const realReset = MyDayService.prototype.reset;
const blameSpy = { resets: 0 };
const realBlameReset = BlameUi.prototype.reset;
let sessionListener: ((e: { provider: { id: string } }) => void) | undefined;
const realFetch = globalThis.fetch;

describe('activate', () => {
  before(async () => {
    globalThis.fetch = fakeFetch as typeof fetch;
    vscode.reset();
    resetExtras();
    vscode.settings['azureDevOps.organization'] = 'contoso';
    vscode.settings['azureDevOps.project'] = 'Fabrikam Shop';
    vscode.settings['azureDevOps.authMethod'] = 'pat';
    vscode.settings['azureDevOps.refreshInterval'] = 0;
    secrets.set('azureDevOps.pat', 'fake-pat');
    (vscode.authentication as any).onDidChangeSessions = (l: typeof sessionListener) => { sessionListener = l; return { dispose() { /* stub */ } }; };
    w.registerWebviewViewProvider = (_id: string, provider: typeof sidebarProvider) => { sidebarProvider = provider; return { dispose() { /* stub */ } }; };
    MyDayService.prototype.reset = function (this: MyDayService) { resetSpy.calls++; realReset.call(this); };
    BlameUi.prototype.reset = function (this: BlameUi) { blameSpy.resets++; realBlameReset.call(this); };
    await activate(context as any);
  });
  after(() => {
    context.subscriptions.forEach(d => d.dispose());
    deactivate();
    MyDayService.prototype.reset = realReset;
    BlameUi.prototype.reset = realBlameReset;
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    vscode.messages.length = 0;
    vscode.executed.length = 0;
    vscode.opened.length = 0;
    inputs = [];
    warnings = [];
    w.showInputBox = async () => inputs.shift();
    w.showWarningMessage = async (m: string) => { vscode.messages.push(m); return warnings.shift(); };
  });

  it('registers every contributed command', () => {
    const missing = pkg.contributes.commands.map(c => c.command).filter(id => !registered.has(id));
    assert.deepEqual(missing, []);
    assert.ok(context.subscriptions.length > 40);
  });

  it('stores a trimmed personal access token', async () => {
    await run('azureDevOps.setPat');
    assert.equal(secrets.get('azureDevOps.pat'), 'fake-pat');
    inputs = ['  new-pat  '];
    await run('azureDevOps.setPat');
    assert.equal(secrets.get('azureDevOps.pat'), 'new-pat');
    assert.equal(vscode.settings['azureDevOps.authMethod'], 'pat');
  });

  it('refreshes the task catalog and reports the outcome', async () => {
    taskReply = undefined;
    await run('azureDevOps.yaml.refreshTaskCatalog');
    assert.match(vscode.messages.at(-1)!, /Could not read the tasks of the organization.*Agent Pools \(Read\)/);
    taskReply = [{ id: 'g1', name: 'ContosoDeploy', friendlyName: 'Contoso deploy', version: { major: 1, minor: 0, patch: 0 } }];
    w.showInformationMessage = async (m: string) => { vscode.messages.push(m); return undefined; };
    await run('azureDevOps.yaml.refreshTaskCatalog');
    assert.equal(vscode.messages.at(-1), 'Task catalog refreshed: 1 task.');
    taskReply = undefined;
  });

  it('runs the pipeline YAML commands for the active editor', async () => {
    w.activeTextEditor = undefined;
    await run('azureDevOps.yaml.showTemplates', 'not a uri');
    await run('azureDevOps.yaml.previewPipeline');
    await run('azureDevOps.yaml.showPreview');
    assert.deepEqual(vscode.messages, ['Open an Azure Pipelines YAML file first.', 'Open a local Azure Pipelines YAML file first.', 'Open an Azure Pipelines YAML file first.']);
    w.activeTextEditor = { document: Object.assign(fakeDoc(vscode.Uri.file('/work/ci.yml'), ['steps: []'], 'yaml'), { version: 1 }) };
    await run('azureDevOps.yaml.showPreview', undefined, 'local');
    assert.equal(lastPanel().viewType, 'azureDevOps.pipelinePreview');
    lastPanel().dispose();
    w.activeTextEditor = undefined;
  });

  it('opens the pipeline designer for the active editor or a file', async () => {
    vscode.messages.length = 0;
    await run('azureDevOps.yaml.openDesigner');
    assert.deepEqual(vscode.messages, ['Open an Azure Pipelines YAML file first.']);
    const ci = Object.assign(fakeDoc(vscode.Uri.file('/work/designer.yml'), ['steps:', '- template: a.yml'], 'yaml'), { version: 1, isClosed: false });
    w.activeTextEditor = { document: ci, selection: { active: { line: 1 } } };
    await run('azureDevOps.yaml.openDesigner');
    assert.equal(lastPanel().viewType, 'azureDevOps.pipelineDesigner');
    lastPanel().dispose();
    await run('azureDevOps.yaml.openDesigner', vscode.Uri.file('/work/other.yml'), 0);
    assert.equal(lastPanel().viewType, 'azureDevOps.pipelineDesigner');
    assert.equal(String(openedDocs.at(-1)), 'file:///work/other.yml');
    lastPanel().dispose();
    w.activeTextEditor = undefined;
    openedDocs.length = 0;
  });

  it('opens items in the browser for the right project', async () => {
    await run('azureDevOps.wi.openInBrowser', 12, 'Contoso Web');
    await run('azureDevOps.pr.openInBrowser', 'web-shop', 7);
    await run('azureDevOps.pipelines.openInBrowser', 900, '');
    await run('azureDevOps.pipelines.openDefinition', 3);
    assert.equal(vscode.opened.length, 4);
    assert.match(vscode.opened[0], /Contoso%20Web\/_workitems\/edit\/12/);
    assert.match(vscode.opened[1], /Fabrikam%20Shop\/_git\/web-shop\/pullrequest\/7/);
  });

  it('pauses, resumes and deletes watchers', async () => {
    vscode.settings['azureDevOps.watchers'] = [{ name: 'Failed builds', type: 'pipeline' }];
    await run('azureDevOps.watchers.pause', { index: 0 });
    assert.equal((vscode.settings['azureDevOps.watchers'] as any[])[0].enabled, false);
    await run('azureDevOps.watchers.resume', { index: 0 });
    assert.equal((vscode.settings['azureDevOps.watchers'] as any[])[0].enabled, undefined);
    await run('azureDevOps.watchers.pause', { index: 5 });
    await run('azureDevOps.watchers.delete', { index: 0 });
    assert.equal((vscode.settings['azureDevOps.watchers'] as any[]).length, 1);
    warnings = ['Delete'];
    await run('azureDevOps.watchers.delete', { index: 0 });
    assert.deepEqual(vscode.settings['azureDevOps.watchers'], []);
    assert.deepEqual(vscode.messages, ['Delete the watcher "Failed builds"?', 'Delete the watcher "Failed builds"?']);
  });

  it('asks before cancelling a run and validates work item IDs', async () => {
    await run('azureDevOps.pipelines.cancel', 900);
    assert.deepEqual(vscode.messages, ['Cancel run 900?']);
    let options: any;
    w.showInputBox = async (o: any) => { options = o; return undefined; };
    await run('azureDevOps.wi.openById');
    assert.equal(options.validateInput('#12'), undefined);
    assert.equal(options.validateInput('abc'), 'Enter a number');
  });

  it('queues a pipeline run again on its branch', async () => {
    await run('azureDevOps.pipelines.rerun', 5, 'release/2.0', 'Fabrikam Shop');
    assert.deepEqual(vscode.messages, ['Queued Contoso CI #2026.8.']);
  });

  it('signs in with a Microsoft account', async () => {
    await run('azureDevOps.signIn');
    assert.equal(vscode.settings['azureDevOps.authMethod'], 'microsoft');
    assert.equal(vscode.messages.length, 1, 'the failed sign-in is reported');
    vscode.settings['azureDevOps.authMethod'] = 'pat';
  });

  it('opens a build log as a document', async () => {
    await run('azureDevOps.pipelines.openLog', 900, 4, 'Build', 'Fabrikam Shop');
    assert.equal(openedDocs.length, 1);
    assert.equal(shownDocs.length, 1);
  });

  it('shows server errors of commands instead of throwing', async () => {
    await run('azureDevOps.pr.checkout', 'r1', 7);
    await run('azureDevOps.wi.changeState', 12, 'Bug', 'Contoso Web');
    await run('azureDevOps.pipelines.rerun', 3, 'main');
    assert.equal(vscode.messages.length, 3);
    assert.ok(requests.some(u => u.includes('/Contoso%20Web/')));
  });

  it('reacts to refresh, configuration and session changes', async () => {
    await run('azureDevOps.refresh');
    await vscode.workspace.getConfiguration('azureDevOps').update('additionalProjects', ['Contoso Web']);
    sessionListener!({ provider: { id: 'github' } });
    sessionListener!({ provider: { id: 'microsoft' } });
    await flush();
    assert.ok(vscode.executed.some(c => c[0] === 'setContext' && c[1] === 'azureDevOps.configured' && c[2] === true));
  });

  it('configures organization and project from a list', async () => {
    const done = run('azureDevOps.configure');
    await flush();
    const qp = quickPicks.at(-1)!;
    await flush();
    assert.deepEqual(qp.items.map(i => i.label), ['Contoso Web', 'Fabrikam Shop', '', '$(organization) Change organization…']);
    assert.deepEqual(qp.activeItems.map(i => i.label), ['Fabrikam Shop']);
    qp.selectedItems = [qp.items[0]];
    qp.fire('accept');
    await done;
    assert.equal(vscode.settings['azureDevOps.project'], 'Contoso Web');
    assert.equal(vscode.settings['azureDevOps.organization'], 'https://dev.azure.com/contoso');
  });

  it('lets the user change the organization and stops when cancelled', async () => {
    const done = run('azureDevOps.configure');
    await flush();
    const qp = quickPicks.at(-1)!;
    qp.selectedItems = [qp.items.at(-1)];
    inputs = ['  fabrikam '];
    qp.fire('accept');
    await flush();
    await flush();
    const second = quickPicks.at(-1)!;
    assert.notEqual(second, qp);
    assert.equal(second.title, 'Azure DevOps project — fabrikam');
    second.selectedItems = [second.items.at(-1)];
    second.fire('accept');
    await done;
    assert.equal(vscode.settings['azureDevOps.project'], 'Contoso Web');
  });

  it('declares and registers the My Day commands', () => {
    const declared = pkg.contributes.commands.map(c => c.command);
    for (const id of ['azureDevOps.myDay.defer', 'azureDevOps.myDay.restore', 'azureDevOps.pr.vote']) {
      assert.ok(declared.includes(id), `${id} is declared`);
      assert.ok(registered.has(id), `${id} is registered`);
    }
  });

  /** Resolves the sidebar with a fake page; returns the messages it received. */
  function openSidebar(): FakeWebview {
    const webview = new FakeWebview();
    const view = { webview, badge: undefined as unknown, visible: true, onDidChangeVisibility: () => ({ dispose() { /* stub */ } }) };
    sidebarProvider!.resolveWebviewView(view);
    return webview;
  }

  it('ignores a vote with invalid arguments without a request or refresh', async () => {
    const page = openSidebar();
    let picks = 0;
    w.showQuickPick = async () => { picks++; return undefined; };
    const before = requests.length;
    await run('azureDevOps.pr.vote', '', 7);
    await run('azureDevOps.pr.vote', 42, 7);
    await run('azureDevOps.pr.vote', 'web-shop', 'x');
    await run('azureDevOps.pr.vote', 'web-shop', 1.5);
    await run('azureDevOps.pr.vote', 'web-shop', 0);
    assert.equal(picks, 0);
    assert.equal(requests.slice(before).filter(u => u.includes('/reviewers/')).length, 0);
    assert.equal(page.ofType('refresh').length, 0);
  });

  it('does nothing when deferring an unknown My Day key', async () => {
    let picks = 0;
    w.showQuickPick = async () => { picks++; return undefined; };
    await run('azureDevOps.myDay.defer', 'pr:unknown');
    await run('azureDevOps.myDay.defer', 12);
    await run('azureDevOps.myDay.defer');
    assert.equal(picks, 0);
    await run('azureDevOps.myDay.restore', 'pr:unknown');
  });

  it('serves My Day through the sidebar and resets it on sign-in and configuration changes', async () => {
    const page = openSidebar();
    await page.send({ type: 'rpc', id: 1, method: 'myDay', params: {} });
    const answer = page.ofType('rpc').find(m => m.id === 1);
    assert.ok(answer, 'the sidebar answers the myDay call');
    assert.notEqual(answer.error?.message, 'My Day is not available', 'the service is connected to the sidebar');
    const base = resetSpy.calls;
    const blameBase = blameSpy.resets;
    await run('azureDevOps.signIn');
    assert.equal(resetSpy.calls, base + 1, 'sign-in resets My Day');
    assert.equal(blameSpy.resets, blameBase + 1, 'and the blame caches, once');
    await run('azureDevOps.setPat');
    await vscode.workspace.getConfiguration('azureDevOps').update('additionalProjects', ['Contoso Web']);
    await flush();
    assert.ok(resetSpy.calls >= base + 2, 'a configuration change resets My Day');
    const afterConfig = resetSpy.calls;
    sessionListener!({ provider: { id: 'microsoft' } });
    assert.equal(resetSpy.calls, afterConfig + 1, 'a Microsoft session change resets My Day');
  });
});

describe('activate when watching git fails', () => {
  it('still starts blame and shows the failure instead of an unhandled rejection', async () => {
    const realWatch = ConnectionManager.prototype.watchGit;
    const realStart = BlameUi.prototype.start;
    let started = 0;
    const seen: unknown[] = [];
    const onReject = (e: unknown): void => { seen.push(e); };
    process.on('unhandledRejection', onReject);
    ConnectionManager.prototype.watchGit = async () => { throw new Error('git is gone'); };
    BlameUi.prototype.start = function () { started++; };
    const realWarn = w.showWarningMessage;
    const shown: string[] = [];
    w.showWarningMessage = async (m: string) => { shown.push(m); return undefined; };
    const second = { ...context, subscriptions: [] as { dispose(): unknown }[] };
    try {
      await activate(second as any);
      await flush();
      assert.equal(started, 1);
      assert.ok(shown.some(m => m.includes('git is gone')), shown.join('|'));
      assert.deepEqual(seen, []);
    } finally {
      process.off('unhandledRejection', onReject);
      second.subscriptions.forEach(d => d.dispose());
      ConnectionManager.prototype.watchGit = realWatch;
      BlameUi.prototype.start = realStart;
      w.showWarningMessage = realWarn;
    }
  });
});
