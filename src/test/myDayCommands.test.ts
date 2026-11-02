import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { deferItem, voteOnPullRequest } from '../myDay/commands';
import type { DeferEntry, MyDayItem } from '../myDay/types';
import { answers, prompts, reset } from './vscodeStub';

function item(source: MyDayItem['source']): MyDayItem {
  return { key: 'k1', source, icon: 'pr', iconClass: 'ok', title: 'Review: Fix login', meta: [], project: 'Contoso Web', score: 1, tier: 'now', reasons: [], fingerprint: 'fp', actions: [] };
}

function target(source: MyDayItem['source'] = 'reviews') {
  const calls: { kind: DeferEntry['kind']; until?: number; item: MyDayItem }[] = [];
  return {
    calls,
    itemByKey: (key: string) => (key === 'k1' ? item(source) : undefined),
    applyDefer: async (i: MyDayItem, kind: DeferEntry['kind'], until?: number) => { calls.push({ item: i, kind, until }); },
  };
}

const labels = () => ((prompts.quickPick as any).items as { label: string }[]).map(i => i.label);

beforeEach(() => reset());

describe('deferItem', () => {
  it('ignores non-string and unknown keys without asking', async () => {
    const t = target();
    for (const k of [undefined, 5, {}, 'nope']) {
      await deferItem(t, k);
    }
    assert.equal(prompts.quickPick, undefined);
    assert.equal(t.calls.length, 0);
  });
  it('offers all choices and titles the pick with the item title', async () => {
    const t = target();
    answers.quickPick.push(undefined);
    await deferItem(t, 'k1');
    assert.deepEqual(labels(), ['In 2 hours', 'Tomorrow morning', 'Next Monday', 'Done until it changes', 'Hide permanently']);
    assert.equal((prompts.quickPick as any).options.title, 'Review: Fix login');
    assert.equal(t.calls.length, 0);
  });
  it('offers only snoozes for approvals', async () => {
    answers.quickPick.push(undefined);
    await deferItem(target('approvals'), 'k1');
    assert.deepEqual(labels(), ['In 2 hours', 'Tomorrow morning', 'Next Monday']);
  });
  it('applies a snooze with a time in the future', async () => {
    const t = target();
    const before = Date.now();
    answers.quickPick.push({ label: 'In 2 hours', defer: 'snooze', choice: 'twoHours' });
    await deferItem(t, 'k1');
    assert.equal(t.calls[0].kind, 'snooze');
    assert.ok((t.calls[0].until ?? 0) >= before + 2 * 3_600_000);
  });
  it('applies done and hide without a time', async () => {
    const t = target();
    answers.quickPick.push({ label: 'Done until it changes', defer: 'done' }, { label: 'Hide permanently', defer: 'hide' });
    await deferItem(t, 'k1');
    await deferItem(t, 'k1');
    assert.deepEqual(t.calls.map(c => [c.kind, c.until]), [['done', undefined], ['hide', undefined]]);
  });
});

describe('voteOnPullRequest', () => {
  function fake() {
    const votes: unknown[][] = [];
    return { votes, vote: async (...a: unknown[]) => { votes.push(a); } } as any;
  }
  it('rejects invalid arguments without asking', async () => {
    const c = fake();
    const bad: [unknown, unknown][] = [['', 1], [5, 1], ['r', 0], ['r', -1], ['r', 1.5], ['r', '7'], ['r', NaN], [undefined, undefined]];
    for (const [r, p] of bad) {
      assert.equal(await voteOnPullRequest(c, r, p), false);
    }
    assert.equal(prompts.quickPick, undefined);
    assert.equal(c.votes.length, 0);
  });
  it('offers the four votes and does not vote when cancelled', async () => {
    const c = fake();
    answers.quickPick.push(undefined);
    assert.equal(await voteOnPullRequest(c, 'repo1', 7), false);
    assert.deepEqual(labels(), ['Approve', 'Approve with suggestions', 'Wait for author', 'Reject']);
    assert.equal(c.votes.length, 0);
  });
  it('casts the picked vote', async () => {
    const c = fake();
    answers.quickPick.push({ label: 'Reject', vote: -10 });
    assert.equal(await voteOnPullRequest(c, 'repo1', 7), true);
    assert.deepEqual(c.votes, [['repo1', 7, -10]]);
  });

});
