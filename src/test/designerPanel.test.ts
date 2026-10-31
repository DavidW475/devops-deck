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
