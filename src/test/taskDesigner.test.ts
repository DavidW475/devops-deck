import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildIndex } from '../pipelines/taskCatalog';
import { CatalogSnapshot, TaskInfo, TaskInput } from '../pipelines/taskModel';
import {
  ageText, buildTaskForm, orgLabel, planNewTask, planTaskStep, taskListItems, taskListState, taskSummary, versionNote,
} from '../pipelines/taskDesigner';
import { asTemplateRef, findTaskSteps } from '../pipelines/taskRefs';
import { applyLineEdits } from '../pipelines/templateEdits';

const NOW = 1_700_000_000_000;
const tin = (name: string, over: Partial<TaskInput> = {}): TaskInput => ({
  name, yamlName: over.aliases?.[0] ?? name, aliases: [], label: name, required: false, type: 'string', options: [], editable: false, multi: false, ...over,
});
const task = (name: string, major: number, over: Partial<TaskInfo> = {}): TaskInfo => ({
  id: `guid-${name}`, name, title: name, description: 'Deploys', category: 'Deploy', major, version: `${major}.4.1`, deprecated: false, preview: false,
  groups: [{ name: 'advanced', label: 'Advanced', visibleRule: 'mode != off' }], inputs: [], ...over,
});
const DEPLOY = task('ContosoDeploy', 2, {
  helpUrl: 'https://learn.contoso.example/x',
  inputs: [
    tin('connectionName', { aliases: ['connection'], required: true, help: 'See [docs](https://x.example) <b>now</b>' }),
    tin('mode', { type: 'picklist', options: [{ value: 'fast', label: 'Fast' }, { value: 'off', label: 'Off' }], default: 'fast' }),
    tin('script', { type: 'multiline', required: true, visibleRule: 'mode = fast' }),
    tin('retries', { type: 'int', default: '3', group: 'advanced' }),
    tin('verbose', { type: 'boolean', default: 'false', group: 'advanced' }),
    tin('region', { group: 'other' }),
  ],
});
const OLD = task('ContosoDeploy', 1, { inputs: [tin('connectionName', { aliases: ['connection'], required: true })] });
const LEGACY = task('ContosoLegacy', 1, { deprecated: true });
const INDEX = buildIndex([DEPLOY, OLD, LEGACY, task('AzureCLI', 0), task('Zed', 1, { title: 'A first', description: 'x'.repeat(400) })]);

describe('task list', () => {
  it('gives one short item per task, majors highest first, deprecated flagged, sorted by title', () => {
    const items = taskListItems(INDEX);
    assert.deepEqual(items.map(i => [i.id, i.title]), [['guid-Zed', 'A first'], ['guid-AzureCLI', 'AzureCLI'], ['guid-ContosoDeploy', 'ContosoDeploy'], ['guid-ContosoLegacy', 'ContosoLegacy']]);
    assert.deepEqual(items[2].versions, [{ major: 2, version: '2.4.1', deprecated: false, retires: undefined }, { major: 1, version: '1.4.1', deprecated: false, retires: undefined }]);
    assert.equal(items[3].versions[0].deprecated, true);
    assert.equal(items[0].description.length, 160, 'long descriptions are cut: the page gets short items');
    assert.equal(taskListItems(INDEX), items, 'cached per index');
  });

  it('flags tasks from the retirement table with their date', () => {
    const retired = buildIndex([task('AzureCLI', 0), task('AzureCLI', 3)]);
    const item = taskListItems(retired)[0];
    assert.equal(item.versions.find(v => v.major === 0)?.deprecated, true);
    assert.match(item.versions.find(v => v.major === 0)?.retires ?? '', /^\d{4}-\d\d-\d\d$/);
    assert.equal(item.versions.find(v => v.major === 3)?.deprecated, false);
  });

  it('says how old the data is', () => {
    assert.equal(ageText(undefined, NOW), 'never');
    assert.equal(ageText(NOW - 10_000, NOW), 'just now');
    assert.equal(ageText(NOW + 10_000, NOW), 'just now');
    assert.equal(ageText(NOW - 5 * 60_000, NOW), '5 min ago');
    assert.equal(ageText(NOW - 2 * 3600_000, NOW), '2 h ago');
    assert.equal(ageText(NOW - 47 * 3600_000, NOW), '47 h ago');
    assert.equal(ageText(NOW - 6 * 24 * 3600_000, NOW), '6 days ago');
  });

  it('names the organization', () => {
    assert.equal(orgLabel('https://dev.azure.com/contoso'), 'contoso');
    assert.equal(orgLabel('https://dev.azure.com/'), 'dev.azure.com');
    assert.equal(orgLabel('https://fabrikam.visualstudio.com'), 'fabrikam');
    assert.equal(orgLabel('not a url'), '');
    assert.equal(orgLabel(undefined), '');
  });

  it('maps catalog snapshots to loading, ready, stale and error', () => {
    const url = 'https://dev.azure.com/contoso';
    const ready = taskListState({ status: 'ready', index: INDEX, fetchedAt: NOW - 3600_000 }, NOW, url, false);
    assert.deepEqual([ready.state, ready.age, ready.refreshing, ready.org, ready.items.length], ['ready', '1 h ago', false, 'contoso', 4]);
    assert.equal(taskListState({ status: 'ready', index: INDEX, fetchedAt: NOW }, NOW, url, false, false).items.length, 0);
    assert.equal(taskListState({ status: 'ready', index: INDEX, fetchedAt: NOW }, NOW, url, true).refreshing, true);
    assert.equal(taskListState({ status: 'loading', index: INDEX, fetchedAt: NOW }, NOW, url, false).refreshing, true);
    const stale = taskListState({ status: 'stale', index: INDEX, fetchedAt: NOW - 6 * 24 * 3600_000, error: 'offline' }, NOW, url, false);
    assert.deepEqual([stale.state, stale.age, stale.items.length], ['stale', '6 days ago', 4]);
    const none: CatalogSnapshot = { status: 'error', error: 'HTTP 401' };
    assert.deepEqual([taskListState(none, NOW, url, false).state, taskListState(none, NOW, url, false).error], ['error', 'HTTP 401']);
    assert.equal(taskListState({ status: 'error' }, NOW, url, false).error, 'Loading the tasks failed.');
    assert.equal(taskListState({ status: 'loading' }, NOW, url, false).state, 'loading');
    assert.equal(taskListState({ status: 'empty' }, NOW, url, false).state, 'loading');
    assert.match(taskListState({ status: 'empty' }, NOW, undefined, false).error ?? '', /No Azure DevOps organization/);
  });
});

describe('task summary and version note', () => {
  it('summarizes the task with its majors and a safe help link', () => {
    const s = taskSummary(INDEX, DEPLOY, true);
    assert.deepEqual([s.name, s.major, s.version, s.deprecated, s.helpUrl], ['ContosoDeploy', 2, '2.4.1', false, 'https://learn.contoso.example/x']);
    assert.deepEqual(s.majors.map(m => m.major), [2, 1]);
    assert.equal(taskSummary(INDEX, { ...DEPLOY, helpUrl: 'http://insecure.example' }, true).helpUrl, undefined);
  });

  it('notes a newer major as a hint, deprecation and retirement as warnings', () => {
    assert.deepEqual(versionNote(INDEX, OLD, true), { level: 'info', text: '@2 is available (majors may break inputs)' });
    assert.equal(versionNote(INDEX, OLD, false), undefined);
    assert.equal(versionNote(INDEX, DEPLOY, true), undefined);
    assert.deepEqual(versionNote(INDEX, LEGACY, true), { level: 'warn', text: 'This task is deprecated.' });
    const idx = buildIndex([task('ContosoDeploy', 1, { deprecated: true }), task('ContosoDeploy', 2)]);
    assert.deepEqual(versionNote(idx, idx.find('ContosoDeploy', 1)!, false), { level: 'warn', text: 'This task is deprecated. Use @2.' });
    const retiring = buildIndex([task('AzureCLI', 0), task('AzureCLI', 3)]);
    const note = versionNote(retiring, retiring.find('AzureCLI', 0)!, false);
    assert.equal(note?.level, 'warn');
    assert.match(note?.text ?? '', /^Retires \d{4}-\d\d-\d\d, removed \d{4}-\d\d-\d\d\. Use AzureCLI@\d\.$/);
    assert.equal(taskSummary(retiring, retiring.find('AzureCLI', 0)!, false).deprecated, true);
  });
});

describe('task form', () => {
  const TEXT = [
    'steps:', '- task: ContosoDeploy@2', '  inputs:', '    connectionName: Fabrikam-Prod', '    mode: fast', '    script: |', '      echo hi',
    '    retries: $(retryCount)', '    verbose: $(flag)', '    wrong: 1',
  ].join('\n');
  const step = () => findTaskSteps(TEXT)[0];
  const form = (pending: Record<string, string> = {}, text = TEXT) => {
    const st = findTaskSteps(text)[0];
    return buildTaskForm(text, DEPLOY, st, asTemplateRef(st, DEPLOY), pending);
  };

  it('shows visible inputs in order with plain help, groups and the input type', () => {
    const f = form();
    assert.deepEqual(f.rows.map(r => [r.name, r.control, r.value, r.group ?? null]), [
      ['connection', 'text', 'Fabrikam-Prod', null], ['mode', 'enum', 'fast', null], ['script', 'multiline', 'echo hi', null],
      ['retries', 'text', '$(retryCount)', 'advanced'], ['verbose', 'text', '$(flag)', 'advanced'], ['region', 'text', '', 'other'],
    ]);
    assert.equal(f.rows[0].help, 'See docs now'.replace('now', '<b>now</b>'), 'links lose their markup; the page escapes the rest');
    assert.equal(f.rows[0].typeLabel, 'string');
    assert.deepEqual(f.groups, [{ name: 'advanced', label: 'Advanced', count: 2 }, { name: 'other', label: 'other', count: 1 }]);
    assert.deepEqual(f.unknown, ['wrong']);
    assert.deepEqual(f.declared.map(p => p.name), f.rows.map(r => r.name));
  });

  it('shows expression values as text instead of a switch or a number box', () => {
    const f = form();
    assert.equal(f.rows.find(r => r.name === 'verbose')?.control, 'text');
    assert.equal(f.rows.find(r => r.name === 'retries')?.error, undefined, 'expressions are not judged');
  });

  it('recomputes visibility with pending values: hides inputs, keeps hidden ones the file sets (flagged), drops hidden new ones', () => {
    const hidden = form({ mode: 'off' });
    const script = hidden.rows.find(r => r.name === 'script')!;
    assert.deepEqual([script.hidden, script.value, script.error], [true, 'echo hi', undefined]);
    assert.deepEqual(hidden.rows.filter(r => r.group === 'advanced').map(r => r.hidden), [true, true], 'the group rule hides its inputs, the file sets them');
    const barehidden = form({ mode: 'off' }, 'steps:\n- task: ContosoDeploy@2\n');
    assert.ok(!barehidden.rows.some(r => r.group === 'advanced'));
    const bare = 'steps:\n- task: ContosoDeploy@2\n';
    const fresh = form({ mode: 'off' }, bare);
    assert.ok(!fresh.rows.some(r => r.name === 'script'), 'hidden and not in the file: not shown');
    assert.ok(!fresh.declared.some(p => p.name === 'script'), 'and never written');
    const shown = form({}, bare);
    assert.equal(shown.rows.find(r => r.name === 'script')?.error, 'A value is required.');
  });

  it('judges values against the input, case-insensitively, and only the ones that can be judged', () => {
    assert.match(form({ mode: 'slow' }).rows[1].error ?? '', /not an allowed value: fast, off/);
    assert.equal(form({ mode: 'FAST' }).rows[1].error, undefined);
    const text = 'steps:\n- task: ContosoDeploy@2\n  inputs:\n    connectionName: x\n    mode: fast\n    script: a\n';
    assert.match(form({ retries: '2.5' }, text).rows.find(r => r.name === 'retries')?.error ?? '', /whole number/);
    assert.match(form({ verbose: 'maybe' }, text).rows.find(r => r.name === 'verbose')?.error ?? '', /boolean/);
    assert.equal(form({ verbose: 'TRUE', retries: '4' }, text).rows.find(r => r.name === 'verbose')?.error, undefined);
    assert.equal(form({ connection: '' }, text).rows[0].error, 'A value is required.', 'clearing a required input is an error');
    assert.equal(form({}, text).rows[0].error, undefined);
    assert.equal(form({}, text.replace('connectionName: x', 'other: x')).rows[0].error, 'A value is required.');
  });

  it('does not require an input whose rule cannot be decided (like the diagnostics), and does not write it', () => {
    const t = task('ContosoRule', 1, { inputs: [tin('mode', { type: 'picklist', options: [{ value: 'a', label: 'A' }] }), tin('target', { required: true, visibleRule: 'mode contains a' })] });
    const bare = 'steps:\n- task: ContosoRule@1\n';
    const st = findTaskSteps(bare)[0];
    const f = buildTaskForm(bare, t, st, asTemplateRef(st, t), {});
    const target = f.rows.find(r => r.name === 'target')!;
    assert.equal(target.error, undefined, 'no "A value is required." for an undecidable rule');
    assert.ok(f.rows.every(r => r.error === undefined));
    const lines = planNewTask(t, f, {}, { at: 2, indent: 0, unit: 2 }, { writeDefaults: false }).insert;
    assert.deepEqual(lines, ['- task: ContosoRule@1']);
    // A decidable rule that shows the input still requires it.
    const decided = task('ContosoRule', 1, { inputs: [tin('target', { required: true, visibleRule: 'mode = a' }), tin('mode', { default: 'a' })] });
    const df = buildTaskForm(bare, decided, st, asTemplateRef(st, decided), {});
    assert.equal(df.rows.find(r => r.name === 'target')?.error, 'A value is required.');
  });

  it('marks optional inputs without a default as clearable (the segmented control offers "not set" for them only)', () => {
    const t = task('ContosoPick', 1, {
      inputs: [
        tin('flavor', { type: 'picklist', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }),
        tin('level', { type: 'picklist', options: [{ value: 'x', label: 'X' }], default: 'x' }),
        tin('must', { type: 'picklist', options: [{ value: 'y', label: 'Y' }], required: true }),
      ],
    });
    const text = 'steps:\n- task: ContosoPick@1\n  inputs:\n    flavor: a\n';
    const st = findTaskSteps(text)[0];
    const f = buildTaskForm(text, t, st, asTemplateRef(st, t), {});
    assert.deepEqual(f.rows.map(r => [r.name, r.clearable ?? false]), [['flavor', true], ['level', false], ['must', false]]);
    // Choosing "not set" sends an empty value: the line leaves the file.
    const cleared = buildTaskForm(text, t, st, asTemplateRef(st, t), { flavor: '' });
    const out = applyLineEdits(text, planTaskStep({ step: st, info: t, form: cleared, text, pending: { flavor: '' }, opts: { writeDefaults: false } })).text;
    assert.ok(!out.includes('flavor'), out);
  });

  it('reads the text of a block scalar for the rules, not its header', () => {
    const t = task('ContosoRule', 1, { inputs: [tin('script', { type: 'multiline' }), tin('extra', { visibleRule: 'script = echo hi' })] });
    const text = 'steps:\n- task: ContosoRule@1\n  inputs:\n    script: |\n      echo hi\n';
    const st = findTaskSteps(text)[0];
    const f = buildTaskForm(text, t, st, asTemplateRef(st, t), {});
    assert.ok(f.rows.some(r => r.name === 'extra'), 'the rule sees "echo hi", not "|"');
  });

  it('is read-only without errors when the call is read-only', () => {
    const st = step();
    const f = buildTaskForm(TEXT, DEPLOY, st, asTemplateRef(st, DEPLOY), { connection: '' }, 'read only');
    assert.ok(f.rows.every(r => r.readOnly === 'read only' && r.error === undefined));
  });

  it('reads visibility rules through input aliases, defaults and conditional inputs', () => {
    const text = 'steps:\n- task: ContosoDeploy@2\n  inputs:\n    ${{ if eq(1, 1) }}:\n      mode: off\n';
    assert.ok(form({}, text).rows.some(r => r.name === 'script'), 'an undecidable rule shows the input');
  });
});

describe('task edits', () => {
  const TEXT = 'steps:\n- task: ContosoDeploy@2\n  inputs:\n    connectionName: Fabrikam-Prod\n    mode: fast\n    script: |\n      echo hi\n';
  const opts = { writeDefaults: false };

  it('plans version, display name and inputs as separate line edits', () => {
    const st = findTaskSteps(TEXT)[0];
    const f = buildTaskForm(TEXT, DEPLOY, st, asTemplateRef(st, DEPLOY), { connection: 'Contoso' });
    const edits = planTaskStep({ step: st, info: OLD, form: f, text: TEXT, pending: { connection: 'Contoso' }, opts, displayName: 'Deploy', major: 1 });
    const out = applyLineEdits(TEXT, edits);
    assert.deepEqual(out.text.split('\n').slice(1, 5), ['- task: ContosoDeploy@1', '  displayName: Deploy', '  inputs:', '    connectionName: Contoso']);
    assert.deepEqual([...out.marks], [[1, '~'], [2, '+'], [4, '~']]);
    assert.deepEqual(planTaskStep({ step: st, info: DEPLOY, form: f, text: TEXT, pending: {}, opts }), []);
  });

  it('plans a new step at an insertion point', () => {
    const f = buildTaskForm(TEXT, DEPLOY, undefined, undefined, { connection: 'x', script: 'a\nb' });
    const edit = planNewTask(DEPLOY, f, { connection: 'x', script: 'a\nb' }, { at: 7, indent: 0, unit: 2 }, opts, 'Roll out');
    assert.deepEqual(edit, {
      line: 7, deleteCount: 0,
      insert: ['- task: ContosoDeploy@2', '  displayName: Roll out', '  inputs:', '    connection: x', '    script: |', '      a', '      b'],
    });
  });
});
