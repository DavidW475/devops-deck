import type { Approval, Build, ClassificationIteration, IdentityRef, PullRequest, WorkItem, WorkItemState } from '../types';

export type MyDaySource = 'reviews' | 'approvals' | 'runs' | 'workItems';
export type MyDayTier = 'now' | 'today' | 'later';

/** One line of "Why here?". The points of all reasons add up to the score. */
export interface RankReason {
  rule: string;
  label: string;
  points: number;
}

/** A button of a card. The page runs it through the `command` message, which only allows `azureDevOps.` commands. */
export interface MyDayAction {
  /** name in `ICONS` of media/sidebar.js */
  icon: string;
  title: string;
  cmd: `azureDevOps.${string}`;
  args: unknown[];
  style?: 'accent' | 'danger';
  /** also shown as a named button in the opened card */
  primary?: boolean;
}

export interface MyDayItem {
  /** `pr:<repoId>:<id>`, `approval:<uuid>`, `run:<project>:<id>` or `wi:<id>` */
  key: string;
  source: MyDaySource;
  /** name in `ICONS` of media/sidebar.js */
  icon: string;
  /** `status` class of the icon */
  iconClass: 'ok' | 'fail' | 'warn' | 'queued' | 'muted';
  title: string;
  /** second line, rendered joined by " · "; every part is plain text */
  meta: string[];
  /** the project of the item, always set; the page shows it only when `MyDayResult.multi` is true */
  project: string;
  /** ISO date the item's age counts from */
  since?: string;
  score: number;
  tier: MyDayTier;
  reasons: RankReason[];
  fingerprint: string;
  actions: MyDayAction[];
  instructions?: string;
  /** when the source failed: the time of the last good load (ms) */
  staleSince?: number;
}

export type RankFacts =
  | { kind: 'approval'; createdOn?: string; openSteps: number; stillNeeded: number }
  | { kind: 'run'; result: string; important: boolean; finishTime?: string }
  | { kind: 'review'; required: boolean; creationDate: string; conflicts: boolean }
  | { kind: 'workItem'; stateCategory?: string; priority?: number; type?: string; sprintFinish?: string };

export interface Ranked {
  score: number;
  tier: MyDayTier;
  reasons: RankReason[];
}

/** What `snoozeUntil` can compute. */
export type SnoozeChoice = 'twoHours' | 'tomorrow' | 'monday';

export interface DeferEntry {
  kind: 'snooze' | 'done' | 'hide';
  /** only for `snooze` (ms) */
  until?: number;
  fingerprint: string;
  /** last time the item was still listed (ms); entries unseen for 30 days are dropped */
  seenAt: number;
  title: string;
  source: MyDaySource;
  project: string;
}

/** A deferred item as the page lists it. */
export interface DeferredDto {
  key: string;
  title: string;
  kind: DeferEntry['kind'];
  until?: number;
  project: string;
}

export interface SourceFailure {
  source: MyDaySource;
  project: string;
  message: string;
  kind: 'auth' | 'forbidden' | 'throttled' | 'other';
  staleSince?: number;
}

export interface MyDayResult {
  /** every visible item, best first */
  items: MyDayItem[];
  deferred: DeferredDto[];
  failures: SourceFailure[];
  /** `now` + `today` after deferring: the badge */
  count: number;
  /** more than one project is selected */
  multi: boolean;
  /** last successful load of any source (ms) */
  loadedAt: number;
}

/** The REST calls per project, a subset of `AdoClient` so tests can fake them. */
export interface MyDayClient {
  listPullRequests(criteria: { reviewerId?: string }): Promise<PullRequest[]>;
  listPendingApprovals(): Promise<Approval[]>;
  listBuildsSince(since: Date, order: 'finished' | 'started', opts?: { requestedFor?: string; top?: number }): Promise<Build[]>;
  queryWiql(wiql: string): Promise<number[]>;
  getWorkItems(ids: number[]): Promise<WorkItem[]>;
  listIterationDates(): Promise<ClassificationIteration[]>;
}

export interface MyDayDeps {
  getMe(): Promise<IdentityRef>;
  clientFor(project: string): MyDayClient;
  /** the selected projects */
  projects(): string[];
  /** the states of a work item type, shared with the sidebar */
  statesFor(project: string, type: string): Promise<WorkItemState[]>;
  /** WIQL of "Assigned to me" */
  assignedWiql(): string;
  /** setting `azureDevOps.myDay.importantBranches` */
  importantBranches(): string[];
  /** setting `azureDevOps.refreshInterval` in seconds, 0 = only at start and by hand */
  refreshSeconds(): number;
  isFocused(): boolean;
  /** time (ms) until which Azure DevOps asked to pause, 0 when it did not */
  throttledUntil(): number;
  now?(): number;
}
