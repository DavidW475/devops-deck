import { workingDays } from '../workItems/sprint';
import type { MyDayItem, MyDayTier, RankFacts, RankReason, Ranked } from './types';

/** One weight of the ranking. `{n}` in the label is replaced by a number. */
export interface RankRule {
  points: number;
  label: string;
}

/**
 * Every rule of the ranking, the only place for weights. The id is the rule, an optional `:variant` after it
 * tells the thresholds apart (`A2:4h`, `A2:24h`).
 */
export const RULES: Readonly<Record<string, RankRule>> = {
  A1: { points: 80, label: 'You are an assigned approver' },
  'A2:4h': { points: 5, label: 'Waiting at least 4 hours' },
  'A2:24h': { points: 10, label: 'Waiting at least 24 hours' },
  A3: { points: 5, label: 'Your approval is required' },
  'R1:failed': { points: 50, label: 'Your run failed' },
  'R1:partiallySucceeded': { points: 30, label: 'Your run partially succeeded' },
  R2: { points: 25, label: 'Failed on an important branch' },
  'R3:recent': { points: 5, label: 'Just failed' },
  'R3:old': { points: -15, label: 'Older failure' },
  P1: { points: 40, label: 'Waiting for your review' },
  P2: { points: 15, label: 'You are a required reviewer' },
  'P3:1': { points: 5, label: 'Open for {n} working {days}' },
  'P3:3': { points: 10, label: 'Open for {n} working {days}' },
  'P3:7': { points: 20, label: 'Open for {n} working {days}' },
  P4: { points: -10, label: 'Has conflicts, author goes first' },
  W1: { points: 10, label: 'Assigned to you' },
  'W2:InProgress': { points: 20, label: 'In progress' },
  'W2:Resolved': { points: -10, label: 'Resolved' },
  'W3:1': { points: 30, label: 'Priority 1' },
  'W3:2': { points: 10, label: 'Priority 2' },
  'W4:over': { points: 30, label: 'Sprint is over' },
  'W4:2': { points: 25, label: 'Sprint ends in {n} working {days}' },
  'W4:5': { points: 10, label: 'Sprint ends in {n} working {days}' },
  W5: { points: 5, label: 'Bug' },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Labels for a run that only partially succeeded: "failed" would be wrong. */
const PARTIAL_LABELS: Readonly<Record<string, string>> = {
  R2: 'Partly failed on an important branch',
  'R3:recent': 'Just finished with problems',
  'R3:old': 'Older partial failure',
};

function reason(id: string, n?: number, partial = false): RankReason {
  const r = RULES[id];
  const label = (partial ? PARTIAL_LABELS[id] : undefined) ?? r.label;
  return { rule: id.split(':')[0], label: label.replace('{n}', String(n ?? '')).replace('{days}', n === 1 ? 'day' : 'days'), points: r.points };
}

function parse(iso: string | undefined): number | undefined {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? undefined : t;
}

function approvalReasons(f: Extract<RankFacts, { kind: 'approval' }>, now: number): RankReason[] {
  const out = [reason('A1')];
  const created = parse(f.createdOn);
  const age = created === undefined ? 0 : now - created;
  if (age >= 24 * HOUR) {
    out.push(reason('A2:24h'));
  } else if (age >= 4 * HOUR) {
    out.push(reason('A2:4h'));
  }
  if (f.openSteps <= f.stillNeeded) {
    out.push(reason('A3'));
  }
  return out;
}

function runReasons(f: Extract<RankFacts, { kind: 'run' }>, now: number): RankReason[] {
  const out: RankReason[] = [];
  if (f.result === 'failed' || f.result === 'partiallySucceeded') {
    out.push(reason(`R1:${f.result}`));
  }
  const partial = f.result === 'partiallySucceeded';
  if (f.important) {
    out.push(reason('R2', undefined, partial));
  }
  const finished = parse(f.finishTime);
  if (finished !== undefined) {
    if (now - finished < DAY) {
      out.push(reason('R3:recent', undefined, partial));
    } else if (now - finished > 3 * DAY) {
      out.push(reason('R3:old', undefined, partial));
    }
  }
  return out;
}

const isWorkingDay = (day: Date): boolean => day.getUTCDay() !== 0 && day.getUTCDay() !== 6;

/** The calendar date of an instant in the user's time zone, as midnight UTC of that date (what `workingDays` counts with). */
function localDay(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/**
 * Working days after the day itself, by the user's local calendar days. A pull request created on a weekend counts from
 * the next working day: on Monday it has been open one working day, as one created on Friday evening.
 */
function daysOpen(from: string, now: number): number {
  const created = parse(from);
  if (created === undefined) {
    return 0;
  }
  const start = localDay(created);
  return Math.max(0, workingDays(start, localDay(now)) - (isWorkingDay(start) ? 1 : 0));
}

function reviewReasons(f: Extract<RankFacts, { kind: 'review' }>, now: number): RankReason[] {
  const out = [reason('P1')];
  if (f.required) {
    out.push(reason('P2'));
  }
  const n = daysOpen(f.creationDate, now);
  if (n >= 7) {
    out.push(reason('P3:7', n));
  } else if (n >= 3) {
    out.push(reason('P3:3', n));
  } else if (n >= 1) {
    out.push(reason('P3:1', n));
  }
  if (f.conflicts) {
    out.push(reason('P4'));
  }
  return out;
}

function sprintReasons(sprintFinish: string | undefined, now: number): RankReason[] {
  const finish = parse(sprintFinish);
  if (finish === undefined) {
    return [];
  }
  // Today is the user's calendar day; the sprint ends on a date (stored at midnight UTC), whatever the time zone.
  const today = localDay(now);
  const end = new Date(finish);
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  if (last < today) {
    return [reason('W4:over')];
  }
  const left = Math.max(0, workingDays(today, last) - 1);
  if (left <= 2) {
    return [reason('W4:2', left)];
  }
  return left <= 5 ? [reason('W4:5', left)] : [];
}

function workItemReasons(f: Extract<RankFacts, { kind: 'workItem' }>, now: number): RankReason[] {
  const out = [reason('W1')];
  if (f.stateCategory === 'InProgress' || f.stateCategory === 'Resolved') {
    out.push(reason(`W2:${f.stateCategory}`));
  }
  if (f.priority === 1 || f.priority === 2) {
    out.push(reason(`W3:${f.priority}`));
  }
  out.push(...sprintReasons(f.sprintFinish, now));
  if (f.type === 'Bug') {
    out.push(reason('W5'));
  }
  return out;
}

function reasonsOf(facts: RankFacts, now: number): RankReason[] {
  switch (facts.kind) {
    case 'approval': return approvalReasons(facts, now);
    case 'run': return runReasons(facts, now);
    case 'review': return reviewReasons(facts, now);
    case 'workItem': return workItemReasons(facts, now);
  }
}

export function tierOf(score: number): MyDayTier {
  if (score >= 70) {
    return 'now';
  }
  return score >= 40 ? 'today' : 'later';
}

export function rankItem(facts: RankFacts, now: number): Ranked {
  const reasons = reasonsOf(facts, now);
  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  return { score, tier: tierOf(score), reasons };
}

/** Best first: higher score, then the older one, then the key. Total, so the order is stable. */
export function compareItems(a: Pick<MyDayItem, 'score' | 'since' | 'key'>, b: Pick<MyDayItem, 'score' | 'since' | 'key'>): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  const ta = parse(a.since) ?? Number.POSITIVE_INFINITY;
  const tb = parse(b.since) ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) {
    return ta < tb ? -1 : 1;
  }
  if (a.key === b.key) {
    return 0;
  }
  return a.key < b.key ? -1 : 1;
}
