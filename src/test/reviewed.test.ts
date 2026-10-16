import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fakeDoc, fire, registered, resetExtras } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { ConnectionManager } from '../connection';
import { makePrUri, PrFileQuery } from '../pullRequests/prFiles';
import { changeVersion, ReviewedChange, ReviewedFiles } from '../pullRequests/reviewed';

function memento() {
  const data = new Map<string, unknown>();
  return {
    data,
    keys: () => [...data.keys()],
    get: <T>(k: string, def?: T) => (data.has(k) ? data.get(k) as T : def),
    update: async (k: string, v: unknown) => { if (v === undefined) { data.delete(k); } else { data.set(k, v); } },
  };
}

const q = (side: 'left' | 'right', obj: string, ct = 4): PrFileQuery => ({ repo: 'r1', pr: 7, obj, side, ct, iter: 2, base: 1 });
const editor = (uri: unknown) => ({ document: fakeDoc(uri, ['x']) });
const w = vscode.window as any;

function lastContext(): unknown {
  const calls = vscode.executed.filter(c => c[0] === 'setContext' && c[1] === 'azureDevOps.fileReviewed');
  return calls[calls.length - 1]?.[2];
}

describe('ReviewedFiles', () => {
  let store: ReturnType<typeof memento>;
  let files: ReviewedFiles;
  let connections: ConnectionManager;

  beforeEach(() => {
    vscode.reset();
    resetExtras();
    store = memento();
    connections = new ConnectionManager();
    connections.current = { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false };
    files = new ReviewedFiles(store as any, connections);
  });
  afterEach(() => files.dispose());

  it('stores marks per file version and removes empty entries', async () => {
    const events: ReviewedChange[] = [];
    files.onDidChange(e => events.push(e));
    await files.set('r1', 7, '/src/a.ts', 'v1', true);
    assert.ok(files.isReviewed('r1', 7, '/src/a.ts', 'v1'));
    assert.ok(!files.isReviewed('r1', 7, '/src/a.ts', 'v2'));
    assert.deepEqual(store.keys(), ['reviewed:https://dev.azure.com/contoso/r1/7']);
    await files.set('r1', 7, '/src/a.ts', 'v1', false);
    assert.ok(!files.isReviewed('r1', 7, '/src/a.ts', 'v1'));
    assert.deepEqual(store.keys(), []);
    assert.deepEqual(events.map(e => e.reviewed), [true, false]);
  });

  it('keys marks without a connection too', async () => {
    connections.current = undefined;
    await files.set('r1', 7, '/a', 'v', true);
    assert.deepEqual(store.keys(), ['reviewed:/r1/7']);
  });

  it('marks the file of the active right diff side', async () => {
    w.activeTextEditor = editor(makePrUri('/src/a.ts', q('right', 'n1')));
    await fire('activeEditor');
    assert.equal(lastContext(), false);
    await registered.get('azureDevOps.pr.markReviewed')!();
    assert.ok(files.isReviewed('r1', 7, '/src/a.ts', 'n1'));
    assert.equal(lastContext(), true);
    await registered.get('azureDevOps.pr.unmarkReviewed')!();
    assert.ok(!files.isReviewed('r1', 7, '/src/a.ts', 'n1'));
  });

  it('finds the right side of the diff when the left side has focus', async () => {
    w.activeTextEditor = editor(makePrUri('/src/old.ts', q('left', 'o1')));
    w.visibleTextEditors = [
      editor(vscode.Uri.file('/src/b.ts')),
      editor(makePrUri('/src/other.ts', q('right', 'x', 9))),
      editor(makePrUri('/src/new.ts', q('right', '')))];
    await registered.get('azureDevOps.pr.markReviewed')!();
    assert.ok(files.isReviewed('r1', 7, '/src/new.ts', 'deleted'));
  });

  it('does nothing outside of PR diffs', async () => {
    w.activeTextEditor = editor(vscode.Uri.file('/src/a.ts'));
    await registered.get('azureDevOps.pr.markReviewed')!();
    w.activeTextEditor = editor(makePrUri('/src/old.ts', q('left', 'o1')));
    await registered.get('azureDevOps.pr.markReviewed')!();
    assert.deepEqual(store.keys(), []);
    assert.equal(lastContext(), false);
  });
});

describe('changeVersion', () => {
  it('uses the blob id, or "deleted" for deletions and missing ids', () => {
    assert.equal(changeVersion({ changeType: 'edit', item: { objectId: 'abc' } }), 'abc');
    assert.equal(changeVersion({ changeType: 'delete', item: { objectId: 'abc' } }), 'deleted');
    assert.equal(changeVersion({ changeType: 'add', item: {} }), 'deleted');
  });
});
