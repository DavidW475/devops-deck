import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { fire, resetExtras, shownDocs, WorkspaceEdit } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { cspNonce, flush, lastPanel, panels } from './fakeWebview';
import { DesignerCodeLens, PipelineDesignerPanel } from '../pipelines/designerPanel';
import { PreviewError } from '../pipelines/yamlTemplates';
import { joinTemplatePath } from '../pipelines/templateRefs';
import { templateKind } from '../pipelines/templateEdits';
import { parsePipelineParameters } from '../pipelines/yamlParameters';
import { buildIndex } from '../pipelines/taskCatalog';
import { CatalogSnapshot, TaskInfo, TaskInput } from '../pipelines/taskModel';

const ext = vscode.Uri.file('/ext') as any;
const ROOT = '/work/contoso-app';

const PIPELINE = [
  'resources:',
  '  repositories:',
  '  - repository: templates',
  '    type: git',
  '    name: Platform/pipeline-templates',
  '    ref: refs/tags/v2.1',
  '',
  'stages:',
  '- stage: Build',
  '  jobs:',
  '  - job: Compile',
  '    steps:',
  '    - template: build/dotnet.yml@templates',
  '      parameters:',
  '        dotnetVersion: 9.0.x',
  '    - script: echo done',
  '- stage: Deploy',
  '  jobs:',
  '  - job: Web',
  '    steps:',
  '    - template: deploy/web.yml@templates',
  '      parameters: { appName: contoso-web }',
].join('\n');

const DOTNET = 'parameters:\n- name: projectPath\n  default: "**/*.csproj"\n- name: dotnetVersion\n  values: [8.0.x, 9.0.x, 10.0.x]\n  default: 10.0.x\n'
  + '- name: runTests\n  type: boolean\n  default: true\n- name: coverage\n  type: number\n  default: 80\n- name: extraSteps\n  type: stepList\n  default: []\nsteps:\n- script: dotnet build\n';
const NODE = 'parameters:\n- name: workingDirectory\n- name: nodeVersion\n  values: [20.x, 22.x]\n  default: 22.x\nsteps:\n- script: npm ci\n';
const WEB = 'parameters:\n- name: appName\nsteps:\n- script: deploy\n';
const LOCAL = 'parameters:\n- name: message\n  default: hi\nsteps:\n- script: echo\n';
const REMOTE: Record<string, string> = { '/build/dotnet.yml': DOTNET, '/build/node.yml': NODE, '/deploy/web.yml': WEB };

/** A text document whose content changes when an edit is applied. */
function mutableDoc(path: string, text: string) {
  const doc = {
    uri: vscode.Uri.file(path), languageId: 'yaml', version: 1, isClosed: false, text,
    get lineCount() { return doc.text.split('\n').length; },
    getText() { return doc.text; },
  };
  return doc;
}

function offsetOf(text: string, line: number, ch: number): number {
  const lines = text.split('\n');
  return lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + ch;
}

let doc: ReturnType<typeof mutableDoc>;
let applied: WorkspaceEdit[];
let applyResult = true;

function installApply(): void {
  (vscode.workspace as any).applyEdit = async (e: WorkspaceEdit) => {
    applied.push(e);
    if (!applyResult) {
      return false;
    }
    const sorted = [...e.replaces].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character);
    for (const r of sorted) {
      const start = offsetOf(doc.text, r.range.start.line, r.range.start.character);
      const end = offsetOf(doc.text, r.range.end.line, r.range.end.character);
      doc.text = doc.text.slice(0, start) + r.text + doc.text.slice(end);
    }
    doc.version++;
    return true;
  };
}

function fakeHost() {
  const calls = { catalog: [] as any[], refs: 0, server: [] as any[] };
  const origin = { kind: 'local', root: ROOT };
  const host = {
    calls,
    serverResult: async (): Promise<any> => ({ yaml: 'stages:\n- stage: Build\n  jobs:\n  - job: A\n    steps:\n    - script: x\n', definition: { id: 7, name: 'Contoso CI' }, branch: 'main' }),
    resolver: {
      contextFor: async () => ({ location: { origin, path: '/azure-pipelines.yml' }, self: origin, repos: {} }),
      resolve: async (_ctx: unknown, target: { path: string; alias?: string }) => {
        const p = target.alias === 'templates' ? joinTemplatePath('/', target.path) : '';
        const text = REMOTE[p];
        if (!text) {
          throw new Error(`${target.path} was not found.`);
        }
        return { text, parameters: parsePipelineParameters(text), label: `${p.slice(1)} · pipeline-templates@v2.1` };
      },
      catalog: async (o: any, force?: boolean) => {
        calls.catalog.push({ o, force });
        if (o.kind === 'local') {
          return { entries: [{ path: '/templates/local.yml', kind: templateKind(LOCAL), parameters: parsePipelineParameters(LOCAL) }], truncated: false };
        }
        const entries = Object.entries(REMOTE).map(([path, text]) => ({ path, kind: templateKind(text), parameters: parsePipelineParameters(text) }));
        return { entries, truncated: true };
      },
      refsOf: async () => { calls.refs++; return { tags: ['refs/tags/v2.0', 'refs/tags/v2.1', 'refs/tags/v10.0'], branches: ['refs/heads/feature/x', 'refs/heads/main'] }; },
      originOf: (r: any) => ({ kind: 'remote', project: 'Platform', repo: 'pipeline-templates', ref: r.ref }),
    },
    expandOnServer: async (...a: unknown[]) => { calls.server.push(a); return host.serverResult(); },
    client: { listRepositories: async () => [{ id: 'r1', name: 'shared-templates', defaultBranch: 'refs/heads/main' }, { id: 'r2', name: 'pipeline-templates' }] },
  };
  return host;
}

let docNo = 0;
beforeEach(() => {
  vscode.reset();
  resetExtras();
  applied = [];
  applyResult = true;
  installApply();
  doc = mutableDoc(`${ROOT}/azure-pipelines-${++docNo}.yml`, PIPELINE);
});

async function open(line = 12, host = fakeHost()) {
  PipelineDesignerPanel.show(host as any, ext, doc as any, line);
  const panel = lastPanel();
  await panel.webview.send({ type: 'ready' });
  await flush(6);
  return { host, panel, web: panel.webview, state: () => panel.webview.last('state') };
}

const param = (s: any, name: string) => s.call.params.find((p: any) => p.name === name);

describe('PipelineDesignerPanel', () => {
  it('shows the form, structure, catalog and preview of the call under the cursor', async () => {
    const { web, host, state, panel } = await open();
    assert.ok(cspNonce(web.html));
    assert.match(web.html, /pipelineDesigner\.js/);
    assert.match(panel.title, /^Designer azure-pipelines-/);
    const s = state();
    assert.equal(s.call.title, 'build/dotnet.yml · pipeline-templates@v2.1');
    assert.equal(s.call.kind, 'steps');
    assert.equal(s.call.status, 'template · line 13');
    assert.deepEqual(s.call.params.map((p: any) => [p.name, p.control, p.value, p.inFile]), [
      ['projectPath', 'text', '**/*.csproj', false], ['dotnetVersion', 'enum', '9.0.x', true], ['runTests', 'boolean', 'true', false],
      ['coverage', 'number', '80', false], ['extraSteps', 'raw', '[]', false],
    ]);
    assert.equal(param(s, 'extraSteps').readOnly, undefined, 'step lists are edited as YAML text');
    assert.equal(param(s, 'extraSteps').tree, undefined, 'only objects get a tree form');
    assert.deepEqual(s.structure.map((g: any) => [g.name, g.items.map((i: any) => [i.label, i.selected])]), [
      ['Build', [['dotnet.yml@templates', true]]], ['Deploy', [['web.yml@templates', false]]],
    ]);
    assert.deepEqual(s.repos.map((r: any) => r.alias), ['self', 'templates']);
    assert.equal(s.repo.alias, 'templates');
    assert.equal(s.repo.source, 'pipeline-templates@v2.1');
    assert.deepEqual(s.repo.refs.map((r: any) => r.label), ['v10.0', 'v2.1', 'v2.0', 'main', 'feature/x']);
    assert.deepEqual(s.catalog.items.map((i: any) => [i.path, i.used, i.selected]), [
      ['/build/dotnet.yml', true, true], ['/build/node.yml', false, false], ['/deploy/web.yml', true, false],
    ]);
    assert.equal(s.catalog.truncated, true);
    assert.equal(s.preview.added + s.preview.changed + s.preview.removed, 0);
    assert.equal(s.preview.lines[0].text, 'resources:');
    assert.equal(s.notices.length, 0, 'a tag gives no branch warning');
    assert.equal(s.validation.state, 'idle');
    assert.equal(host.calls.refs, 1);
    assert.equal(host.calls.catalog.length, 1);
  });

  it('applies changed values as line edits and keeps the selection', async () => {
    const { web, state } = await open();
    await web.send({ type: 'value', name: 'dotnetVersion', value: '10.0.x' });
    await web.send({ type: 'value', name: 'runTests', value: false });
    await web.send({ type: 'value', name: 'projectPath', value: 'src/Contoso.Api/*.csproj' });
    let s = state();
    assert.equal(param(s, 'runTests').unsaved, true);
    assert.equal(param(s, 'runTests').value, 'false');
    assert.deepEqual([s.preview.added, s.preview.changed, s.preview.removed], [2, 0, 1]);
    assert.match(s.preview.lines.map((l: any) => l.text).join('\n'), /runTests: false/);
    await web.send({ type: 'apply' });
    assert.equal(applied.length, 1);
    assert.deepEqual(doc.text.split('\n').slice(12, 17), [
      '    - template: build/dotnet.yml@templates',
      '      parameters:',
      "        projectPath: 'src/Contoso.Api/*.csproj'",
      '        runTests: false',
      '    - script: echo done',
    ]);
    s = state();
    assert.equal(s.notices[0].level, 'ok');
    assert.match(s.notices[0].title, /Updated the call of build\/dotnet\.yml/);
    assert.equal(s.call.status, 'template · line 13');
    assert.equal(param(s, 'runTests').unsaved, false);
    await web.send({ type: 'apply' });
    assert.equal(state().notices[0].title, 'Nothing to change');
  });

  it('blocks invalid values and reports when VS Code rejects the edit', async () => {
    const { web, state } = await open();
    await web.send({ type: 'value', name: 'coverage', value: 'lots' });
    assert.equal(param(state(), 'coverage').error, "'coverage' is a number.");
    assert.match(state().call.blocking, /coverage/);
    await web.send({ type: 'apply' });
    assert.equal(applied.length, 0);
    assert.equal(state().notices[0].level, 'error');
    await web.send({ type: 'value', name: 'coverage', value: '90' });
    applyResult = false;
    await web.send({ type: 'apply' });
    assert.match(state().notices[0].detail, /rejected/);
    await web.send({ type: 'value', name: 'notDeclared' });
    await web.send({ type: 'value', name: 7, value: 'x' });
    await web.send({ type: 'bogus' });
  });

  it('inserts a new call from the catalog at the chosen place', async () => {
    const { web, state } = await open();
    await web.send({ type: 'pick', path: '/build/node.yml' });
    let s = state();
    assert.equal(s.call.isNew, true);
    assert.equal(s.call.applyLabel, 'Insert into pipeline');
    assert.deepEqual(s.call.points, ['Stage Build › Job Compile › steps', 'Stage Deploy › Job Web › steps']);
    assert.equal(s.call.point, 1);
    assert.equal(param(s, 'workingDirectory').error, 'Required: the template has no default.');
    assert.deepEqual(s.structure[0].items.map((i: any) => i.label), ['dotnet.yml@templates']);
    assert.deepEqual(s.structure[1].items.map((i: any) => [i.label, i.isNew]), [['web.yml@templates', false], ['node.yml', true]]);
    await web.send({ type: 'target', index: 0 });
    await web.send({ type: 'value', name: 'workingDirectory', value: 'web' });
    s = state();
    assert.equal(s.call.status, 'New: goes to Stage Build › Job Compile › steps');
    assert.deepEqual(s.preview.lines.filter((l: any) => l.mark).map((l: any) => [l.mark, l.text]), [
      ['+', '    - template: build/node.yml@templates'], ['+', '      parameters:'], ['+', '        workingDirectory: web'],
    ]);
    await web.send({ type: 'apply' });
    assert.equal(doc.text.split('\n')[16], '    - template: build/node.yml@templates', 'at the end of the steps list');
    s = state();
    assert.equal(s.call.isNew, false);
    assert.equal(s.call.line, 16);
    assert.match(s.notices[0].title, /Inserted/);
    assert.equal(s.catalog.items.find((i: any) => i.path === '/build/node.yml').used, true);

    await web.send({ type: 'pick', path: '/build/dotnet.yml' });
    assert.equal(state().call.line, 12, 'picking a used template selects its call');
    await web.send({ type: 'pick', path: '/nope.yml' });
    await web.send({ type: 'select', index: 2 });
    assert.equal(state().call.title, 'deploy/web.yml · pipeline-templates@v2.1');
    assert.match(state().call.readOnly, /flow mapping/);
    await web.send({ type: 'select', index: 99 });
  });

  it('changes the ref of the template repository and warns about branches', async () => {
    const { web, host, state } = await open();
    await web.send({ type: 'ref', ref: 'refs/heads/main' });
    let s = state();
    assert.equal(s.repo.ref, 'refs/heads/main');
    assert.equal(s.repo.refChanged, true);
    assert.deepEqual(s.preview.lines.filter((l: any) => l.mark).map((l: any) => l.text), ['    ref: refs/heads/main']);
    assert.match(s.notices[0].title, /branch main/);
    await flush(6);
    assert.equal(host.calls.catalog.at(-1).o.ref, 'refs/heads/main', 'the catalog follows the ref');
    await web.send({ type: 'ref', ref: 'refs/heads/unknown' });
    assert.equal(state().repo.ref, 'refs/heads/main');
    await web.send({ type: 'ref', ref: '' });
    s = state();
    assert.match(s.notices[0].title, /default branch/);
    await web.send({ type: 'apply' });
    assert.equal(doc.text.split('\n')[5], '');
    assert.match(state().notices[0].title, /Updated the call|Nothing/);
  });

  it('switches to the pipeline repository and reloads the catalog', async () => {
    const { web, host, state } = await open();
    await web.send({ type: 'repo', alias: 'self' });
    await flush(6);
    let s = state();
    assert.equal(s.repo.alias, 'self');
    assert.equal(s.repo.canPickRef, false);
    assert.deepEqual(s.catalog.items.map((i: any) => i.path), ['/templates/local.yml']);
    await web.send({ type: 'pick', path: '/templates/local.yml' });
    s = state();
    assert.equal(s.call.isNew, true);
    await web.send({ type: 'writeDefaults', on: true });
    assert.match(state().preview.lines.map((l: any) => l.text).join('\n'), /- template: templates\/local\.yml\n\s+parameters:\n\s+message: hi/);
    await web.send({ type: 'repo', alias: 'templates' });
    assert.equal(state().call, undefined, 'a new call of another repository is dropped');
    await web.send({ type: 'repo', alias: 'unknown' });
    await web.send({ type: 'reloadCatalog' });
    await flush(6);
    assert.equal(host.calls.catalog.at(-1).force, true);
  });

  it('resets to defaults and writes them explicitly on request', async () => {
    const { web, state } = await open();
    await web.send({ type: 'reset' });
    let s = state();
    assert.equal(param(s, 'dotnetVersion').value, '10.0.x');
    assert.equal(s.preview.removed, 2, 'the value and the empty parameters key go');
    await web.send({ type: 'writeDefaults', on: true });
    s = state();
    assert.equal(s.preview.removed, 0);
    assert.ok(s.preview.added >= 3);
    assert.equal(s.writeDefaults, true);
  });

  it('validates with the server preview, with problems and pipeline choice', async () => {
    const { web, host, state } = await open();
    await web.send({ type: 'validate' });
    assert.equal(web.last('validation').validation.state, 'running');
    let s = state();
    assert.equal(s.validation.state, 'ok');
    assert.match(s.validation.detail, /"Contoso CI" at main: 1 stage, 1 job, 1 step/);
    assert.equal(host.calls.server[0][3], PIPELINE);

    host.serverResult = async () => {
      throw new PreviewError('Azure DevOps could not expand the pipeline', 'error', [
        { file: '/azure-pipelines.yml', line: 13, col: 7, text: 'Unexpected value' }, { file: '/build/dotnet.yml', line: 2, col: 1, text: 'Bad' },
      ]);
    };
    await web.send({ type: 'validate' });
    s = state();
    assert.equal(s.validation.state, 'error');
    assert.deepEqual(s.validation.problems.map((p: any) => p.line), [12, undefined]);
    assert.equal(host.calls.server[1][2], 7, 'the chosen pipeline is kept');

    await web.send({ type: 'value', name: 'coverage', value: '95' });
    await web.send({ type: 'validate' });
    assert.deepEqual(state().validation.problems.map((p: any) => p.line), [undefined, undefined], 'lines of pending text are not linked');

    host.serverResult = async () => undefined;
    await web.send({ type: 'validate' });
    assert.equal(state().validation.title, 'No pipeline selected');
    host.serverResult = async () => { throw new Error('offline'); };
    await web.send({ type: 'validate' });
    assert.equal(state().validation.detail, 'offline');
  });

  it('opens lines in the editor and adds a repository resource', async () => {
    const { web, state } = await open();
    await web.send({ type: 'open', line: 12 });
    await web.send({ type: 'open', line: 999 });
    await web.send({ type: 'open', line: 'x' });
    assert.equal(shownDocs.length, 1);

    vscode.answers.quickPick.push(undefined);
    await web.send({ type: 'addRepo' });
    assert.equal(applied.length, 0);
    vscode.answers.quickPick.push({ label: 'shared-templates', r: { name: 'shared-templates' } });
    vscode.answers.inputBox.push('shared');
    await web.send({ type: 'addRepo' });
    const prompt = vscode.prompts.inputBox as any;
    assert.equal(prompt.value, 'shared_templates');
    assert.equal(prompt.validateInput('1x'), 'Letters, digits and _; must not start with a digit.');
    assert.equal(prompt.validateInput('templates'), "'templates' is already used.");
    assert.equal(prompt.validateInput('ok_1'), undefined);
    assert.deepEqual(doc.text.split('\n').slice(6, 10), ['  - repository: shared', '    type: git', '    name: shared-templates', '']);
    assert.equal(state().repo.alias, 'shared');
    vscode.answers.quickPick.push({ label: 'x', r: { name: 'x' } });
    vscode.answers.inputBox.push('templates');
    await web.send({ type: 'addRepo' });
    assert.equal(applied.length, 1, 'a taken alias is refused');
  });

  it('follows document edits, reopens closed documents and reuses the panel', async () => {
    const host = fakeHost();
    const { web, panel, state } = await open(0, host);
    assert.equal(state().call.line, 12, 'line 0 falls back to the first call');
    doc.text = doc.text.replace('9.0.x', '8.0.x');
    await fire('changeDoc', { document: { uri: vscode.Uri.file('/elsewhere.yml') } });
    await fire('changeDoc', { document: doc });
    await new Promise(r => setTimeout(r, 350));
    assert.equal(param(state(), 'dotnetVersion').value, '8.0.x');

    const reopened = mutableDoc(doc.uri.path, PIPELINE.replace('9.0.x', '10.0.x'));
    const ws = vscode.workspace as any;
    const openDoc = ws.openTextDocument;
    ws.openTextDocument = async () => reopened;
    doc.isClosed = true;
    try {
      await web.send({ type: 'select', index: 0 });
      assert.equal(param(state(), 'dotnetVersion').value, '10.0.x');
    } finally {
      ws.openTextDocument = openDoc;
    }

    PipelineDesignerPanel.show(host as any, ext, doc as any, 20);
    assert.equal(panel.revealed, 1);
    await flush(6);
    assert.equal(state().call.line, 20);
    const count = panels.length;
    const posted = web.posted.length;
    panel.dispose();
    await web.send({ type: 'ready' });
    assert.equal(web.posted.length, posted);
    PipelineDesignerPanel.show(host as any, ext, doc as any);
    assert.equal(panels.length, count + 1);
  });

  it('handles pipelines without calls, unresolvable templates and non-file documents', async () => {
    doc.text = 'steps:\n- script: echo\n';
    let { state } = await open(0);
    assert.equal(state().call, undefined);
    assert.equal(state().empty, true);
    assert.equal(state().repo.alias, 'self');

    doc = mutableDoc(`${ROOT}/other-${docNo}.yml`, 'steps:\n- template: missing.yml@templates\n- template: ${{ parameters.t }}\n');
    ({ state } = await open(1));
    assert.equal(state().call.error, 'missing.yml was not found.');
    assert.equal(state().call.params.length, 0);
    assert.match(state().repo.source, /./);

    const untitled = { uri: { scheme: 'untitled', path: 'Untitled-1', toString: () => 'untitled:1' }, getText: () => '' };
    assert.equal(PipelineDesignerPanel.show(fakeHost() as any, ext, untitled as any), undefined);
    assert.match(vscode.messages.at(-1)!, /local YAML files/);
  });

  it('reports catalog and ref problems', async () => {
    const host = fakeHost();
    host.resolver.catalog = async () => { throw new Error('Repository not found'); };
    host.resolver.refsOf = async () => { throw new Error('No access'); };
    const { state } = await open(12, host);
    await flush(6);
    assert.equal(state().catalog.error, 'Repository not found');
    assert.equal(state().repo.refsError, 'No access');
    assert.deepEqual(state().repo.refs.map((r: any) => r.label), ['v2.1']);

    const github = fakeHost();
    github.resolver.originOf = () => { throw new Error("'contoso/tools' is a github repository: open a clone of it in the workspace to resolve its templates."); };
    doc = mutableDoc(`${ROOT}/gh-${docNo}.yml`, 'resources:\n  repositories:\n  - repository: tools\n    type: github\n    name: contoso/tools\nsteps:\n- template: a.yml@tools\n');
    const second = await open(6, github);
    await flush(6);
    assert.match(second.state().catalog.error, /github repository/);
    assert.match(second.state().repo.source, /github repository/);
  });
});

const APP = 'parameters:\n- name: appSettings\n  type: object\n  default:\n    Level: Info\n- name: preDeploySteps\n  type: stepList\n  default: []\n'
  + 'steps:\n- script: deploy\n';
const APP_PIPELINE = [
  'resources:',
  '  repositories:',
  '  - repository: templates',
  '    type: git',
  '    name: Platform/pipeline-templates',
  '',
  'steps:',
  '- template: deploy/app.yml@templates',
  '  parameters:',
  '    appSettings:',
  '      Level: Debug   # verbose for dev',
  '- script: echo done',
].join('\n');

/** A host whose templates include `deploy/app.yml` with an object and a step list parameter. */
function objectHost() {
  const host = fakeHost();
  const resolve = host.resolver.resolve;
  host.resolver.resolve = async (ctx: unknown, target: { path: string; alias?: string }) =>
    target.path === 'deploy/app.yml' ? { text: APP, parameters: parsePipelineParameters(APP), label: 'deploy/app.yml · pipeline-templates' } : resolve(ctx, target);
  return host;
}

const tree = (entries: [string, unknown][]) => ({ kind: 'map', entries: entries.map(([key, value]) => ({ key, value })) });
const txt = (text: string) => ({ kind: 'text', text });

describe('PipelineDesignerPanel: object and list parameters', () => {
  it('edits an object in the form and writes the block back', async () => {
    doc.text = APP_PIPELINE;
    const { web, state } = await open(7, objectHost());
    let s = state();
    assert.equal(param(s, 'appSettings').value, 'Level: Debug   # verbose for dev');
    assert.deepEqual(param(s, 'appSettings').tree, tree([['Level', txt('Debug')]]));
    assert.equal(param(s, 'preDeploySteps').value, '[]');
    assert.equal(param(s, 'preDeploySteps').tree, undefined);

    await web.send({ type: 'value', name: 'appSettings', tree: tree([['Level', txt('Warning')], ['Hosts', { kind: 'list', items: [txt('contoso.example')] }]]) });
    s = state();
    assert.equal(param(s, 'appSettings').value, 'Level: Warning\nHosts:\n  - contoso.example');
    assert.equal(param(s, 'appSettings').unsaved, true);
    assert.equal(s.call.blocking, undefined);
    await web.send({ type: 'apply' });
    assert.deepEqual(doc.text.split('\n').slice(7, 14), [
      '- template: deploy/app.yml@templates', '  parameters:', '    appSettings:', '      Level: Warning', '      Hosts:', '        - contoso.example', '- script: echo done',
    ]);
    assert.equal(param(state(), 'appSettings').unsaved, false);
  });

  it('keeps empty and duplicate keys of the form visible and blocks them', async () => {
    doc.text = APP_PIPELINE;
    const { web, state } = await open(7, objectHost());
    await web.send({ type: 'value', name: 'appSettings', tree: tree([['Level', txt('a')], ['Level', txt('b')]]) });
    let s = state();
    assert.equal(param(s, 'appSettings').tree.entries.length, 2, 'the form keeps both rows');
    assert.equal(param(s, 'appSettings').error, "The key 'Level' is there twice.");
    assert.match(s.call.blocking, /appSettings: The key 'Level' is there twice/);
    await web.send({ type: 'apply' });
    assert.equal(applied.length, 0);

    await web.send({ type: 'value', name: 'appSettings', tree: tree([['Level', txt('a')], ['', txt('')]]) });
    assert.equal(param(state(), 'appSettings').error, 'A key is empty.');

    const before = state();
    await web.send({ type: 'value', name: 'appSettings', tree: { kind: 'bogus' } });
    assert.equal(state(), before, 'an invalid tree is ignored');

    await web.send({ type: 'value', name: 'appSettings', value: 'Level: Error' });
    s = state();
    assert.deepEqual(param(s, 'appSettings').tree, tree([['Level', txt('Error')]]), 'YAML text replaces the form tree');
    assert.equal(param(s, 'appSettings').error, undefined);
  });

  it('writes a step list from YAML text and resets objects to their defaults', async () => {
    doc.text = APP_PIPELINE;
    const { web, state } = await open(7, objectHost());
    await web.send({ type: 'value', name: 'preDeploySteps', value: 'script: echo' });
    assert.equal(param(state(), 'preDeploySteps').error, "'preDeploySteps' is a stepList: start every item with '- '.");
    await web.send({ type: 'value', name: 'preDeploySteps', value: '- script: echo contoso\n  displayName: Prepare' });
    await web.send({ type: 'apply' });
    assert.deepEqual(doc.text.split('\n').slice(9, 15), [
      '    appSettings:', '      Level: Debug   # verbose for dev', '    preDeploySteps:', '      - script: echo contoso', '        displayName: Prepare', '- script: echo done',
    ]);

    await web.send({ type: 'reset' });
    const s = state();
    assert.equal(param(s, 'appSettings').value, 'Level: Info');
    assert.equal(param(s, 'preDeploySteps').value, '[]');
    await web.send({ type: 'apply' });
    assert.deepEqual(doc.text.split('\n').slice(6), ['steps:', '- template: deploy/app.yml@templates', '- script: echo done'], 'defaults remove the blocks');
  });
});

describe('DesignerCodeLens', () => {
  it('adds "Open in Designer" above template calls of local files', () => {
    const lens = new DesignerCodeLens();
    const lenses = lens.provideCodeLenses(doc as any) as any[];
    assert.deepEqual(lenses.map(l => [l.range.start.line, l.command.command, l.command.arguments[1]]), [
      [12, 'azureDevOps.yaml.openDesigner', 12], [20, 'azureDevOps.yaml.openDesigner', 20],
    ]);
    assert.deepEqual(lens.provideCodeLenses({ ...doc, uri: { scheme: 'ado-template' } } as any), []);
    vscode.settings['azureDevOps.yaml.designerCodeLens'] = false;
    assert.deepEqual(lens.provideCodeLenses(doc as any), []);
    let fired = 0;
    lens.onDidChangeCodeLenses(() => fired++);
    lens.refresh();
    assert.equal(fired, 1);
    lens.dispose();
  });
});

// ---------- task steps ----------

const NOW = Date.now();
const tin = (name: string, over: Partial<TaskInput> = {}): TaskInput => ({
  name, yamlName: over.aliases?.[0] ?? name, aliases: [], label: name, required: false, type: 'string', options: [], editable: false, multi: false, ...over,
});
const ttask = (name: string, major: number, over: Partial<TaskInfo> = {}): TaskInfo => ({
  id: `guid-${name}`, name, title: name, description: 'Deploys things', category: 'Deploy', major, version: `${major}.1.0`, deprecated: false, preview: false,
  groups: [{ name: 'advanced', label: 'Advanced' }], inputs: [], ...over,
});
const SCRIPT_KINDS = [{ value: 'inlineScript', label: 'Inline' }, { value: 'scriptPath', label: 'Path' }];
const DEPLOY2 = ttask('ContosoDeploy', 2, {
  title: 'Contoso Deploy', helpUrl: 'https://learn.contoso.example/deploy',
  inputs: [
    tin('connectionName', { aliases: ['connection'], required: true, help: 'The [service connection](command:evil) to use.' }),
    tin('mode', { type: 'picklist', options: [{ value: 'fast', label: 'Fast' }, { value: 'safe', label: 'Safe' }], default: 'fast' }),
    tin('scriptLocation', { type: 'radio', options: SCRIPT_KINDS, default: 'inlineScript' }),
    tin('inlineScript', { type: 'multiline', required: true, visibleRule: 'scriptLocation = inlineScript' }),
    tin('scriptPath', { type: 'filepath', required: true, visibleRule: 'scriptLocation = scriptPath' }),
    tin('verbose', { type: 'boolean', default: 'false', group: 'advanced' }),
    tin('retries', { type: 'int', default: '3', group: 'advanced' }),
  ],
});
const DEPLOY1 = ttask('ContosoDeploy', 1, { title: 'Contoso Deploy', inputs: [tin('connectionName', { aliases: ['connection'], required: true })] });
const LEGACY = ttask('ContosoLegacy', 1, { deprecated: true, title: 'Contoso Legacy' });
const EVIL = ttask('FabrikamBuild', 1, { title: '<img src=x onerror=alert(1)>', category: 'Build', inputs: [tin('target', { help: '<b>bold</b> ![x](http://evil.example/a.png)' })] });
const INDEX = buildIndex([DEPLOY2, DEPLOY1, LEGACY, EVIL]);

const TASK_PIPELINE = [
  'stages:',
  '- stage: Deploy',
  '  jobs:',
  '  - job: Web',
  '    steps:',
  '    - task: ContosoDeploy@2',
  '      displayName: Deploy web',
  '      inputs:',
  '        connectionName: Fabrikam-Prod',
  '        scriptLocation: inlineScript',
  '        inlineScript: |-',
  '          echo one',
  '          echo two',
  '        retries: 5 # keep',
  '    - script: echo done',
  '  - job: Expr',
  '    steps:',
  '    - task: ContosoDeploy@2',
  '      inputs: ${{ parameters.inputs }}',
].join('\n');

function fakeTasks(snap: CatalogSnapshot) {
  const emitter = new vscode.EventEmitter<void>();
  const t = {
    snap, ensured: 0, refreshed: 0, emitter,
    onDidChange: emitter.event,
    snapshot: () => t.snap,
    ensure: async () => { t.ensured++; return t.snap; },
    refresh: async () => { t.refreshed++; await new Promise(r => setTimeout(r, 15)); return t.snap; },
  };
  return t;
}

function taskHost(snap: CatalogSnapshot = { status: 'ready', index: INDEX, fetchedAt: NOW - 2 * 3600_000 }) {
  const tasks = fakeTasks(snap);
  return Object.assign(fakeHost(), { tasks, orgUrl: () => 'https://dev.azure.com/contoso' });
}

async function openTasks(line = 5, text = TASK_PIPELINE, host = taskHost()) {
  doc = mutableDoc(`${ROOT}/azure-pipelines-${++docNo}.yml`, text);
  return { ...(await open(line, host)), host };
}

describe('PipelineDesignerPanel: task steps', () => {
  it('lists task steps in the structure and shows the form of the step under the cursor', async () => {
    const { state, host } = await openTasks();
    const s = state();
    assert.deepEqual(s.structure.map((g: any) => [g.name, g.items.map((i: any) => [i.label, i.kind, i.index, i.selected])]), [
      ['Deploy', [['ContosoDeploy@2', 'task', 0, true], ['ContosoDeploy@2', 'task', 1, false]]],
    ]);
    assert.equal(s.call.title, 'ContosoDeploy · line 6');
    assert.equal(s.call.status, 'Contoso Deploy · Deploy · installed 2.1.0');
    assert.equal(host.tasks.ensured, 1, 'the catalog is read once a task is selected');
    assert.deepEqual(s.call.params.map((p: any) => [p.name, p.control, p.inFile, p.group ?? null]), [
      ['connection', 'text', true, null], ['mode', 'enum', false, null], ['scriptLocation', 'enum', true, null], ['inlineScript', 'multiline', true, null],
      ['verbose', 'boolean', false, 'advanced'], ['retries', 'number', true, 'advanced'],
    ]);
    assert.equal(param(s, 'inlineScript').value, 'echo one\necho two');
    assert.equal(param(s, 'connection').help, 'The service connection to use.', 'help is plain text');
    assert.equal(param(s, 'retries').value, '5');
    assert.deepEqual(s.call.task.groups, [{ name: 'advanced', label: 'Advanced', count: 2 }]);
    assert.deepEqual(s.call.task.summary.majors.map((m: any) => m.major), [2, 1]);
    assert.equal(s.call.task.summary.helpUrl, 'https://learn.contoso.example/deploy');
    assert.equal(s.call.task.displayName.value, 'Deploy web');
    assert.equal(s.call.task.displayName.placeholder, 'Contoso Deploy');
    assert.deepEqual(s.call.unknown, []);
    assert.equal(s.call.applyLabel, 'Update in pipeline');
    assert.equal(s.preview.added + s.preview.changed + s.preview.removed, 0);
    assert.equal(s.catalogMode, 'templates');
    assert.equal(s.tasks.state, 'ready');
    assert.deepEqual(s.tasks.items, [], 'the list is only sent in Tasks mode');
  });

  it('recomputes the visible inputs on each change and keeps hidden inputs that the file sets', async () => {
    const { web, state } = await openTasks();
    await web.send({ type: 'value', name: 'scriptLocation', value: 'scriptPath' });
    let s = state();
    assert.deepEqual(s.call.params.map((p: any) => p.name), ['connection', 'mode', 'scriptLocation', 'inlineScript', 'scriptPath', 'verbose', 'retries']);
    assert.equal(param(s, 'inlineScript').hidden, true);
    assert.equal(param(s, 'inlineScript').value, 'echo one\necho two', 'the file value stays');
    assert.equal(param(s, 'scriptPath').error, 'A value is required.');
    assert.equal(param(s, 'scriptPath').hidden, undefined);
    assert.match(s.call.blocking, /scriptPath/);
    await web.send({ type: 'apply' });
    assert.equal(applied.length, 0, 'a missing required input blocks the update');
    await web.send({ type: 'value', name: 'scriptPath', value: 'deploy/run.sh' });
    await web.send({ type: 'apply' });
    assert.equal(applied.length, 1);
    const lines = doc.text.split('\n');
    assert.equal(lines[9], '        scriptLocation: scriptPath');
    assert.deepEqual(lines.slice(10, 15), ['        inlineScript: |-', '          echo one', '          echo two', '        retries: 5 # keep', '        scriptPath: deploy/run.sh']);
  });

  it('writes values as line edits: keeps aliases, comments and the block header', async () => {
    const { web, state } = await openTasks();
    await web.send({ type: 'value', name: 'connection', value: 'Contoso Prod' });
    await web.send({ type: 'value', name: 'inlineScript', value: 'echo three\n\necho four' });
    await web.send({ type: 'value', name: 'retries', value: '7' });
    await web.send({ type: 'value', name: 'verbose', value: 'true' });
    const s = state();
    assert.equal(param(s, 'inlineScript').unsaved, true);
    assert.deepEqual([s.preview.added, s.preview.changed, s.preview.removed], [2, 5, 0]);
    await web.send({ type: 'apply' });
    assert.deepEqual(doc.text.split('\n').slice(5, 17), [
      '    - task: ContosoDeploy@2',
      '      displayName: Deploy web',
      '      inputs:',
      '        connectionName: Contoso Prod',
      '        scriptLocation: inlineScript',
      '        inlineScript: |-',
      '          echo three',
      '',
      '          echo four',
      '        retries: 7 # keep',
      '        verbose: true',
      '    - script: echo done',
    ]);
    assert.match(state().notices[0].title, /Updated the step ContosoDeploy@2/);
    assert.equal(state().call.title, 'ContosoDeploy · line 6', 'the step stays selected');
    assert.equal(param(state(), 'retries').unsaved, false);
  });

  it('drops values equal to the default unless Write defaults is on', async () => {
    const { web, state } = await openTasks();
    await web.send({ type: 'value', name: 'retries', value: '3' });
    assert.deepEqual([state().preview.added, state().preview.changed, state().preview.removed], [0, 0, 1]);
    await web.send({ type: 'writeDefaults', on: true });
    assert.deepEqual([state().preview.added, state().preview.changed, state().preview.removed], [2, 1, 0], 'mode and verbose are written too');
    await web.send({ type: 'apply' });
    assert.equal(doc.text.split('\n')[13], '        retries: 3 # keep');
  });

  it('changes the version on the task line only and lists inputs the new version does not know', async () => {
    const { web, state } = await openTasks();
    await web.send({ type: 'taskVersion', major: 1 });
    let s = state();
    assert.deepEqual(s.call.params.map((p: any) => p.name), ['connection']);
    assert.deepEqual(s.call.unknown, ['scriptLocation', 'inlineScript', 'retries']);
    assert.deepEqual([s.preview.added, s.preview.changed, s.preview.removed], [0, 1, 0]);
    assert.equal(s.call.task.label, 'ContosoDeploy@1');
    await web.send({ type: 'apply' });
    assert.equal(doc.text.split('\n')[5], '    - task: ContosoDeploy@1');
    assert.equal(doc.text.split('\n')[13], '        retries: 5 # keep', 'inputs stay');
    s = state();
    assert.equal(s.call.task.summary.major, 1);
    await web.send({ type: 'taskVersion', major: 2 });
    await web.send({ type: 'taskVersion', major: 1 });
    assert.equal(state().preview.changed, 0, 'back to the file version');
  });

  it('sets, changes and removes the display name', async () => {
    const { web, state } = await openTasks();
    await web.send({ type: 'taskField', name: 'displayName', value: 'Deploy: the web app' });
    assert.equal(state().call.task.displayName.unsaved, true);
    await web.send({ type: 'apply' });
    assert.equal(doc.text.split('\n')[6], "      displayName: 'Deploy: the web app'");
    await web.send({ type: 'taskField', name: 'displayName', value: '' });
    assert.deepEqual([state().preview.added, state().preview.changed, state().preview.removed], [0, 0, 1]);
    await web.send({ type: 'apply' });
    assert.equal(doc.text.split('\n')[6], '      inputs:');

    await web.send({ type: 'taskField', name: 'displayName', value: 'Fresh' });
    await web.send({ type: 'apply' });
    assert.equal(doc.text.split('\n')[6], '      displayName: Fresh');
  });

  it('shows a read-only message when the inputs are built with expressions, and reset discards changes', async () => {
    const { web, state } = await openTasks(17);
    let s = state();
    assert.equal(s.call.readOnly, 'The inputs are built with expressions (${{ }}): edit them in the text.');
    assert.equal(s.call.line, 17);
    assert.equal(s.call.params.length, 0);
    assert.equal(s.call.task.hasForm, false);
    await web.send({ type: 'apply' });
    assert.equal(applied.length, 0);
    await web.send({ type: 'open', line: 17 });
    assert.equal(shownDocs.length, 1, 'the jump opens the document');

    await web.send({ type: 'selectTask', index: 0 });
    await web.send({ type: 'value', name: 'retries', value: '9' });
    await web.send({ type: 'taskField', name: 'displayName', value: 'x' });
    await web.send({ type: 'taskVersion', major: 1 });
    await web.send({ type: 'reset' });
    s = state();
    assert.equal(param(s, 'retries').value, '5');
    assert.equal(s.call.task.displayName.value, 'Deploy web');
    assert.equal(s.call.task.summary.major, 2);
    assert.equal(s.preview.changed, 0);
  });

  it('says why a step has no form: unknown task, unknown major, expression name, no catalog data', async () => {
    const text = 'steps:\n- task: Gone@1\n- task: ContosoDeploy@9\n- task: ${{ parameters.t }}\n- task: ContosoDeploy@2\n  inputs: { connection: x }\n';
    const { web, state } = await openTasks(1, text);
    assert.equal(state().call.error, 'This task is not in the task list of contoso. Edit it in the text.');
    await web.send({ type: 'selectTask', index: 1 });
    assert.equal(state().call.error, 'Version @9 is not in the task list of contoso. Edit it in the text.');
    await web.send({ type: 'selectTask', index: 2 });
    assert.equal(state().call.readOnly, 'The task name is an expression: it is only known when the pipeline runs.');
    await web.send({ type: 'selectTask', index: 3 });
    assert.match(state().call.readOnly, /one flow mapping/);
    assert.equal(state().call.blocking, state().call.readOnly);

    const loading = taskHost({ status: 'loading' });
    const o = await openTasks(1, text, loading);
    assert.equal(o.state().call.error, 'The form appears when the task list is there.');
    const failed = taskHost({ status: 'error', error: 'HTTP 401' });
    const f = await openTasks(1, text, failed);
    assert.match(f.state().call.error, /could not be read/);
  });

  it('inserts a picked task with a chosen target list, as new lines', async () => {
    const { web, state, host } = await openTasks(0);
    await web.send({ type: 'catalogMode', mode: 'tasks' });
    assert.equal(state().catalogMode, 'tasks');
    assert.equal(host.tasks.ensured, 1);
    assert.deepEqual(state().tasks.items.map((i: any) => [i.name, i.versions.map((v: any) => v.major), i.versions.map((v: any) => v.deprecated)]), [
      ['FabrikamBuild', [1], [false]], ['ContosoDeploy', [2, 1], [false, false]], ['ContosoLegacy', [1], [true]],
    ]);
    await web.send({ type: 'pickTask', id: 'guid-ContosoDeploy', major: 2 });
    let s = state();
    assert.equal(s.call.isNew, true);
    assert.equal(s.call.title, 'New: ContosoDeploy@2');
    assert.equal(s.call.applyLabel, 'Insert into pipeline');
    assert.deepEqual(s.call.points, ['Stage Deploy › Job Web › steps', 'Stage Deploy › Job Expr › steps']);
    assert.equal(s.call.point, 1, 'the last list is the default');
    assert.deepEqual(s.structure[0].items.filter((i: any) => i.isNew).map((i: any) => [i.label, i.kind]), [['ContosoDeploy@2', 'task']]);
    assert.match(s.call.blocking, /connection/);
    await web.send({ type: 'target', index: 0 });
    await web.send({ type: 'pickTask', id: 'guid-ContosoDeploy', major: 1 });
    assert.equal(state().call.point, 0, 'picking another major keeps the target');
    await web.send({ type: 'pickTask', id: 'guid-ContosoDeploy', major: 2 });
    await web.send({ type: 'taskField', name: 'displayName', value: 'Roll out' });
    await web.send({ type: 'value', name: 'connection', value: 'Fabrikam-Prod' });
    await web.send({ type: 'value', name: 'inlineScript', value: 'echo hi\necho there' });
    s = state();
    assert.deepEqual([s.preview.added, s.preview.changed, s.preview.removed], [7, 0, 0]);
    assert.ok(s.preview.lines.some((l: any) => l.mark === '+' && l.text === '    - task: ContosoDeploy@2'));
    await web.send({ type: 'apply' });
    assert.deepEqual(doc.text.split('\n').slice(14, 24), [
      '    - script: echo done',
      '    - task: ContosoDeploy@2',
      '      displayName: Roll out',
      '      inputs:',
      '        connection: Fabrikam-Prod',
      '        inlineScript: |',
      '          echo hi',
      '          echo there',
      '  - job: Expr',
      '    steps:',
    ]);
    s = state();
    assert.match(s.notices[0].title, /Inserted the step ContosoDeploy@2/);
    assert.equal(s.call.isNew, false);
    assert.equal(s.call.title, 'ContosoDeploy · line 16', 'the inserted step is selected');
  });

  it('ignores ids, indexes and values that are not in the catalog or the document, without rendering', async () => {
    const { web, host, state } = await openTasks();
    await web.send({ type: 'catalogMode', mode: 'tasks' });
    const posted = web.posted.length;
    const ensured = host.tasks.ensured;
    const bad: any[] = [
      { type: 'pickTask', id: 'nope', major: 2 }, { type: 'pickTask', id: 'guid-ContosoDeploy', major: 7 }, { type: 'pickTask', id: 5, major: 2 },
      { type: 'pickTask', id: 'guid-ContosoDeploy', major: '2' }, { type: 'pickTask', id: 'guid-ContosoDeploy' }, { type: 'pickTask' },
      { type: 'selectTask', index: 99 }, { type: 'selectTask', index: -1 }, { type: 'selectTask', index: '0' }, { type: 'selectTask' },
      { type: 'taskVersion', major: 9 }, { type: 'taskVersion', major: '1' }, { type: 'taskVersion', major: 1.5 },
      { type: 'taskField', name: 'inputs', value: 'x' }, { type: 'taskField', name: 'displayName', value: 5 }, { type: 'taskField' },
      { type: 'catalogMode', mode: 'bogus' }, { type: 'catalogMode', mode: 'tasks' }, { type: 'catalogMode' },
    ];
    for (const m of bad) {
      await web.send(m);
    }
    assert.equal(web.posted.length, posted, 'nothing changed, nothing was rendered');
    assert.equal(host.tasks.ensured, ensured);
    assert.equal(state().call.title, 'ContosoDeploy · line 6');
    assert.equal(host.tasks.refreshed, 0);
    await web.send({ type: 'pickTask', id: 'guid-ContosoDeploy', major: 2 });
    const picked = web.posted.length;
    await web.send({ type: 'taskVersion', major: 1 });
    await web.send({ type: 'select', index: 0 });
    assert.equal(web.posted.length, picked, 'taskVersion needs a selected step, select needs a template call');
  });

  it('shows the catalog states: loading, error, stale and ready, and reloads on request', async () => {
    const host = taskHost({ status: 'loading' });
    const { web, state } = await openTasks(0, TASK_PIPELINE, host);
    await web.send({ type: 'catalogMode', mode: 'tasks' });
    assert.deepEqual([state().tasks.state, state().tasks.org, state().tasks.items.length], ['loading', 'contoso', 0]);
    host.tasks.snap = { status: 'error', error: 'HTTP 401: sign in <b>again</b>' };
    await web.send({ type: 'reloadTasks' });
    assert.equal(host.tasks.refreshed, 1);
    assert.equal(state().tasks.state, 'error');
    assert.equal(state().tasks.error, 'HTTP 401: sign in <b>again</b>', 'server text is data; the page escapes it');
    host.tasks.snap = { status: 'stale', index: INDEX, fetchedAt: NOW - 6 * 24 * 3600_000, error: 'offline' };
    await web.send({ type: 'reloadTasks' });
    assert.deepEqual([state().tasks.state, state().tasks.age, state().tasks.items.length], ['stale', '6 days ago', 3]);
    host.tasks.snap = { status: 'ready', index: INDEX, fetchedAt: NOW };
    await web.send({ type: 'reloadTasks' });
    assert.deepEqual([state().tasks.state, state().tasks.age, state().tasks.refreshing], ['ready', 'just now', false]);
    const refreshing = web.posted.filter((m: any) => m.type === 'state' && m.tasks?.refreshing);
    assert.ok(refreshing.length >= 1, 'the page shows "updating" while the reload runs');
    await web.send({ type: 'catalogMode', mode: 'templates' });
    assert.deepEqual(state().tasks.items, []);
  });

  it('renders again when the catalog changes and reads it without a task selected only in Tasks mode', async () => {
    const host = taskHost({ status: 'empty' });
    const { web, state } = await open(12, host);
    assert.equal(host.tasks.ensured, 0, 'a template call does not read the task catalog');
    host.tasks.snap = { status: 'ready', index: INDEX, fetchedAt: NOW };
    host.tasks.emitter.fire();
    await new Promise(r => setTimeout(r, 350));
    assert.equal(state().tasks.state, 'ready');
    assert.equal(web.last('state').catalogMode, 'templates');
    const empty = taskHost({ status: 'empty' });
    delete (empty as any).orgUrl;
    doc = mutableDoc(`${ROOT}/azure-pipelines-${++docNo}.yml`, PIPELINE);
    const o = await open(12, empty);
    assert.equal(o.state().tasks.state, 'error', 'no organization: not a spinner');
  });

  it('has no task features without a catalog or with taskSupport off', async () => {
    let o = await openTasks(5, TASK_PIPELINE, fakeHost() as any);
    assert.equal(o.state().tasks, undefined);
    assert.equal(o.state().catalogMode, 'templates');
    assert.deepEqual(o.state().structure.flatMap((g: any) => g.items), [], 'task steps are not listed');
    assert.equal(o.state().call, undefined);

    vscode.settings['azureDevOps.yaml.taskSupport'] = false;
    const host = taskHost();
    o = await openTasks(5, TASK_PIPELINE, host);
    assert.equal(o.state().tasks, undefined);
    assert.equal(host.tasks.ensured, 0);
    await o.web.send({ type: 'catalogMode', mode: 'tasks' });
    await o.web.send({ type: 'selectTask', index: 0 });
    await o.web.send({ type: 'pickTask', id: 'guid-ContosoDeploy', major: 2 });
    assert.equal(o.state().catalogMode, 'templates');
    assert.equal(o.state().call, undefined);
    await o.web.send({ type: 'reloadTasks' });
    assert.equal(host.tasks.refreshed, 0);
  });

  it('selects a task step from the CodeLens line and reacts to a setting change', async () => {
    const { web, state } = await openTasks(17);
    assert.equal(state().call.line, 17);
    await vscode.workspace.getConfiguration('azureDevOps').update('yaml.taskSupport', false);
    await new Promise(r => setTimeout(r, 350));
    assert.equal(web.last('state').tasks, undefined);
  });

  it('keeps inputs hidden by a rule that the file sets, with a flag, and never removes them', async () => {
    const text = TASK_PIPELINE.replace('scriptLocation: inlineScript', 'scriptLocation: scriptPath');
    const { web, state } = await openTasks(5, text);
    const s = state();
    assert.equal(param(s, 'inlineScript').hidden, true);
    assert.equal(param(s, 'scriptPath').error, 'A value is required.');
    await web.send({ type: 'value', name: 'connection', value: 'x' });
    await web.send({ type: 'value', name: 'scriptPath', value: 'a.sh' });
    await web.send({ type: 'apply' });
    assert.match(doc.text, /inlineScript: \|-/, 'the hidden input stays in the file');
  });

  it('handles CRLF documents and a last line without a line break', async () => {
    const text = 'steps:\r\n- task: ContosoDeploy@2\r\n  inputs:\r\n    connectionName: Fabrikam-Prod\r\n    scriptLocation: inlineScript\r\n    inlineScript: echo hi';
    const { web, state } = await openTasks(1, text);
    assert.equal(param(state(), 'inlineScript').value, 'echo hi');
    await web.send({ type: 'value', name: 'inlineScript', value: 'echo a\necho b' });
    await web.send({ type: 'value', name: 'retries', value: '9' });
    await web.send({ type: 'apply' });
    assert.equal(doc.text, ['steps:', '- task: ContosoDeploy@2', '  inputs:', '    connectionName: Fabrikam-Prod', '    scriptLocation: inlineScript',
      '    inlineScript: |', '      echo a', '      echo b', '    retries: 9'].join('\r\n'), 'CRLF stays, the last line has no break');
  });
});

describe('DesignerCodeLens: task steps', () => {
  it('adds "Open in Designer" above `- task:` lines unless task support or the lens is off', () => {
    const lens = new DesignerCodeLens();
    const d = mutableDoc(`${ROOT}/tasks.yml`, TASK_PIPELINE);
    const lines = (lens.provideCodeLenses(d as any) as any[]).map(l => [l.range.start.line, l.command.arguments[1]]);
    assert.deepEqual(lines, [[5, 5], [17, 17]]);
    vscode.settings['azureDevOps.yaml.taskSupport'] = false;
    assert.deepEqual(lens.provideCodeLenses(d as any), []);
    vscode.settings['azureDevOps.yaml.taskSupport'] = true;
    vscode.settings['azureDevOps.yaml.designerCodeLens'] = false;
    assert.deepEqual(lens.provideCodeLenses(d as any), []);
  });
});
