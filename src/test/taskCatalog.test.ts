import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { AdoClient } from '../client';
import { buildIndex, cacheFileName, keepHighest, FAILURE_BACKOFF_MS, MAX_AGE_MS, TaskCatalog, toTaskInfo, UNKNOWN_TASK_INTERVAL_MS } from '../pipelines/taskCatalog';
import { TaskInfo } from '../pipelines/taskModel';
import * as T from '../types';
import * as vscode from './vscodeStub';
import { files } from './vscodeExtras';

const ORG = 'https://dev.azure.com/contoso';
const STORAGE = '/storage';
const GUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const def = (over: Partial<T.TaskDefinition> = {}): T.TaskDefinition => ({
  id: GUID, name: 'ContosoDeploy', friendlyName: 'Contoso deploy', version: { major: 1, minor: 2, patch: 3 }, ...over,
});

const info = (over: Partial<TaskInfo> = {}): TaskInfo => ({
  id: GUID, name: 'ContosoDeploy', title: 'Contoso deploy', description: '', category: 'Deploy', major: 1, version: '1.0.0',
  deprecated: false, preview: false, groups: [], inputs: [], ...over,
});

const realFs = (vscode.workspace as unknown as { fs: Record<string, unknown> }).fs;
const fsBackup = { ...realFs };
let requests: number;
let answer: () => Promise<T.TaskDefinition[]>;
let connection: { current?: { orgUrl: string; project: string; projects: string[]; detected: boolean } };
let writeFails: boolean;

function newCatalog(storage: boolean = true): TaskCatalog {
  const client = { listTaskDefinitions: () => { requests++; return answer(); } } as unknown as AdoClient;
  return new TaskCatalog(client, connection, storage ? vscode.Uri.file(STORAGE) as never : undefined);
}

const fileOf = (org: string) => `${STORAGE}/${cacheFileName(org)}`;
const cacheText = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, orgUrl: ORG, fetchedAt: Date.now(), tasks: [info()], ...over });
const flush = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); } };

beforeEach(() => {
  files.clear();
  requests = 0;
  writeFails = false;
  answer = async () => [def()];
  connection = { current: { orgUrl: ORG, project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false } };
  realFs.createDirectory = async () => undefined;
  realFs.writeFile = async (u: { fsPath: string }, bytes: Uint8Array) => {
    if (writeFails) {
      throw new Error('disk full');
    }
    files.set(u.fsPath, new TextDecoder().decode(bytes));
  };
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
});

afterEach(() => {
  mock.timers.reset();
  Object.assign(realFs, fsBackup);
});

describe('toTaskInfo', () => {
  it('maps a complete definition', () => {
    const t = toTaskInfo(def({
      description: 'Deploys', category: 'Deploy', helpUrl: 'https://contoso.example/help', contributionIdentifier: 'contoso.tools', deprecated: true, preview: true,
      groups: [{ name: 'adv', displayName: 'Advanced', visibleRule: 'mode = x' }, { displayName: 'no name' }],
      inputs: [
        { name: 'connectedServiceNameARM', aliases: ['azureSubscription'], label: 'Subscription', type: 'connectedService:AzureRM', required: true, helpMarkDown: 'Pick it', groupName: 'adv', visibleRule: 'a == b' },
        { name: 'mode', type: 'pickList', options: { fast: 'Fast', slow: 'Slow' }, defaultValue: 'fast', properties: { editableoptions: 'True', MultiSelect: 'true' } },
        { name: 'plain' },
      ],
    }))!;
    assert.equal(t.fullName, 'contoso.tools.ContosoDeploy');
    assert.equal(t.version, '1.2.3');
    assert.equal(t.helpUrl, 'https://contoso.example/help');
    assert.ok(t.deprecated && t.preview);
    assert.deepEqual(t.groups, [{ name: 'adv', label: 'Advanced', visibleRule: 'mode = x' }]);
    assert.equal(t.inputs[0].yamlName, 'azureSubscription');
    assert.equal(t.inputs[0].type, 'connectedservice:azurerm');
    assert.equal(t.inputs[0].group, 'adv');
    assert.deepEqual(t.inputs[1].options, [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }]);
    assert.ok(t.inputs[1].editable && t.inputs[1].multi);
    assert.equal(t.inputs[1].default, 'fast');
    assert.deepEqual(t.inputs[2], {
      name: 'plain', yamlName: 'plain', aliases: [], label: 'plain', required: false, type: 'string', default: undefined, help: undefined,
      visibleRule: undefined, group: undefined, options: [], editable: false, multi: false,
    });
  });

  it('fills missing arrays and fields with defaults', () => {
    const t = toTaskInfo({ id: GUID, name: 'ContosoDeploy', version: { major: 3 } })!;
    assert.deepEqual([t.title, t.description, t.category, t.version, t.groups, t.inputs, t.deprecated, t.preview, t.fullName], ['ContosoDeploy', '', '', '3.0.0', [], [], false, false, undefined]);
  });

  it('drops malformed definitions without throwing', () => {
    const bad: unknown[] = [
      null, 'text', [], {}, def({ id: undefined }), def({ name: undefined }), def({ id: 5 as never }), def({ version: undefined }),
      def({ version: { major: '1' as never } }), def({ version: { major: -1 } }), def({ version: { major: 1.5 } }), def({ name: '' }),
      def({ name: 'Evil Task' }), def({ name: 'a;b' }), def({ name: '${{ x }}' }), def({ name: 'tâsk' }),
    ];
    for (const b of bad) {
      assert.equal(toTaskInfo(b as T.TaskDefinition), undefined, JSON.stringify(b));
    }
  });

  it('tolerates malformed members', () => {
    const t = toTaskInfo(def({
      groups: 'x' as never, inputs: [null, 5, { label: 'no name' }, { name: 'ok', options: ['a'], aliases: [1, '', 'alias'], properties: 'x', type: 7 }] as never,
    }))!;
    assert.equal(t.groups.length, 0);
    assert.equal(t.inputs.length, 1);
    assert.deepEqual([t.inputs[0].yamlName, t.inputs[0].options, t.inputs[0].type, t.inputs[0].editable], ['alias', [], 'string', false]);
  });

  it('keeps https help links only and a contribution only when safe', () => {
    assert.equal(toTaskInfo(def({ helpUrl: 'http://contoso.example' }))!.helpUrl, undefined);
    assert.equal(toTaskInfo(def({ helpUrl: 'javascript:alert(1)' }))!.helpUrl, undefined);
    assert.equal(toTaskInfo(def({ contributionIdentifier: 'a b' }))!.fullName, undefined);
    assert.equal(toTaskInfo(def({ contributionIdentifier: '' }))!.fullName, undefined);
  });

  it('only treats deprecated === true as deprecated', () => {
    assert.equal(toTaskInfo(def({ deprecated: 'true' as never }))!.deprecated, false);
  });

  it('uses no option map entry without a string label as value text', () => {
    const t = toTaskInfo(def({ inputs: [{ name: 'm', options: { a: 1 as never } }] }))!;
    assert.deepEqual(t.inputs[0].options, [{ value: 'a', label: 'a' }]);
  });
});

describe('buildIndex', () => {
  const tasks = [
    info({ major: 1, version: '1.5.0' }), info({ major: 1, version: '1.10.0' }), info({ major: 2, version: '2.0.0', fullName: 'contoso.tools.ContosoDeploy' }),
    info({ id: 'other', name: 'FabrikamBuild', major: 0, version: '0.1.0' }),
  ];

  it('keeps the highest version per id and major', () => {
    assert.deepEqual(keepHighest(tasks).map(t => t.version).sort((a, b) => a.localeCompare(b)), ['0.1.0', '1.10.0', '2.0.0']);
    assert.equal(buildIndex(tasks).all().length, 3);
  });

  it('finds by name, id and full name without regard to case', () => {
    const ix = buildIndex(tasks);
    assert.equal(ix.find('contosodeploy', 1)?.version, '1.10.0');
    assert.equal(ix.find(GUID.toUpperCase(), 2)?.major, 2);
    assert.equal(ix.find('CONTOSO.tools.contosodeploy', 2)?.major, 2);
    assert.equal(ix.find('ContosoDeploy', 3), undefined);
    assert.equal(ix.find('Nope', 1), undefined);
  });

  it('lists majors highest first and knows names', () => {
    const ix = buildIndex(tasks);
    assert.deepEqual(ix.majors('CONTOSODEPLOY'), [2, 1]);
    assert.deepEqual(ix.majors('Nope'), []);
    assert.ok(ix.knowsName('fabrikambuild'));
    assert.ok(!ix.knowsName('Nope'));
  });

  it('prefers the higher version when two tasks share a name', () => {
    const ix = buildIndex([info({ id: 'a', version: '1.0.0' }), info({ id: 'b', version: '1.4.0' }), info({ id: 'c', version: '1.2.0' })]);
    assert.equal(ix.find('ContosoDeploy', 1)?.id, 'b');
  });
});

describe('cacheFileName', () => {
  it('hashes the organization url', () => {
    assert.equal(cacheFileName(ORG), `tasks-${createHash('sha256').update(ORG).digest('hex')}.json`);
  });
});

describe('TaskCatalog', () => {
  it('makes no request before ensure', async () => {
    const c = newCatalog();
    assert.equal(c.snapshot().status, 'empty');
    c.refreshForUnknownTask();
    await flush();
    assert.equal(requests, 0);
    assert.equal(c.snapshot().index, undefined);
  });

  it('loads without data, caches the file and fires onDidChange', async () => {
    const c = newCatalog();
    const events: string[] = [];
    c.onDidChange(() => events.push(c.snapshot().status));
    const s = await c.ensure();
    assert.equal(s.status, 'ready');
    assert.equal(s.fetchedAt, 1_700_000_000_000);
    assert.ok(s.index!.knowsName('contosodeploy'));
    assert.deepEqual(events, ['loading', 'ready']);
    assert.equal(requests, 1);
    const saved = JSON.parse(files.get(fileOf(ORG))!);
    assert.equal(saved.schema, 1);
    assert.equal(saved.orgUrl, ORG);
    assert.equal(saved.tasks[0].name, 'ContosoDeploy');
  });

  it('serves fresh data from the file without a request', async () => {
    files.set(fileOf(ORG), cacheText());
    const c = newCatalog();
    const s = await c.ensure();
    assert.equal(s.status, 'ready');
    assert.equal(requests, 0);
    await c.ensure();
    assert.equal(requests, 0);
  });

  it('serves old data at once and refreshes in the background', async () => {
    files.set(fileOf(ORG), cacheText({ fetchedAt: Date.now() - MAX_AGE_MS - 1 }));
    let release!: () => void;
    answer = () => new Promise(res => { release = () => res([def({ name: 'ContosoNew' })]); });
    const c = newCatalog();
    const s = await c.ensure();
    assert.ok(s.index!.knowsName('ContosoDeploy'));
    await flush();
    assert.equal(requests, 1);
    release();
    await flush();
    const after = c.snapshot();
    assert.ok(after.index!.knowsName('ContosoNew'));
    assert.ok(!after.index!.knowsName('ContosoDeploy'));
    assert.equal(after.fetchedAt, Date.now());
  });

  it('keeps old data as stale when a refresh fails', async () => {
    files.set(fileOf(ORG), cacheText({ fetchedAt: Date.now() - MAX_AGE_MS - 1 }));
    answer = async () => { throw new Error('boom'); };
    const c = newCatalog();
    await c.ensure();
    await flush();
    const s = c.snapshot();
    assert.deepEqual([s.status, s.error], ['stale', 'boom']);
    assert.ok(s.index!.knowsName('ContosoDeploy'));
  });

  it('reports an error without any data and does not cache the failure', async () => {
    answer = async () => { throw new Error('offline'); };
    const c = newCatalog();
    const s = await c.ensure();
    assert.deepEqual([s.status, s.error, s.index], ['error', 'offline', undefined]);
    answer = async () => [def()];
    assert.equal((await c.refresh()).status, 'ready');
    assert.equal(c.snapshot().error, undefined);
    assert.equal(requests, 2);
  });

  it('does not loop on a failing client: ensure() backs off, an explicit refresh still tries', async () => {
    answer = async () => { throw new Error('forbidden'); };
    const c = newCatalog();
    // The editor revalidates on every change event, as the YAML support does.
    c.onDidChange(() => { void c.ensure(); });
    await c.ensure();
    for (let i = 0; i < 20; i++) { await flush(); }
    assert.equal(requests, 1);
    mock.timers.tick(FAILURE_BACKOFF_MS - 1);
    await c.ensure();
    assert.equal(requests, 1);
    assert.equal((await c.refresh()).status, 'error');
    assert.equal(requests, 2);
    // The second failure doubles the wait.
    mock.timers.tick(FAILURE_BACKOFF_MS);
    await c.ensure();
    await flush();
    assert.equal(requests, 2);
    mock.timers.tick(FAILURE_BACKOFF_MS);
    await c.ensure();
    await flush();
    assert.equal(requests, 3);
  });

  it('does not loop on old data with a failing refresh, and success clears the backoff', async () => {
    files.set(fileOf(ORG), cacheText({ fetchedAt: Date.now() - MAX_AGE_MS - 1 }));
    answer = async () => { throw new Error('boom'); };
    const c = newCatalog();
    c.onDidChange(() => { void c.ensure(); });
    await c.ensure();
    for (let i = 0; i < 20; i++) { await flush(); }
    assert.equal(requests, 1);
    assert.equal(c.snapshot().status, 'stale');
    mock.timers.tick(FAILURE_BACKOFF_MS);
    answer = async () => [def()];
    await c.ensure();
    await flush();
    assert.equal(requests, 2);
    assert.equal(c.snapshot().status, 'ready');
  });

  it('an old refresh does not clear the in-flight request of a newer one after reset', async () => {
    const releases: (() => void)[] = [];
    answer = () => new Promise(res => { releases.push(() => res([def()])); });
    const c = newCatalog();
    const first = c.refresh();
    await flush();
    c.reset();
    const second = c.refresh();
    await flush();
    releases[0]();
    await first;
    // The newer request is still running: a third caller must join it, not start another.
    const third = c.refresh();
    await flush();
    assert.equal(requests, 2);
    releases[1]();
    await Promise.all([second, third]);
    assert.equal(c.snapshot().status, 'ready');
  });

  it('uses a generic message for a thrown non-error', async () => {
    answer = async () => { throw 'x'; }; // NOSONAR: non-Error rejection on purpose
    const s = await newCatalog().ensure();
    assert.equal(s.error, 'Loading the tasks failed.');
  });

  it('shares one request between concurrent callers', async () => {
    let release!: () => void;
    answer = () => new Promise(res => { release = () => res([def()]); });
    const c = newCatalog();
    const a = c.refresh();
    const b = c.ensure();
    const d = c.refresh();
    await flush();
    release();
    const all = await Promise.all([a, b, d]);
    assert.equal(requests, 1);
    assert.ok(all.every(s => s.status === 'ready'));
  });

  it('treats an empty or unusable response as an error and keeps a good cache', async () => {
    files.set(fileOf(ORG), cacheText({ fetchedAt: Date.now() - MAX_AGE_MS - 1 }));
    const before = files.get(fileOf(ORG));
    answer = async () => [{ id: 'x' }, { name: 'bad name', id: 'y', version: { major: 1 } }];
    const c = newCatalog();
    await c.ensure();
    await flush();
    assert.equal(c.snapshot().status, 'stale');
    assert.ok(c.snapshot().index!.knowsName('ContosoDeploy'));
    assert.equal(files.get(fileOf(ORG)), before);
    answer = async () => undefined as never;
    assert.equal((await c.refresh()).status, 'stale');
  });

  it('ignores a damaged file, another organization and another schema', async () => {
    const bad = ['{ not json', JSON.stringify({ schema: 1 }), cacheText({ schema: 2 }), cacheText({ orgUrl: 'https://dev.azure.com/other' }),
      cacheText({ tasks: [] }), cacheText({ tasks: [{ id: 1 }, null] }), cacheText({ fetchedAt: 'x' }), '[]', 'null'];
    for (const text of bad) {
      files.set(fileOf(ORG), text);
      requests = 0;
      const s = await newCatalog().ensure();
      assert.equal(requests, 1, text);
      assert.equal(s.status, 'ready');
    }
  });

  it('keeps each organization in its own file', async () => {
    const c = newCatalog();
    await c.ensure();
    const other = 'https://dev.azure.com/fabrikam';
    connection.current = { orgUrl: other, project: 'Shop', projects: ['Shop'], detected: false };
    answer = async () => [def({ name: 'FabrikamOnly' })];
    assert.equal(c.snapshot().status, 'empty');
    const s = await c.ensure();
    assert.ok(s.index!.knowsName('FabrikamOnly'));
    assert.ok(!s.index!.knowsName('ContosoDeploy'));
    assert.ok(files.has(fileOf(ORG)) && files.has(fileOf(other)));
    assert.notEqual(fileOf(ORG), fileOf(other));
    connection.current = { ...connection.current, orgUrl: ORG };
    requests = 0;
    const back = await c.ensure();
    assert.ok(back.index!.knowsName('ContosoDeploy'));
    assert.equal(requests, 0);
  });

  it('drops the result of a request that finished after a reset', async () => {
    let release!: () => void;
    answer = () => new Promise(res => { release = () => res([def()]); });
    const c = newCatalog();
    const pending = c.refresh();
    await flush();
    c.reset();
    release();
    const s = await pending;
    assert.equal(s.status, 'empty');
    assert.equal(c.snapshot().index, undefined);
    assert.equal(files.size, 0);
  });

  it('reset clears the memory, fires, and keeps the files', async () => {
    const c = newCatalog();
    await c.ensure();
    let fired = 0;
    c.onDidChange(() => fired++);
    c.reset();
    assert.equal(c.snapshot().status, 'empty');
    assert.equal(fired, 1);
    assert.ok(files.has(fileOf(ORG)));
    c.reset();
    assert.equal(fired, 1);
  });

  it('works in memory without a storage uri and survives a failing write', async () => {
    const c = newCatalog(false);
    assert.equal((await c.ensure()).status, 'ready');
    assert.equal(files.size, 0);
    writeFails = true;
    const d = newCatalog();
    assert.equal((await d.ensure()).status, 'ready');
    assert.equal(files.size, 0);
  });

  it('does nothing without a connection', async () => {
    connection.current = undefined;
    const c = newCatalog();
    assert.equal((await c.ensure()).status, 'empty');
    assert.equal((await c.refresh()).status, 'empty');
    c.refreshForUnknownTask();
    assert.equal(requests, 0);
  });

  it('throttles refreshes for unknown tasks to one per 10 minutes', async () => {
    const c = newCatalog();
    await c.ensure();
    assert.equal(requests, 1);
    c.refreshForUnknownTask();
    await flush();
    assert.equal(requests, 2);
    c.refreshForUnknownTask();
    mock.timers.tick(UNKNOWN_TASK_INTERVAL_MS - 1);
    c.refreshForUnknownTask();
    await flush();
    assert.equal(requests, 2);
    mock.timers.tick(1);
    c.refreshForUnknownTask();
    await flush();
    assert.equal(requests, 3);
  });

  it('refreshes data that gets older than 24 hours on the next ensure', async () => {
    const c = newCatalog();
    await c.ensure();
    mock.timers.tick(MAX_AGE_MS);
    await c.ensure();
    await flush();
    assert.equal(requests, 1);
    mock.timers.tick(1);
    await c.ensure();
    await flush();
    assert.equal(requests, 2);
  });

  it('dispose silences the event', async () => {
    const c = newCatalog();
    let fired = 0;
    c.onDidChange(() => fired++);
    c.dispose();
    await c.ensure();
    assert.equal(fired, 0);
  });
});
