import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { appliedEdits, fakeDoc, fakeEditor, fakeRepo, Range, resetExtras, setGitRepositories } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { AdoClient } from '../client';
import { ConnectionManager } from '../connection';
import {
  assignWorkItemToMe, changeWorkItemState, commentOnWorkItem, createBranchForWorkItem, createWorkItem, createWorkItemFromCode, TodoCodeActions,
} from '../workItems/wiCommands';

const REMOTE = 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/web-shop';
const w = vscode.window as any;
const flush = () => new Promise(r => setImmediate(r));

let picks: unknown[];
let inputs: unknown[];
let buttons: unknown[];
const pickPrompts: { items: any; options: any }[] = [];
const inputPrompts: any[] = [];

function fakeClient(me: { displayName: string; uniqueName?: string } = { displayName: 'Alex Morgan', uniqueName: 'alex@contoso.com' }) {
  const calls: unknown[][] = [];
  const client = {
    getWorkItemStates: async () => [{ name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }],
    getWorkItemTypes: async () => ['User Story', 'Bug', 'Task'],
    getMe: async () => me,
    getWorkItem: async (id: number) => ({ id, fields: { 'System.Title': 'Fix login: crash on "Ümlaut" names!!', 'System.WorkItemType': id === 1 ? 'Bug' : 'Task' } }),
    updateWorkItem: async (...a: unknown[]) => { calls.push(['update', ...a]); },
    addWorkItemComment: async (...a: unknown[]) => { calls.push(['comment', ...a]); },
    createWorkItem: async (...a: unknown[]) => { calls.push(['create', ...a]); return { id: 321 }; },
  } as unknown as AdoClient;
  return { client, calls };
}

function connections(): ConnectionManager {
  const c = new ConnectionManager();
  c.current = { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false };
  return c;
}

function branchRepo(root: string, url: string, branch = 'main') {
  const r = fakeRepo(root, url, branch);
  return Object.assign(r, { createBranch: async (...a: unknown[]) => { r.calls.push(a); } });
}

beforeEach(() => {
  vscode.reset();
  resetExtras();
  picks = [];
  inputs = [];
  buttons = [];
  pickPrompts.length = 0;
  inputPrompts.length = 0;
  w.showQuickPick = async (items: any, options: any) => { pickPrompts.push({ items: await items, options }); return picks.shift(); };
  w.showInputBox = async (o: any) => { inputPrompts.push(o); return inputs.shift(); };
  w.showInformationMessage = async (m: string) => { vscode.messages.push(m); return buttons.shift(); };
});

describe('work item quick commands', () => {
  it('changes the state to the picked one', async () => {
    const { client, calls } = fakeClient();
    assert.equal(await changeWorkItemState(client, 5, 'Bug'), false);
    assert.deepEqual(pickPrompts[0].items, [{ label: 'New', description: 'Proposed' }, { label: 'Active', description: 'InProgress' }]);
    picks = [{ label: 'Active' }];
    assert.equal(await changeWorkItemState(client, 5, 'Bug'), true);
    assert.deepEqual(calls, [['update', 5, { 'System.State': 'Active' }]]);
  });

  it('assigns to the signed-in user by unique name or display name', async () => {
    const a = fakeClient();
    await assignWorkItemToMe(a.client, 5);
    const b = fakeClient({ displayName: 'Alex Morgan' });
    await assignWorkItemToMe(b.client, 6);
    assert.deepEqual([...a.calls, ...b.calls], [['update', 5, { 'System.AssignedTo': 'alex@contoso.com' }], ['update', 6, { 'System.AssignedTo': 'Alex Morgan' }]]);
  });

  it('adds a comment unless cancelled', async () => {
    const { client, calls } = fakeClient();
    assert.equal(await commentOnWorkItem(client, 5), false);
    inputs = ['Looks good'];
    assert.equal(await commentOnWorkItem(client, 5), true);
    assert.deepEqual(calls, [['comment', 5, 'Looks good']]);
  });
});

describe('createWorkItem', () => {
  it('stops at every cancelled step', async () => {
    const { client, calls } = fakeClient();
    assert.equal(await createWorkItem(client), undefined);
    picks = ['Bug'];
    assert.equal(await createWorkItem(client), undefined);
    picks = ['Bug', undefined];
    inputs = ['Cart total wrong'];
    assert.equal(await createWorkItem(client), undefined);
    assert.deepEqual(calls, []);
  });

  it('creates an assigned or unassigned item', async () => {
    const { client, calls } = fakeClient();
    picks = ['Bug', 'Assign to me', 'Task', 'Leave unassigned'];
    inputs = ['Cart total wrong', 'Write docs'];
    assert.equal(await createWorkItem(client), 321);
    assert.equal(await createWorkItem(client), 321);
    assert.deepEqual(calls, [
      ['create', 'Bug', { 'System.Title': 'Cart total wrong', 'System.AssignedTo': 'alex@contoso.com' }],
      ['create', 'Task', { 'System.Title': 'Write docs' }],
    ]);
    assert.deepEqual(vscode.messages, ['Created Bug #321.', 'Created Task #321.']);
  });
});

describe('createBranchForWorkItem', () => {
  it('fails without a git repository', async () => {
    await assert.rejects(createBranchForWorkItem(fakeClient().client, connections(), 1), /No open git repository/);
  });

  it('suggests a branch name from the work item and creates it', async () => {
    const repo = branchRepo('/src/web-shop', REMOTE);
    setGitRepositories([repo]);
    inputs = ['bugfix/1-fix-login'];
    await createBranchForWorkItem(fakeClient().client, connections(), 1);
    assert.equal(inputPrompts[0].value, 'bugfix/1-fix-login-crash-on-umlaut-names');
    assert.deepEqual(repo.calls, [['bugfix/1-fix-login', true]]);
    assert.match(vscode.messages[0], /Switched to new branch bugfix\/1-fix-login/);
  });

  it('uses the repository of the active file and stops when the name is cancelled', async () => {
    const a = branchRepo('/src/api', 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/api');
    const b = branchRepo('/src/web-shop', REMOTE);
    setGitRepositories([a, b]);
    w.activeTextEditor = fakeEditor(fakeDoc(vscode.Uri.file('/src/web-shop/app.ts'), ['x']));
    await createBranchForWorkItem(fakeClient().client, connections(), 2);
    assert.equal(inputPrompts[0].value, 'feature/2-fix-login-crash-on-umlaut-names');
    assert.equal(pickPrompts.length, 0);
    assert.deepEqual(b.calls, []);
  });

  it('lets the user pick a repository, Azure Repos clones first', async () => {
    const other = branchRepo('/src/tools', 'https://github.com/fabrikam/tools');
    const ado = branchRepo('/src/web-shop', REMOTE, 'dev');
    setGitRepositories([other, ado]);
    w.activeTextEditor = fakeEditor(fakeDoc(vscode.Uri.parse('untitled://x/Untitled-1'), ['x']));
    await createBranchForWorkItem(fakeClient().client, connections(), 2);
    assert.deepEqual(pickPrompts[0].items.map((i: any) => i.label), ['web-shop', 'tools']);
    assert.equal(pickPrompts[0].items[0].description, 'dev');
    picks = [pickPrompts[0].items[1]];
    inputs = ['feature/2-x'];
    await createBranchForWorkItem(fakeClient().client, connections(), 2);
    assert.deepEqual(other.calls, [['feature/2-x', true]]);
  });
});

describe('createWorkItemFromCode', () => {
  const file = vscode.Uri.file('/src/web-shop/src/cart.ts');
  const lines = ['const a = 1;', '  // TODO(lena): handle <empty> cart', 'return a;'];

  it('needs an open file', async () => {
    await assert.rejects(createWorkItemFromCode(fakeClient().client, connections()), /Open a file first/);
  });

  it('creates an item from a to-do line, links Azure Repos and marks the comment', async () => {
    setGitRepositories([branchRepo('/src/web-shop', REMOTE, 'feature/cart')]);
    const doc = fakeDoc(file, lines);
    w.activeTextEditor = fakeEditor(doc);
    (vscode.workspace as any).openTextDocument = async () => doc;
    const { client, calls } = fakeClient();
    picks = ['Task'];
    inputs = ['Handle empty cart'];
    buttons = ['Open'];
    assert.equal(await createWorkItemFromCode(client, connections(), file as any, 1), 321);
    assert.deepEqual(pickPrompts[0].items, ['Task', 'Bug', 'User Story']);
    assert.equal(inputPrompts[0].value, 'handle <empty> cart');
    const [, type, fields, opts] = calls[0] as [string, string, Record<string, string>, { hyperlink?: string }];
    assert.equal(type, 'Task');
    assert.match(fields['System.Description'], /^<p>From <code>src\/cart.ts:2<\/code> \(<a href="https:\/\/dev.azure.com\/contoso\/Fabrikam%20Shop\/_git\/web-shop\?path=%2Fsrc%2Fcart.ts&amp;version=GBfeature%2Fcart&amp;line=2&amp;lineEnd=3/);
    assert.match(fields['System.Description'], /<pre><code> {2}\/\/ TODO\(lena\): handle &lt;empty&gt; cart<\/code><\/pre>$/);
    assert.ok(opts.hyperlink?.startsWith('https://dev.azure.com/contoso/Fabrikam%20Shop/_git/web-shop?'));
    assert.equal(appliedEdits[0].inserts[0].text, '(#321)');
    assert.deepEqual([appliedEdits[0].inserts[0].at.line, appliedEdits[0].inserts[0].at.character], [1, 9]);
    await flush();
    assert.deepEqual(vscode.executed.at(-1), ['azureDevOps.wi.open', 321]);
  });

  it('uses the selection of the active editor and links nothing outside Azure Repos', async () => {
    const doc = fakeDoc(file, lines);
    w.activeTextEditor = fakeEditor(doc, new Range(0, 0, 2, 9));
    const { client, calls } = fakeClient();
    picks = ['Bug'];
    inputs = ['Refactor'];
    assert.equal(await createWorkItemFromCode(client, connections()), 321);
    const [, , fields, opts] = calls[0] as [string, string, Record<string, string>, { hyperlink?: string }];
    assert.match(fields['System.Description'], /^<p>From <code>cart.ts:1<\/code><\/p>/);
    assert.equal(opts.hyperlink, undefined);
    assert.equal(appliedEdits.length, 0);
  });

  it('opens the given file and stops when the type or title is cancelled', async () => {
    const { client, calls } = fakeClient();
    (vscode.workspace as any).openTextDocument = async (u: unknown) => fakeDoc(u, lines);
    assert.equal(await createWorkItemFromCode(client, connections(), file as any), undefined);
    picks = ['Bug'];
    assert.equal(await createWorkItemFromCode(client, connections(), file as any, 0), undefined);
    assert.equal(inputPrompts[0].value, 'const a = 1;');
    assert.deepEqual(calls, []);
  });
});

describe('TodoCodeActions', () => {
  const provider = new TodoCodeActions();
  const at = (line: number) => new Range(line, 0, line, 0) as any;

  it('offers a work item for open to-do comments only', () => {
    const doc = fakeDoc(vscode.Uri.file('/src/a.ts'), ['// TODO: cache prices', '// TODO(#12): done', 'const todo = 1;']) as any;
    const [action] = provider.provideCodeActions(doc, at(0));
    assert.equal(action.title, 'Create work item from this comment');
    assert.deepEqual((action.command as any).arguments, [doc.uri, 0]);
    assert.deepEqual(provider.provideCodeActions(doc, at(1)), []);
    assert.deepEqual(provider.provideCodeActions(doc, at(2)), []);
  });
});
