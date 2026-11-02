import type * as vscode from 'vscode';
import type { DeferEntry, MyDaySource, SnoozeChoice } from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GC_AGE = 30 * DAY;

/** Whether the entry still hides the item: a snooze until it ends or the item changes, "done" until it changes, "hide" always. */
export function isDeferred(entry: DeferEntry, fingerprint: string, now: number): boolean {
  if (entry.kind === 'hide') {
    return true;
  }
  if (entry.fingerprint !== fingerprint) {
    return false;
  }
  if (entry.kind === 'done') {
    return true;
  }
  return now < (entry.until ?? 0);
}

/** 09:00 local time, `days` calendar days after `now` (local setters keep DST right). */
function morning(now: number, days: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

export function snoozeUntil(choice: SnoozeChoice, now: number): number {
  if (choice === 'twoHours') {
    return now + 2 * HOUR;
  }
  const weekday = new Date(now).getDay(); // 0 = Sunday
  const toMonday = (8 - weekday) % 7 || 7;
  if (choice === 'monday') {
    return morning(now, toMonday);
  }
  // Friday, Saturday and Sunday jump to Monday, otherwise the next day
  return morning(now, weekday >= 5 || weekday === 0 ? toMonday : 1);
}

/** Drops entries unseen for 30 days, but only for sources that loaded fine: a failing source never loses defers. */
export function collectGarbage(entries: Record<string, DeferEntry>, ok: (source: MyDaySource, project: string) => boolean, now: number): Record<string, DeferEntry> {
  const kept: Record<string, DeferEntry> = Object.create(null);
  for (const [key, entry] of Object.entries(entries)) {
    if (now - entry.seenAt > GC_AGE && ok(entry.source, entry.project)) {
      continue;
    }
    kept[key] = entry;
  }
  return kept;
}

/** The deferred items of one organization, kept in the global state. */
export class MyDayDefers {
  constructor(private readonly memento: Pick<vscode.Memento, 'get' | 'update'>, private readonly orgUrl: () => string) {}

  private get storageKey(): string {
    return `myDay:defers:${this.orgUrl()}`;
  }

  all(): Record<string, DeferEntry> {
    const raw = this.memento.get<unknown>(this.storageKey);
    const result: Record<string, DeferEntry> = Object.create(null);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return result;
    }
    for (const [key, entry] of Object.entries(raw)) {
      if (key !== '__proto__' && entry !== null && typeof entry === 'object') {
        result[key] = entry as DeferEntry;
      }
    }
    return result;
  }

  get(key: string): DeferEntry | undefined {
    return this.all()[key];
  }

  private async save(entries: Record<string, DeferEntry>): Promise<void> {
    await this.memento.update(this.storageKey, { ...entries });
  }

  async set(key: string, entry: DeferEntry): Promise<void> {
    const entries = this.all();
    entries[key] = entry;
    await this.save(entries);
  }

  /** Removes several entries with one write. */
  async removeMany(keys: string[]): Promise<void> {
    const entries = this.all();
    const present = keys.filter(k => k in entries);
    if (present.length > 0) {
      present.forEach(k => delete entries[k]);
      await this.save(entries);
    }
  }

  async remove(key: string): Promise<void> {
    const entries = this.all();
    if (key in entries) {
      delete entries[key];
      await this.save(entries);
    }
  }

  /** Remembers that the items were listed now. Writes only when a timestamp moved by more than an hour, so polling does not write constantly. */
  async markSeen(keys: string[], now: number): Promise<void> {
    const entries = this.all();
    let changed = false;
    for (const key of keys) {
      const entry = entries[key];
      if (entry && now - entry.seenAt > HOUR) {
        entries[key] = { ...entry, seenAt: now };
        changed = true;
      }
    }
    if (changed) {
      await this.save(entries);
    }
  }

  async prune(ok: (source: MyDaySource, project: string) => boolean, now: number): Promise<void> {
    const before = this.all();
    const after = collectGarbage(before, ok, now);
    if (Object.keys(after).length !== Object.keys(before).length) {
      await this.save(after);
    }
  }
}
