import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { diagnosticSets, fakeDoc, fakeRepo, fire, openedDocs, providers, resetExtras, setFile, setGitRepositories, shownDocs } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { AdoClient } from '../client';
import { decodeContext, locationLabel, TemplateContentProvider, TemplateResolver, uriOf } from '../pipelines/templateResolver';
import { declarationLine, YamlTemplateSupport } from '../pipelines/yamlTemplates';

const TEMPLATES_ID = '11111111-2222-3333-4444-555555555555';
const TOOLS_ID = '66666666-7777-8888-9999-000000000000';
const APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const PIPELINE = [
  'resources:',
  '  repositories:',
  '  - repository: templates',
  '    type: git',
  '    name: pipeline-templates',
  '    ref: refs/tags/v2',
  'extends:',
  '  template: stages/deploy.yml@templates',
  '  parameters:',
  '    environment: dev',
  '    ',
  'steps:',
  '- template: steps/build.yml',
  '  parameters:',
  '    configuration: Release',
  '- template: missing.yml',
].join('\n');

const BUILD = 'parameters:\n- name: configuration\n  type: string\n  default: Debug\n  values: [Debug, Release]\nsteps:\n- script: dotnet build\n';

/** Remote template of pipeline-templates: includes a template of another repository it declares itself, and one of `self`. */
const DEPLOY = [
  'parameters:',
  '- name: environment',
  '  values: [staging, production]',
  '- name: runTests',
  '  type: boolean',
  '  default: true',
  'resources:',
  '  repositories:',
  '  - repository: tools',
  '    type: git',
  '    name: Contoso Web/build-tools',
  'stages:',
  '- template: jobs/test.yml@tools',
  '  parameters:',
  '    runTests: ${{ parameters.runTests }}',
  '- template: shared/notify.yml',
  '- template: steps/build.yml@self',
].join('\n');

const TEST_JOB = 'parameters:\n- name: runTests\n  type: boolean\njobs:\n- template: loop.yml\n';

let requests: { url: URL; method: string; body?: any }[];
let previewReply: () => Response;
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = new URL(String(url));
  requests.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const p = decodeURIComponent(u.pathname);
  const file = u.searchParams.get('path');
  const items: Record<string, string> = {
    [`${TEMPLATES_ID}/stages/deploy.yml`]: DEPLOY,
    [`${TEMPLATES_ID}/stages/shared/notify.yml`]: 'steps:\n- script: echo done\n',
    [`${TOOLS_ID}/jobs/test.yml`]: TEST_JOB,
    [`${TOOLS_ID}/jobs/loop.yml`]: '- template: loop.yml\n',
  };
  const repos: Record<string, unknown> = {
    '/contoso/Fabrikam Shop/_apis/git/repositories/pipeline-templates': { id: TEMPLATES_ID, name: 'pipeline-templates' },
    '/contoso/Contoso Web/_apis/git/repositories/build-tools': { id: TOOLS_ID, name: 'build-tools' },
    '/contoso/Fabrikam Shop/_apis/git/repositories/contoso-app': { id: APP_ID, name: 'contoso-app', defaultBranch: 'refs/heads/main' },
  };
  if (repos[p]) {
    return json(repos[p]);
  }
  const id = /repositories\/([0-9a-f-]{36})\/items$/.exec(p)?.[1];
  if (id && u.searchParams.get('recursionLevel') === 'Full') {
    const paths = Object.keys(items).filter(k => k.startsWith(id)).map(k => k.slice(id.length));
    return json({ value: [{ path: '/', isFolder: true }, ...paths.map(path => ({ path, gitObjectType: 'blob' })), { path: '/README.md', gitObjectType: 'blob' }] });
  }
  if (/repositories\/[0-9a-f-]{36}\/refs$/.test(p)) {
    return json({ value: u.searchParams.get('filter') === 'tags/' ? [{ name: 'refs/tags/v2' }] : [{ name: 'refs/heads/main' }] });
  }
  if (id && file) {
    const key = `${id}${file}`;
    return key in items ? json({ content: items[key] }) : json({ message: 'not found' }, 404);
  }
  if (p.endsWith('/build/definitions')) {
    return json({ value: [
      { id: 7, name: 'Contoso App CI', path: '\\', process: { type: 2, yamlFilename: 'azure-pipelines.yml' } },
      { id: 8, name: 'Classic', path: '\\', process: { type: 1 } },
    ] });
  }
  if (p.endsWith('/pipelines/7/preview')) {
    return previewReply();
  }
  return json({ message: 'unexpected' }, 500);
}

const conn = { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false };
const connections = { current: conn as typeof conn | undefined };
const client = new AdoClient({ get: async () => 'fake-pat' } as never, connections as never);
const w = vscode.window as any;
const ws = vscode.workspace as any;

function doc(path: string, text: string, languageId = 'yaml') {
  const d: any = Object.assign(fakeDoc(vscode.Uri.file(path), text.split('\n'), languageId), { version: 1, isClosed: false });
  ws.textDocuments.push(d);
  return d;
}

const pos = (line: number, character: number) => new (vscode as any).Position(line, character);
const uri = (u: unknown) => u as any;
const fileCtx = () => new TemplateResolver(client, connections).contextFor(uri(vscode.Uri.file('/work/app/azure-pipelines.yml')), PIPELINE);

beforeEach(() => {
  vscode.reset();
  resetExtras();
  requests = [];
  previewReply = () => json({ finalYaml: 'stages:\n- stage: Deploy\n' });
  globalThis.fetch = fakeFetch as typeof fetch;
  vscode.settings['azureDevOps.authMethod'] = 'pat';
  connections.current = conn;
  ws.workspaceFolders = [{ uri: vscode.Uri.file('/work/app') }];
  setFile('/work/app/.git/HEAD', 'ref: refs/heads/feature/x');
  setFile('/work/app/azure-pipelines.yml', PIPELINE);
  setFile('/work/app/steps/build.yml', BUILD);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('TemplateResolver', () => {
  it('lists the templates of a repository for the designer catalog', async () => {
    const r = new TemplateResolver(client, connections);
    const remote = { kind: 'remote' as const, project: 'Fabrikam Shop', repo: 'pipeline-templates', ref: 'refs/tags/v2' };
    const catalog = await r.catalog(remote);
    assert.deepEqual(catalog.entries.map(e => [e.path, e.kind, e.parameters.map(p => p.name)]), [['/stages/deploy.yml', 'stages', ['environment', 'runTests']]]);
    assert.equal(catalog.truncated, false);
    const list = requests.find(q => q.url.searchParams.get('recursionLevel') === 'Full')!;
    assert.equal(list.url.searchParams.get('versionDescriptor.version'), 'v2');
    const before = requests.length;
    await r.catalog(remote);
    assert.equal(requests.length, before, 'cached per repository and ref');
    await r.catalog(remote, true);
    assert.ok(requests.length > before, 'force reads again');

    const local = await r.catalog({ kind: 'local', root: '/work/app' });
    assert.deepEqual(local.entries.map(e => [e.path, e.kind]), [['/steps/build.yml', 'steps']], 'the pipeline itself declares no parameters');

    assert.deepEqual(await r.refsOf({ alias: 'templates', type: 'git', name: 'pipeline-templates' }), { tags: ['refs/tags/v2'], branches: ['refs/heads/main'] });
    assert.deepEqual(await r.refsOf({ alias: 'gh', type: 'github', name: 'contoso/tools' }), { tags: [], branches: [] });
    connections.current = undefined;
    await assert.rejects(r.refsOf({ alias: 't', type: 'git', name: 'pipeline-templates' }), /not configured/);
    await assert.rejects(r.catalog({ kind: 'remote', project: 'Nope', repo: 'missing' }));
  });

  it('finds the repository root of a local file and resolves relative templates locally', async () => {
    const r = new TemplateResolver(client, connections);
    const ctx = (await fileCtx())!;
    assert.deepEqual(ctx.location, { origin: { kind: 'local', root: '/work/app' }, path: '/azure-pipelines.yml' });
    assert.deepEqual(Object.keys(ctx.repos), ['templates']);
    const build = await r.resolve(ctx, { path: 'steps/build.yml' });
    assert.deepEqual(build.parameters.map(p => p.name), ['configuration']);
    assert.equal(build.uri.toString(), 'file:///work/app/steps/build.yml');
    assert.equal(build.label, 'steps/build.yml · app (local)');
    assert.equal(requests.length, 0);
    await assert.rejects(r.resolve(ctx, { path: 'missing.yml' }), /\/work\/app\/missing\.yml does not exist/);
    await assert.rejects(r.resolve(ctx, { path: 'x.yml', alias: 'constructor' }), /'constructor' is not declared/);
  });

  it('reads open documents with their unsaved changes', async () => {
    doc('/work/app/steps/build.yml', 'parameters:\n- name: changedLocally\n');
    const build = await new TemplateResolver(client, connections).resolve((await fileCtx())!, { path: '/steps/build.yml' });
    assert.deepEqual(build.parameters.map(p => p.name), ['changedLocally']);
  });

  it('reads templates of repository resources from Azure Repos at their ref, recursively with inherited aliases', async () => {
    const r = new TemplateResolver(client, connections);
    const deploy = await r.resolve((await fileCtx())!, { path: 'stages/deploy.yml', alias: 'templates' });
    assert.deepEqual(deploy.parameters.map(p => p.name), ['environment', 'runTests']);
    assert.equal(deploy.label, 'stages/deploy.yml · pipeline-templates@v2');
    const item = requests.find(q => q.url.pathname.endsWith('/items'))!;
    assert.equal(item.url.searchParams.get('versionDescriptor.version'), 'v2');
    assert.equal(item.url.searchParams.get('versionDescriptor.versionType'), 'tag');
    assert.equal(item.url.searchParams.get('path'), '/stages/deploy.yml');
    assert.deepEqual(Object.keys(deploy.context.repos).sort((a, b) => a.localeCompare(b)), ['templates', 'tools']);

    // A template of a third repository, declared in the remote template itself and in another project.
    const test = await r.resolve(deploy.context, { path: 'jobs/test.yml', alias: 'tools' });
    assert.deepEqual(test.parameters.map(p => [p.name, p.default]), [['runTests', undefined]]);
    assert.equal(requests.at(-1)!.url.searchParams.get('versionDescriptor.version'), null);
    // Relative paths stay in the repository of the including template; @self is the pipeline's repository.
    const notify = await r.resolve(deploy.context, { path: 'shared/notify.yml' });
    assert.equal(notify.context.location.origin.kind, 'remote');
    const self = await r.resolve(deploy.context, { path: 'steps/build.yml', alias: 'self' });
    assert.equal(self.uri.toString(), 'file:///work/app/steps/build.yml');

    const before = requests.length;
    await r.resolve((await fileCtx())!, { path: 'stages/deploy.yml', alias: 'templates' });
    assert.equal(requests.length, before, 'cached');
    r.invalidate();
    await r.resolve((await fileCtx())!, { path: 'stages/deploy.yml', alias: 'templates' });
    assert.ok(requests.length > before);
  });

  it('explains missing files, undeclared aliases and external repositories', async () => {
    const r = new TemplateResolver(client, connections);
    const ctx = (await fileCtx())!;
    await assert.rejects(r.resolve(ctx, { path: 'nope.yml', alias: 'templates' }), /nope\.yml was not found in Fabrikam Shop\/pipeline-templates at refs\/tags\/v2/);
    await assert.rejects(r.resolve(ctx, { path: 'x.yml', alias: 'other' }), /'other' is not declared/);
    assert.throws(() => r.originOf({ alias: 'gh', type: 'github', name: 'contoso/build-tools' }), /github repository: open a clone/);
    connections.current = undefined;
    assert.throws(() => r.originOf({ alias: 't', type: 'git', name: 'pipeline-templates' }), /not configured/);
  });

  it('prefers local clones and finds aliases declared elsewhere in the workspace', async () => {
    setGitRepositories([fakeRepo('/work/pipeline-templates', 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/pipeline-templates')]);
    ws.workspaceFolders.push({ uri: vscode.Uri.file('/work/build-tools') });
    const r = new TemplateResolver(client, connections);
    assert.deepEqual(r.originOf({ alias: 't', type: 'git', name: 'pipeline-templates' }), { kind: 'local', root: '/work/pipeline-templates' });
    assert.deepEqual(r.originOf({ alias: 'gh', type: 'github', name: 'contoso/build-tools' }), { kind: 'local', root: '/work/build-tools' });
    vscode.settings['azureDevOps.yaml.preferLocalRepositories'] = false;
    assert.equal(r.originOf({ alias: 't', type: 'git', name: 'pipeline-templates' }).kind, 'remote');

    // A template opened on its own does not declare `templates`; the pipeline in the workspace does.
    const ctx = (await r.contextFor(uri(vscode.Uri.file('/work/app/steps/build.yml')), BUILD))!;
    const deploy = await r.resolve(ctx, { path: 'stages/deploy.yml', alias: 'templates' });
    assert.deepEqual(deploy.parameters.map(p => p.name), ['environment', 'runTests']);
  });

  it('walks the whole template tree and stops at cycles', async () => {
    const r = new TemplateResolver(client, connections);
    const nodes = await r.tree((await fileCtx())!, PIPELINE);
    assert.deepEqual(nodes.map(n => [n.label, n.error]), [
      ['stages/deploy.yml@templates', undefined],
      ['steps/build.yml', undefined],
      ['missing.yml', '/work/app/missing.yml does not exist.'],
    ]);
    const deploy = nodes[0].children;
    assert.deepEqual(deploy.map(n => n.label), ['jobs/test.yml@tools', 'shared/notify.yml', 'steps/build.yml@self']);
    const loop = deploy[0].children[0];
    assert.equal(loop.label, 'loop.yml');
    assert.equal(loop.children[0].error, 'Includes itself (cycle)');
    const dynamic = await r.tree((await fileCtx())!, '- template: ${{ parameters.file }}\n');
    assert.match(dynamic[0].error!, /Expression/);
  });

  it('round-trips the context through ado-template URIs and rejects crafted ones', async () => {
    const r = new TemplateResolver(client, connections);
    const deploy = await r.resolve((await fileCtx())!, { path: 'stages/deploy.yml', alias: 'templates' });
    assert.equal(deploy.uri.scheme, 'ado-template');
    assert.equal(deploy.uri.path, '/Fabrikam Shop/pipeline-templates/stages/deploy.yml');
    const back = decodeContext(deploy.uri.query)!;
    assert.deepEqual(back.location, deploy.context.location);
    assert.deepEqual(back.self, { kind: 'local', root: '/work/app' });
    assert.equal(uriOf(back).toString(), deploy.uri.toString());
    const ctx = (await r.contextFor(deploy.uri, DEPLOY))!;
    assert.ok(ctx.repos.tools && ctx.repos.templates);
    assert.equal(await new TemplateContentProvider(r).provideTextDocumentContent(deploy.uri), DEPLOY);

    const crafted = (patch: object) => JSON.stringify({ ...JSON.parse(deploy.uri.query), ...patch });
    assert.equal(decodeContext('not json'), undefined);
    assert.equal(decodeContext(crafted({ self: { kind: 'local', root: '/etc' } })), undefined);
    assert.equal(decodeContext(crafted({ location: { origin: { kind: 'remote', project: 'P', repo: 'r' }, path: '/../x' } })), undefined);
    assert.deepEqual(decodeContext(crafted({ repos: { a: { name: 'n', type: 'git', ref: 1 }, b: null } }))!.repos,
      { a: { alias: 'a', name: 'n', type: 'git', ref: undefined } });
    const proto = decodeContext(crafted({ repos: JSON.parse('{"__proto__": {"name": "n", "type": "git"}}') }))!.repos;
    assert.equal(Object.getPrototypeOf(proto), Object.prototype);
    assert.deepEqual(Object.keys(proto), ['__proto__']);
    await assert.rejects(new TemplateContentProvider(r).provideTextDocumentContent(uri(vscode.Uri.from({ scheme: 'ado-template', path: '/x', query: '{}' }))), /Invalid/);
    assert.equal(await r.contextFor(uri(vscode.Uri.from({ scheme: 'untitled', path: 'x' })), ''), undefined);
    assert.equal(locationLabel({ origin: { kind: 'remote', project: 'P', repo: 'r' }, path: '/a.yml' }), 'a.yml · r');
  });
});

describe('YamlTemplateSupport', () => {
  const provider = (kind: string) => providers.find(p => p.kind === kind)!.provider;
  let support: YamlTemplateSupport;
  beforeEach(() => {
    support = new YamlTemplateSupport(client, connections).register();
  });
  afterEach(() => support.dispose());

  it('suggests parameters that are not passed yet, required first, and allowed values', async () => {
    const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
    const names = await provider('completion').provideCompletionItems(d, pos(10, 4));
    assert.deepEqual(names.map((i: any) => [i.label, i.detail, i.insertText.value]), [['runTests', 'boolean', 'runTests: ${1|true,false|}']]);
    const values = await provider('completion').provideCompletionItems(d, pos(9, 17));
    assert.deepEqual(values.map((i: any) => i.label), ['staging', 'production']);
    const build = await provider('completion').provideCompletionItems(d, pos(14, 19));
    assert.deepEqual(build.map((i: any) => [i.label, i.detail]), [['Debug', 'default'], ['Release', undefined]]);
    assert.equal(await provider('completion').provideCompletionItems(d, pos(0, 3)), undefined);
  });

  it('offers a parameters block with the required parameters', async () => {
    const d = doc('/work/app/ci.yml', 'steps:\n- template: stages/deploy.yml@templates\n  \n' + PIPELINE.slice(0, PIPELINE.indexOf('extends:')));
    const [item] = await provider('completion').provideCompletionItems(d, pos(2, 2));
    assert.equal(item.label, 'parameters');
    assert.equal(item.insertText.value, 'parameters:\n  environment: ${1|staging,production|}');
    assert.equal(item.detail, 'with the required 1 parameter');
  });

  it('completes aliases after @ and local YAML files', async () => {
    const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
    const aliases = await provider('completion').provideCompletionItems(d, pos(7, 30));
    assert.deepEqual(aliases.map((i: any) => [i.label, i.detail]), [['self', 'Repository of the pipeline'], ['templates', 'git: pipeline-templates']]);
    const local = await provider('completion').provideCompletionItems(d, pos(12, 13));
    assert.deepEqual(local.map((i: any) => i.label), ['steps/build.yml']);
  });

  it('shows the template and its parameters on hover', async () => {
    const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
    const hover = await provider('hover').provideHover(d, pos(7, 15));
    assert.match(hover.contents.value, /pipeline\\-templates@v2/);
    assert.match(hover.contents.value, /\*\*environment\*\*: `string` · \*\*required\*\* · values: `staging`, `production`/);
    assert.match(hover.contents.value, /Includes `jobs\/test\.yml@tools`, `shared\/notify\.yml`, `steps\/build\.yml@self`/);
    const param = await provider('hover').provideHover(d, pos(14, 6));
    assert.match(param.contents.value, /\*\*configuration\*\*: `string` · default: `Debug`/);
    const missing = await provider('hover').provideHover(d, pos(15, 14));
    assert.match(missing.contents.value, /\$\(warning\) .*missing\\\.yml does not exist/);
    assert.equal(await provider('hover').provideHover(d, pos(0, 1)), undefined);
  });

  it('goes to the template and to the declaration of a parameter', async () => {
    const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
    const file = await provider('definition').provideDefinition(d, pos(12, 14));
    assert.equal(file.uri.toString(), 'file:///work/app/steps/build.yml');
    assert.equal(file.range.line, 0);
    const param = await provider('definition').provideDefinition(d, pos(9, 6));
    assert.equal(param.uri.scheme, 'ado-template');
    assert.equal(param.range.line, 1);
    assert.equal(await provider('definition').provideDefinition(d, pos(15, 14)), undefined);
    assert.equal(declarationLine('parameters:\n  legacy: 1\n', 'legacy'), 1);
    assert.equal(declarationLine('steps: []\n', 'x'), 0);
  });

  it('reports parameter problems and unresolvable templates as diagnostics', async () => {
    const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
    await support.validate(d);
    const list = diagnosticSets.get('azureDevOps.templates')!.get(String(d.uri)) as any[];
    assert.deepEqual(list.map(x => [x.severity, x.range.start.line, x.message, x.source]), [
      [0, 9, "'dev' is not an allowed value of 'environment'. Allowed: staging, production", 'DevOps Deck'],
      [1, 15, '/work/app/missing.yml does not exist.', 'DevOps Deck'],
    ]);
    vscode.settings['azureDevOps.yaml.templateDiagnostics'] = false;
    await support.validate(d);
    assert.equal(diagnosticSets.get('azureDevOps.templates')!.get(String(d.uri)), undefined);
  });

  it('stays quiet about remote templates when not signed in', async () => {
    vscode.settings['azureDevOps.authMethod'] = 'pat';
    const unauthorized = new TemplateResolver(new AdoClient({ get: async () => undefined } as never, connections as never), connections);
    (support as any).resolver = unauthorized;
    const d = doc('/work/app/azure-pipelines.yml', 'extends:\n  template: stages/deploy.yml@templates\n' + PIPELINE.slice(0, PIPELINE.indexOf('extends:')));
    await support.validate(d);
    assert.deepEqual(diagnosticSets.get('azureDevOps.templates')!.get(String(d.uri)), []);
  });

  it('validates documents shortly after they open or change', async () => {
    const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
    await fire('openDoc', d);
    await fire('changeDoc', { document: d });
    await fire('openDoc', fakeDoc(vscode.Uri.file('/work/app/readme.md'), ['# x'], 'markdown'));
    await new Promise(r => setTimeout(r, 700));
    assert.equal((diagnosticSets.get('azureDevOps.templates')!.get(String(d.uri)) as unknown[]).length, 2);
    await fire('saveDoc', d);
    await fire('closeDoc', d);
    assert.equal(diagnosticSets.get('azureDevOps.templates')!.get(String(d.uri)), undefined);
  });

  it('lists the template tree and opens the picked template', async () => {
    const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
    w.activeTextEditor = { document: d };
    let shown: any[] = [];
    w.showQuickPick = async (items: any[]) => { shown = items; return items[1]; };
    await support.showTemplates();
    assert.deepEqual(shown.map(i => i.label).slice(0, 3),
      ['$(file-code) stages/deploy.yml@templates', ' $(file-code) jobs/test.yml@tools', '  $(file-code) loop.yml']);
    assert.equal(shown.at(-1).label, '$(warning) missing.yml');
    assert.equal(String(openedDocs.at(-1)), String(shown[1].node.resolved.uri));
    assert.equal(shownDocs.length, 1);

    w.activeTextEditor = { document: doc('/work/app/plain.yml', 'steps: []') };
    await support.showTemplates();
    assert.match(vscode.messages.at(-1)!, /plain\.yml includes no templates/);
    w.activeTextEditor = undefined;
    await support.showTemplates();
    assert.match(vscode.messages.at(-1)!, /Open an Azure Pipelines YAML file/);
  });

  describe('previewPipeline', () => {
    beforeEach(() => {
      setGitRepositories([fakeRepo('/work/app', 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/contoso-app', 'feature/x')]);
    });

    it('expands the pipeline on the server with the local file content', async () => {
      const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
      w.activeTextEditor = { document: d };
      await support.previewPipeline();
      const call = requests.find(q => q.url.pathname.endsWith('/preview'))!;
      assert.equal(call.method, 'POST');
      assert.equal(call.body.yamlOverride, PIPELINE);
      assert.equal(call.body.resources.repositories.self.refName, 'refs/heads/feature/x');
      const defs = requests.find(q => q.url.pathname.endsWith('/build/definitions'))!;
      assert.equal(defs.url.searchParams.get('repositoryId'), APP_ID);
      const opened = openedDocs.at(-1) as { language: string; content: string };
      assert.equal(opened.language, 'yaml');
      assert.match(opened.content, /^# Expanded by Azure DevOps for "Contoso App CI" at feature\/x/);
      assert.match(opened.content, /- stage: Deploy/);
    });

    it('marks the errors Azure DevOps reports in this file', async () => {
      previewReply = () => json({ message: '/azure-pipelines.yml (Line: 10, Col: 5): Unexpected value \'dev\'\n/stages/deploy.yml (Line: 1, Col: 1): Other' }, 400);
      const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
      await support.previewPipeline(d.uri as any);
      const list = diagnosticSets.get('azureDevOps.pipelinePreview')!.get(String(d.uri)) as any[];
      assert.deepEqual(list.map(x => [x.range.start.line, x.range.start.character, x.message]), [[9, 4, "Unexpected value 'dev'"]]);
      assert.match(vscode.messages.at(-1)!, /could not expand the pipeline \(2 errors\): \/azure-pipelines\.yml \(line 10\): Unexpected value 'dev'/);
      await fire('changeDoc', { document: d });
      assert.equal(diagnosticSets.get('azureDevOps.pipelinePreview')!.get(String(d.uri)), undefined);
    });

    it('asks for the pipeline when no definition uses the file', async () => {
      const d = doc('/work/app/other.yml', 'steps: []');
      w.activeTextEditor = { document: d };
      let title = '';
      w.showQuickPick = async (items: any[], o: any) => { title = o.title; return items[0]; };
      await support.previewPipeline();
      assert.equal(title, 'No pipeline uses other.yml: expand it as');
      assert.ok(requests.some(q => q.url.pathname.endsWith('/pipelines/7/preview')));
      w.showQuickPick = async () => undefined;
      requests = [];
      await support.previewPipeline();
      assert.ok(!requests.some(q => q.url.pathname.endsWith('/preview')));
    });

    it('expands on the server with parameters and a known pipeline, and locally through the resolver', async () => {
      const d = doc('/work/app/azure-pipelines.yml', PIPELINE);
      const res = await support.expandOnServer(d, { environment: 'production' }, 7);
      assert.deepEqual(res, { yaml: 'stages:\n- stage: Deploy\n', definition: { id: 7, name: 'Contoso App CI' }, branch: 'feature/x', filePath: '/azure-pipelines.yml' });
      const call = requests.find(q => q.url.pathname.endsWith('/preview'))!;
      assert.deepEqual(call.body.templateParameters, { environment: 'production' });

      const local = await support.expandLocally(d, { });
      assert.ok(local.files >= 3);
      assert.deepEqual(local.doc.stages, [], 'the test templates are job and step templates used under stages');
      assert.ok(local.warnings.includes('jobs/test.yml · build-tools: contains jobs, but is used as a stages template.'));
      assert.ok(local.warnings.some(w => w.includes("'dev' is not an allowed value of 'environment'")));
      await assert.rejects(support.expandLocally(Object.assign(fakeDoc(uri(vscode.Uri.from({ scheme: 'untitled', path: 'x' })), ['a: 1']), { version: 1 }) as any),
        /Open a local Azure Pipelines YAML file/);
      await assert.rejects(support.expandOnServer(Object.assign(fakeDoc(uri(vscode.Uri.from({ scheme: 'untitled', path: 'x' })), ['a: 1']), { version: 1 }) as any),
        /Open a local Azure Pipelines YAML file/);
    });

    it('needs a local Azure Repos clone', async () => {
      setGitRepositories([]);
      w.activeTextEditor = { document: doc('/work/app/azure-pipelines.yml', PIPELINE) };
      await support.previewPipeline();
      assert.match(vscode.messages.at(-1)!, /not in a clone of an Azure Repos repository/);
      w.activeTextEditor = undefined;
      await support.previewPipeline();
      assert.match(vscode.messages.at(-1)!, /Open a local Azure Pipelines YAML file/);
    });
  });
});
