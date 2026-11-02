import * as vscode from 'vscode';
import { AdoError } from '../client';
import type { Approval, Build, ClassificationIteration, IdentityRef, PullRequest, WorkItem, WorkItemState } from '../types';
import { errorMessage, mapLimit } from '../util';
import type { DeferTarget } from './commands';
import { isDeferred, type MyDayDefers } from './defers';
import { approvalItem, dedupe, reviewItem, runItems, workItemItem } from './model';
import { compareItems } from './rank';
import type { DeferEntry, DeferredDto, MyDayDeps, MyDayItem, MyDayResult, MyDaySource, SourceFailure } from './types';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TICK = 15 * SECOND;
const SLOW_TTL = 5 * MINUTE;
const FAST_TTL = MINUTE;
const RAW_TTL = 30 * SECOND;
const FORBIDDEN_RETRY = 30 * MINUTE;
/** After the user's own change, a forced reload counts as a direct action for this long. */
const DIRECT_WINDOW = 10 * SECOND;
const ITERATIONS_TTL = 60 * MINUTE;
const RUN_WINDOW = 7 * 24 * 60 * MINUTE;
const PROJECT_PARALLEL = 4;
const MAX_WORK_ITEMS = 200;
const RUN_TOP = 50;
/** A list that reached its cap may be cut off: an item missing from it is not known to be gone. */
const LIST_CAP: Record<MyDaySource, number> = { reviews: Infinity, approvals: Infinity, runs: RUN_TOP, workItems: MAX_WORK_ITEMS };
const SOURCES: readonly MyDaySource[] = ['reviews', 'approvals', 'runs', 'workItems'];

interface WorkItemEntry {
  wi: WorkItem;
  category?: string;
}

interface Slot {
  data?: unknown;
  /** last good load (ms) */
  loadedAt?: number;
  /** last request (ms) */
  attemptAt?: number;
  /** marked due by `invalidate` */
  stale?: boolean;
  error?: { err: unknown; kind: SourceFailure['kind'] };
  /** 403: no new attempt before this time unless the user asked */
  blockedUntil?: number;
}

interface LoadOptions {
  /** reload although the data is fresh (a change was made, or the user asked); neither the pause nor the 403 backoff is skipped */
  force?: boolean;
  /** load only this source */
  only?: MyDaySource;
  /** ignore the TTL (not the backoff, focus-free) */
  ignoreTtl?: boolean;
  /** the user clicked Refresh or Retry: load although Azure DevOps asked for a pause or the source is blocked after a 403 (timers and reloads after a change never do) */
  user?: boolean;
}

/** What a caller says about a request: `force` reloads, `user` is a real click on Refresh or Retry. */
export interface RequestOptions {
  force?: boolean;
  user?: boolean;
}

/** A running load of one source and the projects (lower case) it covers: a caller that joins it may need more. */
interface Flight {
  promise: Promise<void>;
  projects: ReadonlySet<string>;
}

interface Computed {
  result: MyDayResult;
  /** all listed items by key, deferred ones included */
  listed: Map<string, MyDayItem>;
}

function classify(e: unknown): SourceFailure['kind'] {
  if (e instanceof AdoError) {
    if (e.isAuthError) {
      return 'auth';
    }
    if (e.status === 403) {
      return 'forbidden';
    }
    if (e.status === 429) {
      return 'throttled';
    }
  }
  return 'other';
}

/** Project names compare case-insensitively: the setting, the work item field and the defers may spell them differently. */
const slotKey = (source: MyDaySource, project: string): string => `${source}\u0000${project.toLowerCase()}`;

/** Loads, caches and ranks everything "My Day" shows. Starts no request before `get` or `start`. */
export class MyDayService implements vscode.Disposable, DeferTarget {
  private readonly emitter = new vscode.EventEmitter<MyDayResult>();
  readonly onDidChange: vscode.Event<MyDayResult> = this.emitter.event;
  private readonly slots = new Map<string, Slot>();
  private readonly flights = new Map<MyDaySource, Flight>();
  private readonly iterations = new Map<string, { attemptAt: number; finish: Map<string, string> }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private visible = false;
  private generation = 0;
  /** Counts `invalidate` calls: a flight that started before one must not mark its slot as fresh. */
  private invalidations = 0;
  /** Until this time (ms) a forced request follows a change the user made themselves: it is not held back by a pause. */
  private directUntil = 0;
  private disposed = false;
  private me: IdentityRef | undefined;
  private lastItems: MyDayItem[] = [];
  private lastSignature = '';

  constructor(private readonly deps: MyDayDeps, private readonly defers: MyDayDefers) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ---------- public API ----------

  async get(options: RequestOptions = {}): Promise<MyDayResult> {
    const load: LoadOptions = { force: options.force || options.user, user: this.isDirect(options) };
    await this.ensureLoaded(load);
    if (load.force && this.anyStale(load)) {
      await this.ensureLoaded(load); // a change came in while the first request ran: its answer may be outdated
    }
    const { result } = this.compute();
    this.lastSignature = this.signature(result);
    const authError = this.authOnlyError();
    if (authError) {
      throw authError;
    }
    return result;
  }

  start(): void {
    if (this.timer || this.disposed) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK);
  }

  /** Stops the timer (the view is gone); `start` runs it again. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.visible = false;
  }

  setVisible(visible: boolean): void {
    const becameVisible = visible && !this.visible;
    this.visible = visible;
    if (becameVisible && this.timer && this.anyDue()) {
      void this.tick();
    }
  }

  /** Marks everything due. `direct`: the user's own change caused it, so the reload that follows is not held back by a pause. */
  invalidate(direct = false): void {
    this.invalidations++;
    if (direct) {
      this.directUntil = this.now() + DIRECT_WINDOW;
    }
    for (const slot of this.slots.values()) {
      slot.stale = true;
    }
  }

  reset(): void {
    this.generation++;
    this.slots.clear();
    this.flights.clear();
    this.iterations.clear();
    this.me = undefined;
    this.lastItems = [];
    this.lastSignature = '';
  }

  itemByKey(key: string): MyDayItem | undefined {
    return this.lastItems.find(i => i.key === key);
  }

  async applyDefer(item: MyDayItem, kind: DeferEntry['kind'], until?: number): Promise<void> {
    const entry: DeferEntry = { kind, fingerprint: item.fingerprint, seenAt: this.now(), title: item.title, source: item.source, project: item.project };
    if (kind === 'snooze') {
      entry.until = until;
    }
    await this.defers.set(item.key, entry);
    this.publish();
  }

  async restore(key: unknown): Promise<void> {
    if (typeof key !== 'string' || !this.defers.get(key)) {
      return;
    }
    await this.defers.remove(key);
    this.publish();
  }

  rawReviews(project: string, request: RequestOptions = {}): Promise<PullRequest[]> {
    return this.raw<PullRequest[]>('reviews', project, request);
  }

  rawApprovals(project: string, request: RequestOptions = {}): Promise<Approval[]> {
    return this.raw<Approval[]>('approvals', project, request);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.emitter.dispose();
  }

  // ---------- timer ----------

  private async tick(): Promise<void> {
    if (this.disposed || !this.deps.isFocused() || this.throttled()) {
      return;
    }
    const generation = this.generation;
    try {
      await this.ensureLoaded({});
      if (generation === this.generation && !this.disposed) {
        this.publish(true);
      }
    } catch {
      // getMe failed (the next tick tries again) or a listener threw: a timer has nobody to tell
    }
  }

  /** Recomputes without requests and fires when the visible state differs (or always unless `onlyIfChanged`). */
  private publish(onlyIfChanged = false): void {
    if (this.disposed || !this.me) {
      return;
    }
    const { result } = this.compute();
    const signature = this.signature(result);
    if (onlyIfChanged && signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;
    this.emitter.fire(result);
  }

  private signature(r: MyDayResult): string {
    return JSON.stringify([r.items, r.deferred, r.failures, r.count, r.multi]);
  }

  private throttled(): boolean {
    return this.now() < this.deps.throttledUntil();
  }

  // ---------- due logic ----------

  /** Never shorter than the user's refresh interval: a hidden view or the work items must not poll more often than a visible one. */
  private ttl(source: MyDaySource): number {
    const visible = Math.max(FAST_TTL, this.deps.refreshSeconds() * SECOND);
    return source !== 'workItems' && this.visible && this.deps.isFocused() ? visible : Math.max(SLOW_TTL, visible);
  }

  private isDue(source: MyDaySource, project: string, now: number, opts: LoadOptions): boolean {
    const slot = this.slots.get(slotKey(source, project));
    if (slot?.attemptAt === undefined) {
      return true;
    }
    if (slot.blockedUntil !== undefined && now < slot.blockedUntil && !opts.user) {
      return false;
    }
    if (opts.force || opts.ignoreTtl) {
      return true;
    }
    if (!this.deps.isFocused()) {
      return false;
    }
    if (slot.stale) {
      return true;
    }
    return this.deps.refreshSeconds() > 0 && now - slot.attemptAt >= this.ttl(source);
  }

  private dueProjects(source: MyDaySource, now: number, opts: LoadOptions): string[] {
    return this.deps.projects().filter(p => this.isDue(source, p, now, opts));
  }

  /** A click, or a forced request right after the user's own change. */
  private isDirect(request: RequestOptions): boolean {
    return !!request.user || (!!request.force && this.now() < this.directUntil);
  }

  /** True when a slot was invalidated and a load with these options would reload it (a slot in a 403 backoff or a pause would not). */
  private anyStale(opts: LoadOptions): boolean {
    if (this.throttled() && !opts.user) {
      return false;
    }
    const now = this.now();
    return this.deps.projects().some(p => SOURCES.some(s => this.slots.get(slotKey(s, p))?.stale && this.isDue(s, p, now, opts)));
  }

  private anyDue(): boolean {
    const now = this.now();
    return SOURCES.some(s => this.dueProjects(s, now, {}).length > 0);
  }

  // ---------- loading ----------

  /** Starts the due loads (one flight per source) and waits for them. Starts nothing while throttled. */
  private async ensureLoaded(opts: LoadOptions): Promise<void> {
    const now = this.now();
    if (this.throttled() && !opts.user) {
      return;
    }
    const sources = SOURCES.filter(s => (!opts.only || opts.only === s) && (this.flights.has(s) || this.dueProjects(s, now, opts).length > 0));
    if (sources.length === 0) {
      return;
    }
    const generation = this.generation;
    const fresh = sources.filter(s => !this.flights.has(s));
    // What this caller needs, by source: a flight that is already running may cover only some of those projects.
    const wanted = new Map(sources.map(s => [s, this.dueProjects(s, now, opts)] as const));
    const running = new Map(sources.flatMap(s => { const f = this.flights.get(s); return f ? [[s, new Set(f.projects)] as const] : []; }));
    if (fresh.length > 0 && !(await this.startFlights(fresh, opts, now, generation))) {
      // `reset` ran while we waited for the user: start over in the new generation, never a flight that drops its records.
      return this.ensureLoaded(opts);
    }
    await Promise.all(sources.flatMap(s => this.flights.get(s)?.promise ?? []));
    await Promise.all([...running].map(([s, covered]) => this.loadUncovered(s, wanted.get(s) ?? [], covered, generation)));
    if (generation !== this.generation) {
      // `reset` ran while the flights were running: their answers were dropped, and the empty slots must not read as "nothing to do".
      return this.ensureLoaded(opts);
    }
    if (fresh.length > 0) {
      this.afterLoad(now);
    }
  }

  /**
   * A caller joined a flight that covered only some of the projects it needs (a timer loads only what is due; a click on
   * Refresh or a vote wants all of them, also the ones in a 403 backoff): load the rest in a flight of its own.
   */
  private async loadUncovered(source: MyDaySource, wanted: string[], covered: Set<string>, generation: number): Promise<void> {
    for (let rest = wanted.filter(p => !covered.has(p.toLowerCase())); rest.length > 0; rest = wanted.filter(p => !covered.has(p.toLowerCase()))) {
      const me = this.me;
      if (generation !== this.generation || !me) {
        return;
      }
      const running = this.flights.get(source);
      if (running) {
        running.projects.forEach(p => covered.add(p)); // started after we began: fresh enough for us
        await running.promise; // NOSONAR: sequential rounds, each depends on what the previous flight covered
      } else {
        rest.forEach(p => covered.add(p.toLowerCase()));
        this.startFlight(source, rest, me, this.now(), generation);
        await this.flights.get(source)?.promise; // NOSONAR: sequential rounds, each depends on what the previous flight covered
      }
    }
  }

  /** Starts a flight for each source; false when a `reset` happened while `getMe` was pending (nothing was started). */
  private async startFlights(sources: MyDaySource[], opts: LoadOptions, now: number, generation: number): Promise<boolean> {
    const me = await this.deps.getMe();
    if (generation !== this.generation) {
      return false;
    }
    this.me = me;
    for (const s of sources) {
      if (!this.flights.has(s)) {
        this.startFlight(s, this.dueProjects(s, now, opts), me, now, generation);
      }
    }
    return true;
  }

  private startFlight(source: MyDaySource, projects: string[], me: IdentityRef, now: number, generation: number): void {
    const promise: Promise<void> = this.loadSource(source, projects, me, now, generation, this.invalidations).finally(() => {
      if (this.flights.get(source)?.promise === promise) {
        this.flights.delete(source);
      }
    });
    this.flights.set(source, { promise, projects: new Set(projects.map(p => p.toLowerCase())) });
  }

  private loadSource(source: MyDaySource, projects: string[], me: IdentityRef, now: number, generation: number, invalidations: number): Promise<void> {
    const record = (project: string, outcome: { data: unknown } | { err: unknown }): void => {
      if (generation === this.generation) {
        // An `invalidate` since the request started: this answer may already be outdated, so the slot stays due.
        this.record(source, project, now, outcome, invalidations !== this.invalidations);
      }
    };
    if (source === 'workItems') {
      return this.loadWorkItems(projects, now, generation, record);
    }
    const fetch = (project: string): Promise<unknown> => {
      const client = this.deps.clientFor(project);
      switch (source) {
        case 'reviews':
          return client.listPullRequests({ reviewerId: me.id });
        case 'approvals':
          return client.listPendingApprovals();
        default:
          return client.listBuildsSince(new Date(now - RUN_WINDOW), 'finished', { requestedFor: me.id, top: RUN_TOP });
      }
    };
    return mapLimit(projects, PROJECT_PARALLEL, async project => {
      try {
        record(project, { data: await fetch(project) });
      } catch (err) {
        record(project, { err });
      }
    }).then(() => undefined);
  }

  private async loadWorkItems(projects: string[], now: number, generation: number, record: (project: string, outcome: { data: unknown } | { err: unknown }) => void): Promise<void> {
    const idsByProject = new Map<string, number[]>();
    await mapLimit(projects, PROJECT_PARALLEL, async project => {
      try {
        idsByProject.set(project, (await this.deps.clientFor(project).queryWiql(this.deps.assignedWiql())).slice(0, MAX_WORK_ITEMS));
      } catch (err) {
        record(project, { err });
      }
    });
    const okProjects = projects.filter(p => idsByProject.has(p));
    const ids = [...new Set(okProjects.flatMap(p => idsByProject.get(p) ?? []))];
    let byId = new Map<number, WorkItem>();
    if (ids.length > 0) {
      try {
        byId = new Map((await this.deps.clientFor(okProjects[0]).getWorkItems(ids)).map(w => [w.id, w]));
      } catch (err) {
        okProjects.forEach(p => record(p, { err }));
        return;
      }
      await this.refreshIterations(okProjects, now, generation);
    }
    const categories = new Map<string, Promise<WorkItemState[]>>();
    let entries: (readonly [string, WorkItemEntry[]])[];
    try {
      entries = await Promise.all(okProjects.map(async project => {
        const wis = (idsByProject.get(project) ?? []).map(id => byId.get(id)).filter((w): w is WorkItem => !!w);
        return [project, await Promise.all(wis.map(async wi => ({ wi, category: await this.categoryOf(wi, categories) })))] as const;
      }));
    } catch (err) {
      // Without the states a completed item cannot be told from an active one: this is a failed load, not a load without categories.
      okProjects.forEach(p => record(p, { err }));
      return;
    }
    entries.forEach(([project, data]) => record(project, { data }));
  }

  private categoryOf(wi: WorkItem, cache: Map<string, Promise<WorkItemState[]>>): Promise<string | undefined> {
    const project = String(wi.fields['System.TeamProject'] ?? '');
    const type = String(wi.fields['System.WorkItemType'] ?? '');
    const key = `${project}\u0000${type}`;
    let states = cache.get(key);
    if (!states) {
      states = this.deps.statesFor(project, type);
      cache.set(key, states);
    }
    const state = String(wi.fields['System.State'] ?? '');
    return states.then(list => list.find(x => x.name === state)?.category);
  }

  /** The iteration dates are a helper: a failure only costs rule W4. */
  private async refreshIterations(projects: string[], now: number, generation: number): Promise<void> {
    const stale = projects.filter(p => {
      const known = this.iterations.get(p.toLowerCase());
      return !known || now - known.attemptAt >= ITERATIONS_TTL;
    });
    await mapLimit(stale, PROJECT_PARALLEL, async project => {
      let list: ClassificationIteration[];
      try {
        list = await this.deps.clientFor(project).listIterationDates();
      } catch {
        return; // not remembered: the next load asks again (what we know stays)
      }
      if (generation === this.generation) {
        const finish = new Map<string, string>();
        list.forEach(i => i.finishDate && finish.set(i.path.toLowerCase(), i.finishDate));
        this.iterations.set(project.toLowerCase(), { attemptAt: now, finish });
      }
    });
  }

  private record(source: MyDaySource, project: string, now: number, outcome: { data: unknown } | { err: unknown }, stale: boolean): void {
    const key = slotKey(source, project);
    const prev = this.slots.get(key) ?? {};
    if ('err' in outcome) {
      const kind = classify(outcome.err);
      this.slots.set(key, { ...prev, attemptAt: now, stale, error: { err: outcome.err, kind }, blockedUntil: kind === 'forbidden' ? now + FORBIDDEN_RETRY : undefined });
      return;
    }
    this.slots.set(key, { data: outcome.data, loadedAt: now, attemptAt: now, stale });
  }

  /** After a load: remember the listed items and clean up old defers; neither blocks nor fails. */
  private afterLoad(now: number): void {
    if (!this.me) {
      return;
    }
    const { listed } = this.compute();
    const ok = (source: MyDaySource, project: string): boolean => {
      const slot = this.slots.get(slotKey(source, project));
      return !!slot && slot.loadedAt !== undefined && !slot.error;
    };
    // A "done" entry whose item changed no longer hides anything: forget it, or it would come back under Deferred once the item is gone.
    const changed = [...listed.values()].filter(i => this.defers.get(i.key)?.kind === 'done' && this.defers.get(i.key)?.fingerprint !== i.fingerprint).map(i => i.key);
    // An item that is gone for good (closed, merged, no longer mine) keeps no entry: Restore could not bring it back.
    const complete = this.listsComplete();
    const gone = Object.entries(this.defers.all()).filter(([key, entry]) => this.isGone(key, entry, listed, complete)).map(([key]) => key);
    if (changed.length + gone.length > 0) {
      void this.defers.removeMany([...changed, ...gone]).catch(() => undefined);
    }
    void this.defers.markSeen([...listed.keys()], now).catch(() => undefined);
    void this.defers.prune(ok, now).catch(() => undefined);
  }

  // ---------- shared raw lists ----------

  private async raw<T extends unknown[]>(source: 'reviews' | 'approvals', project: string, request: RequestOptions): Promise<T> {
    const key = slotKey(source, project);
    const fresh = (): T | undefined => {
      const slot = this.slots.get(key);
      return slot?.loadedAt !== undefined && !slot.error && !slot.stale && this.now() - slot.loadedAt <= RAW_TTL ? slot.data as T : undefined;
    };
    const cached = request.force || request.user ? undefined : fresh();
    if (cached) {
      return cached;
    }
    // Only a click on Refresh or Retry loads although Azure DevOps asked for a pause; a tab that is merely open or a timer does not.
    const options: LoadOptions = { only: source, ignoreTtl: true, force: request.force || request.user, user: this.isDirect(request) };
    await this.ensureLoaded(options);
    if (this.slots.get(key)?.stale) {
      await this.ensureLoaded(options); // invalidated while the first request ran
    }
    const slot = this.slots.get(key);
    if (slot?.error) {
      throw slot.error.err;
    }
    if (slot?.attemptAt === undefined && this.deps.projects().some(p => slotKey(source, p) === key)) {
      // Nothing was loaded (a pause, or a reset): an empty list would claim that there is nothing.
      throw new AdoError('Azure DevOps asked to slow down, so this is not loaded yet. Retry loads it anyway.', 429);
    }
    return (slot?.data ?? []) as T;
  }

  // ---------- result ----------

  private authOnlyError(): unknown {
    const slots = this.deps.projects().flatMap(p => SOURCES.map(s => this.slots.get(slotKey(s, p)))).filter((s): s is Slot => !!s && s.attemptAt !== undefined);
    if (slots.length === 0 || slots.some(s => s.loadedAt !== undefined || s.error?.kind !== 'auth')) {
      return undefined;
    }
    return slots[0].error?.err;
  }

  private itemsOf(source: MyDaySource, project: string, now: number): MyDayItem[] {
    const slot = this.slots.get(slotKey(source, project));
    if (!slot?.data || !this.me) {
      return [];
    }
    const me = this.me;
    let items: (MyDayItem | undefined)[];
    switch (source) {
      case 'reviews':
        items = (slot.data as PullRequest[]).map(pr => reviewItem(pr, me, project, now));
        break;
      case 'approvals':
        items = (slot.data as Approval[]).map(a => approvalItem(a, me, project, now));
        break;
      case 'runs':
        items = runItems(slot.data as Build[], project, this.deps.importantBranches(), now);
        break;
      default:
        items = (slot.data as WorkItemEntry[]).map(e => workItemItem(e.wi, e.category, this.sprintFinish(e.wi), now));
    }
    const stale = slot.error ? slot.loadedAt : undefined;
    return items.filter((i): i is MyDayItem => !!i).map(i => (stale === undefined ? i : { ...i, staleSince: stale }));
  }

  private sprintFinish(wi: WorkItem): string | undefined {
    const project = String(wi.fields['System.TeamProject'] ?? '');
    return this.iterations.get(project.toLowerCase())?.finish.get(String(wi.fields['System.IterationPath'] ?? '').toLowerCase());
  }

  private failures(projects: string[]): SourceFailure[] {
    const out: SourceFailure[] = [];
    const paused = this.throttled();
    for (const project of projects) {
      for (const source of SOURCES) {
        const slot = this.slots.get(slotKey(source, project));
        if (slot?.error) {
          out.push({ source, project, message: errorMessage(slot.error.err), kind: slot.error.kind, staleSince: slot.loadedAt });
        } else if (paused && slot?.attemptAt === undefined) {
          // Nothing was loaded yet and the pause forbids it: the page must not claim that nothing needs the user.
          out.push({ source, project, message: 'Azure DevOps asked to slow down, so this is not loaded yet. Retry loads it anyway.', kind: 'throttled' });
        }
      }
    }
    return out;
  }

  /** True when every source of every project loaded without error and none of the lists may be cut off at its cap. */
  private listsComplete(): boolean {
    const projects = this.deps.projects();
    return projects.length > 0 && projects.every(p => SOURCES.every(s => {
      const slot = this.slots.get(slotKey(s, p));
      const length = Array.isArray(slot?.data) ? slot.data.length : 0;
      return slot?.loadedAt !== undefined && !slot.error && length < LIST_CAP[s];
    }));
  }

  /** The entry's item is not listed although everything loaded fine: it is gone, not just missing because a source failed. */
  private isGone(key: string, entry: DeferEntry, listed: Map<string, MyDayItem>, complete: boolean): boolean {
    const project = entry.project.toLowerCase();
    return complete && !listed.has(key) && this.deps.projects().some(p => p.toLowerCase() === project);
  }

  private deferredList(entries: Record<string, DeferEntry>, listed: Map<string, MyDayItem>, now: number): DeferredDto[] {
    const out: DeferredDto[] = [];
    const complete = this.listsComplete();
    for (const [key, entry] of Object.entries(entries)) {
      const item = listed.get(key);
      const active = item ? isDeferred(entry, item.fingerprint, now) : entry.kind !== 'snooze' && !this.isGone(key, entry, listed, complete);
      if (active) {
        out.push({ key, title: entry.title, kind: entry.kind, until: entry.until, project: entry.project });
      }
    }
    return out;
  }

  private compute(): Computed {
    const now = this.now();
    const projects = this.deps.projects();
    const all = dedupe(projects.flatMap(p => SOURCES.flatMap(s => this.itemsOf(s, p, now))));
    const entries = this.defers.all();
    const listed = new Map(all.map(i => [i.key, i] as const));
    const items = all.filter(i => !entries[i.key] || !isDeferred(entries[i.key], i.fingerprint, now)).sort(compareItems);
    this.lastItems = items;
    const loadedAts = projects.flatMap(p => SOURCES.map(s => this.slots.get(slotKey(s, p))?.loadedAt ?? 0));
    const result: MyDayResult = {
      items,
      deferred: this.deferredList(entries, listed, now),
      failures: this.failures(projects),
      count: items.filter(i => i.tier !== 'later').length,
      multi: projects.length > 1,
      loadedAt: Math.max(0, ...loadedAts),
      generation: this.generation,
    };
    return { result, listed };
  }
}
