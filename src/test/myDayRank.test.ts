import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RULES, compareItems, rankItem, tierOf } from '../myDay/rank';
import type { RankFacts } from '../myDay/types';

/** Wednesday, 4 November 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const rules = (facts: RankFacts): string[] => rankItem(facts, NOW).reasons.map(r => r.rule + ':' + r.points);

describe('RULES', () => {
  it('holds every rule of the concept', () => {
    const ids = new Set(Object.keys(RULES).map(k => k.split(':')[0]));
    for (const id of ['A1', 'A2', 'A3', 'R1', 'R2', 'R3', 'P1', 'P2', 'P3', 'P4', 'W1', 'W2', 'W3', 'W4', 'W5']) {
      assert.ok(ids.has(id), id);
    }
    assert.equal(RULES.A1.points, 80);
    assert.equal(RULES['P3:7'].points, 20);
  });
});

describe('approval rules', () => {
  const base = { kind: 'approval' as const, openSteps: 2, stillNeeded: 1 };
  it('A1 alone', () => assert.deepEqual(rules({ ...base, createdOn: ago(HOUR) }), ['A1:80']));
  it('A2 4 h and 24 h, only the higher', () => {
    assert.deepEqual(rules({ ...base, createdOn: ago(4 * HOUR) }), ['A1:80', 'A2:5']);
    assert.deepEqual(rules({ ...base, createdOn: ago(24 * HOUR) }), ['A1:80', 'A2:10']);
    assert.equal(rankItem({ ...base, createdOn: ago(3 * HOUR) }, NOW).reasons.length, 1);
  });
  it('missing createdOn adds nothing', () => assert.deepEqual(rules(base), ['A1:80']));
  it('A3 when open steps do not exceed the needed ones', () => {
    assert.deepEqual(rules({ ...base, openSteps: 1 }), ['A1:80', 'A3:5']);
    assert.deepEqual(rules({ ...base, openSteps: 0, stillNeeded: 0 }), ['A1:80', 'A3:5']);
  });
});

describe('run rules', () => {
  const base = { kind: 'run' as const, important: false };
  it('R1 failed and partial', () => {
    assert.deepEqual(rules({ ...base, result: 'failed' }), ['R1:50']);
    assert.deepEqual(rules({ ...base, result: 'partiallySucceeded' }), ['R1:30']);
    assert.deepEqual(rules({ ...base, result: 'succeeded' }), []);
  });
  it('R2 important branch', () => assert.deepEqual(rules({ ...base, result: 'failed', important: true }), ['R1:50', 'R2:25']));
  it('a partially succeeded run is not called a failure in the reasons', () => {
    const labels = (r: ReturnType<typeof rankItem>) => r.reasons.map(x => x.label);
    const partial = rankItem({ ...base, result: 'partiallySucceeded', important: true, finishTime: ago(HOUR) }, NOW);
    assert.deepEqual(labels(partial), ['Your run partially succeeded', 'Partly failed on an important branch', 'Just finished with problems']);
    const old = rankItem({ ...base, result: 'partiallySucceeded', finishTime: ago(73 * HOUR) }, NOW);
    assert.equal(old.reasons[1].label, 'Older partial failure');
    const failed = rankItem({ ...base, result: 'failed', important: true, finishTime: ago(HOUR) }, NOW);
    assert.deepEqual(labels(failed), ['Your run failed', 'Failed on an important branch', 'Just failed']);
  });
  it('R3 recent, old and in between', () => {
    assert.deepEqual(rules({ ...base, result: 'failed', finishTime: ago(23 * HOUR) }), ['R1:50', 'R3:5']);
    assert.deepEqual(rules({ ...base, result: 'failed', finishTime: ago(24 * HOUR) }), ['R1:50']);
    assert.deepEqual(rules({ ...base, result: 'failed', finishTime: ago(73 * HOUR) }), ['R1:50', 'R3:-15']);
    assert.deepEqual(rules({ ...base, result: 'failed', finishTime: 'garbage' }), ['R1:50']);
  });
});

describe('review rules', () => {
  const base = { kind: 'review' as const, required: false, conflicts: false };
  /** Friday 30 October 2026 is 3 working days before NOW. */
  const FRI = '2026-10-30T09:00:00Z';
  it('P1 alone on the same day', () => assert.deepEqual(rules({ ...base, creationDate: ago(HOUR) }), ['P1:40']));
  it('P2 required', () => assert.deepEqual(rules({ ...base, required: true, creationDate: ago(HOUR) }), ['P1:40', 'P2:15']));
  it('P3 thresholds 1, 3, 7 working days', () => {
    assert.deepEqual(rules({ ...base, creationDate: '2026-11-03T09:00:00Z' }), ['P1:40', 'P3:5']);
    assert.deepEqual(rules({ ...base, creationDate: '2026-11-02T09:00:00Z' }), ['P1:40', 'P3:5']);
    assert.deepEqual(rules({ ...base, creationDate: FRI }), ['P1:40', 'P3:10']);
    assert.deepEqual(rules({ ...base, creationDate: '2026-10-23T09:00:00Z' }), ['P1:40', 'P3:20']);
  });
  it('P3 label names the working days', () => {
    assert.equal(rankItem({ ...base, creationDate: FRI }, NOW).reasons[1].label, 'Open for 3 working days');
  });
  it('P3 and W4 labels say "1 working day" in the singular', () => {
    assert.equal(rankItem({ ...base, creationDate: '2026-11-03T09:00:00Z' }, NOW).reasons[1].label, 'Open for 1 working day');
  });
  it('P4 conflicts', () => assert.deepEqual(rules({ ...base, conflicts: true, creationDate: ago(HOUR) }), ['P1:40', 'P4:-10']));
  it('a creation date in the future does not go below 0 days', () => {
    assert.deepEqual(rules({ ...base, creationDate: '2026-12-01T00:00:00Z' }), ['P1:40']);
  });
});

describe('work item rules', () => {
  const base = { kind: 'workItem' as const };
  it('W1 alone', () => assert.deepEqual(rules(base), ['W1:10']));
  it('W2 in progress and resolved', () => {
    assert.deepEqual(rules({ ...base, stateCategory: 'InProgress' }), ['W1:10', 'W2:20']);
    assert.deepEqual(rules({ ...base, stateCategory: 'Resolved' }), ['W1:10', 'W2:-10']);
    assert.deepEqual(rules({ ...base, stateCategory: 'Proposed' }), ['W1:10']);
  });
  it('W3 priority', () => {
    assert.deepEqual(rules({ ...base, priority: 1 }), ['W1:10', 'W3:30']);
    assert.deepEqual(rules({ ...base, priority: 2 }), ['W1:10', 'W3:10']);
    assert.deepEqual(rules({ ...base, priority: 3 }), ['W1:10']);
  });
  it('W4 sprint over, ending soon, ending later, far away', () => {
    assert.deepEqual(rules({ ...base, sprintFinish: '2026-11-03T00:00:00Z' }), ['W1:10', 'W4:30']);
    assert.deepEqual(rules({ ...base, sprintFinish: '2026-11-04T23:00:00Z' }), ['W1:10', 'W4:25']);
    assert.deepEqual(rules({ ...base, sprintFinish: '2026-11-06T00:00:00Z' }), ['W1:10', 'W4:25']);
    assert.deepEqual(rules({ ...base, sprintFinish: '2026-11-09T00:00:00Z' }), ['W1:10', 'W4:10']);
    assert.deepEqual(rules({ ...base, sprintFinish: '2026-11-11T00:00:00Z' }), ['W1:10', 'W4:10']);
    assert.deepEqual(rules({ ...base, sprintFinish: '2026-11-12T00:00:00Z' }), ['W1:10']);
    assert.deepEqual(rules({ ...base, sprintFinish: 'nonsense' }), ['W1:10']);
  });
  it('W4 label names the working days left', () => {
    assert.equal(rankItem({ ...base, sprintFinish: '2026-11-06T00:00:00Z' }, NOW).reasons[1].label, 'Sprint ends in 2 working days');
  });
  it('W4 label says "1 working day" in the singular', () => {
    assert.equal(rankItem({ ...base, sprintFinish: '2026-11-05T00:00:00Z' }, NOW).reasons[1].label, 'Sprint ends in 1 working day');
  });
  it('W5 bug', () => assert.deepEqual(rules({ ...base, type: 'Bug' }), ['W1:10', 'W5:5']));
});

describe('tiers and scores', () => {
  it('tier limits', () => {
    assert.equal(tierOf(39), 'later');
    assert.equal(tierOf(40), 'today');
    assert.equal(tierOf(69), 'today');
    assert.equal(tierOf(70), 'now');
    assert.equal(tierOf(-5), 'later');
  });
  it('the reasons add up to the score', () => {
    const r = rankItem({ kind: 'workItem', stateCategory: 'InProgress', priority: 1, type: 'Bug', sprintFinish: '2026-11-03T00:00:00Z' }, NOW);
    assert.equal(r.reasons.reduce((s, x) => s + x.points, 0), r.score);
    assert.equal(r.score, 10 + 20 + 30 + 30 + 5);
    assert.equal(r.tier, 'now');
  });
  it('concept examples', () => {
    const a = rankItem({ kind: 'approval', createdOn: ago(6 * HOUR), openSteps: 1, stillNeeded: 1 }, NOW);
    assert.deepEqual([a.score, a.tier], [90, 'now']);
    const main = rankItem({ kind: 'run', result: 'failed', important: true, finishTime: ago(40 * 60_000) }, NOW);
    assert.deepEqual([main.score, main.tier], [80, 'now']);
    const rev = rankItem({ kind: 'review', required: true, creationDate: '2026-10-30T09:00:00Z', conflicts: false }, NOW);
    assert.deepEqual([rev.score, rev.tier], [65, 'today']);
    const feat = rankItem({ kind: 'run', result: 'failed', important: false, finishTime: ago(2 * HOUR) }, NOW);
    assert.deepEqual([feat.score, feat.tier], [55, 'today']);
    const wi = rankItem({ kind: 'workItem', priority: 3 }, NOW);
    assert.deepEqual([wi.score, wi.tier], [10, 'later']);
  });
});

describe('compareItems', () => {
  const item = (key: string, score: number, since?: string) => ({ key, score, since });
  it('score descending, then older first, missing since last, then key', () => {
    const items = [
      item('d', 50),
      item('c', 50, '2026-11-01T00:00:00Z'),
      item('b', 50, '2026-10-01T00:00:00Z'),
      item('a', 50, '2026-10-01T00:00:00Z'),
      item('z', 90),
    ];
    assert.deepEqual(items.toSorted(compareItems).map(i => i.key), ['z', 'a', 'b', 'c', 'd']);
  });
  it('is stable for any input order and 0 only for the same key', () => {
    const items = [item('x', 1, 'bad'), item('y', 1), item('w', 1, 'bad')];
    assert.deepEqual(items.toSorted(compareItems).map(i => i.key), ['w', 'x', 'y']);
    assert.deepEqual(items.toReversed().toSorted(compareItems).map(i => i.key), ['w', 'x', 'y']);
    assert.equal(compareItems(items[0], items[0]), 0);
  });
});
