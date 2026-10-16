import { IterationWorkItemLink, TeamMemberCapacity } from '../types';

const DAY = 86_400_000;

/** Midnight UTC of the date part, so time zones don't shift days. */
function dayOf(iso: string | Date): number {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function inRanges(day: number, ranges: { start: string; end: string }[]): boolean {
  return ranges.some(r => day >= dayOf(r.start) && day <= dayOf(r.end));
}

/** Working days (Mon–Fri, minus days off) from `from` through `to`, both included. */
export function workingDays(from: string | Date, to: string | Date, daysOff: { start: string; end: string }[] = []): number {
  let n = 0;
  for (let d = dayOf(from); d <= dayOf(to); d += DAY) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6 && !inRanges(d, daysOff)) {
      n++;
    }
  }
  return n;
}

/** Parent of every item in the sprint (only when the parent is in the sprint too) and all IDs in backlog order. */
export function sprintStructure(links: IterationWorkItemLink[]): { ids: number[]; parentOf: Map<number, number> } {
  const ids: number[] = [];
  const parentOf = new Map<number, number>();
  for (const l of links) {
    const id = l.target?.id;
    if (!id) {
      continue;
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
    if (l.rel && l.source?.id) {
      parentOf.set(id, l.source.id);
    }
  }
  return { ids, parentOf };
}

export interface PersonLoad {
  name: string;
  remaining: number;
  /** hours available until the end of the sprint; undefined when the team plans no capacity for the person */
  capacity?: number;
}

/**
 * Remaining work per person compared with their capacity for the rest of the sprint
 * (capacity per day × working days left, minus personal and team days off).
 */
export function loadByPerson(
  items: { assignedTo?: string; remaining?: number; done: boolean }[],
  capacities: TeamMemberCapacity[], teamDaysOff: { start: string; end: string }[], today: Date, finish?: string | null,
): PersonLoad[] {
  const people = new Map<string, PersonLoad>();
  const get = (name: string) => {
    let p = people.get(name);
    if (!p) {
      p = { name, remaining: 0 };
      people.set(name, p);
    }
    return p;
  };
  for (const c of capacities) {
    const perDay = c.activities.reduce((s, a) => s + (a.capacityPerDay || 0), 0);
    if (perDay > 0 && finish) {
      get(c.teamMember.displayName).capacity = perDay * workingDays(today, finish, [...teamDaysOff, ...c.daysOff]);
    }
  }
  for (const i of items) {
    if (!i.done && i.remaining) {
      get(i.assignedTo ?? 'Unassigned').remaining += i.remaining;
    }
  }
  return [...people.values()].filter(p => p.remaining || p.capacity).sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
}
