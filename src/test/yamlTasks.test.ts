import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { diagnosticSets, fakeDoc, fire, providers, Range, resetExtras } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { buildIndex } from '../pipelines/taskCatalog';
import { CatalogSnapshot, TaskInfo, TaskInput, TaskIssue } from '../pipelines/taskModel';
import {
  addInputEdit, OTHER_EXTENSION_ID, REFRESH_COMMAND, TaskCatalogSource, YamlTaskSupport,
} from '../pipelines/yamlTasks';
import { plainHelp, safeHelpUrl } from '../pipelines/taskHelp';
import { indentUnit } from '../pipelines/templateEdits';

const ORG = 'https://dev.azure.com/contoso';
const URI = vscode.Uri.file('/repo/azure-pipelines.yml');
const NOW = 1_700_000_000_000;

const input = (name: string, over: Partial<TaskInput> = {}): TaskInput => ({
  name, yamlName: name, aliases: [], label: name, required: false, type: 'string', options: [], editable: false, multi: false, ...over,
});
const task = (name: string, major: number, over: Partial<TaskInfo> = {}): TaskInfo => ({
  id: `${name}-${major}`, name, title: name, description: '', category: 'Deploy', major,
  version: `${major}.4.1`, deprecated: false, preview: false, groups: [], inputs: [], ...over,
});

const EVIL = '![logo](http://evil.example/a.png) see [docs](command:azureDevOps.refresh) <img src=x onerror=alert(1)>';
const DEPLOY2 = task('ContosoDeploy', 2, {
  title: 'Contoso <b>Deploy</b>', description: 'Deploys](command:evil) <img src=x>', helpUrl: 'https://learn.contoso.example/deploy',
  inputs: [
    input('connection', { required: true, type: 'connectedservice:azurerm' }),
    input('mode', { required: true, type: 'picklist', options: [{ value: 'fast', label: 'Fast' }, { value: 'safe', label: 'safe' }], default: '' }),
    input('scriptPath', { required: true, type: 'filepath', visibleRule: 'mode = safe', label: 'Script Path', help: 'Path of the script.' }),
    input('retries', { type: 'int', default: '3' }),
    input('verbose', { type: 'boolean', default: 'false' }),
    input('notes', { label: '<i>Notes</i>', help: EVIL }),
  ],
});
const DEPLOY1 = task('ContosoDeploy', 1, { inputs: [input('connection', { required: true })], helpUrl: 'http://insecure.example/x' });
const LEGACY = task('ContosoLegacy', 1, { deprecated: true });
const CLI3 = task('AzureCLI', 3);
const INDEX = buildIndex([DEPLOY2, DEPLOY1, LEGACY, CLI3]);

class FakeCatalog implements TaskCatalogSource {
  readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event as never;
  snap: CatalogSnapshot = { status: 'ready', index: INDEX, fetchedAt: NOW };
  gate?: Promise<CatalogSnapshot>;
  ensured = 0;
  unknown = 0;
  snapshot(): CatalogSnapshot {
    return this.snap;
  }
  ensure(): Promise<CatalogSnapshot> {
    this.ensured++;
    return this.gate ?? Promise.resolve(this.snap);
  }
  refreshForUnknownTask(): void {
    this.unknown++;
  }
}

type Doc = ReturnType<typeof makeDoc>;
function makeDoc(text: string, languageId = 'yaml', uri: vscode.Uri = URI) {
  const doc = fakeDoc(uri, text.split('\n').map(l => l.replace(/\r$/, '')), languageId);
  return Object.assign(doc, { getText: () => text, version: 1, isClosed: false });
}

let catalog: FakeCatalog;
let support: YamlTaskSupport;
const flush = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); } };

const diags = (doc: Doc) => (diagnosticSets.get('azureDevOps.tasks')?.get(String(doc.uri)) ?? []) as any[];
const labels = (items: any[] | undefined) => (items ?? []).map((i: any) => String(i.label));
const complete = (doc: Doc, line: number, col: number) => support.provideCompletionItems(doc as never, new (vscode as any).Position(line, col));
const hover = (doc: Doc, line: number, col: number) => support.provideHover(doc as never, new (vscode as any).Position(line, col));
const hoverText = (h: any | undefined) => (h?.contents as { value: string } | undefined)?.value ?? '';
const actions = (doc: Doc, d: any[]) => support.provideCodeActions(doc as never, new Range(0, 0, 0, 0) as never, { diagnostics: d } as never);

beforeEach(() => {
  resetExtras();
  vscode.reset();
  catalog = new FakeCatalog();
  support = new YamlTaskSupport(catalog, { current: { orgUrl: ORG, project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false } }, 20);
  mock.timers.enable({ apis: ['Date'], now: NOW });
});

afterEach(() => {
  support.dispose();
  mock.timers.reset();
});

describe('pure helpers', () => {
  it('plainHelp keeps link text and drops images', () => {
    assert.equal(plainHelp('See [the docs](https://x.example) and ![img](http://e/a.png) now'), 'See the docs and  now');
    assert.equal(plainHelp('open [broken](no end'), 'open [broken](no end');
    assert.equal(plainHelp('a [b] c'), 'a [b] c');
    assert.equal(plainHelp('x'.repeat(5000)).length, 800);
  });

  it('safeHelpUrl accepts https only', () => {
    assert.equal(safeHelpUrl('https://learn.contoso.example/a(b)'), 'https://learn.contoso.example/a%28b%29');
    assert.equal(safeHelpUrl('http://learn.contoso.example'), undefined);
    assert.equal(safeHelpUrl('javascript:alert(1)'), undefined);
    assert.equal(safeHelpUrl('not a url'), undefined);
    assert.equal(safeHelpUrl(undefined), undefined);
  });

  it('uses the same indentation as the designer', () => {
    // A quick fix and the designer read the same file: both use the most common step.
    const text = ['steps:', '    - task: A@1', '      displayName: A', '      inputs:', '          x: 1', '    - task: B@1', '      displayName: B'].join('\n');
    assert.equal(indentUnit(text), 4);
  });
});

describe('completion', () => {
  const NAME_DOC = 'steps:\n- task: Cont';

  it('offers one item per name and major, deprecated and retired last, and inserts the inputs', async () => {
    catalog.snap = { status: 'ready', index: buildIndex([DEPLOY2, DEPLOY1, LEGACY, task('AzureCLI', 0), CLI3]), fetchedAt: NOW };
    const items = (await complete(makeDoc(NAME_DOC), 1, 12))!;
    const sorted = [...items].sort((a, b) => a.sortText!.localeCompare(b.sortText!));
    assert.deepEqual(sorted.map(i => i.label), ['AzureCLI@3', 'ContosoDeploy@2', 'ContosoDeploy@1', 'AzureCLI@0', 'ContosoLegacy@1']);
    const byLabel = new Map(items.map(i => [String(i.label), i]));
    assert.equal(byLabel.get('AzureCLI@0')!.detail, 'retires 2026-11-24');
    assert.equal(byLabel.get('ContosoLegacy@1')!.detail, 'deprecated');
    assert.equal(byLabel.get('ContosoDeploy@1')!.detail, 'ContosoDeploy · Deploy · older major');
    assert.equal(byLabel.get('ContosoDeploy@2')!.detail, 'Contoso <b>Deploy</b> · Deploy');
    const snippet = byLabel.get('ContosoDeploy@2')!.insertText as { value: string };
    assert.equal(snippet.value, 'ContosoDeploy@2\n  inputs:\n    connection: ${1}\n    mode: ${2}');
    const range = byLabel.get('ContosoDeploy@2')!.range as Range;
    assert.deepEqual([range.start.line, range.start.character, range.end.character], [1, 8, 12]);
    assert.equal(catalog.ensured, 1);
  });

  it('inserts only the name when the step has inputs, and an empty stop without required inputs', async () => {
    const items = (await complete(makeDoc('steps:\n- task: Cont\n  inputs:\n    a: 1'), 1, 12))!;
    assert.equal(items.find(i => i.label === 'ContosoDeploy@2')!.insertText, 'ContosoDeploy@2');
    const plain = (await complete(makeDoc(NAME_DOC), 1, 12))!;
    assert.equal((plain.find(i => i.label === 'ContosoLegacy@1')!.insertText as { value: string }).value, 'ContosoLegacy@1\n  inputs:\n    $0');
  });

  it('replaces an existing @major instead of doubling it, also when a snippet with inputs is inserted', async () => {
    const line = '- task: ContosoDeploy@1';
    const items = (await complete(makeDoc(`steps:\n${line}`), 1, 14))!;
    const item = items.find(i => i.label === 'ContosoDeploy@2')!;
    const range = item.range as Range;
    const text = typeof item.insertText === 'string' ? item.insertText : (item.insertText as { value: string }).value;
    const result = line.slice(0, range.start.character) + text + line.slice(range.end.character);
    assert.ok(!result.includes('@2@1') && !result.includes('@1'), result);
    assert.ok(result.startsWith('- task: ContosoDeploy@2'), result);
    // With inputs: the step has none, so the snippet is multi-line and nothing of the old version is left behind it.
    assert.ok(result.endsWith('${2}'), result);
  });

  it('inserts only the name inside quotes and before a trailing comment', async () => {
    for (const doc of ['steps:\n- task: "Cont', "steps:\n- task: 'Cont", 'steps:\n- task: Cont # why']) {
      const items = (await complete(makeDoc(doc), 1, doc.includes('"') || doc.includes("'") ? 13 : 12))!;
      assert.equal(items.find(i => i.label === 'ContosoDeploy@2')!.insertText, 'ContosoDeploy@2', doc);
    }
  });

  it('drops names with unsafe characters and duplicates', async () => {
    catalog.snap = { status: 'ready', index: buildIndex([DEPLOY2, { ...DEPLOY2, id: 'other' }, task('Bad Name', 1), task('Evil$(x)', 1)]), fetchedAt: NOW };
    assert.deepEqual(labels(await complete(makeDoc(NAME_DOC), 1, 12)), ['ContosoDeploy@2']);
  });

  it('offers the installed majors after the @', async () => {
    const items = (await complete(makeDoc('steps:\n- task: ContosoDeploy@'), 1, 22))!;
    assert.deepEqual(items.map(i => [i.label, i.detail]), [['2', 'installed 2.4.1'], ['1', 'installed 1.4.1']]);
  });

  it('offers inputs: with the required inputs below a step', async () => {
    const items = (await complete(makeDoc('steps:\n- task: ContosoDeploy@2\n  inp'), 2, 5))!;
    assert.equal(items.length, 1);
    assert.equal((items[0].insertText as { value: string }).value, 'inputs:\n  connection: ${1}\n  mode: ${2}');
    assert.equal(items[0].detail, 'with the required 2 inputs');
    const none = (await complete(makeDoc('steps:\n- task: ContosoLegacy@1\n  inp'), 2, 5))!;
    assert.equal(none[0].detail, 'Inputs of ContosoLegacy@1');
  });

  it('offers inputs not yet passed, required first, without hidden ones', async () => {
    const doc = makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    connection: c\n    ');
    const items = (await complete(doc, 4, 4))!;
    assert.deepEqual(labels(items), ['mode', 'scriptPath', 'retries', 'verbose', 'notes'].filter(n => n !== 'scriptPath'));
    assert.equal(items.find(i => i.label === 'mode')!.detail, 'picklist (required)');
    assert.equal(items.find(i => i.label === 'mode')!.sortText, '0mode');
    assert.equal(items.find(i => i.label === 'retries')!.sortText, '1retries');
    assert.deepEqual(items.find(i => i.label === 'mode')!.command, { command: 'editor.action.triggerSuggest', title: 'Suggest values' });
    const safe = makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    mode: safe\n    ');
    assert.ok(labels(await complete(safe, 4, 4)).includes('scriptPath'));
    const docs = items.find(i => i.label === 'notes')!.documentation as { value: string };
    assert.ok(!docs.value.includes('evil.example') && !docs.value.includes('](command'));
  });

  it('offers values of pick lists and booleans', async () => {
    const mode = (await complete(makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    mode: '), 3, 10))!;
    assert.deepEqual(mode.map(i => [i.label, i.detail]), [['fast', 'Fast'], ['safe', undefined]]);
    const flag = (await complete(makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    verbose: '), 3, 13))!;
    assert.deepEqual(labels(flag), ['true', 'false']);
    assert.equal(flag[1].detail, 'default');
    const free = (await complete(makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    retries: '), 3, 13))!;
    assert.deepEqual(free, []);
    assert.equal(await complete(makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    unknown: '), 3, 14), undefined);
  });

  it('quotes values that need it', async () => {
    const odd = task('ContosoOdd', 1, { inputs: [input('mode', { type: 'picklist', options: [{ value: 'a: b', label: 'a: b' }] })] });
    catalog.snap = { status: 'ready', index: buildIndex([odd]), fetchedAt: NOW };
    const items = (await complete(makeDoc('steps:\n- task: ContosoOdd@1\n  inputs:\n    mode: '), 3, 10))!;
    assert.equal(items[0].insertText, "'a: b'");
  });

  it('returns nothing for an unknown task or outside a task step', async () => {
    assert.equal(await complete(makeDoc('steps:\n- task: Nope@1\n  inputs:\n    '), 3, 4), undefined);
    assert.equal(await complete(makeDoc('steps:\n- script: echo\n'), 1, 4), undefined);
    assert.equal(await complete(makeDoc('steps:\n- task: Nope@1\n  inp'), 2, 5), undefined);
  });

  it('shows a loading item when the catalog is still loading after the delay', async () => {
    catalog.snap = { status: 'loading' };
    catalog.gate = new Promise(() => undefined);
    const items = (await complete(makeDoc(NAME_DOC), 1, 12))!;
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Loading tasks of contoso …');
    assert.equal(items[0].insertText, '');
    assert.equal(items[0].filterText, 'Cont');
    const other = await complete(makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    mode: '), 3, 10);
    assert.equal(other, undefined);
  });

  it('returns what is there when the data arrives during the delay, and nothing without data', async () => {
    catalog.snap = { status: 'loading' };
    catalog.gate = new Promise(resolve => setTimeout(() => { catalog.snap = { status: 'ready', index: INDEX, fetchedAt: NOW }; resolve(catalog.snap); }, 5));
    assert.ok(labels(await complete(makeDoc(NAME_DOC), 1, 12)).includes('ContosoDeploy@2'));
    catalog.snap = { status: 'error', error: 'HTTP 401' };
    catalog.gate = undefined;
    assert.equal(await complete(makeDoc(NAME_DOC), 1, 12), undefined);
  });

  it('shows a generic organization name without a connection', async () => {
    support = new YamlTaskSupport(catalog, {}, 5);
    catalog.snap = { status: 'loading' };
    catalog.gate = new Promise(() => undefined);
    assert.equal((await complete(makeDoc(NAME_DOC), 1, 12))![0].label, 'Loading tasks of the organization …');
  });

  it('stays out of the way of the Microsoft extension in azure-pipelines documents', async () => {
    (vscode.extensions as any).getExtension = (id: string) => (id === OTHER_EXTENSION_ID ? { isActive: true } : undefined);
    assert.equal(await complete(makeDoc(NAME_DOC, 'azure-pipelines'), 1, 12), undefined);
    assert.ok(await complete(makeDoc(NAME_DOC, 'yaml'), 1, 12));
    assert.equal(catalog.ensured, 1);
    (vscode.extensions as any).getExtension = () => ({ isActive: false });
    assert.ok(await complete(makeDoc(NAME_DOC, 'azure-pipelines'), 1, 12));
  });

  it('is off with taskSupport false and ignores other documents', async () => {
    vscode.settings['azureDevOps.yaml.taskSupport'] = false;
    assert.equal(await complete(makeDoc(NAME_DOC), 1, 12), undefined);
    vscode.settings['azureDevOps.yaml.taskSupport'] = true;
    assert.equal(await complete(makeDoc(NAME_DOC, 'typescript'), 1, 12), undefined);
    assert.equal(catalog.ensured, 0);
  });
});

describe('hover', () => {
  it('describes the task with escaped text, version, notes and an https link', () => {
    const doc = makeDoc('steps:\n- task: ContosoDeploy@1');
    const h = hover(doc, 1, 12)!;
    const text = hoverText(h);
    assert.ok(text.startsWith('**ContosoDeploy**  `ContosoDeploy@1` · installed 1\\.4\\.1 · Deploy'));
    assert.ok(text.includes('Note: a newer major version is available: @2. Majors may break inputs.'));
    assert.ok(!text.includes('insecure.example'), 'http link dropped');
    const md = h.contents as { isTrusted?: boolean; supportHtml?: boolean };
    assert.equal(md.isTrusted, undefined);
    assert.equal(md.supportHtml, undefined);
  });

  it('escapes server text and links https help', () => {
    const text = hoverText(hover(makeDoc('steps:\n- task: ContosoDeploy@2'), 1, 12));
    assert.ok(text.includes('Contoso \\<b\\>Deploy\\</b\\>'));
    assert.ok(text.includes('Deploys\\]\\(command:evil\\) \\<img src=x\\>'));
    assert.ok(text.endsWith('[Learn more](https://learn.contoso.example/deploy)'));
    assert.ok(!text.includes('newer major'));
  });

  it('notes deprecation and retirement', () => {
    catalog.snap = { status: 'ready', index: buildIndex([LEGACY, task('AzureCLI', 0, { deprecated: true }), CLI3]), fetchedAt: NOW };
    assert.ok(hoverText(hover(makeDoc('steps:\n- task: ContosoLegacy@1'), 1, 12)).includes('Note: this task is deprecated.'));
    const cli = hoverText(hover(makeDoc('steps:\n- task: AzureCLI@0'), 1, 12));
    assert.ok(cli.includes('Note: retires 2026-11-24, removed 2027-03-15. Use AzureCLI@3.'));
    assert.ok(!cli.includes('newer major'));
    const noHint = (vscode.settings['azureDevOps.yaml.taskVersionHints'] = false, hoverText(hover(makeDoc('steps:\n- task: ContosoDeploy@1'), 1, 12)));
    assert.ok(!noHint.includes('newer major'));
  });

  it('describes an input with its condition and state, help as plain text', () => {
    const doc = makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    mode: safe\n    scriptPath: x.ps1\n    notes: n');
    const path = hoverText(hover(doc, 4, 6));
    assert.ok(path.includes('**scriptPath**  Script Path · filepath'));
    assert.ok(path.includes('Required when mode = safe \\(now: visible\\)') || path.includes('Required when mode = safe (now: visible)'));
    assert.ok(path.includes('Path of the script\\.'));
    const hidden = hoverText(hover(makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    mode: fast\n    scriptPath: x'), 4, 6));
    assert.ok(hidden.includes('now: hidden'));
    const unknown = hoverText(hover(makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    mode: $(m)\n    scriptPath: x'), 4, 6));
    assert.ok(unknown.includes('now: unknown'));
    const notes = hoverText(hover(doc, 5, 6));
    assert.ok(notes.includes('\\<i\\>Notes\\</i\\>'));
    assert.ok(notes.includes('see docs'));
    assert.ok(!notes.includes('evil.example') && !notes.includes('](command') && notes.includes('\\<img src=x onerror=alert\\(1\\)\\>'));
    const required = hoverText(hover(makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    connection: c'), 3, 6));
    assert.ok(required.includes('Required.'));
    const withDefault = hoverText(hover(makeDoc('steps:\n- task: ContosoDeploy@2\n  inputs:\n    retries: 1'), 3, 6));
    assert.ok(withDefault.includes('Default: 3') && !withDefault.includes('Required'));
  });

  it('returns nothing elsewhere or without data', () => {
    const doc = makeDoc('steps:\n- task: ContosoDeploy@2\n  displayName: x\n  inputs:\n    nope: 1');
    assert.equal(hover(doc, 1, 3), undefined);
    assert.equal(hover(doc, 2, 4), undefined);
    assert.equal(hover(doc, 4, 5), undefined);
    assert.equal(hover(doc, 0, 2), undefined);
    assert.equal(hover(makeDoc('steps:\n- task: Missing@1'), 1, 12), undefined);
    catalog.snap = { status: 'error' };
    assert.equal(hover(doc, 1, 12), undefined);
    catalog.snap = { status: 'ready', index: INDEX, fetchedAt: NOW };
    vscode.settings['azureDevOps.yaml.taskSupport'] = false;
    assert.equal(hover(makeDoc('steps:\n- task: ContosoDeploy@2'), 1, 12), undefined);
  });
});

const PIPELINE = [
  'steps:',
  '- task: ContosoDeploy@2',
  '- task: ContosoDeploy@1',
  '  inputs:',
  '    connection: c',
  '    old: x',
  '- task: ContosoLegacy@1',
  '- task: AzureCLI@0',
  '- task: NoSuchTask@1',
  '- task: ContosoDeploy@2',
  '  inputs:',
  '    connection: c',
  '    mode: zsh',
  '- script: echo',
].join('\n');

describe('diagnostics', () => {
  it('maps every issue to a diagnostic', async () => {
    const doc = makeDoc(PIPELINE);
    await support.validate(doc as never);
    const list = diags(doc);
    const byCode = (code: string) => list.filter(d => d.code === code);
    assert.deepEqual(list.map(d => d.code).sort((a, b) => String(a).localeCompare(String(b))), ['deprecated', 'invalidValue', 'missingInput', 'missingInput', 'newerMajor', 'notInstalled', 'retired', 'unknownInput']);
    assert.ok(list.every(d => d.source === 'DevOps Deck'));
    assert.equal(byCode('newerMajor')[0].severity, 2);
    assert.ok(list.filter(d => d.code !== 'newerMajor').every(d => d.severity === 1));
    assert.deepEqual(byCode('deprecated')[0].tags, [2]);
    assert.deepEqual(byCode('retired')[0].tags, [2]);
    assert.equal(byCode('notInstalled')[0].tags, undefined);
    const r = byCode('notInstalled')[0].range as Range;
    assert.deepEqual([r.start.line, r.start.character, r.end.character], [8, 8, 20]);
    assert.equal(catalog.unknown, 1, 'NoSuchTask@1 asks for a refresh');
  });

  it('respects the settings', async () => {
    const doc = makeDoc(PIPELINE);
    vscode.settings['azureDevOps.yaml.taskVersionHints'] = false;
    await support.validate(doc as never);
    assert.ok(!diags(doc).some(d => d.code === 'newerMajor'));
    vscode.settings['azureDevOps.yaml.taskDiagnostics'] = false;
    await support.validate(doc as never);
    assert.equal(diags(doc).length, 0);
    vscode.settings['azureDevOps.yaml.taskDiagnostics'] = true;
    vscode.settings['azureDevOps.yaml.taskSupport'] = false;
    await support.validate(doc as never);
    assert.equal(diags(doc).length, 0);
    assert.deepEqual(actions(doc, []), []);
  });

  it('makes no request without a task step and clears old marks', async () => {
    const doc = makeDoc(PIPELINE);
    await support.validate(doc as never);
    assert.ok(diags(doc).length > 0);
    const plain = makeDoc('steps:\n- script: echo\n- task: ${{ parameters.t }}', 'yaml', doc.uri);
    await support.validate(plain as never);
    assert.equal(diags(plain).length, 0);
    assert.equal(catalog.ensured, 1);
    await support.validate(makeDoc('steps:\n- task: A@1', 'typescript') as never);
    assert.equal(catalog.ensured, 1);
  });

  it('stays silent about missing data (auth, scope, offline): only retirement is marked', async () => {
    for (const snap of [{ status: 'error', error: 'HTTP 401: unauthorized' }, { status: 'empty' }] as CatalogSnapshot[]) {
      catalog.snap = snap;
      const doc = makeDoc(PIPELINE);
      await support.validate(doc as never);
      assert.deepEqual(diags(doc).map(d => d.code), ['retired']);
    }
    assert.equal(catalog.unknown, 0);
    assert.deepEqual(vscode.messages, []);
  });

  it('reports not-installed only for fresh data', async () => {
    const doc = makeDoc('steps:\n- task: NoSuchTask@1');
    catalog.snap = { status: 'stale', index: INDEX, fetchedAt: NOW };
    await support.validate(doc as never);
    assert.equal(diags(doc).length, 0);
    catalog.snap = { status: 'ready', index: INDEX, fetchedAt: NOW - 25 * 3600_000 };
    await support.validate(doc as never);
    assert.equal(diags(doc).length, 0);
    catalog.snap = { status: 'error', index: INDEX, fetchedAt: NOW - 3600_000, error: 'offline' };
    await support.validate(doc as never);
    assert.deepEqual(diags(doc).map(d => d.code), ['notInstalled']);
  });

  it('drops results for a changed or closed document', async () => {
    const doc = makeDoc(PIPELINE);
    let release: ((s: CatalogSnapshot) => void) | undefined;
    catalog.gate = new Promise(resolve => { release = resolve; });
    const run = support.validate(doc as never);
    doc.version = 2;
    release?.(catalog.snap);
    await run;
    assert.equal(diags(doc).length, 0);
    const closed = makeDoc(PIPELINE);
    const second = support.validate(closed as never);
    closed.isClosed = true;
    release?.(catalog.snap);
    await second;
    assert.equal(diags(closed).length, 0);
  });
});

describe('quick fixes', () => {
  async function fixes(text: string) {
    const doc = makeDoc(text);
    await support.validate(doc as never);
    const list = diags(doc);
    return { doc, list, actions: actions(doc, list) };
  }

  it('adds a missing input below the inputs of the step, with the indentation of the file', async () => {
    const { doc, actions: acts } = await fixes('steps:\n- task: ContosoDeploy@2\n  inputs:\n    connection: c\n  displayName: Deploy');
    assert.deepEqual(acts.map(a => a.title), ["Add input 'mode'"]);
    const edit = acts[0].edit as unknown as { inserts: { uri: unknown; at: { line: number; character: number }; text: string }[] };
    assert.deepEqual(edit.inserts.map(i => [i.at.line, i.at.character, i.text]), [[3, 17, '\n    mode: ']]);
    assert.equal(edit.inserts[0].uri, doc.uri);
    assert.equal(acts[0].kind, vscode.CodeActionKind.QuickFix);
    assert.equal(acts[0].diagnostics?.length, 1);
  });

  it('creates inputs: when the step has none, with CRLF line breaks', async () => {
    const { actions: acts } = await fixes('steps:\r\n- task: ContosoDeploy@2\r\n  displayName: Deploy\r\n- script: x');
    const edit = acts[0].edit as unknown as { inserts: { at: { line: number; character: number }; text: string }[] };
    assert.equal(acts[0].title, "Add input 'connection'");
    assert.deepEqual(edit.inserts.map(i => [i.at.line, i.at.character, i.text]), [[2, 21, '\r\n  inputs:\r\n    connection: ']]);
  });

  it('adds after the last line of a block scalar in a step without inputs and at the end of the file', async () => {
    const { actions: acts } = await fixes('steps:\n- task: ContosoDeploy@2');
    const edit = acts[0].edit as unknown as { inserts: { at: { line: number; character: number }; text: string }[] };
    assert.deepEqual(edit.inserts.map(i => [i.at.line, i.at.character]), [[1, 23]]);
  });

  it('raises the version of newer, deprecated and retired tasks', async () => {
    catalog.snap = { status: 'ready', index: buildIndex([DEPLOY2, DEPLOY1, task('ContosoLegacy', 2), task('ContosoLegacy', 1, { deprecated: true }), CLI3]), fetchedAt: NOW };
    const { actions: acts } = await fixes("steps:\n- task: ContosoDeploy@1\n  inputs: {connection: c}\n- task: ContosoLegacy@1\n- task: 'AzureCLI@0'");
    assert.deepEqual(acts.map(a => a.title), ['Change to ContosoDeploy@2', 'Change to ContosoLegacy@2', 'Change to AzureCLI@3']);
    const replaces = acts.map(a => (a.edit as unknown as { replaces: { range: Range; text: string }[] }).replaces[0]);
    assert.deepEqual(replaces.map(r => [r.range.start.line, r.range.start.character, r.range.end.character, r.text]),
      [[1, 8, 23, 'ContosoDeploy@2'], [3, 8, 23, 'ContosoLegacy@2'], [4, 9, 19, 'AzureCLI@3']]);
  });

  it('offers a catalog refresh for a task that is not installed', async () => {
    const { actions: acts } = await fixes('steps:\n- task: NoSuchTask@1');
    assert.equal(acts.length, 1);
    assert.equal(acts[0].title, 'Refresh task catalog');
    assert.deepEqual(acts[0].command, { command: REFRESH_COMMAND, title: 'Refresh task catalog' });
    assert.ok(REFRESH_COMMAND.startsWith('azureDevOps.'));
  });

  it('offers nothing for unknown or invalid inputs, other sources or stale diagnostics', async () => {
    const { doc, list } = await fixes('steps:\n- task: ContosoDeploy@2\n  inputs:\n    connection: c\n    mode: zsh\n    old: 1');
    assert.deepEqual(list.map(d => d.code).sort((a, b) => String(a).localeCompare(String(b))), ['invalidValue', 'unknownInput']);
    assert.deepEqual(actions(doc, list), []);
    const foreign = Object.assign(new (vscode as any).Diagnostic(new Range(1, 8, 1, 23), 'x', 1), { source: 'other', code: 'missingInput' });
    assert.deepEqual(actions(doc, [foreign]), []);
    const stale = Object.assign(new (vscode as any).Diagnostic(new Range(1, 8, 1, 23), 'x', 1), { source: 'DevOps Deck', code: 'missingInput' });
    assert.deepEqual(actions(doc, [stale]), []);
    assert.deepEqual(actions(makeDoc('steps:\n- task: A@1', 'yaml', vscode.Uri.file('/other.yml')), list), []);
  });

  describe('addInputEdit', () => {
    const issue = (over: Partial<TaskIssue> = {}): TaskIssue => ({ code: 'missingInput', severity: 'warning', message: 'm', line: 1, start: 8, end: 20, input: 'mode', ...over });

    it('uses four spaces in a four-space file and nested steps', () => {
      const text = 'jobs:\n    - job: a\n      steps:\n          - task: X@1\n            inputs:\n                a: 1\n          - script: y';
      const edit = addInputEdit(text, issue({ line: 3, input: 'b' }))!;
      assert.deepEqual([edit.line, edit.character, edit.text], [5, 20, '\n                b: ']);
    });

    it('refuses flow inputs, dynamic inputs, an unknown line and a missing name', () => {
      assert.equal(addInputEdit('steps:\n- task: X@1\n  inputs: {a: 1}', issue()), undefined);
      assert.equal(addInputEdit('steps:\n- task: X@1\n  inputs: ${{ parameters.i }}', issue()), undefined);
      assert.equal(addInputEdit('steps:\n- task: X@1', issue({ line: 0 })), undefined);
      assert.equal(addInputEdit('steps:\n- task: X@1', issue({ input: undefined })), undefined);
    });

    it('adds to an empty inputs key and ignores a trailing comment', () => {
      const edit = addInputEdit('steps:\n- task: X@1\n  inputs: # none\n  displayName: d', issue())!;
      assert.deepEqual([edit.line, edit.character, edit.text], [2, 16, '\n    mode: ']);
    });
  });
});

/** The beforeEach hook mocks only the date; these tests also need the debounce timer. */
function useTimers(): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
}

describe('registration and events', () => {
  it('registers providers, validates open documents after the delay and clears on close', async () => {
    const doc = makeDoc(PIPELINE);
    (vscode.workspace as any).textDocuments = [doc];
    useTimers();
    assert.equal(support.register(), support);
    assert.deepEqual(providers.map(p => p.kind).sort((a, b) => a.localeCompare(b)), ['codeAction', 'completion', 'hover']);
    mock.timers.tick(600);
    await flush();
    assert.ok(diags(doc).length > 0);

    (vscode.workspace as any).textDocuments = [];
    await fire('closeDoc', doc);
    assert.equal(diags(doc).length, 0);

    await fire('openDoc', doc);
    await fire('changeDoc', { document: doc });
    mock.timers.tick(600);
    await flush();
    assert.ok(diags(doc).length > 0);
    assert.equal(catalog.ensured, 2, 'one validation per debounce');
    const other = makeDoc('a: 1', 'typescript');
    await fire('openDoc', other);
    mock.timers.tick(600);
    assert.equal(catalog.ensured, 2);
  });

  it('revalidates open documents when the catalog or the settings change', async () => {
    const doc = makeDoc('steps:\n- task: ContosoDeploy@1');
    (vscode.workspace as any).textDocuments = [doc];
    support.register();
    useTimers();
    catalog.emitter.fire();
    mock.timers.tick(600);
    await flush();
    assert.equal(catalog.ensured, 1);
    await vscode.workspace.getConfiguration('azureDevOps').update('yaml.taskSupport', false);
    mock.timers.tick(600);
    await flush();
    assert.equal(diags(doc).length, 0);
    assert.equal(catalog.ensured, 1);
    await vscode.workspace.getConfiguration('azureDevOps').update('other', 1);
    mock.timers.tick(600);
    assert.equal(catalog.ensured, 1);
  });

  it('dispose cancels pending validations', async () => {
    const doc = makeDoc(PIPELINE);
    (vscode.workspace as any).textDocuments = [doc];
    useTimers();
    support.register();
    support.dispose();
    mock.timers.tick(600);
    await flush();
    assert.equal(catalog.ensured, 0);
  });
});
