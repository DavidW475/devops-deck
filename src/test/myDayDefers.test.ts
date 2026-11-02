import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectGarbage, isDeferred, MyDayDefers, snoozeUntil } from '../myDay/defers';
import type { DeferEntry } from '../myDay/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function entry(over: Partial<DeferEntry> = {}): DeferEntry {
  return { kind: 'snooze', until: 1000, fingerprint: 'f1', seenAt: 0, title: 'Fix build', source: 'reviews', project: 'Contoso Web', ...over };
}

function memento(initial?: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}));
  const writes: string[] = [];
  return {
    data, writes,
    get: (k: string, d?: unknown) => (data.has(k) ? data.get(k) : d),
    update: async (k: string, v: unknown) => { writes.push(k); data.set(k, v); },
  } as any;
}

describe('isDeferred', () => {
  it('snooze holds until it ends and while unchanged', () => {
    const e = entry();
    assert.equal(isDeferred(e, 'f1', 999), true);
    assert.equal(isDeferred(e, 'f1', 1000), false);
    assert.equal(isDeferred(e, 'f2', 500), false);
    assert.equal(isDeferred(entry({ until: undefined }), 'f1', 0), false);
  });
  it('done holds while unchanged', () => {
    const e = entry({ kind: 'done' });
    assert.equal(isDeferred(e, 'f1', 1e12), true);
    assert.equal(isDeferred(e, 'f2', 0), false);
  });
  it('hide always holds', () => {
    assert.equal(isDeferred(entry({ kind: 'hide' }), 'other', 1e12), true);
  });
});

describe('snoozeUntil', () => {
  const at = (y: number, m: number, d: number, h = 14) => new Date(y, m, d, h, 30).getTime();
  // 2026-11-01 is a Sunday (month index 10)
  it('twoHours adds two hours', () => {
    const now = at(2026, 10, 4);
    assert.equal(snoozeUntil('twoHours', now), now + 2 * HOUR);
  });
  it('tomorrow is 09:00 on the next working day', () => {
    const cases: [number, number][] = [[4, 5], [5, 6], [6, 9], [7, 9], [1, 2], [2, 3], [3, 4]];
    for (const [from, to] of cases) {
      assert.deepEqual(new Date(snoozeUntil('tomorrow', at(2026, 10, from))), new Date(2026, 10, to, 9, 0, 0, 0), `from day ${from}`);
    }
  });
  it('monday is the next Monday, the following one on a Monday', () => {
    assert.deepEqual(new Date(snoozeUntil('monday', at(2026, 10, 4))), new Date(2026, 10, 9, 9));
    assert.deepEqual(new Date(snoozeUntil('monday', at(2026, 10, 1))), new Date(2026, 10, 2, 9));
    assert.deepEqual(new Date(snoozeUntil('monday', at(2026, 10, 2))), new Date(2026, 10, 9, 9));
  });
});

describe('collectGarbage', () => {
  const now = 100 * DAY;
  it('drops entries unseen for 30 days only when the source is ok', () => {
    const entries = {
      old: entry({ seenAt: now - 31 * DAY }),
      fresh: entry({ seenAt: now - 29 * DAY }),
      oldFailing: entry({ seenAt: now - 40 * DAY, source: 'runs', project: 'Fabrikam' }),
    };
    const kept = collectGarbage(entries, source => source !== 'runs', now);
    assert.deepEqual(Object.keys(kept).toSorted((a, b) => a.localeCompare(b)), ['fresh', 'oldFailing']);
  });
});

describe('MyDayDefers', () => {
  const org = 'https://dev.azure.com/contoso';
  it('sets, gets and removes', async () => {
    const m = memento();
    const d = new MyDayDefers(m, () => org);
    await d.set('wi:1', entry());
    assert.equal(d.get('wi:1')?.title, 'Fix build');
    assert.ok(m.data.has(`myDay:defers:${org}`));
    await d.remove('wi:1');
    assert.equal(d.get('wi:1'), undefined);
    const writes = m.writes.length;
    await d.remove('wi:1');
    assert.equal(m.writes.length, writes);
  });
  it('separates organizations', async () => {
    const m = memento();
    let current = org;
    const d = new MyDayDefers(m, () => current);
    await d.set('wi:1', entry());
    current = 'https://dev.azure.com/fabrikam';
    assert.deepEqual(Object.keys(d.all()), []);
    current = org;
    assert.deepEqual(Object.keys(d.all()), ['wi:1']);
  });
  it('tolerates malformed storage', () => {
    for (const bad of ['text', 5, null, [1, 2]]) {
      const d = new MyDayDefers(memento({ [`myDay:defers:${org}`]: bad }), () => org);
      assert.deepEqual(Object.keys(d.all()), []);
    }
    const d = new MyDayDefers(memento({ [`myDay:defers:${org}`]: { a: 'x', b: entry() } }), () => org);
    assert.deepEqual(Object.keys(d.all()), ['b']);
  });
  it('is prototype safe', async () => {
    const m = memento({ [`myDay:defers:${org}`]: JSON.parse('{"__proto__":{"polluted":true},"ok":{"kind":"hide"}}') });
    const d = new MyDayDefers(m, () => org);
    assert.equal(({} as any).polluted, undefined);
    assert.equal(d.get('__proto__'), undefined);
    await d.set('__proto__', entry());
    assert.equal(({} as any).kind, undefined);
    assert.equal(({} as any).polluted, undefined);
    await d.remove('__proto__');
    assert.equal(d.get('constructor'), undefined);
  });
  it('markSeen writes only on changes over an hour', async () => {
    const m = memento();
    const d = new MyDayDefers(m, () => org);
    await d.set('a', entry({ seenAt: 10 * HOUR }));
    const writes = m.writes.length;
    await d.markSeen(['a', 'missing'], 10 * HOUR + HOUR);
    assert.equal(m.writes.length, writes);
    await d.markSeen(['a', 'missing'], 12 * HOUR);
    assert.equal(m.writes.length, writes + 1);
    assert.equal(d.get('a')?.seenAt, 12 * HOUR);
  });
  it('prune writes only when something was dropped', async () => {
    const m = memento();
    const d = new MyDayDefers(m, () => org);
    await d.set('old', entry({ seenAt: 0 }));
    await d.set('new', entry({ seenAt: 50 * DAY }));
    const writes = m.writes.length;
    await d.prune(() => false, 60 * DAY);
    await d.prune(() => true, 20 * DAY);
    assert.equal(m.writes.length, writes);
    await d.prune(() => true, 60 * DAY);
    assert.equal(m.writes.length, writes + 1);
    assert.deepEqual(Object.keys(d.all()), ['new']);
  });
});
