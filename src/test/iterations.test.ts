import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import './vscodeExtras';
import * as vscode from './vscodeStub';
import { AdoClient } from '../client';
import { compareIterations } from '../pullRequests/iterations';
import { parsePrUri } from '../pullRequests/prFiles';
import { PrChange } from '../types';

const change = (p: string, ct = 1): PrChange => ({ changeTrackingId: ct, changeType: 'edit', item: { path: p, objectId: `o${ct}`, originalObjectId: `b${ct}` } });

function client(iterations: number[], changes: PrChange[]) {
  const calls: unknown[][] = [];
  const c = {
    getIterations: async () => iterations.map(id => ({ id, description: id === 2 ? 'Address review' : undefined, createdDate: id === 1 ? '2026-03-01T10:00:00Z' : undefined })),
    getIterationChanges: async (...a: unknown[]) => { calls.push(a); return changes; },
  } as unknown as AdoClient;
  return { c, calls };
}

let picks: unknown[] = [];
let pickPrompts: { items: any[]; options: any }[] = [];

describe('compareIterations', () => {
  beforeEach(() => {
    vscode.reset();
    picks = [];
    pickPrompts = [];
    (vscode.window as any).showQuickPick = async (items: any[], options: any) => { pickPrompts.push({ items, options }); return picks.shift(); };
  });

  it('fails for a pull request without updates', async () => {
    await assert.rejects(compareIterations(client([], []).c, 'r1', 7), /!7 has no updates yet/);
  });

  it('asks for the base and stops when the pick is cancelled', async () => {
    const { c, calls } = client([1, 2, 3], []);
    await compareIterations(c, 'r1', 7);
    assert.deepEqual(pickPrompts[0].items.map(i => i.label), ['Target branch', 'Update 2', 'Update 1']);
    assert.equal(pickPrompts[0].items[1].description, 'Address review');
    assert.ok(pickPrompts[0].items[2].detail);
    assert.equal(pickPrompts[0].options.title, 'PR !7: compare update 3 with…');
    assert.equal(calls.length, 0);
  });

  it('opens the only changed file against the picked base', async () => {
    const { c, calls } = client([1, 2, 3], [change('/src/cart.ts')]);
    picks = [{ id: 0 }];
    await compareIterations(c, 'r1', 7, Number.NaN);
    assert.deepEqual(calls, [['r1', 7, 3, 0]]);
    const [cmd, , right, title] = vscode.executed[0] as [string, unknown, any, string];
    assert.equal(cmd, 'vscode.diff');
    assert.equal(parsePrUri(right).iter, 3);
    assert.equal(title, 'cart.ts (PR !7)');
  });

  it('caps the target at the latest update and reports no changes', async () => {
    const { c, calls } = client([1, 2, 3], []);
    await compareIterations(c, 'r1', 7, 2, 9);
    assert.deepEqual(calls, [['r1', 7, 3, 2]]);
    assert.deepEqual(vscode.messages, ['No file changed between update 2 and 3.']);
  });

  it('lets the user pick one of several changed files', async () => {
    const { c } = client([1, 2, 3], [change('/src/a.ts', 1), change('/src/lib/b.ts', 2)]);
    picks = [undefined];
    await compareIterations(c, 'r1', 7, 1, 2);
    assert.equal(pickPrompts[0].options.title, 'PR !7: 2 files changed from update 1 to 2');
    assert.deepEqual(pickPrompts[0].items.map(i => i.description), ['/src', '/src/lib']);
    assert.equal(vscode.executed.length, 0);

    picks = [pickPrompts[0].items[1]];
    await compareIterations(c, 'r1', 7, 0);
    assert.equal(pickPrompts[1].options.title, 'PR !7: 2 files changed');
    const [, , right, title] = vscode.executed[0] as [string, unknown, any, string];
    assert.equal(right.path, '/src/lib/b.ts');
    assert.equal(title, 'b.ts (PR !7)');
  });
});
